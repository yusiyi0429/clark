import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { createFeishuCalendarApi, type FeishuCalendarApi, type FeishuCalendarEventInput, type FeishuCalendarInstance } from "../src/feishu/calendar.js";
import { FeishuApiError } from "../src/feishu/client.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import { createJobWorker } from "../src/jobs.js";
import { meetingFeishuEventJobs } from "../src/meetingFeishuEvent.js";

// 天枢约会时自动在飞书约上：建会排任务、用建会的人的授权建日程（视频会议、自动录制、邀请参会人），改时间、取消、等连飞书、失败重试。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = TEST_CEO.personId; // 测试甲：建会的人，也就是组织者
const HOST = TEST_MEMBER.personId; // 测试乙
const OWNER = "person-fixture-003"; // 测试丙：没有飞书身份
const feishu = { appId: "cli_test", appSecret: "test-secret", tokenKey: randomBytes(32), tokenKeyVersion: 1 };
const CALENDAR_SCOPE = "offline_access calendar:calendar:readonly calendar:calendar.event:create calendar:calendar.event:update calendar:calendar.event:delete";
const START = "2030-06-01T10:00:00.000+08:00";

const preflightAgent: PreflightAgent = { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };

function fakeCalendar(): FeishuCalendarApi & { calls: unknown[][]; createError: Error | null; instances: FeishuCalendarInstance[]; listError: Error | null } {
  const api = {
    calls: [] as unknown[][],
    createError: null as Error | null,
    instances: [] as FeishuCalendarInstance[],
    listError: null as Error | null,
    async primaryCalendarId(token: string) { api.calls.push(["primary", token]); return "cal_ceo"; },
    async createEvent(token: string, calendarId: string, input: FeishuCalendarEventInput, key: string) {
      api.calls.push(["create", token, calendarId, input, key]);
      if (api.createError) throw api.createError;
      return { eventId: "evt_1", joinUrl: "https://vc.feishu.cn/j/123456789" };
    },
    async addAttendees(token: string, calendarId: string, eventId: string, openIds: string[]) { api.calls.push(["attendees", token, calendarId, eventId, openIds]); },
    async updateEvent(token: string, calendarId: string, eventId: string, input: FeishuCalendarEventInput) { api.calls.push(["update", token, calendarId, eventId, input]); },
    async deleteEvent(token: string, calendarId: string, eventId: string) { api.calls.push(["delete", token, calendarId, eventId]); },
    async listInstances(token: string, calendarId: string, from: Date, to: Date) {
      api.calls.push(["list", token, calendarId, to.getTime() - from.getTime()]);
      if (api.listError) throw api.listError;
      return api.instances;
    },
  };
  return api;
}

async function app(calendar: FeishuCalendarApi): Promise<TestApp> {
  return createTestApp({ companyPeopleSeed: PEOPLE_SEED, feishu }, undefined, { preflightAgent, meetingFollowThroughAgents: { calendarApi: calendar } });
}

async function authorize(t: TestApp, personId: string, openId: string, scope = CALENDAR_SCOPE) {
  await t.pool.query("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1, $2) ON CONFLICT (person_id) DO NOTHING", [personId, openId]);
  await saveAuthorizedToken(t.pool.query.bind(t.pool), feishu, personId, { accessToken: `u-${personId}`, expiresIn: 7200, scope }, new Date());
}

type ActionCard = { objectRef: { id: string }; version: number; payload: Record<string, unknown>; actions: { actionType: string; actionId: string }[] };

async function execute(t: TestApp, card: ActionCard, actionType: string, input: unknown = {}) {
  const action = card.actions.find((a) => a.actionType === actionType)!;
  const done = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: await t.loginCookie(), origin: t.publicOrigin },
    payload: { actionId: action.actionId, input } });
  expect(done.statusCode).toBe(200);
  return done.json().cards[0] as ActionCard;
}

async function createMeeting(t: TestApp): Promise<ActionCard> {
  const issueCard = await t.createIssue() as unknown as ActionCard;
  return execute(t, issueCard, "issue.create_meeting",
    { title: "接口切换会", scheduledAt: START, leadDriId: HOST, ceoParticipantId: CEO, participants: [HOST, OWNER], issueIds: [issueCard.objectRef.id] });
}

const card = async (t: TestApp, id: string) =>
  (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${id}`, headers: { cookie: await t.loginCookie() } })).json().cards[0] as ActionCard;
const row = async (t: TestApp, id: string) =>
  (await t.sql("SELECT feishu_event_status, feishu_calendar_id, feishu_event_id, feishu_event_join_url, feishu_event_organizer_id, feishu_event_error FROM meetings WHERE id = $1", [id]))[0];
// 入队的 run_at 取数据库 now()，执行器领任务用 Node 时钟；两边差一两毫秒时刚排上的任务会被当成没到点跳过，执行器时钟拨快 1 秒。
const runJobs = (t: TestApp) => createJobWorker({ pool: t.pool, handlers: meetingFeishuEventJobs(t.app.meetingFollowThrough.feishuEvents), now: () => new Date(Date.now() + 1000) }).tick();

describe("飞书日历接口的请求", () => {
  it("主日历、建日程（视频会议、自动录制、时间带时区）、加参会人、改时间、删除", async () => {
    const requests: { method: string; url: string; auth: string; body: unknown }[] = [];
    const reply = (data: unknown) => new Response(JSON.stringify({ code: 0, msg: "success", data }), { headers: { "content-type": "application/json" } });
    const fetchFake = (async (url: string, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", url, auth: (init?.headers as Record<string, string>).authorization, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/calendars/primary")) return reply({ calendars: [{ calendar: { calendar_id: "feishu.cn_abc@group.calendar.feishu.cn" }, user_id: "ou_ceo" }] });
      if (url.includes("/events?")) return reply({ event: { event_id: "evt_9_0", app_link: "https://applink.feishu.cn/client/calendar/event/detail?x=1", vchat: { vc_type: "vc", meeting_url: "https://vc.feishu.cn/j/987654321" } } });
      return reply({});
    }) as typeof fetch;
    const api = createFeishuCalendarApi({ fetch: fetchFake });
    const input = { summary: "接口切换会", start: new Date("2030-06-01T02:00:00Z"), end: new Date("2030-06-01T03:00:00Z") };

    const calendarId = await api.primaryCalendarId("u-1");
    expect(calendarId).toBe("feishu.cn_abc@group.calendar.feishu.cn");
    expect(await api.createEvent("u-1", calendarId, input, "meeting-uuid")).toEqual({ eventId: "evt_9_0", joinUrl: "https://vc.feishu.cn/j/987654321" });
    await api.addAttendees("u-1", calendarId, "evt_9_0", ["ou_a", "ou_b"]);
    await api.updateEvent("u-1", calendarId, "evt_9_0", { ...input, start: new Date("2030-06-02T02:00:00Z"), end: new Date("2030-06-02T03:30:00Z") });
    await api.deleteEvent("u-1", calendarId, "evt_9_0");

    const base = "https://open.feishu.cn/open-apis/calendar/v4/calendars";
    const cal = encodeURIComponent("feishu.cn_abc@group.calendar.feishu.cn");
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${base}/primary`,
      `POST ${base}/${cal}/events?idempotency_key=meeting-uuid`,
      `POST ${base}/${cal}/events/evt_9_0/attendees?user_id_type=open_id`,
      `PATCH ${base}/${cal}/events/evt_9_0`,
      `DELETE ${base}/${cal}/events/evt_9_0?need_notification=true`,
    ]);
    expect(requests.every((request) => request.auth === "Bearer u-1")).toBe(true);
    expect(requests[1].body).toEqual({
      summary: "接口切换会",
      start_time: { timestamp: "1906509600", timezone: "Asia/Shanghai" },
      end_time: { timestamp: "1906513200", timezone: "Asia/Shanghai" },
      vchat: { vc_type: "vc", meeting_settings: { auto_record: true } },
    });
    expect(requests[2].body).toEqual({ attendees: [{ type: "user", user_id: "ou_a" }, { type: "user", user_id: "ou_b" }], need_notification: true });
    expect(requests[3].body).toEqual({
      summary: "接口切换会",
      start_time: { timestamp: "1906596000", timezone: "Asia/Shanghai" },
      end_time: { timestamp: "1906601400", timezone: "Asia/Shanghai" },
      need_notification: true,
    });
  });

  it("飞书报错带上错误码；只有日程链接时不给入会地址", async () => {
    const api = createFeishuCalendarApi({ fetch: (async (url: string) => new Response(JSON.stringify(url.includes("/events?")
      ? { code: 0, data: { event: { event_id: "evt_2_0", app_link: "https://applink.feishu.cn/client/calendar/event/detail?x=2", vchat: { vc_type: "vc" } } } }
      : { code: 99991679, msg: "Unauthorized" }))) as typeof fetch });
    await expect(api.primaryCalendarId("u-1")).rejects.toMatchObject({ code: 99991679 });
    expect(await api.createEvent("u-1", "cal", { summary: "x", start: new Date(), end: new Date() }, "k"))
      .toEqual({ eventId: "evt_2_0", joinUrl: null });
  });

  it("读日程视图：按秒传起止，取主题、起止、状态、本人回复和打开日程的链接", async () => {
    const urls: string[] = [];
    const api = createFeishuCalendarApi({ fetch: (async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify({ code: 0, data: { items: [
        { event_id: "evt_5_0", summary: "M2 本月复盘模拟", start_time: { timestamp: "1793237400", timezone: "Asia/Shanghai" }, end_time: { timestamp: "1793241000" },
          status: "confirmed", self_rsvp_status: "accept", app_link: "https://applink.feishu.cn/client/calendar/event/detail?x=5", vchat: { meeting_url: "https://vc.feishu.cn/j/1" } },
        { summary: "没有 id 的不要" },
      ] } }));
    }) as typeof fetch });
    const items = await api.listInstances("u-1", "cal@x", new Date("2026-10-28T15:00:00Z"), new Date("2026-11-04T15:00:00Z"));
    expect(urls).toEqual(["GET https://open.feishu.cn/open-apis/calendar/v4/calendars/cal%40x/events/instance_view?start_time=1793199600&end_time=1793804400"]);
    expect(items).toEqual([{ eventId: "evt_5_0", summary: "M2 本月复盘模拟", start: { timestamp: "1793237400", timezone: "Asia/Shanghai" }, end: { timestamp: "1793241000" },
      status: "confirmed", selfRsvpStatus: "accept", appLink: "https://applink.feishu.cn/client/calendar/event/detail?x=5" }]);
  });
});

describe("建会后在飞书约上", () => {
  it("建会排任务，用建会的人的授权建日程、邀请有飞书身份的参会人；改时间更新日程，取消删除日程", async () => {
    const calendar = fakeCalendar();
    const t = await app(calendar);
    try {
      await authorize(t, CEO, "ou_ceo");
      await t.pool.query("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1, 'ou_host')", [HOST]);
      const created = await createMeeting(t);
      const meetingId = created.objectRef.id;
      expect(await row(t, meetingId)).toMatchObject({ feishu_event_status: "pending", feishu_event_organizer_id: CEO, feishu_event_id: null });
      expect((await t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.feishu_event'"))[0].n).toBe(1);

      await runJobs(t);
      expect(calendar.calls).toEqual([
        ["primary", `u-${CEO}`],
        ["create", `u-${CEO}`, "cal_ceo", { summary: "接口切换会", start: new Date(START), end: new Date(Date.parse(START) + 60 * 60_000) }, meetingId],
        // 组织者本人不重复加；测试丙没有飞书身份，跳过。
        ["attendees", `u-${CEO}`, "cal_ceo", "evt_1", ["ou_host"]],
      ]);
      expect(await row(t, meetingId)).toEqual({ feishu_event_status: "booked", feishu_calendar_id: "cal_ceo", feishu_event_id: "evt_1",
        feishu_event_join_url: "https://vc.feishu.cn/j/123456789", feishu_event_organizer_id: CEO, feishu_event_error: null });
      let current = await card(t, meetingId);
      expect(current.payload.feishuEvent).toEqual({ status: "booked", joinUrl: "https://vc.feishu.cn/j/123456789", organizerId: CEO });
      expect(current.actions.some((a) => a.actionType === "meeting.retry_feishu_booking")).toBe(false);
      // 主持人（成员）看自己的会也有入会链接。
      const member = await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${meetingId}`, headers: { cookie: await t.memberCookie() } });
      expect(member.json().payload.feishuEvent).toMatchObject({ joinUrl: "https://vc.feishu.cn/j/123456789" });

      calendar.calls.length = 0;
      current = await execute(t, current, "meeting.reschedule", { scheduledAt: "2030-06-02T14:00:00.000+08:00", endsAt: "2030-06-02T15:30:00.000+08:00" });
      await runJobs(t);
      expect(calendar.calls).toEqual([["update", `u-${CEO}`, "cal_ceo", "evt_1",
        { summary: "接口切换会", start: new Date("2030-06-02T14:00:00.000+08:00"), end: new Date("2030-06-02T15:30:00.000+08:00") }]]);

      calendar.calls.length = 0;
      await execute(t, current, "meeting.cancel");
      await runJobs(t);
      expect(calendar.calls).toEqual([["delete", `u-${CEO}`, "cal_ceo", "evt_1"]]);
      expect((await row(t, meetingId)).feishu_event_status).toBe("cancelled");
    } finally {
      await t.close();
    }
  });

  it("建会的人没连飞书（或授权里没有日历权限）：会照常建，记等连飞书；连上后补约", async () => {
    const calendar = fakeCalendar();
    const t = await app(calendar);
    try {
      const meetingId = (await createMeeting(t)).objectRef.id;
      await runJobs(t);
      expect(calendar.calls).toEqual([]);
      expect((await row(t, meetingId)).feishu_event_status).toBe("waiting_auth");
      expect((await card(t, meetingId)).payload.feishuEvent).toEqual({ status: "waiting_auth", joinUrl: null, organizerId: CEO });

      // 连过飞书，但是在加日历权限之前授权的：还是等他重新连。
      await authorize(t, CEO, "ou_ceo", "offline_access minutes:minutes:readonly");
      await t.app.meetingFollowThrough.feishuEvents.resumeFor(CEO);
      await runJobs(t);
      expect(calendar.calls).toEqual([]);
      expect((await row(t, meetingId)).feishu_event_status).toBe("waiting_auth");

      // 即时开会已经进入预约时段，授权完成后仍要给原场次补上真正的入会地址。
      await t.sql("UPDATE meetings SET scheduled_at=now()-interval '2 minutes',ends_at=now()+interval '45 minutes' WHERE id=$1",[meetingId]);
      await authorize(t, CEO, "ou_ceo");
      expect(await t.app.meetingFollowThrough.feishuEvents.resumeFor(CEO)).toBe(1);
      expect((await row(t, meetingId)).feishu_event_status).toBe("pending");
      await runJobs(t);
      expect(calendar.calls.map((call) => call[0])).toEqual(["primary", "create"]);
      expect((await row(t, meetingId)).feishu_event_status).toBe("booked");
      // 别人连飞书不动这场会。
      expect(await t.app.meetingFollowThrough.feishuEvents.resumeFor(HOST)).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("飞书报错：记失败和原因，队列照常退避；「重试」再约一次", async () => {
    const calendar = fakeCalendar();
    calendar.createError = new FeishuApiError(190002, "invalid parameters in request");
    const t = await app(calendar);
    try {
      await authorize(t, CEO, "ou_ceo");
      const meetingId = (await createMeeting(t)).objectRef.id;
      await runJobs(t);
      expect(await row(t, meetingId)).toMatchObject({ feishu_event_status: "failed", feishu_event_error: "invalid parameters in request", feishu_event_id: null });
      const [job] = await t.sql("SELECT status, attempts, run_at > now() AS later FROM jobs WHERE kind = 'meeting.feishu_event'");
      expect(job).toEqual({ status: "pending", attempts: 1, later: true });
      const failed = await card(t, meetingId);
      expect(failed.payload.feishuEvent).toMatchObject({ status: "failed" });

      calendar.createError = null;
      calendar.calls.length = 0;
      const retried = await execute(t, failed, "meeting.retry_feishu_booking");
      expect(retried.payload.feishuEvent).toMatchObject({ status: "pending" });
      expect(retried.actions.some((a) => a.actionType === "meeting.retry_feishu_booking")).toBe(false);
      await runJobs(t);
      expect(calendar.calls.map((call) => call[0])).toEqual(["primary", "create"]);
      expect(await row(t, meetingId)).toMatchObject({ feishu_event_status: "booked", feishu_event_error: null, feishu_event_id: "evt_1" });
    } finally {
      await t.close();
    }
  });
});

describe("飞书日程只读显示在会议安排里", () => {
  const seconds = (ms: number) => String(Math.floor(ms / 1000));
  const instance = (eventId: string, summary: string, startMs: number, endMs: number, extra: Partial<FeishuCalendarInstance> = {}): FeishuCalendarInstance =>
    ({ eventId, summary, start: { timestamp: seconds(startMs) }, end: { timestamp: seconds(endMs) }, status: "confirmed", selfRsvpStatus: "accept",
      appLink: `https://applink.feishu.cn/client/calendar/event/detail?id=${eventId}`, ...extra });
  const list = async (t: TestApp) => {
    const response = await t.app.inject({ method: "GET", url: "/api/me/feishu-events", headers: { cookie: await t.loginCookie() } });
    expect(response.statusCode).toBe(200);
    return response.json().events as { eventId: string; title: string; startsAt: string; endsAt: string; allDay: boolean; url: string | null }[];
  };

  it("只列还没结束的、没取消没拒绝的，天枢约的会不重复列，全天日程按北京时间当天，按开始时间排；5 分钟内不再问飞书", async () => {
    const calendar = fakeCalendar();
    const t = await app(calendar);
    try {
      await authorize(t, CEO, "ou_ceo");
      const meeting = await createMeeting(t);
      await t.pool.query("UPDATE meetings SET feishu_event_id = 'evt_booked' WHERE id = $1", [meeting.objectRef.id]);
      const hour = 3_600_000;
      const now = Date.now();
      calendar.instances = [
        instance("evt_later_0", "下周的会", now + 30 * hour, now + 31 * hour),
        instance("evt_soon_0", "  M2 本月复盘模拟 ", now + 2 * hour, now + 3 * hour),
        instance("evt_booked_0", "天枢约的会", now + 4 * hour, now + 5 * hour),
        instance("evt_cancel_0", "取消了", now + 5 * hour, now + 6 * hour, { status: "cancelled" }),
        instance("evt_decline_0", "拒绝了", now + 6 * hour, now + 7 * hour, { selfRsvpStatus: "decline" }),
        instance("evt_ended_0", "开完了", now - 3 * hour, now - 2 * hour),
        { ...instance("evt_allday_0", "", 0, 0), start: { date: "2030-06-03" }, end: { date: "2030-06-04" }, appLink: null },
      ];
      const events = await list(t);
      expect(events.map((event) => event.eventId)).toEqual(["evt_soon_0", "evt_later_0", "evt_allday_0"]);
      expect(events[0]).toMatchObject({ title: "M2 本月复盘模拟", allDay: false, url: "https://applink.feishu.cn/client/calendar/event/detail?id=evt_soon_0" });
      expect(events[2]).toEqual({ eventId: "evt_allday_0", title: "无主题日程", startsAt: "2030-06-02T16:00:00.000Z", endsAt: "2030-06-03T16:00:00.000Z", allDay: true, url: null });
      expect(calendar.calls.filter((call) => call[0] === "list")).toEqual([["list", `u-${CEO}`, "cal_ceo", 7 * 24 * hour]]);

      await list(t);
      expect(calendar.calls.filter((call) => call[0] === "list" || call[0] === "primary")).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  it("没连飞书是空的、不问飞书；飞书报错也是空的，不影响页面", async () => {
    const calendar = fakeCalendar();
    const t = await app(calendar);
    try {
      expect(await list(t)).toEqual([]);
      expect(calendar.calls).toEqual([]);
      await authorize(t, TEST_MEMBER.personId, "ou_member");
      calendar.listError = new FeishuApiError(99991679, "Unauthorized");
      const response = await t.app.inject({ method: "GET", url: "/api/me/feishu-events", headers: { cookie: await t.memberCookie() } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ events: [] });
    } finally {
      await t.close();
    }
  });
});
