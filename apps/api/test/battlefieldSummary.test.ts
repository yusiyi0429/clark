import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { Pool } from "pg";
import { BattlefieldSummariesResponse } from "@warmap/contracts";
import { BATTLEFIELD_SUMMARY_KIND, collectBattlefieldSummaryInput, type BattlefieldSummaryAgent, type BattlefieldSummaryInput } from "../src/battlefieldSummary.js";
import { BATTLEFIELD_SUMMARY_PROMPT, createBattlefieldSummaryAgent } from "../src/battlefieldSummaryAgent.js";
import type { WorldSnapshot } from "../src/worldReader.js";
import { call, executionFixture, type Fixture } from "./executionFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

/** 10/26 15:00（北京时间）。 */
const OCT_26 = new Date("2026-10-26T07:00:00.000Z");
const PARAGRAPHS = ["按目前进展有风险，上线还差两件。", "测试乙负责的上线完成一半。", "目前没有记录到卡点。"];

/** 假模型：记下每次的输入；hold() 之后要 release() 才交稿，fail 时直接报错。 */
function fakeAgent() {
  const calls: { input: BattlefieldSummaryInput; battlefieldId: string }[] = [];
  let gate: Promise<void> = Promise.resolve(), release = () => {};
  let fail = false;
  const agent: BattlefieldSummaryAgent = {
    modelId: "fake-model",
    async summarize(input, battlefieldId) {
      calls.push({ input, battlefieldId });
      await gate;
      if (fail) throw new Error("模型没交稿");
      return PARAGRAPHS;
    },
  };
  return { agent, calls, hold() { gate = new Promise((resolve) => { release = resolve; }); }, release: () => release(), failNext() { fail = true; } };
}

async function setup(agent: BattlefieldSummaryAgent) {
  const f = await executionFixture("confirmed", "2026-10", { battlefieldSummaryAgent: agent });
  f.setNow(OCT_26);
  return f;
}
async function read(f: Fixture, cookie: string) {
  const res = await call(f, cookie, "GET", "/api/progress/battlefield-summaries");
  expect(res.statusCode).toBe(200);
  expect(Value.Check(BattlefieldSummariesResponse, res.json())).toBe(true);
  return res.json() as { today: string; battlefields: { battlefieldId: string; name: string; summary: Record<string, unknown> | null; generation: Record<string, unknown> | null }[] };
}
const seed = (f: Fixture, battlefieldId: string, day: string, body: string, goal: string | null = "本月目标") => f.t.sql(
  `INSERT INTO battlefield_summaries (battlefield_id, day, period, goal, body, progress_until, summarized_at, model)
   VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed')`, [battlefieldId, day, day.slice(0, 7), goal, body, `${day}T06:30:00Z`, `${day}T07:02:00Z`]);
const addProduct = (f: Fixture) => f.t.sql("INSERT INTO battlefield_config (id,version,code,name,six_month_outcome) VALUES ('product',1,'03','产品战场','产品半年目标')");
async function task(f: Fixture, missionId: string, title: string, extra: { status?: string; start?: string; due?: string; blocked?: string } = {}) {
  const id = randomUUID();
  await f.t.sql(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,client_id,start_date,due_date,blocked_reason,waiting_on,blocked_at)
    VALUES($1,$2,$3,'self',$4,$5,(SELECT COALESCE(max(step_order),0)+1 FROM tasks WHERE mission_id=$5),$6,$7,$8,$9,$10,$11)`,
  [id, title, TEST_MEMBER.personId, extra.status ?? "in_progress", missionId, randomUUID(), extra.start ?? null, extra.due ?? null,
    extra.blocked ?? null, extra.blocked ? TEST_CEO.personId : null, extra.blocked ? "2026-10-23T02:00:00Z" : null]);
  return id;
}
const progress = (f: Fixture, taskId: string, body: string, at: string) =>
  f.t.sql("INSERT INTO task_progress(id,task_id,author_id,source,body,created_at) VALUES($1,$2,$3,'web',$4,$5)", [randomUUID(), taskId, TEST_MEMBER.personId, body, at]);

describe("战场进展汇总", () => {
  it("可见范围：CEO 看全部战场，成员只看自己所在的战场，不在任何战场的人一个都没有；当天已有的直接给，不调模型", async () => {
    const fake = fakeAgent();
    const f = await setup(fake.agent);
    try {
      await addProduct(f);
      await seed(f, "growth", "2026-10-26", "增长第一段\n\n增长第二段");
      await seed(f, "product", "2026-10-26", "产品战场的汇总", null);
      const ceo = await read(f, f.ceo);
      expect(ceo.today).toBe("2026-10-26");
      expect(ceo.battlefields.map((item) => item.battlefieldId).sort()).toEqual(["growth", "product"]);
      const member = await read(f, f.member);
      expect(member.battlefields).toEqual([{ battlefieldId: "growth", name: "增长战场", generation: null, summary: {
        day: "2026-10-26", goal: "本月目标", paragraphs: ["增长第一段", "增长第二段"],
        progressUntil: "2026-10-26T06:30:00.000Z", summarizedAt: "2026-10-26T07:02:00.000Z" } }]);
      expect(JSON.stringify(member)).not.toContain("产品战场");
      expect((await read(f, f.third)).battlefields).toEqual([]);
      expect(fake.calls).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("当天还没有：打开时当场整理，期间显示阶段并先给昨天那份；整理完存一份，之后不再重复生成", async () => {
    const fake = fakeAgent();
    const f = await setup(fake.agent);
    try {
      await seed(f, "growth", "2026-10-25", "昨天的汇总");
      const done = await task(f, "execution-one", "接入登录", { status: "done" });
      await progress(f, done, "登录接入完成，PR 已合", "2026-10-24T03:00:00Z");
      fake.hold();
      const first = (await read(f, f.member)).battlefields[0];
      expect(first.summary).toMatchObject({ day: "2026-10-25", paragraphs: ["昨天的汇总"] });
      expect(first.generation).toMatchObject({ state: "running" });
      expect(["reading", "writing"]).toContain(first.generation!.phase);
      // 整理中再打开：不另起一份。
      expect((await read(f, f.ceo)).battlefields[0].generation).toMatchObject({ state: "running" });
      fake.release();
      await f.t.app.battlefieldSummaries.idle();
      expect(fake.calls.map((item) => item.battlefieldId)).toEqual(["growth"]);
      const after = (await read(f, f.member)).battlefields[0];
      expect(after).toEqual({ battlefieldId: "growth", name: "增长战场", generation: null, summary: {
        day: "2026-10-26", goal: "本月目标", paragraphs: PARAGRAPHS, progressUntil: "2026-10-24T03:00:00.000Z", summarizedAt: OCT_26.toISOString() } });
      await read(f, f.ceo);
      expect(fake.calls).toHaveLength(1);
      expect(await f.t.sql("SELECT period, model FROM battlefield_summaries WHERE day = '2026-10-26'")).toEqual([{ period: "2026-10", model: "fake-model" }]);
    } finally { await f.t.close(); }
  });

  it("没整理出来：显示没整理出来，10 分钟内再打开不重试", async () => {
    const fake = fakeAgent();
    const f = await setup(fake.agent);
    try {
      fake.failNext();
      await read(f, f.member);
      await f.t.app.battlefieldSummaries.idle();
      const failed = (await read(f, f.member)).battlefields[0];
      expect(failed).toMatchObject({ summary: null, generation: { state: "failed" } });
      expect(fake.calls).toHaveLength(1);
    } finally { await f.t.close(); }
  });

  it("没有目标、成员和进展的战场也能出一份：输入里如实为空，进展收集至为空", async () => {
    const fake = fakeAgent();
    const f = await setup(fake.agent);
    try {
      await addProduct(f);
      await seed(f, "growth", "2026-10-26", "增长战场的汇总");
      await read(f, f.ceo);
      await f.t.app.battlefieldSummaries.idle();
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].input).toEqual({ battlefield: "产品战场", today: "2026-10-26", period: "2026-10", goal: null, members: [], missions: [],
        progress: [], weeklyReviews: [], counts: { progress: 0, weeklyReviews: 0 } });
      const product = (await read(f, f.ceo)).battlefields.find((item) => item.battlefieldId === "product")!;
      expect(product.summary).toMatchObject({ day: "2026-10-26", goal: null, progressUntil: null, paragraphs: PARAGRAPHS });
    } finally { await f.t.close(); }
  });

  it("交给模型的提示词带上本期目标、Mission、执行事项的卡点和信号、最近 14 天的进展和周复盘", async () => {
    const contexts: Context[] = [];
    let pool: Pool | undefined;
    const agent = createBattlefieldSummaryAgent({ query: (sql, params) => pool!.query(sql, params), baseUrl: "https://provider.invalid/v1", apiKey: "test",
      modelId: "gpt-test", thinkingLevel: "medium", streamSimple: (_model, context) => {
        contexts.push(context);
        const events = createAssistantMessageEventStream();
        const toolCall = { type: "toolCall" as const, id: randomUUID(), name: "submit_candidate", arguments: { paragraphs: PARAGRAPHS } };
        const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "warmap", model: "gpt-test", content: [toolCall], stopReason: "toolUse",
          timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { events.push({ type: "start", partial: message }); events.push({ type: "done", reason: "toolUse", message }); });
        return events;
      } });
    const f = await setup(agent);
    pool = f.t.pool;
    try {
      const blocked = await task(f, "execution-one", "接口联调", { blocked: "等对方给测试账号" });
      const late = await task(f, "execution-two", "灰度验证", { start: "2026-10-12", due: "2026-10-16" });
      await progress(f, blocked, "联调到第三个接口，卡在测试账号", "2026-10-25T03:00:00Z");
      await progress(f, late, "灰度方案写完", "2026-10-20T03:00:00Z");
      await progress(f, late, "三周前的进展", "2026-10-01T03:00:00Z");
      await f.t.sql(`INSERT INTO weekly_reviews (id, person_id, week_start, status, body, submitted_at, created_at, updated_at)
        VALUES ($1, $2, '2026-10-19', 'submitted', $3, '2026-10-24T09:00:00Z', now(), now())`,
      [randomUUID(), TEST_MEMBER.personId, JSON.stringify({ overall: { text: "状态：黄｜上线慢了两天", sources: [] }, actions: { text: "继续推进", sources: [] } })]);
      await read(f, f.member);
      await f.t.app.battlefieldSummaries.idle();
      expect(contexts).toHaveLength(1);
      expect(contexts[0].systemPrompt).toContain(BATTLEFIELD_SUMMARY_PROMPT);
      const message = contexts[0].messages[0];
      const input = JSON.parse(typeof message.content === "string" ? message.content : (message.content[0] as { text: string }).text).input as BattlefieldSummaryInput;
      expect(input.goal).toEqual({ source: "月度计划", items: [{ title: null, outcome: "本月目标", successCriteria: null }] });
      expect(input.members).toEqual([{ name: "测试甲", role: "负责人" }, { name: "测试乙", role: "成员" }]);
      const tasks = input.missions.flatMap((mission) => mission.tasks);
      expect(tasks.find((item) => item.title === "接口联调")).toMatchObject({ blockedReason: "等对方给测试账号", waitingOn: "测试甲", blockedSince: "2026-10-23" });
      expect(tasks.find((item) => item.title === "灰度验证")?.signals).toEqual(["已过截止 6 个工作日"]);
      expect(input.progress.map((item) => [item.at, item.person, item.task, item.text])).toEqual([
        ["2026-10-25 11:00", "测试乙", "接口联调", "联调到第三个接口，卡在测试账号"], ["2026-10-20 11:00", "测试乙", "灰度验证", "灰度方案写完"]]);
      expect(input.weeklyReviews).toEqual([{ person: "测试乙", weekStart: "2026-10-19", overall: "状态：黄｜上线慢了两天", progress: "", issues: "", actions: "继续推进" }]);
      expect(input.counts).toEqual({ progress: 2, weeklyReviews: 1 });
      const stored = await f.t.sql("SELECT body, model, progress_until FROM battlefield_summaries");
      expect(stored).toEqual([{ body: PARAGRAPHS.join("\n\n"), model: "gpt-test", progress_until: new Date("2026-10-25T03:00:00Z") }]);
    } finally { await f.t.close(); }
  });

  it("本期目标：本体里这个战场本月的本期目标优先于月度计划；不是本月的不算", async () => {
    const f = await setup(fakeAgent().agent);
    try {
      const goal = (period: string, outcome: string) => ({ objectId: `po-${period}`, ref: `po-${period}@1`, title: `${period} 增长`, version: 1, lifecycle: "已确认",
        period, horizon: null, outcome, successCriteria: "签约 3 家", acceptance: null, timeBoundary: null, realizationLogic: null });
      const world = (goals: ReturnType<typeof goal>[]): WorldSnapshot => ({ fetchedAt: OCT_26.toISOString(), company: null, strategy: null,
        units: [{ battlefieldId: "growth", unit: { objectId: "u1", ref: "u1@1", title: "增长", domainId: "d1" }, lto: null, periodGoals: goals }] });
      const q = f.t.pool.query.bind(f.t.pool);
      const growth = { id: "growth", name: "增长战场" };
      const fromWorld = await collectBattlefieldSummaryInput(q, growth, OCT_26, [], world([goal("2026-10", "10 月签下 3 家\n渠道打通"), goal("2026-09", "9 月目标")]));
      expect(fromWorld.input.goal).toEqual({ source: "本体", items: [{ title: "2026-10 增长", outcome: "10 月签下 3 家\n渠道打通", successCriteria: "签约 3 家" }] });
      expect(fromWorld.goalLine).toBe("10 月签下 3 家 渠道打通");
      const fallback = await collectBattlefieldSummaryInput(q, growth, OCT_26, [], world([goal("2026-09", "9 月目标")]));
      expect(fallback.input.goal?.source).toBe("月度计划");
      expect(fallback.goalLine).toBe("本月目标");
    } finally { await f.t.close(); }
  });

  it("每天 07:30（北京时间）之后后台任务补齐当天各战场的汇总，之前不动", async () => {
    const fake = fakeAgent();
    const f = await setup(fake.agent);
    try {
      const run = f.t.app.battlefieldSummaries.jobs().handlers[BATTLEFIELD_SUMMARY_KIND];
      f.setNow(new Date("2026-10-25T23:20:00.000Z"));
      await run({}, { id: "1", kind: BATTLEFIELD_SUMMARY_KIND, dedupe_key: "k1", attempts: 1, payload: {} });
      expect(fake.calls).toEqual([]);
      f.setNow(new Date("2026-10-25T23:31:00.000Z"));
      await run({}, { id: "2", kind: BATTLEFIELD_SUMMARY_KIND, dedupe_key: "k2", attempts: 1, payload: {} });
      expect(fake.calls.map((item) => item.battlefieldId)).toEqual(["growth"]);
      expect(await f.t.sql("SELECT to_char(day,'YYYY-MM-DD') AS day FROM battlefield_summaries")).toEqual([{ day: "2026-10-26" }]);
      await run({}, { id: "3", kind: BATTLEFIELD_SUMMARY_KIND, dedupe_key: "k3", attempts: 1, payload: {} });
      expect(fake.calls).toHaveLength(1);
    } finally { await f.t.close(); }
  });
});
