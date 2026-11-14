import { describe, expect, it } from "vitest";
import { meetingJoinUrl } from "../src/feishu/calendar.js";
import { isPartnerMeetingRecipient, listPartnerMeetings, meetingForViewer, partnerMeetingStatus, readPartnerMeetingRecord, type MinuteReader } from "../src/partnerMeetings.js";
import type { MeetingRow, Query } from "../src/meetingStore.js";
import { emptyPreflight } from "../src/meetingStore.js";
import { transcriptContentHash } from "../src/transcriptHash.js";

const now = new Date("2026-11-13T12:00:00Z");
const host = "host", member = "member", ceo = "ceo";
const base: Parameters<typeof partnerMeetingStatus>[0] = {
  id: "123", title: "设计评审", status: "scheduled", scheduled_at: now, ends_at: new Date(+now + 3_600_000), ended_at: null,
  lead_dri_id: host, ceo_participant_id: ceo, created_by: host, invited_person_ids: [host, member], participants: [], attendees_actual: null,
  minute_token: null, preflight: emptyPreflight(now), has_candidate: false, has_transcript: false, transcript_format: null, transcript_url: null,
  outcome_status: null, mine: 0,
};
const minutes = { async checkMinuteFor() { return { sourceUrl: null }; },
  async readMinuteFor() { throw new Error("列表不应读取正文"); } } as MinuteReader;

describe("伙伴会议收件", () => {
  it("实际出席优先，外部人员名单不会退回邀请，全球角色不会自动订阅", () => {
    expect(isPartnerMeetingRecipient(base, member, false)).toBe(true);
    expect(isPartnerMeetingRecipient(base, ceo, false)).toBe(false);
    expect(isPartnerMeetingRecipient({ ...base, attendees_actual: [] }, member, true)).toBe(false);
    expect(isPartnerMeetingRecipient({ ...base, attendees_actual: [] }, host, true)).toBe(true);
    expect(isPartnerMeetingRecipient({ ...base, attendees_actual: ["late"] }, "late", true)).toBe(true);
  });

  it("已知来源、录音失败和本机候选都有独立状态", () => {
    expect(partnerMeetingStatus({ ...base, has_transcript:true, transcript_format:"feishu_minutes", minute_binding:"unverified" },now,member).stage).toBe("processing");
    expect(partnerMeetingStatus({ ...base, has_candidate:true },now,host)).toMatchObject({stage:"attention",needsAction:true});
    expect(partnerMeetingStatus({ ...base, has_candidate:true },now,member)).toMatchObject({stage:"processing",needsAction:false});
    expect(partnerMeetingStatus({ ...base, latest_recording:{id:"r",status:"failed",error:"转写失败"} },now,host).statusText).toContain("失败");
  });

  it("日程页不能充当入会地址，标题或时间相同的预约仍是不同场次", async () => {
    const appLink = "https://applink.feishu.cn/client/calendar/event/detail?id=1";
    expect(meetingJoinUrl(appLink)).toBeNull();
    expect(meetingJoinUrl("https://vc.feishu.cn/j/123")).toBe("https://vc.feishu.cn/j/123");
    const later = new Date(+now + 12*86_400_000);
    const rows = [
      { ...base, id:"first", feishu_event_id:"booking", feishu_event_status:"booked", feishu_event_join_url:appLink },
      { ...base, id:"second", scheduled_at:later, ends_at:new Date(+later+3_600_000) },
    ];
    const q = (async (sql:string) => ({ rows: sql.includes("FROM meetings m\n") ? rows : [] })) as Query;
    const calendar = { async listFor() { return [
      { eventId:"booking_0", title:"重复日程", startsAt:now.toISOString(),endsAt:base.ends_at.toISOString(),allDay:false,url:appLink },
      { eventId:"external_0",title:"独立日程",startsAt:now.toISOString(),endsAt:base.ends_at.toISOString(),allDay:false,url:appLink },
    ]; } };
    const feed = await listPartnerMeetings(q,minutes,calendar,{personId:member,role:"member"},now);
    expect(feed.map(item=>item.id).sort()).toEqual(["feishu-event:external_0","meeting:first","meeting:second"]);
    expect(feed.every(item=>item.joinUrl===null)).toBe(true);
    expect(feed.find(item=>item.id==="meeting:second")?.at).toBe(later.toISOString());
  });

  it("两种来源各自保留；逐字稿深链在飞书撤权或版本变化后重新判定", async () => {
    const id = "5f601a70-c9f0-409b-b984-18b8958af4d1";
    const recordingId = "55d3be0f-d979-4074-a5b4-627dedad690d";
    const speaker = { personId:host,displayName:"主持人" };
    const local = { turns:[{speakerId:host,text:"本机原文"}],source:{format:"volc_asr"} };
    let current = { ...base,id,minute_token:"m",minute_binding:"source_id",participants:[speaker],transcript:local } as unknown as MeetingRow;
    const q = (async (sql:string) => {
      if (sql.includes("FROM meetings WHERE id")) return {rowCount:1,rows:[current]};
      if (sql.includes("SELECT transcript_candidate FROM meeting_recordings")) return {rowCount:1,rows:[{transcript_candidate:{turns:[{speakerName:"主持人",offsetSeconds:0,text:"本机原文"}]}}]};
      return {rowCount:0,rows:[]};
    }) as Query;
    const viewer = {personId:member,role:"member" as const};
    let text = "飞书原文";
    let revoked = false;
    const reader:MinuteReader = { ...minutes, async readMinuteFor() {
      return revoked ? {error:{status:403,code:"FEISHU_NO_PERMISSION",message:"无权读取"} as const}
        : {title:"会议",text,sourceUrl:"https://test.feishu.cn/minutes/m"};
    }};
    expect((await meetingForViewer(q,reader,current,viewer)).transcript).toBe(current.transcript);
    expect(await readPartnerMeetingRecord(q,reader,viewer,id)).toMatchObject({text:expect.stringContaining("本机原文")});
    expect(await readPartnerMeetingRecord(q,reader,viewer,id,"feishu")).toMatchObject({text});
    current={...current,transcript:{...local,source:{format:"feishu_minutes",contentHash:transcriptContentHash(text)}} as unknown as MeetingRow["transcript"]};
    expect((await meetingForViewer(q,reader,current,viewer)).transcript).toBe(current.transcript);
    text="更新后的飞书原文";
    expect((await meetingForViewer(q,reader,current,viewer)).transcript).toBeNull();
    expect(await readPartnerMeetingRecord(q,reader,viewer,id)).toMatchObject({text});
    revoked=true;
    expect((await meetingForViewer(q,reader,current,viewer)).transcript).toBeNull();
    expect(await readPartnerMeetingRecord(q,reader,viewer,id)).toMatchObject({error:{status:403}});
    expect(await readPartnerMeetingRecord(q,reader,viewer,id,undefined,recordingId)).toMatchObject({text:expect.stringContaining("本机原文")});
    // 上线前的逐字稿可能没有 source；只要曾经绑定妙记，不能把这份缓存当成本机来源绕开撤权。
    current={...current,transcript:{ turns:[] } as unknown as MeetingRow["transcript"]};
    expect((await meetingForViewer(q,reader,current,viewer)).transcript).toBeNull();
    expect(await readPartnerMeetingRecord(q,reader,viewer,id,"tianshu")).toMatchObject({error:{status:404}});
  });
});
