import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TestApp } from "./helpers.js";
import { emptyDraft, emptyPreflight } from "../src/meetingStore.js";
import type { FeishuMinuteInfo, FeishuMinutesApi } from "../src/feishu/minutes.js";
import { authorize, CEO, connect, HOST, inboxApp, loginAs, OWNER } from "./feishuMinutesFixtures.js";

// 飞书里直接开的会待整理：扫描登记、妙记生成事件、列表与忽略（只认本人）。
const MINUTE_MS = 60_000;

function minute(token: string, options: { sourceType?: string | null; meetingId?: string | null; ownerOpenId?: string | null; createdAt?: Date } = {}): FeishuMinuteInfo {
  return {
    token, title: `会 ${token}`, ownerOpenId: options.ownerOpenId === undefined ? "ou_owner" : options.ownerOpenId,
    createdAt: options.createdAt ?? new Date(Date.now() - 30 * MINUTE_MS), durationSeconds: 4200, url: null,
    meetingId: options.meetingId === undefined ? `vc_${token}` : options.meetingId, sourceType: options.sourceType === undefined ? "meeting" : options.sourceType,
  };
}

/** 假妙记接口：列出全部未在 skip 里的妙记（不按所有者、不按时间），让服务自己的判断被测到。 */
function fakeApi(minutes: FeishuMinuteInfo[] = []) {
  const api = {
    calls: [] as string[],
    minutes,
    participants: async (_meetingId: string): Promise<string[]> => [],
    async getMinute(): Promise<never> { throw new Error("不该调用"); },
    async artifactTranscript(): Promise<never> { throw new Error("不该调用"); },
    async exportTranscript(): Promise<never> { throw new Error("不该调用"); },
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

async function insertRow(t: TestApp, token: string, options: { owner?: string; startsAt?: Date; status?: string; meetingId?: string | null } = {}) {
  const startsAt = options.startsAt ?? new Date(Date.now() - 60 * MINUTE_MS);
  await t.sql(`INSERT INTO feishu_minute_inbox (minute_token, owner_id, title, starts_at, ends_at, feishu_meeting_id, status, meeting_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [token, options.owner ?? OWNER, `会 ${token}`, startsAt, new Date(startsAt.getTime() + 70 * MINUTE_MS), `vc_${token}`, options.status ?? "pending", options.meetingId ?? null]);
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
