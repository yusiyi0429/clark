import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ConversationCard, type TConversationCard } from "@warmap/contracts";
import type { ConversationRuntime } from "../src/conversations.js";
import { DraftMeetingParams, draftMeeting, parseMeetingDate, parseMeetingTime, type DraftMeetingArgs } from "../src/meetingDraft.js";
import type { Query } from "../src/meetingStore.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

/**
 * 对话里约会议（meetingDraft.ts）：模型只起草，草稿整份在会议卡上，不写库；本人点「约好」才建会，同一张卡只建一场。
 * 公司时区北京时间；NOW 是北京时间 2026-10-26（周一）10:00。
 */
const NOW = new Date("2026-10-26T02:00:00Z");
const RENHAO = "person-fixture-004", SIYI = "person-fixture-005", JIANGUO_A = "person-fixture-006", JIANGUO_B = "person-fixture-007";
const PEOPLE = [
  { personId: TEST_CEO.personId, displayName: "刘明华" },
  { personId: TEST_MEMBER.personId, displayName: "孙铭泽" },
  { personId: RENHAO, displayName: "刘人豪" },
  { personId: SIYI, displayName: "于斯一" },
  { personId: JIANGUO_A, displayName: "张建国" },
  { personId: JIANGUO_B, displayName: "李建国" },
];
const day = (raw: string, now = NOW) => {
  const value = parseMeetingDate(raw, now);
  return value && `${value.y}-${String(value.m).padStart(2, "0")}-${String(value.d).padStart(2, "0")}`;
};
const args = (extra: Partial<DraftMeetingArgs> = {}): DraftMeetingArgs => ({ title: "新 Chat 切换", date: "明天", time: "下午三点", ...extra });

/** 只读的假库：记下每条 SQL，Mission 只有测试乙在 10 月的一张。 */
function recordingQuery() {
  const sql: string[] = [];
  const q: Query = async (text) => {
    sql.push(text);
    if (/FROM missions/.test(text)) return { rows: [{ id: "m-chat", title: "新 Chat 上线", outcome: "", owner_id: TEST_MEMBER.personId, world_status: null, world_goal_id: null, round_status: null }] } as never;
    return { rows: [] } as never;
  };
  return { q, sql };
}

describe("起草会议：参数和时间换算", () => {
  it("工具参数：名称、日期、时间必填，时长 5–600 分钟，不收多余字段", () => {
    expect(Value.Check(DraftMeetingParams, args({ durationMinutes: 30, participants: ["人豪", "斯一"] }))).toBe(true);
    expect(Value.Check(DraftMeetingParams, { title: "新 Chat 切换", date: "明天" })).toBe(false);
    expect(Value.Check(DraftMeetingParams, args({ durationMinutes: 0 }))).toBe(false);
    expect(Value.Check(DraftMeetingParams, args({ durationMinutes: 30.5 }))).toBe(false);
    expect(Value.Check(DraftMeetingParams, { ...args(), anchor: "m-chat" })).toBe(false);
    expect(Value.Check(DraftMeetingParams, args({ participants: Array.from({ length: 21 }, (_, i) => `人${i}`) }))).toBe(false);
  });

  it("相对日期按北京时间的今天算", () => {
    expect(day("今天")).toBe("2026-10-26");
    expect(day("明天")).toBe("2026-10-27");
    expect(day("后天")).toBe("2026-10-28");
    expect(day("大后天")).toBe("2026-10-29");
    expect(day("周三")).toBe("2026-10-28");
    expect(day("星期一")).toBe("2026-10-26");
    expect(day("周日")).toBe("2026-11-01");
    expect(day("下周三")).toBe("2026-11-04");
    expect(day("下个星期一")).toBe("2026-11-02");
    expect(day("这周五")).toBe("2026-10-30");
    expect(day("10月28日")).toBe("2026-10-28");
    expect(day("28号")).toBe("2026-10-28");
    expect(day("3号")).toBe("2026-11-03");
    expect(day("1月5日")).toBe("2027-01-05");
    expect(day("2026-11-02")).toBe("2026-11-02");
    expect(day("2026年11月2日")).toBe("2026-11-02");
    for (const raw of ["2月30日", "周末", "过两天", "下下周三"]) expect(day(raw)).toBeNull();
    // 北京时间已经过了零点（UTC 还是前一天）：明天是北京时间的明天。
    expect(day("明天", new Date("2026-10-26T17:00:00Z"))).toBe("2026-10-28");
    expect(day("周三", new Date("2026-10-27T16:30:00Z"))).toBe("2026-10-28");
  });

  it("时刻换成 24 小时制；没说上下午的 1–6 点按下午", () => {
    const at = (raw: string) => { const value = parseMeetingTime(raw); return value && `${value.hour}:${String(value.minute).padStart(2, "0")}`; };
    expect(at("下午三点")).toBe("15:00");
    expect(at("下午3点半")).toBe("15:30");
    expect(at("三点")).toBe("15:00");
    expect(at("三点十五")).toBe("15:15");
    expect(at("上午十点")).toBe("10:00");
    expect(at("上午10:30")).toBe("10:30");
    expect(at("晚上八点一刻")).toBe("20:15");
    expect(at("中午一点")).toBe("13:00");
    expect(at("十二点")).toBe("12:00");
    expect(at("九点")).toBe("9:00");
    expect(at("15:00")).toBe("15:00");
    expect(at("15：40")).toBe("15:40");
    expect(at("两点零五分")).toBe("14:05");
    for (const raw of ["下午", "25:00", "三点七十", "明天"]) expect(at(raw)).toBeNull();
  });
});

describe("起草会议：卡上的内容", () => {
  it("CEO：明天下午三点、默认半小时，人名按目录对上，没对上、重名的标出来，默认不挂，不读也不写库", async () => {
    const { q, sql } = recordingQuery();
    const result = await draftMeeting({ q, viewer: { personId: TEST_CEO.personId, role: "ceo" }, people: PEOPLE, now: NOW },
      args({ participants: ["人豪", "斯一", "王总", "建国", "我", "刘人豪"] }));
    if (!("card" in result)) throw new Error(result.reason);
    const card = result.card;
    expect(Value.Check(ConversationCard, card)).toBe(true);
    expect(card).toMatchObject({
      kind: "meeting_draft", title: "新 Chat 切换", scheduledAt: "2026-10-27T15:00:00+08:00", endsAt: "2026-10-27T15:30:00+08:00",
      host: { personId: TEST_CEO.personId, displayName: "刘明华" },
      participants: [{ personId: RENHAO, displayName: "刘人豪" }, { personId: SIYI, displayName: "于斯一" }],
      unresolved: [{ name: "王总", reason: "not_found" }, { name: "建国", reason: "ambiguous" }],
      anchor: null,
    });
    expect(new Date(card.scheduledAt).toISOString()).toBe("2026-10-27T07:00:00.000Z");
    expect(sql).toEqual([]);
  });

  it("CEO 指定主持人：对上就换主持人（主持人不再列进参会人），没对上主持人空着并标出来", async () => {
    const { q } = recordingQuery();
    const ceo = { q, viewer: { personId: TEST_CEO.personId, role: "ceo" as const }, people: PEOPLE, now: NOW };
    const hosted = await draftMeeting(ceo, args({ host: "人豪", participants: ["人豪", "斯一"], endTime: "四点" }));
    if (!("card" in hosted)) throw new Error(hosted.reason);
    expect(hosted.card).toMatchObject({ host: { personId: RENHAO }, participants: [{ personId: SIYI }], endsAt: "2026-10-27T16:00:00+08:00", unresolved: [] });
    const unknown = await draftMeeting(ceo, args({ host: "建国" }));
    if (!("card" in unknown)) throw new Error(unknown.reason);
    expect(unknown.card).toMatchObject({ host: null, unresolved: [{ name: "建国", reason: "ambiguous", host: true }] });
  });

  it("成员：主持人只能是本人，默认挂自己那个月的 Mission；只读", async () => {
    const { q, sql } = recordingQuery();
    const result = await draftMeeting({ q, viewer: { personId: TEST_MEMBER.personId, role: "member" }, people: PEOPLE, now: NOW },
      args({ host: "人豪", participants: ["斯一"], durationMinutes: 60 }));
    if (!("card" in result)) throw new Error(result.reason);
    expect(result.hostNote).toBeTruthy();
    expect(result.card).toMatchObject({ host: { personId: TEST_MEMBER.personId }, participants: [{ personId: SIYI }],
      endsAt: "2026-10-27T16:00:00+08:00", anchor: { kind: "mission", id: "m-chat", title: "新 Chat 上线" } });
    expect(sql.length).toBeGreaterThan(0);
    for (const text of sql) expect(text.trim()).toMatch(/^SELECT/i);
  });

  it("认不出、已经过去、结束不晚于开始：不出卡，给原因", async () => {
    const { q } = recordingQuery();
    const deps = { q, viewer: { personId: TEST_CEO.personId, role: "ceo" as const }, people: PEOPLE, now: NOW };
    expect(await draftMeeting(deps, args({ date: "过两天" }))).toEqual({ reason: "日期「过两天」认不出" });
    expect(await draftMeeting(deps, args({ time: "下午" }))).toEqual({ reason: "时间「下午」认不出" });
    expect(await draftMeeting(deps, args({ date: "今天", time: "上午九点" }))).toEqual({ reason: "10月26日（周一）09:00已经过去了" });
    expect(await draftMeeting(deps, args({ endTime: "下午两点" }))).toEqual({ reason: "结束时间要晚于开始时间" });
  });
});

describe("对话里约会议：起草不写库，约好只建一场，已约读得回", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "meeting-draft-test-"));
    const seed = join(dir, "people.json");
    await writeFile(seed, JSON.stringify({ schemaVersion: "company-people.v1", people: PEOPLE.map((person) => ({
      ...person, roles: person.personId === TEST_CEO.personId ? ["ceo", "dri", "participant"] : ["dri", "participant"] })) }));
    let draft: DraftMeetingArgs = args();
    const runtime: ConversationRuntime = { async run(input) {
      await input.entries!.draftMeeting(draft);
      input.emit({ type: "message", delta: "好" });
      return { assistantMessage: "好", runtimeEntries: input.runtimeEntries };
    } };
    const t: TestApp = await createTestApp({ companyPeopleSeed: seed }, runtime, { monthlyNow: () => NOW });
    cleanup = async () => { await t.close(); await rm(dir, { recursive: true, force: true }); };
    await t.pool.query("INSERT INTO capability_config (id, version, name, \"group\", six_month_outcome, code, owner_id) VALUES ('unit-chat', 1, '对话单元', 'test', '', '99', $1)", [TEST_MEMBER.personId]);
    await t.pool.query(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, source_ref, source_document_id, source_revision, source_title)
      VALUES ('m-chat', 1, 'chat-202610', '2026-10', '新 Chat 上线', $1, 'unit-chat', '切到新 Chat', 'test://m', 'test', 1, '测试')`, [TEST_MEMBER.personId]);
    const member = await t.memberCookie();
    const say = async (message: string, next: DraftMeetingArgs) => {
      draft = next;
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message } });
      expect(response.statusCode).toBe(200);
      const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: member } })).json();
      return (history.messages.at(-1) as { cards?: TConversationCard[] }).cards ?? [];
    };
    const book = (cookie: string, payload: Record<string, unknown>) =>
      t.app.inject({ method: "POST", url: "/api/meetings", headers: { cookie, origin: t.publicOrigin }, payload });
    const status = async (cookie: string, draftId: string) =>
      (await t.app.inject({ method: "GET", url: `/api/meeting-drafts/${draftId}`, headers: { cookie } })).json();
    return { t, member, say, book, status };
  }

  it("会议卡随回答存下；点「约好」多次（含同时两次）只建一场，刷新后读回已约", async () => {
    const { t, member, say, book, status } = await setup();
    const cards = await say("明天下午三点跟人豪、斯一约半小时，聊新 Chat 切换", args({ participants: ["人豪", "斯一"] }));
    expect(cards).toHaveLength(1);
    const card = cards[0] as Extract<TConversationCard, { kind: "meeting_draft" }>;
    expect(card).toMatchObject({ kind: "meeting_draft", scheduledAt: "2026-10-27T15:00:00+08:00", endsAt: "2026-10-27T15:30:00+08:00",
      host: { personId: TEST_MEMBER.personId }, participants: [{ personId: RENHAO }, { personId: SIYI }], anchor: { kind: "mission", id: "m-chat" } });
    // 起草不写库：没有会。
    expect(await t.sql("SELECT id FROM meetings")).toEqual([]);
    expect(await status(member, card.draftId)).toEqual({ meeting: null });

    const payload = { title: card.title, scheduledAt: card.scheduledAt, endsAt: card.endsAt, participants: card.participants.map((person) => person.personId),
      anchors: [{ kind: card.anchor!.kind, id: card.anchor!.id }], draftId: card.draftId };
    // 同时点两次：只建一场；撞上正在约的那次 409（不排队），没撞上的拿到同一场。之后再约也是同一场。
    const both = await Promise.all([book(member, payload), book(member, payload)]);
    for (const response of both) expect(response.statusCode === 200 || response.json().code === "MEETING_DRAFT_BUSY").toBe(true);
    const ids = new Set(both.filter((response) => response.statusCode === 200).map((response) => response.json().card.objectRef.id as string));
    expect(ids.size).toBe(1);
    const [meetingId] = [...ids];
    const again = await book(member, payload);
    expect(again.statusCode).toBe(200);
    expect(again.json().card.objectRef.id).toBe(meetingId);
    const rows = await t.sql("SELECT id, lead_dri_id, participants, world_anchors, origin_ref FROM meetings");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: meetingId, lead_dri_id: TEST_MEMBER.personId, world_anchors: [{ kind: "mission", id: "m-chat" }],
      origin_ref: { type: "booking", draftId: card.draftId } });
    expect((rows[0].participants as { personId: string }[]).map((person) => person.personId)).toEqual(expect.arrayContaining([RENHAO, SIYI]));

    expect(await status(member, card.draftId)).toEqual({ meeting: { id: meetingId, title: "新 Chat 切换", href: `/me/meetings/${meetingId}` } });
    // 别人拿同一个 draftId 读不到这场会。
    expect(await status(await t.loginCookie(), card.draftId)).toEqual({ meeting: null });
  });
});
