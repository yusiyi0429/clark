import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TPostMeetingCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import type { FeishuMinuteInfo, FeishuMinutesApi } from "../src/feishu/minutes.js";
import { createMeetingMinutesService, meetingMinutesReply, minuteFromEvent } from "../src/meetingMinutes.js";
import { parseFeishuTranscriptText } from "../src/transcriptMarkdown.js";
import { getMeetingRow } from "../src/meetingStore.js";

// 会议链路：妙记自动获取（事件 + 5 分钟轮询兜底）、waiting / manual、实际参会名单、手动上传仍是兜底。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = TEST_CEO.personId; // 测试甲
const HOST = TEST_MEMBER.personId; // 测试乙
const OWNER = "person-fixture-003"; // 测试丙
const feishuEnv = { tokenKey: randomBytes(32), tokenKeyVersion: 1 };
const START = "2026-06-01T10:00:00.000+08:00";

/** 飞书导出的逐字稿 txt（合成样例）：第一行开会时刻，然后关键词，再是「姓名 hh:mm:ss.mmm」加正文。 */
const TRANSCRIPT = [
  "2026-06-01 10:02:10 CST|58min 3s",
  "",
  "关键词:",
  "接口、看板",
  "",
  "测试乙 00:00:05.120 ",
  "接口统一改成 v2，测试丙那边月底前切过去。",
  "",
  "测试丙 00:01:10.002 ",
  "好，我月底前把渠道看板接到 v2。",
  "我们定在 10:30 再碰一次。",
  "",
].join("\n");

const CANDIDATE: TPostMeetingCandidate = {
  summary: "接口统一切到 v2",
  items: [{ kind: "decision", text: "接口统一改成 v2", turnId: "turn-0001", quote: "接口统一改成 v2" }],
};

const preflightAgent: PreflightAgent = { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };

function recordingOutcome(): PostMeetingAgent & { inputs: PostMeetingAgentInput[] } {
  const agent = { inputs: [] as PostMeetingAgentInput[], async generate(input: PostMeetingAgentInput) { agent.inputs.push(input); return { candidate: structuredClone(CANDIDATE) }; } };
  return agent;
}

function fakeMinutesApi(transcript = TRANSCRIPT): FeishuMinutesApi & { calls: string[] } {
  const minute: FeishuMinuteInfo = { token: "obcn_minute_1", title: "接口切换会", ownerOpenId: "ou_host", createdAt: new Date("2026-06-01T10:02:10+08:00"),
    durationSeconds: 3483, url: "https://example.feishu.cn/minutes/obcn_minute_1", meetingId: "vc_1" };
  const api = {
    calls: [] as string[],
    async getMinute(token: string, minuteToken: string) { api.calls.push(`get:${token}:${minuteToken}`); return { ...minute, meetingId: null }; },
    async exportTranscript(token: string, minuteToken: string) { api.calls.push(`export:${token}:${minuteToken}`); return transcript; },
    async listMinutes(token: string, owner: { openId: string }) { api.calls.push(`list:${token}:${owner.openId}`); return [minute]; },
    async meetingParticipants(token: string, meetingId: string) { api.calls.push(`participants:${meetingId}`); return ["ou_host", "ou_owner", "ou_guest"]; },
  };
  return api;
}

async function scheduledMeeting(t: TestApp): Promise<string> {
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue() as unknown as { objectRef: { id: string }; actions: { actionType: string; actionId: string }[] };
  const create = issueCard.actions.find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "接口切换会", scheduledAt: START, leadDriId: HOST, ceoParticipantId: CEO, participants: [HOST], issueIds: [issueCard.objectRef.id] },
  } });
  expect(created.statusCode).toBe(200);
  return created.json().cards[0].objectRef.id as string;
}

async function authorize(t: TestApp, personId: string, openId: string, name: string, at: Date) {
  await t.pool.query("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, $2, $3)", [personId, openId, name]);
  await saveAuthorizedToken(t.pool.query.bind(t.pool), feishuEnv, personId, { accessToken: `u-${personId}`, expiresIn: 7200, scope: "offline_access" }, at);
}

describe("飞书妙记逐字稿解析", () => {
  it("认「姓名 hh:mm:ss.mmm」发言头，取第一行的开会时刻；正文里的时间不当发言头", () => {
    const parsed = parseFeishuTranscriptText(TRANSCRIPT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.startedAt).toBe("2026-06-01T02:02:10.000Z");
    expect(parsed.transcript.turns).toEqual([
      { speakerName: "测试乙", offsetSeconds: 5, text: "接口统一改成 v2，测试丙那边月底前切过去。" },
      { speakerName: "测试丙", offsetSeconds: 70, text: "好，我月底前把渠道看板接到 v2。\n我们定在 10:30 再碰一次。" },
    ]);
    expect(parseFeishuTranscriptText("2026-06-01 10:02:10 CST|1min\n\n关键词:\n无").ok).toBe(false);
  });

  it("事件里的妙记 token 与来源会议（拍平和没拍平的都认）", () => {
    expect(minuteFromEvent({ event_id: "e1", minute_token: "obcn1", minute_source: { source_type: "meeting", source_entity_id: "vc_9" } }))
      .toEqual({ minuteToken: "obcn1", feishuMeetingId: "vc_9" });
    expect(minuteFromEvent({ event: { minute_token: "obcn2" } })).toEqual({ minuteToken: "obcn2", feishuMeetingId: null });
    expect(minuteFromEvent({ event_id: "e2" })).toBeNull();
  });
});

describe("会开完后自动拿妙记", () => {
  it("轮询：开完的会记 waiting（对话里答还在生成），拿到妙记后说话人都对得上就直接解读纪要，实际参会名单来自飞书", async () => {
    const outcome = recordingOutcome();
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: outcome });
    try {
      const meetingId = await scheduledMeeting(t);
      let clock = new Date("2026-06-01T11:10:00+08:00");
      await authorize(t, HOST, "ou_host", "测试乙", clock);
      await authorize(t, OWNER, "ou_owner", "测试丙", clock);
      const api = fakeMinutesApi();
      const minutes = createMeetingMinutesService({ pool: t.pool, companyMemory: loadCompanyMemory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api }, now: () => clock });

      // 开完了、妙记还没生成：waiting。
      const emptyApi = { ...api, async listMinutes() { return []; } };
      await createMeetingMinutesService({ pool: t.pool, companyMemory: loadCompanyMemory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api: emptyApi }, now: () => clock }).tick();
      expect(await meetingMinutesReply(t.pool.query.bind(t.pool), meetingId)).toEqual({ status: "waiting", reply: "飞书妙记还在生成，生成后会自动整理纪要。" });
      const ceo = await t.loginCookie();
      expect((await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0].payload.minutesStatus).toBe("waiting");

      clock = new Date("2026-06-01T11:15:00+08:00");
      await minutes.tick();
      expect(api.calls).toEqual(["list:u-person-fixture-002:ou_host", "export:u-person-fixture-002:obcn_minute_1", "participants:vc_1"]);
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row).toMatchObject({ status: "held", minutes_status: "ready", minute_token: "obcn_minute_1", feishu_meeting_id: "vc_1", attendees_actual: [HOST, OWNER] });
      expect(row.transcript?.source).toMatchObject({ format: "feishu_minutes", timeAnchor: "2026-06-01T02:02:10.000Z" });
      expect(row.transcript?.turns.map((turn) => [turn.speakerId, turn.startedAt])).toEqual([[HOST, "2026-06-01T02:02:15.000Z"], [OWNER, "2026-06-01T02:03:20.000Z"]]);
      // 说话人测试丙补进参会人；会后抽取跑完。
      expect(row.participants.map((person) => person.personId)).toEqual([CEO, HOST, OWNER]);
      expect(row.outcome?.status).toBe("ready");
      expect(outcome.inputs).toHaveLength(1);
      const card = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0];
      expect(card.payload).toMatchObject({ minutesStatus: "ready", attendees: { source: "feishu", personIds: [HOST, OWNER] } });
      expect(await meetingMinutesReply(t.pool.query.bind(t.pool), meetingId)).toEqual({ status: "ready", reply: null });

      // 再轮询不重复拿。
      await minutes.tick();
      expect(api.calls).toHaveLength(3);
    } finally {
      await t.close();
    }
  });

  it("「妙记生成」事件：对上主持人名下的妙记；有对不上的说话人时只生成候选，留给主持人确认", async () => {
    const outcome = recordingOutcome();
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: outcome });
    try {
      const meetingId = await scheduledMeeting(t);
      const clock = new Date("2026-06-01T11:10:00+08:00");
      await authorize(t, HOST, "ou_host", "测试乙", clock);
      const api = fakeMinutesApi(`${TRANSCRIPT}\nSpeaker 1 00:03:00.000\n我补充一句。\n`);
      const minutes = createMeetingMinutesService({ pool: t.pool, companyMemory: loadCompanyMemory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api: { ...api, async listMinutes() { return []; } } }, now: () => clock });
      await minutes.tick();
      await minutes.onMinuteGenerated({ event_id: "ev1", minute_token: "obcn_minute_1" });
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row).toMatchObject({ status: "scheduled", minutes_status: "ready", minute_token: "obcn_minute_1", transcript: null });
      expect(row.transcript_candidate?.speakers.map((speaker) => [speaker.speakerName, speaker.suggestedPersonId])).toEqual([
        ["测试乙", HOST], ["测试丙", OWNER], ["Speaker 1", null],
      ]);
      expect(outcome.inputs).toHaveLength(0);
      // 同一份妙记不会再对到别的会。
      expect((await t.pool.query("SELECT count(*)::int AS n FROM meetings WHERE minute_token = 'obcn_minute_1'")).rows[0].n).toBe(1);
    } finally {
      await t.close();
    }
  });

  it("飞书没接或主持人没授权：退回手动上传（manual）；手动上传后算 ready", async () => {
    const outcome = recordingOutcome();
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: outcome });
    try {
      const meetingId = await scheduledMeeting(t);
      const clock = new Date("2026-06-01T11:10:00+08:00");
      await createMeetingMinutesService({ pool: t.pool, companyMemory: loadCompanyMemory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret, now: () => clock }).tick();
      expect(await meetingMinutesReply(t.pool.query.bind(t.pool), meetingId)).toEqual({ status: "manual", reply: "这场会的妙记没能自动拿到，主持人可以在会议页上传妙记。" });
      const host = await t.memberCookie();
      const boundary = "----minutes-test";
      const payload = Buffer.from([`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="miaoji.md"', "Content-Type: text/markdown", "",
        "### 文字记录\n测试乙 00:05\n接口统一改成 v2。", `--${boundary}--`, ""].join("\r\n"), "utf8");
      const upload = await t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/transcript-candidate`,
        headers: { cookie: host, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
      expect(upload.statusCode).toBe(200);
      expect(await meetingMinutesReply(t.pool.query.bind(t.pool), meetingId)).toEqual({ status: "ready", reply: null });
    } finally {
      await t.close();
    }
  });
});
