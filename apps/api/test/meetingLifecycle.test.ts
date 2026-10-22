import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyDraft, emptyPreflight } from "../src/meetingStore.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

const NOW = new Date("2026-09-30T08:00:00Z");
async function meeting(t: TestApp, title: string, options: { host?: string; end?: Date; marked?: boolean; status?: string } = {}) {
  const id = randomUUID(), end = options.end ?? new Date(NOW.getTime() - 60_000);
  await t.sql(`INSERT INTO meetings (id,version,title,status,scheduled_at,ends_at,ended_at,lead_dri_id,ceo_participant_id,participants,issue_ids,preflight,draft,origin_ref)
    VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'[]',$10::jsonb,$11::jsonb,'{}')`,
  [id,title,options.status ?? "scheduled",new Date(end.getTime()-3_600_000),end,options.marked ? NOW : null,
    options.host ?? TEST_MEMBER.personId,TEST_CEO.personId,
    JSON.stringify([{ personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri"], sourceRef: "test", updatedAt: NOW.toISOString() }]),
    JSON.stringify(emptyPreflight()),JSON.stringify({ ...emptyDraft(), note: "CEO 私有准备笔记" })]);
  await t.sql("INSERT INTO thread_members (object_type,object_id,person_id,added_by) VALUES ('meeting',$1,$2,$3)", [id,TEST_MEMBER.personId,TEST_CEO.personId]);
  return id;
}
async function read(t: TestApp, cookie: string, url: string) {
  const r = await t.app.inject({ method: "GET", url, headers: { cookie } });
  expect(r.statusCode).toBe(200); return r.json();
}
async function execute(t: TestApp, cookie: string, card: any, type: string, input: unknown = {}) {
  const action = card.actions.find((a: any) => a.actionType === type);
  expect(action).toBeTruthy();
  return t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin }, payload: { actionId: action.actionId, input } });
}
async function upload(t: TestApp, cookie: string, id: string, suffix: string, content: string) {
  const boundary = "meeting-lifecycle-fixture";
  return t.app.inject({ method: "POST", url: `/api/meetings/${id}/${suffix}`, headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="minutes.${suffix === "transcript" ? "json" : "md"}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) });
}

describe("meeting notification lifecycle and host follow-through", () => {
  it("removes ended meetings for attendees, keeps host follow-up, and uses the application clock at the exact end boundary", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => NOW });
    try {
      const ceo = await t.loginCookie(), member = await t.memberCookie();
      const past = await meeting(t,"expired host"), marked = await meeting(t,"marked host",{ marked:true,end:new Date(NOW.getTime()+3_600_000) });
      const boundary = await meeting(t,"exact end",{ host:TEST_CEO.personId,end:NOW });
      const future = await meeting(t,"future attendee",{ host:TEST_CEO.personId,end:new Date(NOW.getTime()+1) });
      await meeting(t,"recorded",{ status:"held" }); await meeting(t,"cancelled",{ status:"cancelled" });
      const notices = (await read(t,member,"/api/me/meetings")).meetings;
      expect(notices.map((m:any)=>m.meetingId).sort()).toEqual([past,marked,future].sort());
      expect(notices.find((m:any)=>m.meetingId===past).followUp).toBe(true);
      expect(notices.find((m:any)=>m.meetingId===marked).followUp).toBe(true);
      expect(notices.find((m:any)=>m.meetingId===future).followUp).toBe(false);
      for (const url of ["/api/cards/home","/api/cards/notifications"]) {
        const cards=(await read(t,ceo,url)).cards.filter((c:any)=>c.kind==="meeting");
        expect(cards.map((c:any)=>c.objectRef.id).sort()).toEqual([boundary,future].sort());
      }
    } finally { await t.close(); }
  });

  it("lets the current host reschedule a marked-ended meeting, preserves duration, and restores attendee notices", async () => {
    const t=await createTestApp({}, undefined, { outcomeAgent: { async generate() { return { candidate: { summary: "已核对会议记录", items: [] } }; } } });
    try {
      const member=await t.memberCookie(),ceo=await t.loginCookie();
      const id=await meeting(t,"reschedule",{marked:true});
      const card=await read(t,member,`/api/me/cards/meetings/${id}`);
      const starts=new Date(Date.now()+86_400_000).toISOString();
      const response=await execute(t,member,card,"meeting.reschedule",{scheduledAt:starts});
      expect(response.statusCode).toBe(200);
      expect(response.json().cards[0].payload).toMatchObject({scheduledAt:starts,endedAt:null,hasEnded:false});
      expect(response.json().cards[0].payload).not.toHaveProperty("draft");
      const row=(await t.sql("SELECT scheduled_at,ends_at,ended_at FROM meetings WHERE id=$1",[id]))[0];
      expect(row.ends_at.getTime()-row.scheduled_at.getTime()).toBe(3_600_000);
      expect((await read(t,ceo,"/api/cards/notifications")).cards.some((c:any)=>c.objectRef.id===id)).toBe(true);
      const stale=await execute(t,member,card,"meeting.reschedule",{scheduledAt:new Date(Date.now()+172_800_000).toISOString()});
      expect(stale.statusCode).toBe(409);expect(stale.json().latestCard.payload).not.toHaveProperty("draft");
      const fresh=await read(t,member,`/api/me/cards/meetings/${id}`);
      expect((await execute(t,member,fresh,"meeting.reschedule",{scheduledAt:"2000-01-01T00:00:00Z"})).statusCode).toBe(400);
      expect((await execute(t,member,fresh,"meeting.reschedule",{scheduledAt:starts,title:"越权改名"})).statusCode).toBe(400);
      await t.sql("UPDATE meetings SET lead_dri_id=$2 WHERE id=$1",[id,TEST_CEO.personId]);
      expect((await execute(t,member,fresh,"meeting.reschedule",{scheduledAt:starts})).statusCode).toBe(404);
    } finally {await t.close();}
  });

  it("lets the host import and confirm textual minutes without exposing CEO drafts or review actions", async () => {
    const t=await createTestApp({}, undefined, { outcomeAgent: { async generate(input) {
      const turn = input.transcript.turns[0];
      return { candidate: { summary: "已核对会议记录", sections: [{ heading: "排期", body: `已定：${turn.text}`, turnIds: [turn.id] }], objectChanges: [],
        actionItems: [{ text: turn.text, ownerPersonId: turn.speakerId, dueDate: null, basisSections: [1] }] } };
    } } });
    try {
      const member=await t.memberCookie(),ceo=await t.loginCookie();const id=await meeting(t,"minutes",{marked:true});
      const uploaded=await upload(t,member,id,"transcript-candidate","### 文字记录\n\n测试乙 00:01\n我负责核对排期。\n");
      expect(uploaded.statusCode).toBe(200);
      const card=uploaded.json().cards[0];
      expect(card.payload.transcriptCandidate.turnCount).toBe(1);expect(card.payload).not.toHaveProperty("draft");
      const rescheduleCard=(await read(t,ceo,`/api/cards/meetings/${id}`)).cards[0];
      const edit=await execute(t,ceo,rescheduleCard,"meeting.edit_details",{scheduledAt:new Date(Date.now()+86_400_000).toISOString()});
      expect(edit.statusCode).toBe(409);expect(edit.json().code).toBe("TRANSCRIPT_CANDIDATE_EXISTS");
      const confirmed=await execute(t,member,card,"meeting.confirm_transcript_candidate",{speakerMappings:[{speakerName:"测试乙",personId:TEST_MEMBER.personId}],confirmAddParticipants:true});
      expect(confirmed.statusCode).toBe(200);expect(["held", "reviewed"]).toContain(confirmed.json().cards[0].payload.status);
      expect((await t.sql("SELECT outcome->>'status' AS status FROM meetings WHERE id=$1", [id]))[0].status).toBe("ready");
      expect(confirmed.json().cards[0].actions).toEqual([]);expect(confirmed.json().cards[0].payload).not.toHaveProperty("draft");
      expect((await read(t,member,"/api/me/meetings")).meetings).toEqual([]);
      const second=await meeting(t,"json minutes");
      expect((await upload(t,member,second,"transcript-candidate","### 文字记录\n测试乙 00:01\n待确认的旧记录。\n")).statusCode).toBe(200);
      const json=await upload(t,member,second,"transcript",JSON.stringify({schemaVersion:"warmap-transcript.v1",meetingId:second,turns:[{id:"1",speakerId:TEST_MEMBER.personId,startedAt:NOW.toISOString(),text:"已核对排期。"}]}));
      expect(json.statusCode).toBe(200);expect(json.json().cards[0].payload).not.toHaveProperty("draft");
      expect(json.json().cards[0].payload.transcriptCandidate).toBeNull();
      const other=await meeting(t,"not host",{host:TEST_CEO.personId});
      expect((await upload(t,member,other,"transcript-candidate","### 文字记录\n测试乙 00:01\n越权上传")).statusCode).toBe(404);
      expect((await read(t,member,`/api/me/cards/meetings/${other}`)).payload).not.toHaveProperty("transcriptCandidate");
    } finally {await t.close();}
  });
});
