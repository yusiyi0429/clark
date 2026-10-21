import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { TMeetingCardCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import { createFeishuMinutesApi, type FeishuMinuteInfo, type FeishuMinutesApi } from "../src/feishu/minutes.js";
import { createMeetingMinutesService, meetingMinutesReply, minuteFromEvent } from "../src/meetingMinutes.js";
import { parseFeishuTranscriptText } from "../src/transcriptMarkdown.js";
import { getMeetingRow } from "../src/meetingStore.js";
import { minutesManualImport } from "../src/meetingDecisionView.js";
import { FeishuApiError } from "../src/feishu/client.js";
import { hashSecret } from "../src/session.js";
import { normalizeTranscriptText, transcriptContentHash } from "../src/transcriptHash.js";

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

const CANDIDATE: TMeetingCardCandidate = {
  summary: "接口统一切到 v2",
  sections: [{ heading: "接口", body: "已定：接口统一改成 v2。", turnIds: ["turn-0001"] }],
  objectChanges: [],
  actionItems: [],
};

const preflightAgent: PreflightAgent = { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };

function recordingOutcome(): PostMeetingAgent & { inputs: PostMeetingAgentInput[] } {
  const agent = { inputs: [] as PostMeetingAgentInput[], async generate(input: PostMeetingAgentInput) { agent.inputs.push(input); return { candidate: structuredClone(CANDIDATE) }; } };
  return agent;
}

function fakeMinutesApi(transcript = TRANSCRIPT): FeishuMinutesApi & {
  calls: string[]; artifactsError: Error | null; exportError: Error | null; listEmpty: boolean; onRead: (() => Promise<void>) | null;
} {
  const minute: FeishuMinuteInfo = { token: "obcn_minute_1", title: "接口切换会", ownerOpenId: "ou_host", createdAt: new Date("2026-06-01T10:02:10+08:00"),
    durationSeconds: 3483, url: "https://example.feishu.cn/minutes/obcn_minute_1", meetingId: "vc_1" };
  const api = {
    calls: [] as string[],
    artifactsError: null as Error | null,
    exportError: null as Error | null,
    /** 列妙记时返回空（妙记还没生成）。 */
    listEmpty: false,
    /** 读全文时先做的事（模拟读的过程中会议被取消）。 */
    onRead: null as (() => Promise<void>) | null,
    async getMinute(token: string, minuteToken: string) { api.calls.push(`get:${token}:${minuteToken}`); return { ...minute, token: minuteToken, meetingId: null }; },
    async artifactTranscript(token: string, minuteToken: string) {
      api.calls.push(`artifacts:${token}:${minuteToken}`);
      await api.onRead?.();
      if (api.artifactsError) throw api.artifactsError;
      return transcript;
    },
    async exportTranscript(token: string, minuteToken: string) {
      api.calls.push(`export:${token}:${minuteToken}`);
      if (api.exportError) throw api.exportError;
      return transcript;
    },
    async listMinutes(token: string, owner: { openId: string }) { api.calls.push(`list:${token}:${owner.openId}`); return api.listEmpty ? [] : [minute]; },
    async meetingParticipants(token: string, meetingId: string) { api.calls.push(`participants:${meetingId}`); return ["ou_host", "ou_owner", "ou_guest"]; },
  };
  return api;
}

async function scheduledMeeting(t: TestApp, participants: string[] = [HOST]): Promise<string> {
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue() as unknown as { objectRef: { id: string }; actions: { actionType: string; actionId: string }[] };
  const create = issueCard.actions.find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "接口切换会", scheduledAt: START, leadDriId: HOST, ceoParticipantId: CEO, participants, issueIds: [issueCard.objectRef.id] },
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
      const minutes = createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api }, now: () => clock });

      // 开完了、妙记还没生成：waiting。
      const emptyApi = { ...api, async listMinutes() { return []; } };
      await createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api: emptyApi }, now: () => clock }).tick();
      expect(await meetingMinutesReply(t.pool.query.bind(t.pool), meetingId)).toEqual({ status: "waiting", reply: "飞书妙记还在生成，生成后会自动整理纪要。" });
      // 等妙记从会开完那一刻算起，不是从轮询发现的时刻。
      const waitingRow = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(waitingRow.minutes_waiting_since?.toISOString()).toBe((waitingRow.ended_at ?? waitingRow.ends_at).toISOString());
      const ceo = await t.loginCookie();
      expect((await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0].payload.minutesStatus).toBe("waiting");

      clock = new Date("2026-06-01T11:15:00+08:00");
      await minutes.tick();
      expect(api.calls).toEqual(["list:u-person-fixture-002:ou_host", "artifacts:u-person-fixture-002:obcn_minute_1", "participants:vc_1"]);
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

  it("「妙记生成」事件：对上主持人名下的妙记；对不上的说话人保留飞书原名，照样直接确认并生成会议卡，不编人、不进参会人", async () => {
    const outcome = recordingOutcome();
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: outcome });
    try {
      const meetingId = await scheduledMeeting(t);
      const clock = new Date("2026-06-01T11:10:00+08:00");
      await authorize(t, HOST, "ou_host", "测试乙", clock);
      const api = fakeMinutesApi(`${TRANSCRIPT}
Speaker 3 00:03:00.000
我来把预算表发给大家。
`);
      const minutes = createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api: { ...api, async listMinutes() { return []; } } }, now: () => clock });
      await minutes.tick();
      await minutes.onMinuteGenerated({ event_id: "ev1", minute_token: "obcn_minute_1" });
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row).toMatchObject({ status: "held", minutes_status: "ready", minute_token: "obcn_minute_1", transcript_candidate: null });
      // 对不上的说话人：合成编号 + 飞书原名，不对到任何人，也不进参会人。
      expect(row.transcript?.unmappedSpeakers).toEqual([{ id: "speaker:3", name: "Speaker 3" }]);
      expect(row.transcript?.turns.map((turn) => turn.speakerId)).toEqual([HOST, OWNER, "speaker:3"]);
      expect(row.participants.map((person) => person.personId)).toEqual([CEO, HOST, OWNER]);
      // 会议卡照常生成；模型看得到原名。
      expect(row.outcome?.status).toBe("ready");
      expect(outcome.inputs).toHaveLength(1);
      expect(outcome.inputs[0].transcript.unmappedSpeakers).toEqual([{ id: "speaker:3", name: "Speaker 3" }]);
      const ceo = await t.loginCookie();
      const card = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0];
      expect(card.payload.transcript.unmappedSpeakers).toEqual([{ id: "speaker:3", name: "Speaker 3" }]);
      // 同一份妙记不会再对到别的会。
      expect((await t.pool.query("SELECT count(*)::int AS n FROM meetings WHERE minute_token = 'obcn_minute_1'")).rows[0].n).toBe(1);
    } finally {
      await t.close();
    }
  });

  it("几个说话人对到同一人时也直接确认", async () => {
    const outcome = recordingOutcome();
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: outcome });
    try {
      const meetingId = await scheduledMeeting(t);
      const clock = new Date("2026-06-01T11:10:00+08:00");
      // 测试乙的飞书名是「乙」：人员目录的显示名和飞书名都对到测试乙。
      await authorize(t, HOST, "ou_host", "乙", clock);
      const api = fakeMinutesApi(`${TRANSCRIPT}
乙 00:03:00.000
我补充一句。
`);
      await createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api }, now: () => clock }).tick();
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row.status).toBe("held");
      expect(row.transcript?.turns.map((turn) => turn.speakerId)).toEqual([HOST, OWNER, HOST]);
      expect(row.transcript?.unmappedSpeakers ?? []).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("主持人没授权、或主持人的授权读不了妙记：用建会的人的授权拿", async () => {
    for (const hostState of ["none", "no_scope"] as const) {
      const outcome = recordingOutcome();
      const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: outcome });
      try {
        // 会是 CEO（测试甲）建的，主持人是测试乙。
        const meetingId = await scheduledMeeting(t);
        const clock = new Date("2026-06-01T11:15:00+08:00");
        await authorize(t, CEO, "ou_ceo", "测试甲", clock);
        if (hostState === "no_scope") await authorize(t, HOST, "ou_host", "测试乙", clock);
        const api = fakeMinutesApi();
        const listMinutes = api.listMinutes;
        api.listMinutes = async (token, owner) => {
          if (token === `u-${HOST}`) { api.calls.push(`list:${token}:${owner.openId}`); throw new FeishuApiError(99991679, "missing scope"); }
          return listMinutes(token, owner);
        };
        await createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret,
          feishu: { env: feishuEnv, api }, now: () => clock }).tick();
        expect(api.calls.filter((call) => call.startsWith("list:"))).toEqual(
          hostState === "none" ? [`list:u-${CEO}:ou_ceo`] : [`list:u-${HOST}:ou_host`, `list:u-${CEO}:ou_ceo`]);
        expect(api.calls).toContain(`artifacts:u-${CEO}:obcn_minute_1`);
        expect((await getMeetingRow(t.pool.query.bind(t.pool), meetingId))).toMatchObject({ status: "held", minutes_status: "ready", minute_token: "obcn_minute_1" });
      } finally {
        await t.close();
      }
    }
  });

  it("飞书没接或主持人没授权：退回手动上传（manual）；手动上传后算 ready", async () => {
    const outcome = recordingOutcome();
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: outcome });
    try {
      const meetingId = await scheduledMeeting(t);
      const clock = new Date("2026-06-01T11:10:00+08:00");
      await createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: outcome, secret: t.env.sessionSecret, now: () => clock }).tick();
      expect(await meetingMinutesReply(t.pool.query.bind(t.pool), meetingId)).toEqual({ status: "manual", reply: "这场会的妙记没能自动拿到，主持人可以在会议页上传妙记。" });
      const host = await t.memberCookie();
      const boundary = "----minutes-test";
      const markdown = "### 文字记录\n测试乙 00:05\n接口统一改成 v2。";
      const payload = Buffer.from([`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="miaoji.md"', "Content-Type: text/markdown", "",
        markdown, `--${boundary}--`, ""].join("\r\n"), "utf8");
      const upload = await t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/transcript-candidate`,
        headers: { cookie: host, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
      expect(upload.statusCode).toBe(200);
      // 没有飞书妙记的来源：地址是天枢会议页的逐字稿，摘要值用同一函数。
      expect((await getMeetingRow(t.pool.query.bind(t.pool), meetingId))?.transcript_candidate?.source).toMatchObject({
        url: `${t.publicOrigin}/meetings/${meetingId}#transcript`, contentHash: transcriptContentHash(markdown), capturedAt: expect.stringMatching(/\+08:00$/) });
      expect(await meetingMinutesReply(t.pool.query.bind(t.pool), meetingId)).toEqual({ status: "ready", reply: null });
    } finally {
      await t.close();
    }
  });
});

/** 接了飞书的天枢（妙记接口用假实现）：路由里的「再读一次」「贴链接」走这里。授权按真实时刻存，app 内的服务用真实时钟。 */
async function feishuApp(api: FeishuMinutesApi) {
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, feishu: { appId: "cli_test", appSecret: "test-secret", ...feishuEnv } }, undefined,
    { preflightAgent, outcomeAgent: recordingOutcome(), meetingFollowThroughAgents: { minutesApi: api } });
  await authorize(t, HOST, "ou_host", "测试乙", new Date());
  return t;
}

/** 会开完后跑一次自动拉取（时钟拨到会后；同一次里先记 waiting 再去拿）。 */
async function tickAfterMeeting(t: TestApp, api: FeishuMinutesApi, extra: { feishuWebOrigin?: string } = {}) {
  const clock = new Date("2026-06-01T11:15:00+08:00");
  await createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: recordingOutcome(), secret: t.env.sessionSecret,
    feishu: { env: feishuEnv, api }, now: () => clock, ...extra }).tick();
}

const post = (t: TestApp, cookie: string, url: string, payload?: unknown) =>
  t.app.inject({ method: "POST", url, headers: { cookie, origin: t.publicOrigin }, ...(payload === undefined ? {} : { payload }) });

describe("妙记来源与再读", () => {
  it("摘要值只规范换行", () => {
    expect(normalizeTranscriptText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(transcriptContentHash("a\r\nb\rc")).toBe(transcriptContentHash("a\nb\nc"));
    expect(transcriptContentHash("a\nb\nc")).toBe(createHash("sha256").update("a\nb\nc", "utf8").digest("hex"));
    expect(transcriptContentHash("a\nb\nc ")).not.toBe(transcriptContentHash("a\nb\nc"));
  });

  it("关键词行英文也能解析", () => {
    const parsed = parseFeishuTranscriptText(TRANSCRIPT.replace("关键词:", "Keywords:"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.startedAt).toBe("2026-06-01T02:02:10.000Z");
    expect(parsed.transcript.turns.map((turn) => turn.speakerName)).toEqual(["测试乙", "测试丙"]);
  });

  it("妙记读完记下来源", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: recordingOutcome() });
    try {
      const meetingId = await scheduledMeeting(t);
      await authorize(t, HOST, "ou_host", "测试乙", new Date());
      const raw = TRANSCRIPT.replace(/\n/g, "\r\n");
      await tickAfterMeeting(t, fakeMinutesApi(raw), { feishuWebOrigin: "https://example.feishu.cn/" });
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row).toMatchObject({ minutes_status: "ready", status: "held" });
      expect(row.transcript?.source).toMatchObject({
        format: "feishu_minutes",
        url: "https://example.feishu.cn/minutes/obcn_minute_1",
        title: "接口切换会",
        contentHash: transcriptContentHash(raw),
        capturedAt: "2026-06-01T11:15:00+08:00",
      });
      expect(row.transcript?.source?.contentHash).toBe(createHash("sha256").update(TRANSCRIPT, "utf8").digest("hex"));
    } finally {
      await t.close();
    }
  });

  it("产物接口无权限时退回导出接口", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: recordingOutcome() });
    try {
      const meetingId = await scheduledMeeting(t);
      await authorize(t, HOST, "ou_host", "测试乙", new Date());
      const api = fakeMinutesApi();
      api.artifactsError = new FeishuApiError(99991679, "Unauthorized");
      const stdout = vi.spyOn(process.stdout, "write");
      try {
        await tickAfterMeeting(t, api);
        expect(stdout.mock.calls.some(([line]) => String(line).includes('"status":"artifacts_unavailable"'))).toBe(true);
      } finally {
        stdout.mockRestore();
      }
      expect(api.calls).toEqual(["list:u-person-fixture-002:ou_host", "artifacts:u-person-fixture-002:obcn_minute_1",
        "export:u-person-fixture-002:obcn_minute_1", "participants:vc_1"]);
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row.minutes_status).toBe("ready");
      expect(row.transcript?.source?.contentHash).toBe(transcriptContentHash(TRANSCRIPT));
    } finally {
      await t.close();
    }
  });

  it("读取失败可以再读", async () => {
    const api = fakeMinutesApi();
    const t = await feishuApp(api);
    try {
      const meetingId = await scheduledMeeting(t);
      api.artifactsError = new FeishuApiError(99991679, "Unauthorized");
      api.exportError = new FeishuApiError(99991679, "Unauthorized");
      await tickAfterMeeting(t, api);
      const failed = await t.pool.query("SELECT minutes_status, minutes_failure FROM meetings WHERE id = $1", [meetingId]);
      expect(failed.rows[0]).toEqual({ minutes_status: "failed", minutes_failure: "no_permission" });
      const ceo = await t.loginCookie();
      expect((await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0].payload)
        .toMatchObject({ minutesStatus: "failed", minutesFailure: "no_permission" });

      api.artifactsError = null;
      api.exportError = null;
      api.calls.length = 0;
      const again = await post(t, await t.memberCookie(), `/api/meetings/${meetingId}/minutes/refetch`);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ minutesStatus: "ready", minutesFailure: null });
      expect(api.calls).toContain("artifacts:u-person-fixture-002:obcn_minute_1");
      expect((await getMeetingRow(t.pool.query.bind(t.pool), meetingId))?.transcript?.source?.contentHash).toBe(transcriptContentHash(TRANSCRIPT));
    } finally {
      await t.close();
    }
  });

  it("读完了不能再读", async () => {
    const api = fakeMinutesApi();
    const t = await feishuApp(api);
    try {
      const meetingId = await scheduledMeeting(t);
      await tickAfterMeeting(t, api);
      expect((await getMeetingRow(t.pool.query.bind(t.pool), meetingId))?.minutes_status).toBe("ready");
      api.calls.length = 0;
      const again = await post(t, await t.memberCookie(), `/api/meetings/${meetingId}/minutes/refetch`);
      expect(again.statusCode).toBe(409);
      expect(api.calls).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("贴链接读取", async () => {
    const api = fakeMinutesApi();
    const t = await feishuApp(api);
    try {
      const meetingId = await scheduledMeeting(t);
      const host = await t.memberCookie();
      for (const url of [
        "https://example.com/minutes/obcnpasted1",
        "https://example.feishu.cn/docx/obcnpasted1",
        "https://example.feishu.cn/minutes/obcnpasted1;drop",
        "http://example.feishu.cn/minutes/obcnpasted1",
        "not a link",
      ]) {
        expect((await post(t, host, `/api/meetings/${meetingId}/minutes`, { url })).statusCode).toBe(400);
      }
      expect(api.calls).toEqual([]);

      const read = await post(t, host, `/api/meetings/${meetingId}/minutes`, { url: "https://example.feishu.cn/minutes/obcnpasted1?from=from_copylink" });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ minutesStatus: "ready", minutesFailure: null });
      expect(api.calls).toEqual(["get:u-person-fixture-002:obcnpasted1", "artifacts:u-person-fixture-002:obcnpasted1"]);
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row).toMatchObject({ minute_token: "obcnpasted1", minutes_status: "ready", status: "held" });
      expect(row.transcript?.source).toMatchObject({ format: "feishu_minutes", title: "接口切换会", contentHash: transcriptContentHash(TRANSCRIPT) });
    } finally {
      await t.close();
    }
  });

  it("参会人不能贴链接", async () => {
    const api = fakeMinutesApi();
    const t = await feishuApp(api);
    try {
      const meetingId = await scheduledMeeting(t, [HOST, OWNER]);
      await t.pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, 'ceshib', $2, FALSE)", [OWNER, hashSecret("8642")]);
      const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: { loginId: "ceshib", passcode: "8642" } });
      expect(login.statusCode).toBe(200);
      const owner = String(login.headers["set-cookie"]).split(";")[0];
      const url = "https://example.feishu.cn/minutes/obcnpasted1";
      expect((await post(t, owner, `/api/meetings/${meetingId}/minutes`, { url })).statusCode).toBe(404);
      expect((await post(t, owner, `/api/meetings/${meetingId}/minutes/refetch`)).statusCode).toBe(404);
      expect(api.calls).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("产物接口回任何飞书错误都退回导出接口（非 JSON 的 403、没有逐字稿）", async () => {
    const responses = [
      () => new Response("<html>403 Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } }),
      () => new Response(JSON.stringify({ code: 0, msg: "success", data: { transcript: "" } }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    for (const response of responses) {
      const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: recordingOutcome() });
      try {
        const meetingId = await scheduledMeeting(t);
        await authorize(t, HOST, "ou_host", "测试乙", new Date());
        const api = fakeMinutesApi();
        // 产物接口走真实适配层（假 fetch），其余用假实现。
        api.artifactTranscript = createFeishuMinutesApi({ fetch: async () => response() }).artifactTranscript;
        await tickAfterMeeting(t, api);
        expect(api.calls).toContain("export:u-person-fixture-002:obcn_minute_1");
        const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
        expect(row.minutes_status).toBe("ready");
        expect(row.transcript?.source?.contentHash).toBe(transcriptContentHash(TRANSCRIPT));
      } finally {
        await t.close();
      }
    }
  });

  it("自动拉取遇到临时故障（网络、飞书 5xx）照常再取，不记失败", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: recordingOutcome() });
    try {
      const meetingId = await scheduledMeeting(t);
      await authorize(t, HOST, "ou_host", "测试乙", new Date());
      const api = fakeMinutesApi();
      const status = async () => (await t.pool.query("SELECT minutes_status, minutes_failure FROM meetings WHERE id = $1", [meetingId])).rows[0];
      // 网络错误：不算产物接口不可用，不退回导出接口。
      api.artifactsError = new TypeError("fetch failed");
      await tickAfterMeeting(t, api);
      expect(await status()).toEqual({ minutes_status: "waiting", minutes_failure: null });
      expect(api.calls.some((call) => call.startsWith("export:"))).toBe(false);
      api.artifactsError = new FeishuApiError(0, "飞书接口返回了非 JSON 响应（HTTP 502）", 502);
      api.exportError = new FeishuApiError(0, "导出妙记逐字稿失败：HTTP 502", 502);
      await tickAfterMeeting(t, api);
      expect(await status()).toEqual({ minutes_status: "waiting", minutes_failure: null });
      api.artifactsError = null;
      api.exportError = null;
      await tickAfterMeeting(t, api);
      expect(await status()).toEqual({ minutes_status: "ready", minutes_failure: null });
    } finally {
      await t.close();
    }
  });

  it("再读一次没找到妙记时照常轮询", async () => {
    const api = fakeMinutesApi();
    const t = await feishuApp(api);
    try {
      const meetingId = await scheduledMeeting(t);
      api.listEmpty = true;
      await tickAfterMeeting(t, api);
      expect((await getMeetingRow(t.pool.query.bind(t.pool), meetingId))?.minutes_status).toBe("waiting");
      const again = await post(t, await t.memberCookie(), `/api/meetings/${meetingId}/minutes/refetch`);
      expect(again.json()).toEqual({ minutesStatus: "failed", minutesFailure: "not_ready" });
      api.listEmpty = false;
      api.calls.length = 0;
      await tickAfterMeeting(t, api);
      expect(api.calls[0]).toBe("list:u-person-fixture-002:ou_host");
      expect((await getMeetingRow(t.pool.query.bind(t.pool), meetingId))?.minutes_status).toBe("ready");
    } finally {
      await t.close();
    }
  });

  it("不是待开的会不能贴链接，妙记不会锁在错的会上", async () => {
    const api = fakeMinutesApi();
    const t = await feishuApp(api);
    try {
      const host = await t.memberCookie();
      const url = "https://example.feishu.cn/minutes/obcnpasted1";
      const tokenOf = async (id: string) => (await t.pool.query("SELECT minute_token FROM meetings WHERE id = $1", [id])).rows[0].minute_token;
      // 已取消的会：先拒，接口一次没调。
      const cancelled = await scheduledMeeting(t);
      await t.pool.query("UPDATE meetings SET status = 'cancelled' WHERE id = $1", [cancelled]);
      const rejected = await post(t, host, `/api/meetings/${cancelled}/minutes`, { url });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().code).toBe("MEETING_NOT_SCHEDULED");
      expect((await post(t, host, `/api/meetings/${cancelled}/minutes/refetch`)).statusCode).not.toBe(200);
      expect(api.calls).toEqual([]);
      expect(await tokenOf(cancelled)).toBeNull();
      // 读的过程中会被取消：候选写不进去，妙记还回去。
      const racing = await scheduledMeeting(t);
      api.onRead = async () => { await t.pool.query("UPDATE meetings SET status = 'cancelled' WHERE id = $1", [racing]); };
      expect((await post(t, host, `/api/meetings/${racing}/minutes`, { url })).statusCode).toBe(409);
      expect(await tokenOf(racing)).toBeNull();
      // 对的会照样能对上这份妙记。
      api.onRead = null;
      const right = await scheduledMeeting(t);
      const read = await post(t, host, `/api/meetings/${right}/minutes`, { url });
      expect(read.statusCode).toBe(200);
      expect(await tokenOf(right)).toBe("obcnpasted1");
    } finally {
      await t.close();
    }
  });
});

/** 上传妙记 Markdown（生成候选，走说话人确认）。 */
async function uploadMarkdown(t: TestApp, meetingId: string, markdown = "### 文字记录\n测试乙 00:05\n接口统一改成 v2。") {
  const boundary = "----minutes-upload";
  const payload = Buffer.from([`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="miaoji.md"', "Content-Type: text/markdown", "",
    markdown, `--${boundary}--`, ""].join("\r\n"), "utf8");
  const upload = await t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/transcript-candidate`,
    headers: { cookie: await t.loginCookie(), origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
  expect(upload.statusCode).toBe(200);
}

describe("自动同步失败才给手动导入", () => {
  const ENDS = Date.parse("2026-06-01T11:00:00+08:00");
  const row = (overrides: Record<string, unknown> = {}) => ({
    minutes_status: "none" as const, minutes_failure: null, transcript: null, transcript_candidate: null,
    ended_at: null, ends_at: new Date(ENDS), ...overrides,
  }) as Parameters<typeof minutesManualImport>[0];
  const hours = (n: number) => new Date(ENDS + n * 3_600_000);

  it("manual、读取失败（不是原文还没好）、开完超过 48 小时还没有记录时才给；自动同步进行中不给", () => {
    expect(minutesManualImport(row({ minutes_status: "manual" }), hours(1))).toBe(true);
    expect(minutesManualImport(row({ minutes_status: "failed", minutes_failure: "no_permission" }), hours(1))).toBe(true);
    expect(minutesManualImport(row({ minutes_status: "failed", minutes_failure: "fetch_failed" }), hours(1))).toBe(true);
    expect(minutesManualImport(row({ minutes_status: "failed", minutes_failure: "not_ready" }), hours(1))).toBe(false);
    expect(minutesManualImport(row({ minutes_status: "waiting" }), hours(1))).toBe(false);
    expect(minutesManualImport(row({ minutes_status: "waiting" }), hours(49))).toBe(false);
    expect(minutesManualImport(row(), hours(47))).toBe(false);
    expect(minutesManualImport(row(), hours(49))).toBe(true);
    // 已经有逐字稿或候选：不再给大块导入。
    expect(minutesManualImport(row({ minutes_status: "manual", transcript_candidate: {} }), hours(1))).toBe(false);
    expect(minutesManualImport(row({ transcript: {} }), hours(49))).toBe(false);
  });

  it("等妙记最多等 2 小时，过了退回手动导入", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: recordingOutcome() });
    try {
      const meetingId = await scheduledMeeting(t);
      let clock = new Date("2026-06-01T11:10:00+08:00");
      await authorize(t, HOST, "ou_host", "测试乙", clock);
      const api = fakeMinutesApi();
      api.listEmpty = true;
      const minutes = createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: recordingOutcome(), secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api }, now: () => clock });
      await minutes.tick();
      // 等待起点记在会开完时（库里的 now() 是真实时刻，这里按测试时钟写回）。
      await t.pool.query("UPDATE meetings SET minutes_waiting_since = $2 WHERE id = $1", [meetingId, clock]);
      const ceo = await t.loginCookie();
      const payload = async () => (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0].payload;
      expect(await payload()).toMatchObject({ minutesStatus: "waiting", minutesWaitingSince: clock.toISOString(), minutesManualImport: false });

      clock = new Date("2026-06-01T13:05:00+08:00");
      await minutes.tick();
      expect((await getMeetingRow(t.pool.query.bind(t.pool), meetingId))?.minutes_status).toBe("waiting");
      clock = new Date("2026-06-01T13:11:00+08:00");
      await minutes.tick();
      const given = await t.pool.query("SELECT minutes_status, minutes_error FROM meetings WHERE id = $1", [meetingId]);
      expect(given.rows[0]).toEqual({ minutes_status: "manual", minutes_error: "等了 2 小时还没拿到妙记" });
      expect(await payload()).toMatchObject({ minutesStatus: "manual", minutesManualImport: true });
    } finally {
      await t.close();
    }
  });
});

describe("用户自己上传了，自动同步就停下", () => {
  it("等妙记时上传了候选：轮询和「妙记生成」事件都不再处理这场会，候选不被覆盖", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: recordingOutcome() });
    try {
      const meetingId = await scheduledMeeting(t);
      const clock = new Date("2026-06-01T11:10:00+08:00");
      await authorize(t, HOST, "ou_host", "测试乙", clock);
      const api = fakeMinutesApi();
      api.listEmpty = true;
      const minutes = createMeetingMinutesService({ pool: t.pool, peopleDirectory: loadPeopleDirectory(t.env), outcomeAgent: recordingOutcome(), secret: t.env.sessionSecret,
        feishu: { env: feishuEnv, api }, now: () => clock });
      await minutes.tick();
      expect((await getMeetingRow(t.pool.query.bind(t.pool), meetingId))?.minutes_status).toBe("waiting");

      await uploadMarkdown(t, meetingId);
      api.listEmpty = false;
      api.calls.length = 0;
      await minutes.tick();
      await minutes.onMinuteGenerated({ event_id: "ev1", minute_token: "obcn_minute_1" });
      await minutes.onMinuteGenerated({ event_id: "ev2", minute_token: "obcn_minute_1", minute_source: { source_type: "meeting", source_entity_id: "vc_1" } });
      expect(api.calls.filter((call) => call.startsWith("artifacts:") || call.startsWith("export:"))).toEqual([]);
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row).toMatchObject({ status: "scheduled", minute_token: null, transcript: null });
      expect(row.transcript_candidate?.source.format).toBe("miaoji_markdown");
    } finally {
      await t.close();
    }
  });

  it("自动拉取读妙记的过程中用户上传了：不覆盖用户的候选", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: recordingOutcome() });
    try {
      const meetingId = await scheduledMeeting(t);
      await authorize(t, HOST, "ou_host", "测试乙", new Date());
      const api = fakeMinutesApi();
      api.onRead = async () => { await uploadMarkdown(t, meetingId); };
      await tickAfterMeeting(t, api);
      const row = (await getMeetingRow(t.pool.query.bind(t.pool), meetingId))!;
      expect(row).toMatchObject({ status: "scheduled", transcript: null, minute_token: null });
      expect(row.transcript_candidate?.source.format).toBe("miaoji_markdown");
    } finally {
      await t.close();
    }
  });

  it("清掉自己上传的候选：开完不到 2 小时回到等妙记，超过 2 小时退回手动导入", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: recordingOutcome() });
    try {
      const ceo = await t.loginCookie();
      const discard = async (meetingId: string) => {
        const card = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0];
        const action = card.actions.find((a: { actionType: string }) => a.actionType === "meeting.discard_transcript_candidate");
        const done = await post(t, ceo, "/api/actions/execute", { actionId: action.actionId, input: {} });
        expect(done.statusCode).toBe(200);
        return (await t.pool.query("SELECT minutes_status, minutes_failure, minutes_waiting_since, COALESCE(ended_at, ends_at) AS ended FROM meetings WHERE id = $1", [meetingId])).rows[0];
      };
      // 刚开完 30 分钟：回到等妙记，等待起点按开完时刻算。
      const recent = await scheduledMeeting(t);
      await t.pool.query("UPDATE meetings SET scheduled_at = now() - interval '90 minutes', ends_at = now() - interval '30 minutes', minutes_status = 'waiting', minutes_waiting_since = NULL WHERE id = $1", [recent]);
      await uploadMarkdown(t, recent);
      await t.pool.query("UPDATE meetings SET minutes_status = 'ready' WHERE id = $1", [recent]);
      const back = await discard(recent);
      expect(back).toMatchObject({ minutes_status: "waiting", minutes_failure: null });
      expect(back.minutes_waiting_since).toEqual(back.ended);
      // 开完早就超过 2 小时：退回手动导入。
      const old = await scheduledMeeting(t);
      await uploadMarkdown(t, old);
      expect(await discard(old)).toMatchObject({ minutes_status: "manual" });
      expect((await t.app.inject({ method: "GET", url: `/api/cards/meetings/${old}`, headers: { cookie: ceo } })).json().cards[0].payload.minutesManualImport).toBe(true);
    } finally {
      await t.close();
    }
  });
});

// 10/21 对真飞书：search 条件在 filter 里、每页最多 30，结果只有 token 和展示文字；开始时刻、所有者、来源会议逐条查详情补上。
describe("妙记搜索按真飞书的请求与返回", () => {
  it("按本人和时间段搜，再逐条查详情；来源会议取 generated_source", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const json = (data: unknown) => new Response(JSON.stringify({ code: 0, msg: "success", data }), { headers: { "content-type": "application/json" } });
    const fetchFake = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/minutes/search")) {
        return url.includes("page_token=p2")
          ? json({ has_more: false, items: [{ token: "obcn_b", display_info: "周会", meta_data: { app_link: "https://x/minutes/obcn_b" } }] })
          : json({ has_more: true, page_token: "p2", items: [{ token: "obcn_a", display_info: "对话质量", meta_data: { app_link: "https://x/minutes/obcn_a" } }] });
      }
      const token = url.includes("obcn_a") ? "obcn_a" : "obcn_b";
      return json({ minute: { token, title: token === "obcn_a" ? "对话质量" : "周会", owner_id: "ou_host", create_time: token === "obcn_a" ? "1792380446082" : "1792390000000",
        duration: "3181000", url: `https://x/minutes/${token}`, generated_source: { source_entity_id: `vc_${token}`, source_type: "meeting" } } });
    }) as typeof fetch;
    const api = createFeishuMinutesApi({ fetch: fetchFake });
    const start = new Date("2026-10-19T02:00:00.000Z");
    const end = new Date("2026-10-19T06:00:00.000Z");
    const minutes = await api.listMinutes("u-token", { openId: "ou_host" }, { start, end });

    const searches = requests.filter((item) => item.url.includes("/minutes/search"));
    expect(searches).toHaveLength(2);
    expect(searches[0].url).toContain("page_size=30");
    expect(searches[0].body).toEqual({ filter: { owner_ids: ["ou_host"], create_time: { start_time: start.toISOString(), end_time: end.toISOString() } } });
    expect(searches[1].url).toContain("page_token=p2");
    expect(minutes.map(({ token, ownerOpenId, meetingId, durationSeconds }) => ({ token, ownerOpenId, meetingId, durationSeconds }))).toEqual([
      { token: "obcn_a", ownerOpenId: "ou_host", meetingId: "vc_obcn_a", durationSeconds: 3181 },
      { token: "obcn_b", ownerOpenId: "ou_host", meetingId: "vc_obcn_b", durationSeconds: 3181 },
    ]);
    expect(minutes[0].createdAt?.toISOString()).toBe(new Date(1792380446082).toISOString());
  });
});
