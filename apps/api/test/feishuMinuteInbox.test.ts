import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { preflightCandidate, TEST_MEMBER, type TestApp } from "./helpers.js";
import { emptyDraft, emptyPreflight } from "../src/meetingStore.js";
import { FeishuApiError } from "../src/feishu/client.js";
import type { FeishuMinuteInfo, FeishuMinutesApi } from "../src/feishu/minutes.js";
import { recoverInterruptedPreflight, resumePreflights, type PreflightAgent } from "../src/meetingPreflight.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { shanghaiDate } from "../src/workdays.js";
import { authorize, CEO, connect, HOST, inboxApp, loginAs, OWNER, TRANSCRIPT } from "./feishuMinutesFixtures.js";

// 飞书里直接开的会待整理：扫描登记、妙记生成事件、列表与忽略（只认本人）、整理成一场天枢会。
const MINUTE_MS = 60_000;

function minute(token: string, options: { sourceType?: string | null; meetingId?: string | null; ownerOpenId?: string | null; createdAt?: Date } = {}): FeishuMinuteInfo {
  return {
    token, title: `会 ${token}`, ownerOpenId: options.ownerOpenId === undefined ? "ou_owner" : options.ownerOpenId,
    createdAt: options.createdAt ?? new Date(Date.now() - 30 * MINUTE_MS), durationSeconds: 4200, url: null,
    meetingId: options.meetingId === undefined ? `vc_${token}` : options.meetingId, sourceType: options.sourceType === undefined ? "meeting" : options.sourceType,
  };
}

/** 假妙记接口：列出全部未在 skip 里的妙记（不按所有者、不按时间），让服务自己的判断被测到；读原文时有 readError 就抛它。 */
function fakeApi(minutes: FeishuMinuteInfo[] = []) {
  const api = {
    calls: [] as string[],
    minutes,
    readError: null as Error | null,
    participants: async (_meetingId: string): Promise<string[]> => [],
    async getMinute(token: string, minuteToken: string) {
      api.calls.push(`get:${token}:${minuteToken}`);
      const found = api.minutes.find((item) => item.token === minuteToken);
      if (!found) throw new FeishuApiError(2091002, "not found");
      return found;
    },
    async artifactTranscript(token: string, minuteToken: string) {
      api.calls.push(`artifacts:${token}:${minuteToken}`);
      if (api.readError) throw api.readError;
      return TRANSCRIPT;
    },
    async exportTranscript(token: string, minuteToken: string) {
      api.calls.push(`export:${token}:${minuteToken}`);
      if (api.readError) throw api.readError;
      return TRANSCRIPT;
    },
    async listMinutes(token: string, _owner: { openId: string }, _range: { start: Date; end: Date }, skip?: ReadonlySet<string>) {
      api.calls.push(`list:${token}`);
      return api.minutes.filter((item) => !skip?.has(item.token));
    },
    async meetingParticipants(token: string, meetingId: string) { api.calls.push(`participants:${token}:${meetingId}`); return api.participants(meetingId); },
  };
  return api satisfies FeishuMinutesApi;
}

const scan = (t: TestApp) => t.app.meetingFollowThrough.minuteInbox.scan();
const inboxTokens = async (t: TestApp) => (await t.sql("SELECT minute_token FROM feishu_minute_inbox ORDER BY minute_token")).map((row) => row.minute_token);
const list = (t: TestApp, cookie: string) => t.app.inject({ method: "GET", url: "/api/me/feishu-minutes", headers: { cookie } });
const ignore = (t: TestApp, cookie: string, token: string) =>
  t.app.inject({ method: "POST", url: `/api/me/feishu-minutes/${token}/ignore`, headers: { cookie, origin: t.publicOrigin } });

async function insertRow(t: TestApp, token: string,
  options: { owner?: string; startsAt?: Date; status?: string; meetingId?: string | null; feishuMeetingId?: string } = {}) {
  const startsAt = options.startsAt ?? new Date(Date.now() - 60 * MINUTE_MS);
  await t.sql(`INSERT INTO feishu_minute_inbox (minute_token, owner_id, title, starts_at, ends_at, feishu_meeting_id, status, meeting_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [token, options.owner ?? OWNER, `会 ${token}`, startsAt, new Date(startsAt.getTime() + 70 * MINUTE_MS), options.feishuMeetingId ?? `vc_${token}`,
    options.status ?? "pending", options.meetingId ?? null]);
}

async function insertMeeting(t: TestApp, minuteToken: string | null = null): Promise<string> {
  const id = randomUUID(), end = new Date(Date.now() - 60 * MINUTE_MS);
  await t.sql(`INSERT INTO meetings (id,version,title,status,scheduled_at,ends_at,lead_dri_id,ceo_participant_id,participants,issue_ids,preflight,draft,origin_ref,minute_token)
    VALUES ($1,1,'周会','scheduled',$2,$3,$4,$5,'[]','[]',$6::jsonb,$7::jsonb,'{}',$8)`,
  [id, new Date(end.getTime() - 60 * MINUTE_MS), end, HOST, CEO, JSON.stringify(emptyPreflight()), JSON.stringify(emptyDraft()), minuteToken]);
  return id;
}

describe("飞书妙记待整理：扫描登记", () => {
  it("只收视频会议生成的妙记", async () => {
    const api = fakeApi([
      minute("minutea", { sourceType: "meeting", meetingId: "vc_a" }),
      minute("minuteb", { sourceType: null, meetingId: "vc_b" }),
      minute("minutec", { sourceType: null, meetingId: null }),
      minute("minuted", { sourceType: "upload", meetingId: "x" }),
    ]);
    const t = await inboxApp(api);
    try {
      await connect(t, OWNER, "ou_owner", "测试丙");
      expect(await scan(t)).toBe(2);
      expect(await inboxTokens(t)).toEqual(["minutea", "minuteb"]);
      // 起止 = 妙记生成时刻与加上时长；所有者是本人。
      const [row] = await t.sql("SELECT owner_id, title, status, feishu_meeting_id, starts_at, ends_at FROM feishu_minute_inbox WHERE minute_token = 'minutea'");
      expect(row).toMatchObject({ owner_id: OWNER, title: "会 minutea", status: "pending", feishu_meeting_id: "vc_a" });
      expect((row.ends_at as Date).getTime() - (row.starts_at as Date).getTime()).toBe(4200 * 1000);
      // 再扫一次不重复登记，已登记的不再查。
      expect(await scan(t)).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("不回溯", async () => {
    const api = fakeApi([
      minute("minuteold", { createdAt: new Date(Date.now() - 120 * MINUTE_MS) }),
      minute("minutenew", { createdAt: new Date(Date.now() - 10 * MINUTE_MS) }),
    ]);
    const t = await inboxApp(api);
    try {
      await t.sql("UPDATE feishu_minute_inbox_launch SET launched_at = now() - interval '1 hour'");
      await connect(t, OWNER, "ou_owner", "测试丙");
      expect(await scan(t)).toBe(1);
      expect(await inboxTokens(t)).toEqual(["minutenew"]);
    } finally {
      await t.close();
    }
  });

  it("已挂在天枢会上的、不是本人名下的不登记", async () => {
    const api = fakeApi([minute("minutetaken"), minute("minuteother", { ownerOpenId: "ou_other" }), minute("minutemine")]);
    const t = await inboxApp(api);
    try {
      await insertMeeting(t, "minutetaken");
      await connect(t, OWNER, "ou_owner", "测试丙");
      expect(await scan(t)).toBe(1);
      expect(await inboxTokens(t)).toEqual(["minutemine"]);
    } finally {
      await t.close();
    }
  });

  it("没有妙记搜索权限不扫", async () => {
    const api = fakeApi([minute("minutea")]);
    const t = await inboxApp(api);
    try {
      await authorize(t, HOST, "ou_host", "测试乙", new Date());
      await connect(t, OWNER, "ou_owner", "测试丙");
      await scan(t);
      expect(api.calls).toContain("list:u-person-fixture-003");
      expect(api.calls).not.toContain("list:u-person-fixture-002");
    } finally {
      await t.close();
    }
  });

  it("参会人读不到时只有所有者", async () => {
    const api = fakeApi([
      minute("minutefail", { meetingId: "vc_fail", createdAt: new Date(Date.now() - 20 * MINUTE_MS) }),
      minute("minuteok", { meetingId: "vc_ok", createdAt: new Date(Date.now() - 40 * MINUTE_MS) }),
    ]);
    api.participants = async (meetingId) => {
      if (meetingId === "vc_fail") throw new Error("飞书读不到参会人");
      return ["ou_owner", "ou_host", "ou_guest"];
    };
    const t = await inboxApp(api);
    try {
      await authorize(t, HOST, "ou_host", "测试乙", new Date());
      await connect(t, OWNER, "ou_owner", "测试丙");
      expect(await scan(t)).toBe(2);
      const owner = await loginAs(t, OWNER, "ceshib", "8642");
      const response = await list(t, owner);
      expect(response.statusCode).toBe(200);
      const byToken = Object.fromEntries(response.json().minutes.map((item: { minuteToken: string }) => [item.minuteToken, item]));
      expect(byToken.minutefail).toMatchObject({ attendees: [{ personId: OWNER, displayName: "测试丙" }], otherAttendees: 0 });
      expect(byToken.minuteok).toMatchObject({
        attendees: [{ personId: OWNER, displayName: "测试丙" }, { personId: HOST, displayName: "测试乙" }], otherAttendees: 1 });
    } finally {
      await t.close();
    }
  });

  it("妙记生成事件排一次扫描", async () => {
    const t = await inboxApp(fakeApi());
    try {
      const jobs = t.app.meetingFollowThrough.jobs();
      const event = { event_id: "e1", minute_token: "minuteevt", minute_source: { source_type: "meeting", source_entity_id: "vc_evt" } };
      await jobs.feishuEvents["minutes.minute.generated_v1"](event);
      await jobs.feishuEvents["minutes.minute.generated_v1"]({ ...event, event_id: "e2" });
      await jobs.feishuEvents["minutes.minute.generated_v1"]({ event_id: "e3", minute_token: "minutenosource" });
      expect(await t.sql("SELECT kind, dedupe_key FROM jobs WHERE kind = 'meeting.minute_inbox_scan' ORDER BY dedupe_key")).toEqual([
        { kind: "meeting.minute_inbox_scan", dedupe_key: "meeting.minute_inbox_scan:event:minuteevt" },
      ]);
      expect(jobs.handlers["meeting.minute_inbox_scan"]).toBeTypeOf("function");
      expect(jobs.handlers["meeting.minute_inbox_ingest"]).toBeTypeOf("function");
      expect(jobs.recurring).toContainEqual({ kind: "meeting.minute_inbox_scan", everyMs: 300_000 });
    } finally {
      await t.close();
    }
  });
});

describe("飞书妙记待整理：列表与忽略", () => {
  it("列表", async () => {
    const t = await inboxApp(fakeApi());
    try {
      await insertRow(t, "minutenewer", { startsAt: new Date(Date.now() - 60 * MINUTE_MS) });
      await insertRow(t, "minuteolder", { startsAt: new Date(Date.now() - 3 * 24 * 60 * MINUTE_MS) });
      await insertRow(t, "minuteignored", { status: "ignored" });
      await insertRow(t, "minutestale", { startsAt: new Date(Date.now() - 8 * 24 * 60 * MINUTE_MS) });
      const owner = await loginAs(t, OWNER, "ceshib", "8642");
      const response = await list(t, owner);
      expect(response.statusCode).toBe(200);
      const minutes = response.json().minutes as { minuteToken: string; suggestion: unknown; title: string; startsAt: string; endsAt: string }[];
      expect(minutes.map((item) => item.minuteToken)).toEqual(["minutenewer", "minuteolder"]);
      expect(minutes.map((item) => item.suggestion)).toEqual([null, null]);
      expect(minutes[0]).toMatchObject({ title: "会 minutenewer" });
      expect(Date.parse(minutes[0].endsAt) - Date.parse(minutes[0].startsAt)).toBe(70 * MINUTE_MS);
    } finally {
      await t.close();
    }
  });

  it("只认本人", async () => {
    const t = await inboxApp(fakeApi());
    try {
      await insertRow(t, "minuteowner");
      const host = await t.memberCookie();
      expect((await list(t, host)).json().minutes).toEqual([]);
      const denied = await ignore(t, host, "minuteowner");
      expect(denied.statusCode).toBe(404);
      expect(denied.json().code).toBe("MINUTE_NOT_FOUND");
      expect(await t.sql("SELECT status FROM feishu_minute_inbox WHERE minute_token = 'minuteowner'")).toEqual([{ status: "pending" }]);
      expect((await ignore(t, host, "minutemissing")).statusCode).toBe(404);

      const owner = await loginAs(t, OWNER, "ceshib", "8642");
      expect((await ignore(t, owner, "minuteowner")).statusCode).toBe(204);
      expect((await list(t, owner)).json().minutes).toEqual([]);
      expect((await ignore(t, owner, "minuteowner")).statusCode).toBe(204);
      expect(await t.sql("SELECT status FROM feishu_minute_inbox WHERE minute_token = 'minuteowner'")).toEqual([{ status: "ignored" }]);

      // 已整理或已记到会上的不能忽略。
      await insertRow(t, "minuteattached", { status: "attached", meetingId: await insertMeeting(t) });
      const conflict = await ignore(t, owner, "minuteattached");
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("MINUTE_NOT_PENDING");
    } finally {
      await t.close();
    }
  });
});

describe("飞书妙记待整理：整理成一场天枢会", () => {
  const TOKEN = "minuteorg";
  const MISSION = "m-inbox";
  const body = (extra: Record<string, unknown> = {}) => ({ title: "改过的会名", anchors: [{ kind: "mission", id: MISSION }], ...extra });
  const organize = (t: TestApp, cookie: string, payload: Record<string, unknown> = body()) =>
    t.app.inject({ method: "POST", url: `/api/me/feishu-minutes/${TOKEN}/organize`, headers: { cookie, origin: t.publicOrigin }, payload });
  const ingestQueued = (t: TestApp) => t.app.meetingFollowThrough.minuteInbox.ingestQueued({ minuteToken: TOKEN });
  const inboxRow = async (t: TestApp) => (await t.sql("SELECT status, meeting_id FROM feishu_minute_inbox WHERE minute_token = $1", [TOKEN]))[0];
  const meetingCount = async (t: TestApp) => (await t.sql("SELECT count(*)::int AS count FROM meetings"))[0].count as number;
  const ingestJobs = (t: TestApp) => t.sql("SELECT kind, dedupe_key FROM jobs WHERE kind = 'meeting.minute_inbox_ingest'");

  /** OWNER（只有 participant 角色）连好飞书、扫描登记了一份待整理；挂点是妙记所在月的 Mission；预审用计数的假实现。 */
  async function setup() {
    const api = fakeApi([minute(TOKEN)]);
    api.participants = async () => ["ou_owner", "ou_host", "ou_guest"];
    const preflight = { meetingIds: [] as string[], async generate(input) { preflight.meetingIds.push(input.meeting.id); return { candidate: preflightCandidate([]) }; } } satisfies PreflightAgent & { meetingIds: string[] };
    const t = await inboxApp(api, { preflightAgent: preflight });
    const period = shanghaiDate(api.minutes[0].createdAt!).slice(0, 7);
    await t.pool.query("INSERT INTO capability_config (id, version, name, \"group\", six_month_outcome, code, owner_id) VALUES ('unit-inbox', 1, '待整理单元', 'test', '', '98', $1)", [TEST_MEMBER.personId]);
    await t.pool.query(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, source_ref, source_document_id, source_revision, source_title)
      VALUES ($1, 1, 'inbox-mission', $2, '待整理挂点 Mission', $3, 'unit-inbox', '跑通待整理', 'test://m', 'test', 1, '测试')`, [MISSION, period, TEST_MEMBER.personId]);
    await authorize(t, HOST, "ou_host", "测试乙", new Date());
    await connect(t, OWNER, "ou_owner", "测试丙");
    expect(await scan(t)).toBe(1);
    const owner = await loginAs(t, OWNER, "ceshib", "8642");
    return { t, api, preflight, owner };
  }

  it("整理：建一场已开完的会", async () => {
    const { t, api, preflight, owner } = await setup();
    try {
      const response = await organize(t, owner);
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json())).toEqual(["meetingId"]);
      const meetingId = response.json().meetingId as string;
      const [row] = await t.sql(`SELECT title, lead_dri_id, created_by, scheduled_at, ends_at, started_at, ended_at, status, minutes_status, minute_token,
        feishu_meeting_id, external_id, origin_ref, world_anchors, participants, preflight FROM meetings WHERE id = $1`, [meetingId]);
      expect(row).toMatchObject({ title: "改过的会名", lead_dri_id: OWNER, created_by: OWNER, status: "scheduled", minutes_status: "waiting",
        minute_token: TOKEN, feishu_meeting_id: `vc_${TOKEN}`, external_id: `feishu-minute:${TOKEN}`, world_anchors: [{ kind: "mission", id: MISSION }] });
      expect(row.origin_ref.type).toBe("feishu_minute");
      const start = api.minutes[0].createdAt!.getTime();
      expect([row.scheduled_at, row.started_at].map((at: Date) => at.getTime())).toEqual([start, start]);
      expect([row.ends_at, row.ended_at].map((at: Date) => at.getTime())).toEqual([start + 4200_000, start + 4200_000]);
      expect(row.participants.map((person: { personId: string }) => person.personId)).toEqual([CEO, OWNER, HOST]);
      // 不跑预审、不在飞书约会。
      expect(row.preflight.status).toBe("pending");
      expect(preflight.meetingIds).toEqual([]);
      expect(await t.sql("SELECT 1 FROM jobs WHERE kind = 'meeting.feishu_event'")).toEqual([]);
      expect(await inboxRow(t)).toEqual({ status: "organized", meeting_id: meetingId });
      expect(await ingestJobs(t)).toEqual([{ kind: "meeting.minute_inbox_ingest", dedupe_key: `meeting.minute_inbox_ingest:${TOKEN}` }]);
      expect((await list(t, owner)).json().minutes).toEqual([]);
      // 另一场会的主持人贴这份妙记链接：已经对到这场会上了。
      const other = await insertMeeting(t);
      const pasted = await t.app.inject({ method: "POST", url: `/api/meetings/${other}/minutes`, headers: { cookie: await t.memberCookie(), origin: t.publicOrigin },
        payload: { url: `https://example.feishu.cn/minutes/${TOKEN}` } });
      expect(pasted.statusCode).toBe(409);
      expect(pasted.json().code).toBe("MINUTE_TAKEN");
    } finally {
      await t.close();
    }
  });

  it("重启时的预审恢复和补跑不碰整理出来的会", async () => {
    const { t, preflight, owner } = await setup();
    try {
      const organized = (await organize(t, owner)).json().meetingId as string;
      const booked = await insertMeeting(t);
      // 两场会的预审都停在 pending 超过 15 分钟。
      await t.sql("UPDATE meetings SET preflight = jsonb_set(preflight, '{pendingSince}', to_jsonb((now() - interval '20 minutes')::text))");
      const before = (await t.sql("SELECT version, preflight FROM meetings WHERE id = $1", [organized]))[0];
      expect(await recoverInterruptedPreflight(t.pool.query.bind(t.pool))).toBe(1);
      expect((await t.sql("SELECT preflight FROM meetings WHERE id = $1", [booked]))[0].preflight).toMatchObject({ status: "failed", error: { code: "preflight_interrupted" } });
      expect(await resumePreflights(t.pool, loadPeopleDirectory(t.env), preflight)).toBe(1);
      expect(preflight.meetingIds).toEqual([booked]);
      expect((await t.sql("SELECT version, preflight FROM meetings WHERE id = $1", [organized]))[0]).toEqual(before);
      expect(before.preflight.status).toBe("pending");
    } finally {
      await t.close();
    }
  });

  it("读妙记只用所有者本人的授权，之后同一条链路", async () => {
    const { t, api, owner } = await setup();
    try {
      const meetingId = (await organize(t, owner)).json().meetingId as string;
      api.calls = [];
      await ingestQueued(t);
      expect(api.calls.length).toBeGreaterThan(0);
      for (const call of api.calls) expect(call).toContain("u-person-fixture-003");
      const [row] = await t.sql("SELECT status, minutes_status, transcript, outcome FROM meetings WHERE id = $1", [meetingId]);
      expect(row).toMatchObject({ status: "held", minutes_status: "ready" });
      expect(row.transcript.source.format).toBe("feishu_minutes");
      expect(row.outcome.status).toBe("ready");
      const cards = await t.app.inject({ method: "GET", url: "/api/me/meeting-cards", headers: { cookie: owner } });
      expect(cards.json().meetings).toEqual([expect.objectContaining({ meetingId, status: "pending" })]);
    } finally {
      await t.close();
    }
  });

  it("同一份妙记并发整理只成一场", async () => {
    const { t, owner } = await setup();
    try {
      const [first, second] = await Promise.all([organize(t, owner), organize(t, owner)]);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(second.json().meetingId).toBe(first.json().meetingId);
      expect(await t.sql("SELECT id FROM meetings WHERE external_id = $1", [`feishu-minute:${TOKEN}`])).toHaveLength(1);
      expect(await ingestJobs(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("原文还没好时整理", async () => {
    const { t, api, owner } = await setup();
    try {
      api.readError = new FeishuApiError(2091003, "not ready");
      const meetingId = (await organize(t, owner)).json().meetingId as string;
      await expect(ingestQueued(t)).rejects.toThrow("MINUTES_NOT_READY");
      expect(await t.sql("SELECT minutes_status, minutes_failure FROM meetings WHERE id = $1", [meetingId])).toEqual([{ minutes_status: "failed", minutes_failure: "not_ready" }]);
      api.readError = null;
      await ingestQueued(t);
      expect((await t.sql("SELECT minutes_status FROM meetings WHERE id = $1", [meetingId]))[0].minutes_status).toBe("ready");
    } finally {
      await t.close();
    }
  });

  it("整理时妙记已被挂走", async () => {
    const { t, owner } = await setup();
    try {
      const other = await insertMeeting(t);
      await t.sql("UPDATE meetings SET minute_token = $2 WHERE id = $1", [other, TOKEN]);
      const response = await organize(t, owner);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("MINUTE_TAKEN");
      expect(await meetingCount(t)).toBe(1);
      expect(await inboxRow(t)).toEqual({ status: "pending", meeting_id: null });
      expect(await ingestJobs(t)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("不能整理的", async () => {
    const { t, owner } = await setup();
    try {
      const expectRejected = async (response: Awaited<ReturnType<typeof organize>>, status: number, code: string, inboxStatus = "pending") => {
        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
        expect(await meetingCount(t)).toBe(0);
        expect((await inboxRow(t)).status).toBe(inboxStatus);
      };
      await expectRejected(await organize(t, await t.memberCookie()), 404, "MINUTE_NOT_FOUND");
      await expectRejected(await organize(t, owner, body({ anchors: [{ kind: "mission", id: "not-a-mission" }] })), 400, "ANCHOR_NOT_FOUND");
      const blank = await organize(t, owner, body({ title: "   " }));
      await expectRejected(blank, 400, "INVALID_INPUT");
      expect(blank.json().fieldErrors).toHaveProperty("title");
      expect((await ignore(t, owner, TOKEN)).statusCode).toBe(204);
      await expectRejected(await organize(t, owner), 409, "MINUTE_NOT_PENDING", "ignored");
      expect(await ingestJobs(t)).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

describe("飞书妙记待整理：记到天枢里约好的会", () => {
  const T = new Date(Date.now() - 3 * 60 * MINUTE_MS);
  const HOUR_MS = 60 * MINUTE_MS;
  const at = (offsetMs: number) => new Date(T.getTime() + offsetMs);
  const attach = (t: TestApp, cookie: string, token: string, meetingId: string) =>
    t.app.inject({ method: "POST", url: `/api/me/feishu-minutes/${token}/attach`, headers: { cookie, origin: t.publicOrigin }, payload: { meetingId } });
  const inboxRow = async (t: TestApp, token: string) => (await t.sql("SELECT status, meeting_id FROM feishu_minute_inbox WHERE minute_token = $1", [token]))[0];
  const meetingMinutes = async (t: TestApp, id: string) =>
    (await t.sql("SELECT minute_token, minutes_status, feishu_meeting_id FROM meetings WHERE id = $1", [id]))[0];

  /** HOST、OWNER 都连好飞书并登录；HOST 用 POST /api/meetings 预约（挂点用责任单元，不受月份影响）。 */
  async function setup(minutes: FeishuMinuteInfo[]) {
    const api = fakeApi(minutes);
    const preflight = { async generate() { return { candidate: preflightCandidate([]) }; } } satisfies PreflightAgent;
    const t = await inboxApp(api, { preflightAgent: preflight });
    await t.pool.query("INSERT INTO capability_config (id, version, name, \"group\", six_month_outcome, code, owner_id) VALUES ('unit-inbox', 1, '待整理单元', 'test', '', '98', $1)", [TEST_MEMBER.personId]);
    await authorize(t, HOST, "ou_host", "测试乙", new Date());
    await connect(t, OWNER, "ou_owner", "测试丙");
    const host = await t.memberCookie();
    const owner = await loginAs(t, OWNER, "ceshib", "8642");
    const book = async (startsAt: Date, title = "预约的会") => {
      const created = await t.app.inject({ method: "POST", url: "/api/meetings", headers: { cookie: host, origin: t.publicOrigin }, payload: {
        title, scheduledAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(), anchors: [{ kind: "unit", id: "unit-inbox" }] } });
      expect(created.statusCode).toBe(200);
      return created.json().card.objectRef.id as string;
    };
    return { t, api, host, owner, book };
  }

  it("会议号对上：别的参会人录制的也能记过去", async () => {
    const TOKEN = "minutelive";
    const { t, api, host, owner, book } = await setup([minute(TOKEN, { meetingId: "vc_live", createdAt: T })]);
    try {
      const meetingId = await book(at(-10 * MINUTE_MS));
      await t.sql("UPDATE meetings SET feishu_meeting_id = 'vc_live' WHERE id = $1", [meetingId]);
      await insertRow(t, TOKEN, { owner: OWNER, startsAt: T, feishuMeetingId: "vc_live" });
      expect((await list(t, owner)).json().minutes).toEqual([expect.objectContaining({ minuteToken: TOKEN, suggestion: { meetingId, title: "预约的会" } })]);

      const attached = await attach(t, owner, TOKEN, meetingId);
      expect(attached.statusCode).toBe(200);
      expect(attached.json()).toEqual({ meetingId });
      expect(await meetingMinutes(t, meetingId)).toEqual({ minute_token: TOKEN, minutes_status: "waiting", feishu_meeting_id: "vc_live" });
      expect(await inboxRow(t, TOKEN)).toEqual({ status: "attached", meeting_id: meetingId });
      expect(await t.sql("SELECT dedupe_key FROM jobs WHERE kind = 'meeting.minute_inbox_ingest'")).toEqual([{ dedupe_key: `meeting.minute_inbox_ingest:${TOKEN}` }]);
      // 再点一次：同一场会。
      expect((await attach(t, owner, TOKEN, meetingId)).json()).toEqual({ meetingId });

      api.calls = [];
      await t.app.meetingFollowThrough.minuteInbox.ingestQueued({ minuteToken: TOKEN });
      expect(api.calls.length).toBeGreaterThan(0);
      for (const call of api.calls) expect(call).toContain("u-person-fixture-003");
      expect((await meetingMinutes(t, meetingId)).minutes_status).toBe("ready");
      const cards = await t.app.inject({ method: "GET", url: "/api/me/meeting-cards", headers: { cookie: host } });
      expect(cards.json().meetings).toEqual([expect.objectContaining({ meetingId })]);
      expect((await list(t, owner)).json().minutes).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("会议号对不上：所有者主持或建的、3 小时内最近的一场", async () => {
    const TOKEN = "minutehost";
    const { t, host, book } = await setup([]);
    try {
      const chosen = await book(at(-HOUR_MS), "一小时前的会");
      await book(at(2 * HOUR_MS), "两小时后的会");
      const otherSource = await book(T, "别的飞书会");
      await t.sql("UPDATE meetings SET feishu_meeting_id = 'vc_other' WHERE id = $1", [otherSource]);
      const taken = await book(T, "已有妙记的会");
      await t.sql("UPDATE meetings SET minute_token = 'minuteelse' WHERE id = $1", [taken]);
      const notMine = await book(T, "别人主持的会");
      await t.sql("UPDATE meetings SET lead_dri_id = $2, created_by = $2 WHERE id = $1", [notMine, CEO]);
      await insertRow(t, TOKEN, { owner: HOST, startsAt: T, feishuMeetingId: "vc_none" });
      expect((await list(t, host)).json().minutes).toEqual([expect.objectContaining({ minuteToken: TOKEN, suggestion: { meetingId: chosen, title: "一小时前的会" } })]);
    } finally {
      await t.close();
    }
  });

  it("建议变了就不记", async () => {
    const TOKEN = "minutelive";
    const { t, host, owner, book } = await setup([minute(TOKEN, { meetingId: "vc_live", createdAt: T })]);
    try {
      const suggested = await book(at(-10 * MINUTE_MS));
      await t.sql("UPDATE meetings SET feishu_meeting_id = 'vc_live' WHERE id = $1", [suggested]);
      const other = await book(T, "另一场会");
      await insertRow(t, TOKEN, { owner: OWNER, startsAt: T, feishuMeetingId: "vc_live" });
      const unchanged = { minute_token: null, minutes_status: "none" };

      const changed = await attach(t, owner, TOKEN, other);
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe("SUGGESTION_CHANGED");
      expect(await meetingMinutes(t, other)).toMatchObject(unchanged);

      const denied = await attach(t, host, TOKEN, suggested);
      expect(denied.statusCode).toBe(404);
      expect(denied.json().code).toBe("MINUTE_NOT_FOUND");
      expect(await meetingMinutes(t, suggested)).toMatchObject(unchanged);
      expect(await inboxRow(t, TOKEN)).toEqual({ status: "pending", meeting_id: null });

      // 妙记已经对到别的会上（轮询刚挂走、待整理还没改）：不记。
      await t.sql("UPDATE meetings SET minute_token = $2 WHERE id = $1", [other, TOKEN]);
      const taken = await attach(t, owner, TOKEN, suggested);
      expect(taken.statusCode).toBe(409);
      expect(taken.json().code).toBe("MINUTE_TAKEN");
      expect(await meetingMinutes(t, suggested)).toMatchObject(unchanged);
      expect(await inboxRow(t, TOKEN)).toEqual({ status: "pending", meeting_id: null });
      expect(await t.sql("SELECT 1 FROM jobs WHERE kind = 'meeting.minute_inbox_ingest'")).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
