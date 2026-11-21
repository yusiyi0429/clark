import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TUsagePath, TUsageResponse } from "@warmap/contracts";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { ensureLastWeekReport, weekStartOf } from "../src/usage.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

/** 三人名单：测试甲（CEO，管理员）、乙（DRI）、丙（参与人）。 */
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const THIRD = "person-fixture-003";
/** 2026-10-19 是周一，北京时间 10:00：上一周是 10/12–10/18。 */
const NOW = new Date("2026-10-19T02:00:00.000Z");
const LAST_WEEK = "2026-10-12";
const at = (iso: string) => new Date(iso);

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function setup() {
  t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, adminPersonIds: [TEST_CEO.personId] }, undefined, { monthlyNow: () => NOW });
  return { t, admin: await t.loginCookie(), member: await t.memberCookie() };
}
const get = (cookie: string, url: string) => t!.app.inject({ method: "GET", url, headers: { cookie } });
const pathOf = (view: TUsageResponse, key: string) => view.report.paths.find((path) => path.key === key) as TUsagePath;
const units = (path: TUsagePath) => path.steps.map((step) => step.units);

/** 甲在首页问了 4 句：一句写完但下一句说「不对」，一句写完，一句超时后点了「重新回答」，一句停止；乙在对象页问了 1 句。 */
async function seedConversation(app: TestApp) {
  const conversation = randomUUID();
  await app.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, 'global', $3)", [conversation, TEST_CEO.personId, randomUUID()]);
  let sequence = 0;
  const turn = async (status: string, started: Date, options: { error?: string; next?: string; resumeOf?: string; scope?: string; viewer?: string; memory?: boolean } = {}) => {
    const id = randomUUID();
    await app.sql(`INSERT INTO agent_runs (id, kind, status, model_slot, prompt_hash, input_snapshot, error, started_at, completed_at)
      VALUES ($1, 'conversation', $2, 'light', 'h', $3::jsonb, $4, $5, $5)`, [id, status, JSON.stringify({
      scope: options.scope ?? "global", viewerId: options.viewer ?? TEST_CEO.personId, conversationId: conversation, message: "问题",
      ...(options.resumeOf ? { resumeOf: options.resumeOf } : {}),
    }), options.error ?? null, started]);
    await app.sql("INSERT INTO conversation_messages (conversation_id, sequence, role, content, run_id, created_at) VALUES ($1, $2, 'user', '机密正文', $3, $4)",
      [conversation, ++sequence, id, started]);
    if (status === "succeeded") {
      await app.sql("INSERT INTO conversation_messages (conversation_id, sequence, role, content, run_id, created_at, memory_used) VALUES ($1, $2, 'assistant', $3, $4, $5, $6::jsonb)",
        [conversation, ++sequence, options.memory ? "按你说的 [记忆](cite:pmem:m1)" : "回答", id, started, options.memory ? '["m1"]' : null]);
    }
    return id;
  };
  await turn("succeeded", at("2026-10-13T02:00:00Z"));
  // 下一句以「不对」开头：上一句算被否定。
  await turn("succeeded", at("2026-10-13T03:00:00Z"), { memory: true });
  const timedOut = await turn("failed", at("2026-10-14T02:00:00Z"), { error: "Conversation turn exceeded 600 seconds" });
  await app.sql("UPDATE conversation_messages SET content = '不对，你再看看' WHERE run_id = $1", [timedOut]);
  await turn("succeeded", at("2026-10-14T02:05:00Z"), { resumeOf: timedOut });
  await turn("aborted", at("2026-10-15T02:00:00Z"));
  await turn("succeeded", at("2026-10-16T02:00:00Z"), { scope: "task:abc", viewer: TEST_MEMBER.personId });
  // 上上周的一句：只进对比。
  await turn("succeeded", at("2026-10-06T02:00:00Z"));
}

async function seedEvents(app: TestApp) {
  const event = (person: string, kind: string, when: string, detail: string | null = null) => app.sql(
    `INSERT INTO usage_events (person_id, kind, detail, day, created_at) VALUES ($1, $2, $3, ($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date, $4)`,
    [person, kind, detail, at(when)]);
  await event(TEST_MEMBER.personId, "active", "2026-10-12T02:00:00Z");
  await event(TEST_MEMBER.personId, "active", "2026-10-17T02:00:00Z");
  // 丙第一次登录，上手走到雷达就停了；乙走完上手。
  await event(THIRD, "login", "2026-10-15T01:00:00Z");
  for (const step of ["hello", "tour-notifications", "tour-board", "radar"]) await event(THIRD, "onboarding_step", "2026-10-15T01:01:00Z", step);
  await event(TEST_MEMBER.personId, "login", "2026-10-12T01:00:00Z");
  for (const step of ["hello", "tour-board", "work", "connect", "review", "start"]) await event(TEST_MEMBER.personId, "onboarding_step", "2026-10-12T01:01:00Z", step);
  await app.sql("INSERT INTO person_onboarding (person_id, completed_at) VALUES ($1, $2) ON CONFLICT (person_id) DO UPDATE SET completed_at = $2",
    [TEST_MEMBER.personId, at("2026-10-12T01:10:00Z")]);
  // 个人记忆：乙在界面上改了一条，甲的一条被替代、一条被忘掉。
  await event(TEST_MEMBER.personId, "memory_edit", "2026-10-16T02:00:00Z");
  const replacement = randomUUID();
  await app.sql(`INSERT INTO personal_memory_items (id, person_id, title, text, status, superseded_by, updated_at) VALUES
    ($1, $3, '新', '新', 'active', NULL, $4), ($2, $3, '旧', '旧', 'superseded', $1, $4), (gen_random_uuid(), $3, '忘', '忘', 'forgotten', NULL, $4)`,
    [replacement, randomUUID(), TEST_CEO.personId, at("2026-10-16T03:00:00Z")]);
}

async function seedLedger(app: TestApp) {
  const run = (status: string, snapshot: unknown, started: Date) => app.sql(
    `INSERT INTO agent_runs (id, kind, status, model_slot, prompt_hash, input_snapshot, started_at, completed_at) VALUES ($1, 'preflight', $2, 'light', 'h', $3::jsonb, $4, $4)`,
    [randomUUID(), status, JSON.stringify(snapshot), started]);
  await run("succeeded", { viewerId: TEST_CEO.personId, qualitySignals: [{ kind: "tool_error", tool: "search_company", code: "TIMEOUT", at: "x" }] }, at("2026-10-13T05:00:00Z"));
  await run("succeeded", { viewerId: TEST_MEMBER.personId, qualitySignals: [{ kind: "tool_error", tool: "search_company", code: "TIMEOUT", at: "x" },
    { signal: "memory_mark_unknown_id", ids: ["x"] }] }, at("2026-10-14T05:00:00Z"));
  await app.sql(`INSERT INTO impact_cards (id, person_id, trigger_kind, trigger_id, status, title, impact, action, irrelevant_at)
    VALUES ($1, $2, 'meeting_decision', $3, 'irrelevant', '影响', '影响', '{"kind":"know","text":"x","due":null}'::jsonb, $4)`,
    [randomUUID(), THIRD, randomUUID(), at("2026-10-15T05:00:00Z")]);
}

describe("使用周报", () => {
  it("只给管理员；本周现算，周一 08:00 之后生成上一周并能导出 Markdown", async () => {
    const { t, admin, member } = await setup();
    expect((await get(member, "/api/admin/usage")).statusCode).toBe(404);
    expect((await get(member, "/api/admin/usage/markdown")).statusCode).toBe(404);
    expect((await get(admin, "/api/admin/usage?week=2026-10-13")).statusCode).toBe(400);
    expect((await get(admin, `/api/admin/usage?week=${LAST_WEEK}`)).statusCode).toBe(404);

    await seedConversation(t);
    await seedEvents(t);
    await seedLedger(t);
    const q = t.pool.query.bind(t.pool);
    const people = loadPeopleDirectory(t.env);
    // 周一 08:00 之前不生成；之后生成一次，再跑不重复。
    expect(await ensureLastWeekReport(q, people, new Date("2026-10-18T23:00:00Z"))).toBeNull();
    expect(await ensureLastWeekReport(q, people, NOW)).toBe(LAST_WEEK);
    expect(await ensureLastWeekReport(q, people, NOW)).toBeNull();

    const response = await get(admin, `/api/admin/usage?week=${LAST_WEEK}`);
    expect(response.statusCode).toBe(200);
    const view = response.json() as TUsageResponse;
    expect(view.weeks).toEqual([{ weekStart: weekStartOf(NOW), live: true }, { weekStart: LAST_WEEK, live: false }]);
    const report = view.report;
    expect(report).toMatchObject({ weekStart: LAST_WEEK, weekEnd: "2026-10-18", live: false });
    // 甲 3 天（13、14、15）、乙 3 天（12、16、17）、丙 1 天（登录）；发问不含「重新回答」那一轮。
    expect(report.summary).toEqual({ roster: 3, activePeople: 3, avgActiveDays: 2.3, asks: 5 });
    expect(report.previous).toMatchObject({ activePeople: 1, asks: 1 });
    expect(report.people.map((row) => [row.displayName, row.days.length, row.asks, row.breaks])).toEqual([
      ["测试甲", 3, 4, 3], ["测试乙", 3, 1, 0], ["测试丙", 1, 0, 0],
    ]);

    const conversation = pathOf(view, "conversation");
    expect(units(conversation)).toEqual([4, 2, 1]);
    expect(conversation.stuckStep).toBe("answered");
    expect(conversation.breaks).toEqual([
      { step: "answered", label: "超时", count: 1 }, { step: "answered", label: "停止", count: 1 },
      { step: "answered", label: "点了重答", count: 1 }, { step: "accepted", label: "说「不对」", count: 1 },
    ]);
    expect(conversation.previousUnits).toEqual([1, 1, 1]);
    // 这一周没有会议：会议写入那条漏斗是空的。
    expect(pathOf(view, "meeting")).toMatchObject({ steps: [{ units: 0 }, { units: 0 }, { units: 0 }, { units: 0 }] });
    expect(pathOf(view, "memory").steps.map((step) => [step.key, step.units, step.people])).toEqual([["used", 1, 1], ["edited", 2, 2], ["deleted", 1, 1]]);
    // 上手：乙、丙登录；丙停在雷达，乙走完。
    const onboarding = pathOf(view, "onboarding");
    const reached = Object.fromEntries(onboarding.steps.map((step) => [step.key, step.units]));
    expect(reached).toMatchObject({ login: 2, hello: 2, "mission-flow": 2, radar: 2, voiceprint: 1, start: 1, done: 1 });
    expect(onboarding.stuckStep).toBe("voiceprint");
    expect(report.ledger.map((item) => [item.label, item.count, item.people, item.open])).toEqual([
      ["工具报错 · search_company", 2, 2, 2], ["影响卡「和我无关」", 1, 1, 1], ["记忆标记对不上", 1, 1, 1], ["运行失败 · 对话", 1, 1, 1],
    ]);

    const markdown = await get(admin, `/api/admin/usage/markdown?week=${LAST_WEEK}`);
    expect(markdown.statusCode).toBe(200);
    expect(markdown.headers["content-type"]).toContain("text/markdown");
    expect(markdown.body).toContain("# 天枢使用周报 · 10/12–10/18");
    expect(markdown.body).toContain("| 测试甲 | 3 | 1 | 4 | 3 |");
    expect(markdown.body).toContain("卡住最多：发问 → 写完回答（−2：超时 1、停止 1、点了重答 1）");
    expect(markdown.body).not.toContain("机密正文");
  }, 30_000);

  it("会议写入按会议结束 → 会议卡 → 主持人确认 → 写入本体算", async () => {
    const { t, admin } = await setup();
    const meeting = async (host: string, ended: string, minutes: string) => {
      const id = randomUUID();
      await t.sql(`INSERT INTO meetings (id, version, title, status, scheduled_at, ends_at, ended_at, lead_dri_id, ceo_participant_id, participants, issue_ids, preflight, draft, origin_ref, minutes_status)
        VALUES ($1, 1, '会', 'scheduled', $2::timestamptz - interval '1 hour', $2, $2, $3, $4, '[]', '[]', '{}', '{}', '{}', $5)`, [id, at(ended), host, TEST_CEO.personId, minutes]);
      return id;
    };
    const written = await meeting(TEST_MEMBER.personId, "2026-10-19T01:00:00Z", "ready");
    const failed = await meeting(TEST_MEMBER.personId, "2026-10-19T01:10:00Z", "ready");
    const pending = await meeting(THIRD, "2026-10-19T01:20:00Z", "ready");
    await meeting(THIRD, "2026-10-19T01:30:00Z", "waiting");
    await t.sql("INSERT INTO meeting_cards (meeting_id, draft_status, current_revision) VALUES ($1, 'draft_ready', 1), ($2, 'draft_ready', 1), ($3, 'draft_ready', NULL)", [written, failed, pending]);
    await t.sql(`INSERT INTO meeting_card_confirmations (meeting_id, revision, draft_version, kind, payload, confirmation, write_to_world)
      VALUES ($1, 1, 1, 'first', '{}', '{}', true), ($2, 1, 1, 'first', '{}', '{}', true)`, [written, failed]);
    await t.sql("INSERT INTO meeting_card_syncs (meeting_id, revision, event_status) VALUES ($1, 1, 'succeeded'), ($2, 1, 'failed')", [written, failed]);

    const view = (await get(admin, "/api/admin/usage")).json() as TUsageResponse;
    const path = pathOf(view, "meeting");
    expect(path.steps.map((step) => [step.key, step.units, step.people])).toEqual([["ended", 4, 2], ["carded", 3, 2], ["confirmed", 2, 1], ["written", 1, 1]]);
    expect(path.breaks).toEqual([
      { step: "carded", label: "妙记未生成", count: 1 }, { step: "confirmed", label: "待确认", count: 1 }, { step: "written", label: "写入失败", count: 1 },
    ]);
  });

  it("只有发问或改动才记「这一天用过」，GET 和上手步骤上报不算；上手每一步记一次", async () => {
    const { t, member } = await setup();
    const rows = () => t.sql("SELECT kind, detail, to_char(day, 'YYYY-MM-DD') AS day FROM usage_events WHERE person_id = $1 ORDER BY kind, detail", [TEST_MEMBER.personId]);
    expect((await get(member, "/api/me/onboarding")).statusCode).toBe(200);
    const post = (url: string, payload?: unknown) => t.app.inject({ method: "POST", url, headers: { cookie: member, origin: t.publicOrigin }, ...(payload ? { payload } : {}) });
    expect((await post("/api/me/usage/onboarding-step", { step: "radar" })).statusCode).toBe(204);
    expect((await post("/api/me/usage/onboarding-step", { step: "radar" })).statusCode).toBe(204);
    expect((await post("/api/me/usage/onboarding-step", { step: "buddy" })).statusCode).toBe(204);
    expect((await post("/api/me/usage/onboarding-step", { step: "nowhere" })).statusCode).toBe(400);
    expect(await rows()).toEqual([
      { kind: "login", detail: null, day: "2026-10-19" },
      { kind: "onboarding_step", detail: "buddy", day: "2026-10-19" },
      { kind: "onboarding_step", detail: "radar", day: "2026-10-19" },
    ]);
    expect((await post("/api/me/onboarding/complete")).statusCode).toBe(200);
    // active 是请求结束后顺手写的，不等它。
    await vi.waitFor(async () => expect((await rows()).map((row) => row.kind)).toEqual(["active", "login", "onboarding_step", "onboarding_step"]));
  });
});
