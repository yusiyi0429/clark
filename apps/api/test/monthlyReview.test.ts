import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  MonthlyReviewItemPayload,
  MonthlyReviewPayload,
  type TMonthlyReviewAssessment,
  type TMonthlyReviewSelfReview,
  type TMonthlyReviewSummaryCandidate,
} from "@warmap/contracts";
import { signActionId } from "../src/actionToken.js";
import type { MonthlyDraftAgent, MonthlyDraftAgentInput } from "../src/monthlyDraft.js";
import { proposeMonthlyReviewSuggestion } from "../src/monthlyReviews.js";
import type {
  MonthlyReviewAgents,
  MonthlyReviewAssessInput,
  MonthlyReviewDraftInput,
  MonthlyReviewSummaryInput,
} from "../src/monthlyReviewService.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, testEnv, type TestApp } from "./helpers.js";

const PERIOD = "2026-09";
const SEPT_15 = new Date("2026-09-15T02:00:00Z"); // 上海 2026-09-15 10:00
const CAPABILITY_ID = "cap-delivery";
const MEMBER_VIEWER = { personId: TEST_MEMBER.personId, role: "member" };
const CEO_VIEWER = { personId: TEST_CEO.personId, role: "ceo" };

function selfReview(prefix = "灯塔"): TMonthlyReviewSelfReview {
  return {
    overall: { text: `${prefix}完成了渠道切换。第二句不进入摘要`, sources: ["todo-1"] },
    judgments: { text: "1. 交付节奏落后两周，供应商延期", sources: ["mission-1"] },
    nextFocus: { text: "十月先补齐交付", sources: [] },
    escalations: { text: "", sources: [] },
  };
}

const ASSESSMENT: TMonthlyReviewAssessment = {
  overall: "自评偏乐观，交付证据不足",
  deviations: [{ point: "渠道切换完成度", evidence: "计划反馈只提到签约，没有交付记录" }],
  questions: ["十月的交付由谁兜底？"],
};

const SUMMARY: TMonthlyReviewSummaryCandidate = {
  overall: "九月完成渠道切换，交付仍有差距",
  judgments: [1, 2, 3, 4, 5].map((n) => ({ title: `判断 ${n}`, body: `依据 ${n}` })),
  nextFocus: ["补齐交付证据"],
  ltcoSuggestion: { change: false, proposedLtco: "三年成为行业第一", rationale: "战略没有变化", units: [] },
};

type Behavior<I> = (input: I, call: number) => unknown;
type FakeReviewAgents = MonthlyReviewAgents & {
  calls: { draft: MonthlyReviewDraftInput[]; assess: MonthlyReviewAssessInput[]; summarize: MonthlyReviewSummaryInput[] };
  behave: { draft: Behavior<MonthlyReviewDraftInput>; assess: Behavior<MonthlyReviewAssessInput>; summarize: Behavior<MonthlyReviewSummaryInput> };
};

/** 行为函数返回候选；抛错模拟 Agent 失败。 */
function fakeReviewAgents(): FakeReviewAgents {
  const calls: FakeReviewAgents["calls"] = { draft: [], assess: [], summarize: [] };
  const behave: FakeReviewAgents["behave"] = {
    draft: (input) => selfReview(input.subject.name),
    assess: () => ASSESSMENT,
    summarize: () => SUMMARY,
  };
  const agent = <K extends keyof FakeReviewAgents["calls"]>(kind: K) => ({
    async generate(input: FakeReviewAgents["calls"][K][number]) {
      (calls[kind] as unknown[]).push(input);
      const count = (calls[kind] as unknown[]).length;
      return { candidate: (behave[kind] as Behavior<unknown>)(input, count) };
    },
  });
  return { calls, behave, draft: agent("draft"), assess: agent("assess"), summarize: agent("summarize") } as FakeReviewAgents;
}

function fakePlanAgent(): MonthlyDraftAgent & { calls: MonthlyDraftAgentInput[] } {
  const agent = {
    calls: [] as MonthlyDraftAgentInput[],
    async generate(input: MonthlyDraftAgentInput) {
      agent.calls.push(input);
      return { candidate: { companyOutcome: "十月公司结果", battlefields: [], capabilities: [], todos: [] } };
    },
  };
  return agent;
}

type Ctx = {
  t: TestApp;
  agents: FakeReviewAgents;
  planAgent: ReturnType<typeof fakePlanAgent>;
  ceo: string;
  member: string;
  setNow: (at: Date) => void;
};

/** growth 由成员负责，能力域没有负责人（挂到 CEO）；9 月有已签发计划，只写了 growth 的 PCO。 */
async function setup(at = SEPT_15): Promise<Ctx> {
  const agents = fakeReviewAgents();
  const planAgent = fakePlanAgent();
  let now = at;
  const t = await createTestApp({}, undefined, { monthlyReviewAgents: agents, monthlyReviewRetryDelayMs: 0, monthlyDraftAgent: planAgent, monthlyNow: () => now });
  await t.sql("UPDATE battlefield_config SET owner_id = $1, code = '01', name = '灯塔项目' WHERE id = 'growth'", [TEST_MEMBER.personId]);
  await t.sql(
    `INSERT INTO capability_config (id, version, code, sort_order, name, "group", six_month_outcome)
     VALUES ($1, 1, '07', 10, '交付能力', '', '端到端交付六个月目标')`,
    [CAPABILITY_ID],
  );
  await t.sql("UPDATE company_strategy_config SET ltco = '三年成为行业第一' WHERE id = 'default'");
  await t.sql(
    `INSERT INTO monthly_plans (id, version, period, status, company_outcome, battlefields, capabilities, todos, negotiation, generation, confirmed_at)
     VALUES (gen_random_uuid(), 3, $1, 'confirmed', '九月公司结果', $2::jsonb, '[]'::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, now())`,
    [
      PERIOD,
      JSON.stringify([{ battlefieldId: "growth", outcome: "灯塔客户完成切换" }]),
      JSON.stringify([{ id: "todo-1", title: "签约灯塔客户", ownerId: TEST_MEMBER.personId, sourceRef: "dri://t", battlefieldId: "growth" }]),
      JSON.stringify({ edits: [], checkedItemIds: [], note: "", feedback: [] }),
      JSON.stringify({ status: "ready", pendingSince: null, runId: null, previousRunIds: [], error: null, generatedAt: null }),
    ],
  );
  return { t, agents, planAgent, ceo: await t.loginCookie(), member: await t.memberCookie(), setNow: (value) => { now = value; } };
}

async function overview(c: Ctx, cookie = c.ceo, period = PERIOD) {
  return c.t.app.inject({ method: "GET", url: `/api/monthly-reviews/${period}`, headers: { cookie } });
}

async function readItem(c: Ctx, itemId: string, cookie: string) {
  return c.t.app.inject({ method: "GET", url: `/api/monthly-review-items/${itemId}`, headers: { cookie } });
}

async function item(c: Ctx, itemId: string, cookie: string): Promise<Record<string, any>> {
  const response = await readItem(c, itemId, cookie);
  expect(response.statusCode).toBe(200);
  return response.json().item;
}

async function execute(c: Ctx, cookie: string, actionId: string, input?: unknown) {
  return c.t.app.inject({
    method: "POST",
    url: "/api/monthly-reviews/actions/execute",
    headers: { cookie, origin: c.t.publicOrigin },
    payload: { actionId, ...(input === undefined ? {} : { input }) },
  });
}

function actionId(payload: { actions: { actionType: string; actionId: string }[] }, actionType: string): string {
  const found = payload.actions.find((action) => action.actionType === actionType);
  expect(found, `应提供 ${actionType}`).toBeTruthy();
  return found!.actionId;
}

/** 开启 9 月复盘并等起草结束，返回两项 id。 */
async function openReview(c: Ctx): Promise<{ reviewId: string; growthId: string; capId: string }> {
  const opened = await execute(c, c.ceo, actionId((await overview(c)).json(), "monthly-review.open"));
  expect(opened.statusCode).toBe(200);
  await c.t.monthlyReviews!.idle();
  const rows = await c.t.sql("SELECT id, subject_id, review_id FROM monthly_review_items ORDER BY subject_type");
  return {
    reviewId: rows[0].review_id as string,
    growthId: rows.find((row) => row.subject_id === "growth")!.id as string,
    capId: rows.find((row) => row.subject_id === CAPABILITY_ID)!.id as string,
  };
}

/** 负责人提交本项（起草已写好必填栏），等评估结束。 */
async function submit(c: Ctx, itemId: string, cookie: string) {
  const response = await execute(c, cookie, actionId(await item(c, itemId, cookie), "monthly-review-item.submit"));
  expect(response.statusCode).toBe(200);
  await c.t.monthlyReviews!.idle();
  return response;
}

async function confirm(c: Ctx, itemId: string) {
  const response = await execute(c, c.ceo, actionId(await item(c, itemId, c.ceo), "monthly-review-item.confirm"));
  expect(response.statusCode).toBe(200);
  await c.t.monthlyReviews!.idle();
  return response;
}

/** 两项都提交并确认，公司复盘汇总完成。 */
async function allConfirmed(c: Ctx) {
  const ids = await openReview(c);
  await submit(c, ids.growthId, c.member);
  await submit(c, ids.capId, c.ceo);
  await confirm(c, ids.growthId);
  await confirm(c, ids.capId);
  return ids;
}

async function toLtcoPending(c: Ctx) {
  const ids = await allConfirmed(c);
  const review = (await overview(c)).json().review;
  expect((await execute(c, c.ceo, actionId(review, "monthly-review.confirm_summary"))).statusCode).toBe(200);
  return ids;
}

describe("MonthlyReview open", () => {
  it("creates one item per battlefield and capability, assigns owners, snapshots targets and is idempotent", async () => {
    const c = await setup();
    try {
      expect((await overview(c, c.member)).statusCode).toBe(403);
      const empty = (await overview(c)).json();
      expect(empty.review).toBeNull();
      const openId = actionId(empty, "monthly-review.open");
      expect((await overview(c, c.ceo, "2026-08")).json().actions).toEqual([]);

      // 成员拿到 actionId 也不能开启；非当月 slot 400
      expect((await execute(c, c.member, openId)).statusCode).toBe(403);
      const august = signActionId(testEnv.sessionSecret, { actionType: "monthly-review.open", objectType: "monthly-review-slot", objectId: "2026-08", objectVersion: 1 });
      expect((await execute(c, c.ceo, august)).statusCode).toBe(400);

      const opened = await execute(c, c.ceo, openId);
      expect(opened.statusCode).toBe(200);
      expect(Value.Check(MonthlyReviewPayload, opened.json().review)).toBe(true);
      await c.t.monthlyReviews!.idle();
      const review = (await overview(c)).json().review;
      expect(review).toMatchObject({ period: PERIOD, nextPeriod: "2026-10", status: "collecting", counts: { total: 2, submitted: 0 } });
      expect(review.items.map((row: any) => [row.subjectId, row.ownerName, row.ownerUnassigned, row.status])).toEqual([
        ["growth", "测试乙", false, "draft"],
        [CAPABILITY_ID, "测试甲", true, "draft"],
      ]);
      expect(review.items[0].lead).toBe("灯塔项目完成了渠道切换");

      const rows = await c.t.sql("SELECT subject_id, owner_id, target FROM monthly_review_items ORDER BY subject_type");
      expect(rows).toEqual([
        { subject_id: "growth", owner_id: TEST_MEMBER.personId, target: "灯塔客户完成切换" },
        { subject_id: CAPABILITY_ID, owner_id: TEST_CEO.personId, target: null },
      ]);
      // 起草输入：战场按 battlefieldId 过滤计划待办
      const growthInput = c.agents.calls.draft.find((input) => input.subject.id === "growth")!;
      expect(growthInput.target).toBe("灯塔客户完成切换");
      expect(growthInput.planTodos.map((todo) => todo.id)).toEqual(["todo-1"]);
      expect(c.agents.calls.draft.find((input) => input.subject.id === CAPABILITY_ID)!.planTodos).toEqual([]);

      const again = await execute(c, c.ceo, openId);
      expect(again.statusCode).toBe(200);
      expect(again.json().review.reviewId).toBe(review.reviewId);
      expect(await c.t.sql("SELECT id FROM monthly_review_items")).toHaveLength(2);
      expect(c.agents.calls.draft).toHaveLength(2);
    } finally {
      await c.t.close();
    }
  });
});

describe("MonthlyReview scheduler", () => {
  it("opens on the third-to-last Shanghai day and only once", async () => {
    const c = await setup(new Date("2026-09-27T04:00:00Z")); // 上海 9 月 27 日
    try {
      expect(await c.t.monthlyReviews!.runScheduled()).toEqual({ period: PERIOD, status: "not_due" });
      expect(await c.t.sql("SELECT id FROM monthly_reviews")).toHaveLength(0);
      c.setNow(new Date("2026-09-27T16:30:00Z")); // 上海 9 月 28 日 00:30
      expect((await c.t.monthlyReviews!.runScheduled()).status).toBe("created");
      expect((await c.t.monthlyReviews!.runScheduled()).status).toBe("skipped");
      await c.t.monthlyReviews!.idle();
      expect(await c.t.sql("SELECT period FROM monthly_reviews")).toEqual([{ period: PERIOD }]);
      expect(await c.t.sql("SELECT id FROM monthly_review_items")).toHaveLength(2);
    } finally {
      await c.t.close();
    }
  });
});

describe("MonthlyReview drafting", () => {
  it("succeeds on the third automatic attempt and reads only in-period weekly progress for its unit", async () => {
    const c = await setup();
    let growthCalls = 0;
    c.agents.behave.draft = (input) => {
      if (input.subject.id === "growth" && ++growthCalls < 3) throw new Error("temporary provider error");
      return selfReview(input.subject.name);
    };
    try {
      const mission = async (id: string, period: string, battlefield: string) => c.t.sql(
        `INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, battlefield_ids, outcome, source_ref, source_document_id, source_revision, source_title)
         VALUES ($1, 1, $1, $2, $1, $3, '', $4::jsonb, '目标', 'test', 'test', 1, 'test')`,
        [id, period, TEST_MEMBER.personId, JSON.stringify([battlefield])]);
      await mission("weekly-growth", PERIOD, "growth");
      await mission("weekly-other", PERIOD, "other");
      await mission("weekly-august", "2026-08", "growth");
      const progress = async (missionId: string, date: string, body: string) => {
        const taskId = randomUUID();
        await c.t.sql("INSERT INTO tasks (id, title, status, owner_id, created_by, mission_id, step_order) VALUES ($1, '周报任务', 'in_progress', $2, $2, $3, 1)",
          [taskId, TEST_MEMBER.personId, missionId]);
        await c.t.sql("INSERT INTO task_progress (id, task_id, author_id, source, body, created_at) VALUES ($1, $2, $3, 'web', $4, $5)",
          [randomUUID(), taskId, TEST_MEMBER.personId, body, date]);
      };
      await progress("weekly-growth", "2026-09-15T02:00:00Z", "本月周报");
      await progress("weekly-growth", "2026-10-07T15:00:00Z", "七日补报");
      await progress("weekly-growth", "2026-10-07T16:00:00Z", "八日不算");
      await progress("weekly-other", "2026-09-15T02:00:00Z", "其他单元");
      await progress("weekly-august", "2026-09-15T02:00:00Z", "其他月份 Mission");
      const { growthId } = await openReview(c);
      expect((await item(c, growthId, c.member)).status).toBe("draft");
      expect(growthCalls).toBe(3);
      expect(c.agents.calls.draft.filter((input) => input.subject.id === "growth")[0].weeklyProgress).toEqual([
        expect.objectContaining({ date: "2026-10-07", missionTitle: "weekly-growth", taskTitle: "周报任务", author: TEST_MEMBER.personId, body: "七日补报" }),
        expect.objectContaining({ date: "2026-09-15", body: "本月周报" }),
      ]);
    } finally { await c.t.close(); }
  });

  it("keeps failures visible, retries on request and recovers interrupted runs", async () => {
    const c = await setup();
    let capCalls = 0;
    c.agents.behave.draft = (input) => {
      if (input.subject.id !== CAPABILITY_ID) return selfReview();
      capCalls += 1;
      if (capCalls === 1) throw new Error("provider down");
      if (capCalls === 2) return { ...selfReview(), extra: true };
      if (capCalls === 3) throw new Error("provider down again");
      return selfReview("能力");
    };
    try {
      const { reviewId, growthId, capId } = await openReview(c);
      let cap = await item(c, capId, c.ceo);
      expect(Value.Check(MonthlyReviewItemPayload, cap)).toBe(true);
      expect(cap.status).toBe("draft_failed");
      expect(cap.draftError).toMatchObject({ code: "monthly_review_generation_failed", message: "provider down again" });
      expect(capCalls).toBe(3);
      expect((await item(c, growthId, c.member)).status).toBe("draft");

      expect((await execute(c, c.ceo, actionId(cap, "monthly-review-item.retry_draft"))).json().item.status).toBe("drafting");
      await c.t.monthlyReviews!.idle();
      cap = await item(c, capId, c.ceo);
      expect(cap.status).toBe("draft");
      expect(cap.selfReview.overall.text).toContain("能力");

      // 进程重启前没跑完的起草、评估、汇总都标为可见 failed
      await c.t.sql("UPDATE monthly_review_items SET status = 'drafting' WHERE id = $1", [capId]);
      await c.t.sql(`UPDATE monthly_review_items SET status = 'submitted', submitted_at = now(), assessment = '{"status":"running","runId":"r1","result":null,"error":null}' WHERE id = $1`, [growthId]);
      await c.t.sql(`UPDATE monthly_reviews SET status = 'summarizing', summary = summary || '{"status":"running","runId":"s1"}' WHERE id = $1`, [reviewId]);
      expect(await c.t.monthlyReviews!.recoverInterrupted()).toBe(3);
      cap = await item(c, capId, c.ceo);
      expect(cap.status).toBe("draft_failed");
      expect(cap.draftError).toMatchObject({ code: "monthly_review_interrupted", message: "生成在进程重启前未完成，请重试" });
      expect((await item(c, growthId, c.ceo)).assessment).toMatchObject({ status: "failed", error: { code: "monthly_review_interrupted" } });
      expect((await overview(c)).json().review.summary.status).toBe("failed");
    } finally {
      await c.t.close();
    }
  });
});

describe("MonthlyReview owner editing and submit", () => {
  it("treats a stored old-key self-review as absent", async () => {
    const c = await setup();
    try {
      const { growthId } = await openReview(c);
      await c.t.sql("UPDATE monthly_review_items SET self_review = $2::jsonb WHERE id = $1", [growthId,
        JSON.stringify({ achievement: { text: "旧数据", sources: [] }, gaps: { text: "旧差距", sources: [] } })]);
      const mine = await item(c, growthId, c.member);
      expect(mine.selfReview).toBeNull();
      expect((await execute(c, c.member, actionId(mine, "monthly-review-item.submit"))).json().fieldErrors).toEqual({
        overall: "required", judgments: "required", nextFocus: "required",
      });
    } finally { await c.t.close(); }
  });

  it("updates only the given fields, requires three fields to submit and runs the assessment", async () => {
    const c = await setup();
    try {
      const { growthId } = await openReview(c);
      // CEO 不是 growth 的负责人：看不到编辑动作，拿到签名也 403
      const asCeo = await item(c, growthId, c.ceo);
      expect(asCeo.viewer).toEqual({ isOwner: false, isCeo: true, isParticipant: false, canComment: true });
      expect(asCeo.actions).toEqual([]);
      let mine = await item(c, growthId, c.member);
      expect(mine.actions.map((action: any) => action.actionType)).toEqual(["monthly-review-item.update", "monthly-review-item.submit"]);
      const update = actionId(mine, "monthly-review-item.update");
      expect((await execute(c, c.ceo, update, { fields: [{ field: "judgments", text: "CEO 改" }] })).statusCode).toBe(403);

      const saved = await execute(c, c.member, update, { fields: [{ field: "overall", text: "改过的达成" }, { field: "judgments", text: "  " }] });
      expect(saved.statusCode).toBe(200);
      mine = saved.json().item;
      expect(mine.selfReview.overall).toEqual({ text: "改过的达成", sources: ["todo-1"] });
      expect(mine.selfReview.nextFocus).toEqual(selfReview().nextFocus);

      const incomplete = await execute(c, c.member, actionId(mine, "monthly-review-item.submit"));
      expect(incomplete.statusCode).toBe(400);
      expect(incomplete.json().fieldErrors).toEqual({ judgments: "required" });

      mine = (await execute(c, c.member, actionId(mine, "monthly-review-item.update"), { fields: [{ field: "judgments", text: "差距", sources: ["s"] }] })).json().item;
      const submitted = await execute(c, c.member, actionId(mine, "monthly-review-item.submit"));
      expect(submitted.json().item).toMatchObject({ status: "submitted", assessment: { status: "running" }, actions: [] });
      await c.t.monthlyReviews!.idle();
      mine = await item(c, growthId, c.member);
      expect(mine.assessment).toMatchObject({ status: "ready", result: ASSESSMENT });
      expect(c.agents.calls.assess[0].selfReview.judgments).toEqual({ text: "差距", sources: ["s"] });
    } finally {
      await c.t.close();
    }
  });

  it("does not block confirmation when the assessment fails, and retries it on request", async () => {
    const c = await setup();
    c.agents.behave.assess = (_input, call) => {
      if (call <= 3) throw new Error("assess down");
      return ASSESSMENT;
    };
    try {
      const { growthId } = await openReview(c);
      await submit(c, growthId, c.member);
      let asCeo = await item(c, growthId, c.ceo);
      expect(asCeo.assessment.status).toBe("failed");
      expect(asCeo.actions.map((action: any) => action.actionType)).toEqual([
        "monthly-review-item.confirm", "monthly-review-item.return", "monthly-review-item.retry_assessment",
      ]);
      asCeo = (await execute(c, c.ceo, actionId(asCeo, "monthly-review-item.retry_assessment"))).json().item;
      await c.t.monthlyReviews!.idle();
      expect((await item(c, growthId, c.ceo)).assessment.status).toBe("ready");

      await c.t.sql(`UPDATE monthly_review_items SET assessment = assessment || '{"status":"failed"}' WHERE id = $1`, [growthId]);
      await confirm(c, growthId);
      const confirmed = await item(c, growthId, c.member);
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.actions).toEqual([]);
    } finally {
      await c.t.close();
    }
  });
});

describe("MonthlyReview suggestions", () => {
  it("stores one suggestion per field for the owner and resolves it by adopt or dismiss", async () => {
    const c = await setup();
    try {
      const { growthId, capId } = await openReview(c);
      const propose = (viewer: typeof MEMBER_VIEWER, itemId = growthId, text = "建议一") =>
        proposeMonthlyReviewSuggestion(c.t.pool, itemId, viewer, { field: "judgments", text, rationale: "按手写复盘" }, SEPT_15);
      expect(await propose(MEMBER_VIEWER)).toMatchObject({ ok: true });
      expect(await propose(MEMBER_VIEWER, growthId, "建议二")).toMatchObject({ ok: true });
      // CEO 不是 growth 的负责人；成员不是能力域项的负责人
      expect(await propose(CEO_VIEWER)).toMatchObject({ error: "FORBIDDEN" });
      expect(await propose(MEMBER_VIEWER, capId)).toMatchObject({ error: "FORBIDDEN" });

      let mine = await item(c, growthId, c.member);
      expect(mine.suggestions).toEqual([{ field: "judgments", text: "建议二", rationale: "按手写复盘", createdAt: SEPT_15.toISOString() }]);
      mine = (await execute(c, c.member, actionId(mine, "monthly-review-item.resolve_suggestion"), { field: "judgments", decision: "adopt" })).json().item;
      expect(mine.selfReview.judgments).toEqual({ text: "建议二", sources: ["mission-1"] });
      expect(mine.suggestions).toEqual([]);
      expect(mine.actions.some((action: any) => action.actionType === "monthly-review-item.resolve_suggestion")).toBe(false);

      await propose(MEMBER_VIEWER, growthId, "建议三");
      mine = await item(c, growthId, c.member);
      const resolve = actionId(mine, "monthly-review-item.resolve_suggestion");
      mine = (await execute(c, c.member, resolve, { field: "judgments", decision: "dismiss" })).json().item;
      expect(mine.selfReview.judgments.text).toBe("建议二");
      expect(mine.suggestions).toEqual([]);

      await submit(c, growthId, c.member);
      expect(await propose(MEMBER_VIEWER)).toMatchObject({ error: "INVALID_STATE" });
    } finally {
      await c.t.close();
    }
  });

  it("rejects resolving a field without a suggestion", async () => {
    const c = await setup();
    try {
      const { growthId } = await openReview(c);
      await proposeMonthlyReviewSuggestion(c.t.pool, growthId, MEMBER_VIEWER, { field: "judgments", text: "建议", rationale: "" }, SEPT_15);
      const resolve = actionId(await item(c, growthId, c.member), "monthly-review-item.resolve_suggestion");
      const response = await execute(c, c.member, resolve, { field: "overall", decision: "adopt" });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("MONTHLY_REVIEW_SUGGESTION_NOT_FOUND");
    } finally {
      await c.t.close();
    }
  });
});

describe("MonthlyReview return", () => {
  it("requires a reason, shows it to the owner and clears it on resubmit", async () => {
    const c = await setup();
    try {
      const { growthId } = await openReview(c);
      await submit(c, growthId, c.member);
      const returnId = actionId(await item(c, growthId, c.ceo), "monthly-review-item.return");
      expect((await execute(c, c.ceo, returnId, { reason: "   " })).statusCode).toBe(400);
      expect((await execute(c, c.ceo, returnId)).statusCode).toBe(400);
      const returned = await execute(c, c.ceo, returnId, { reason: "交付证据不够" });
      expect(returned.json().item).toMatchObject({ status: "returned", returnReason: "交付证据不够" });

      let mine = await item(c, growthId, c.member);
      expect(mine.returnReason).toBe("交付证据不够");
      expect(mine.actions.map((action: any) => action.actionType)).toContain("monthly-review-item.submit");
      await submit(c, growthId, c.member);
      mine = await item(c, growthId, c.member);
      expect(mine.status).toBe("submitted");
      expect(mine.returnReason).toBeNull();
      expect(mine.history.map((entry: any) => [entry.action, entry.byName, entry.reason])).toEqual([
        ["submit", "测试乙", null], ["return", "测试甲", "交付证据不够"], ["submit", "测试乙", null],
      ]);
      expect(c.agents.calls.assess).toHaveLength(2);
    } finally {
      await c.t.close();
    }
  });
});

describe("MonthlyReview company summary and LTCO", () => {
  it("retries invalid summary unit references before accepting the third candidate", async () => {
    const c = await setup();
    let calls = 0;
    c.agents.behave.summarize = () => {
      calls += 1;
      return calls < 3 ? { ...SUMMARY, ltcoSuggestion: { ...SUMMARY.ltcoSuggestion,
        units: [{ subjectType: "battlefield", subjectId: "missing", proposedOutcome: "虚构目标", rationale: "虚构" }] } } : SUMMARY;
    };
    try {
      await allConfirmed(c);
      expect(calls).toBe(3);
      expect((await overview(c)).json().review.summary).toMatchObject({ status: "ready", overall: SUMMARY.overall, nextFocus: SUMMARY.nextFocus });
    } finally { await c.t.close(); }
  });

  it("summarizes after the last confirmation, lets the CEO edit and confirm it, then asks for the LTCO decision", async () => {
    const c = await setup();
    try {
      const { growthId } = await openReview(c);
      await submit(c, growthId, c.member);
      await confirm(c, growthId);
      expect((await overview(c)).json().review.status).toBe("collecting");
      expect(c.agents.calls.summarize).toHaveLength(0);

      const { capId } = await c.t.sql("SELECT id AS \"capId\" FROM monthly_review_items WHERE subject_id = $1", [CAPABILITY_ID]).then((rows) => rows[0] as { capId: string });
      await submit(c, capId, c.ceo);
      const last = await confirm(c, capId);
      expect(last.json().item.status).toBe("confirmed");
      let review = (await overview(c)).json().review;
      expect(review).toMatchObject({ status: "summarizing", summary: { status: "ready", judgments: SUMMARY.judgments }, ltco: { current: "三年成为行业第一", suggestion: SUMMARY.ltcoSuggestion } });
      expect(c.agents.calls.summarize[0].items).toHaveLength(2);
      expect(c.agents.calls.summarize[0].ltco).toBe("三年成为行业第一");
      const notices = (await c.t.app.inject({ method: "GET", url: "/api/me/monthly-reviews", headers: { cookie: c.ceo } })).json().notices;
      expect(notices.map((notice: any) => notice.kind)).toEqual(["summary_pending"]);

      const judgments = SUMMARY.judgments.slice(0, 3).map((judgment) => ({ ...judgment, body: `${judgment.body}（CEO 改）` }));
      review = (await execute(c, c.ceo, actionId(review, "monthly-review.update_summary"), { overall: "CEO 修改总体结果", judgments, nextFocus: ["聚焦证据"] })).json().review;
      expect(review.summary.judgments).toEqual(judgments);
      expect(review.summary).toMatchObject({ overall: "CEO 修改总体结果", nextFocus: ["聚焦证据"] });
      review = (await execute(c, c.ceo, actionId(review, "monthly-review.confirm_summary"))).json().review;
      expect(review.status).toBe("ltco_pending");
      expect(review.summary.confirmedAt).toBe(SEPT_15.toISOString());
      expect(review.actions.map((action: any) => action.actionType)).toEqual(["monthly-review.decide_ltco"]);
      const ltcoNotice = (await c.t.app.inject({ method: "GET", url: "/api/me/monthly-reviews", headers: { cookie: c.ceo } })).json().notices;
      expect(ltcoNotice).toEqual([expect.objectContaining({ kind: "ltco_pending", text: "9 月复盘已完成 · 待决定 LTCO", href: "/reviews/2026-09/ltco" })]);
    } finally {
      await c.t.close();
    }
  });

  it("keeps the LTCO and immediately drafts next month's plan with the closed review as input", async () => {
    const c = await setup();
    try {
      await toLtcoPending(c);
      const review = (await overview(c)).json().review;
      const decided = await execute(c, c.ceo, actionId(review, "monthly-review.decide_ltco"), { decision: "keep" });
      expect(decided.statusCode).toBe(200);
      expect(decided.json().review).toMatchObject({ status: "closed", ltco: { current: "三年成为行业第一", decision: { decision: "keep", ltcoBefore: "三年成为行业第一", ltcoAfter: "三年成为行业第一", planExisted: false } } });
      await c.t.monthlyPlans!.idle();
      expect(await c.t.sql("SELECT ltco, version FROM company_strategy_config")).toEqual([{ ltco: "三年成为行业第一", version: 1 }]);
      expect((await c.t.sql("SELECT period FROM monthly_plans ORDER BY period")).map((row) => row.period)).toEqual([PERIOD, "2026-10"]);
      expect(c.planAgent.calls).toHaveLength(1);
      const previous = c.planAgent.calls[0].previousReview!;
      expect(previous.period).toBe(PERIOD);
      expect(previous.judgments).toHaveLength(5);
      expect(previous.items.map((entry) => entry.subjectId)).toEqual(["growth", CAPABILITY_ID]);
      expect(previous.items[0].selfReview?.judgments.text).toContain("交付节奏落后两周");
      // 已关闭的复盘不再出现在通知里
      expect((await c.t.app.inject({ method: "GET", url: "/api/me/monthly-reviews", headers: { cookie: c.ceo } })).json().notices).toEqual([]);
    } finally {
      await c.t.close();
    }
  });

  it("revises the LTCO in strategy config and does not recreate an existing next-month plan", async () => {
    const c = await setup();
    try {
      await toLtcoPending(c);
      await c.t.monthlyPlans!.createForPeriod("2026-10");
      await c.t.monthlyPlans!.idle();
      expect(c.planAgent.calls).toHaveLength(1);
      const review = (await overview(c)).json().review;
      const decided = await execute(c, c.ceo, actionId(review, "monthly-review.decide_ltco"), { decision: "revise", ltco: "两年成为行业第一" });
      expect(decided.json().review.ltco).toMatchObject({ current: "两年成为行业第一", decision: { decision: "revise", ltcoBefore: "三年成为行业第一", ltcoAfter: "两年成为行业第一", planExisted: true } });
      await c.t.monthlyPlans!.idle();
      expect(await c.t.sql("SELECT ltco, version FROM company_strategy_config")).toEqual([{ ltco: "两年成为行业第一", version: 2 }]);
      expect(await c.t.sql("SELECT id FROM monthly_plans WHERE period = '2026-10'")).toHaveLength(1);
      expect(c.planAgent.calls).toHaveLength(1);
    } finally {
      await c.t.close();
    }
  });

  it("revises only unit goals, rejects unchanged revisions and unknown subjects", async () => {
    const c = await setup();
    try {
      await toLtcoPending(c);
      let review = (await overview(c)).json().review;
      expect(review.ltco.units.map((unit: any) => [unit.subjectType, unit.subjectId])).toEqual([
        ["battlefield", "growth"], ["capability", CAPABILITY_ID],
      ]);
      const decide = actionId(review, "monthly-review.decide_ltco");
      const unchanged = await execute(c, c.ceo, decide, { decision: "revise", ltco: "三年成为行业第一" });
      expect(unchanged.statusCode).toBe(400);
      expect(unchanged.json().code).toBe("LTCO_NOTHING_CHANGED");
      const unknown = await execute(c, c.ceo, decide, { decision: "revise", units: [{ subjectType: "capability", subjectId: "missing", sixMonthOutcome: "新目标" }] });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().code).toBe("INVALID_SUBJECT");
      const decided = await execute(c, c.ceo, decide, { decision: "revise", units: [
        { subjectType: "battlefield", subjectId: "growth", sixMonthOutcome: "灯塔项目新长期目标" },
        { subjectType: "capability", subjectId: CAPABILITY_ID, sixMonthOutcome: "交付能力新长期目标" },
      ] });
      expect(decided.statusCode).toBe(200);
      review = decided.json().review;
      expect(review.ltco.current).toBe("三年成为行业第一");
      expect(review.ltco.decision.units).toEqual([
        expect.objectContaining({ subjectType: "battlefield", subjectId: "growth", after: "灯塔项目新长期目标" }),
        { subjectType: "capability", subjectId: CAPABILITY_ID, before: "端到端交付六个月目标", after: "交付能力新长期目标" },
      ]);
      expect(await c.t.sql("SELECT six_month_outcome, version FROM battlefield_config WHERE id = 'growth'")).toEqual([
        expect.objectContaining({ six_month_outcome: "灯塔项目新长期目标", version: 2 }),
      ]);
      expect(await c.t.sql("SELECT six_month_outcome, version FROM capability_config WHERE id = $1", [CAPABILITY_ID])).toEqual([
        { six_month_outcome: "交付能力新长期目标", version: 2 },
      ]);
      expect((await c.t.sql("SELECT ltco, version FROM company_strategy_config"))[0]).toEqual({ ltco: "三年成为行业第一", version: 1 });
    } finally { await c.t.close(); }
  });
});

describe("MonthlyReview action concurrency", () => {
  it("rejects stale versions and replays the same action without writing twice", async () => {
    const c = await setup();
    try {
      const { growthId } = await openReview(c);
      const update = actionId(await item(c, growthId, c.member), "monthly-review-item.update");
      const input = { fields: [{ field: "nextFocus", text: "第一次" }] };
      const first = await execute(c, c.member, update, input);
      expect(first.statusCode).toBe(200);
      const version = first.json().item.version;
      const replay = await execute(c, c.member, update, input);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().item.version).toBe(version);
      const stale = await execute(c, c.member, update, { fields: [{ field: "nextFocus", text: "第二次" }] });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("VERSION_CONFLICT");
      expect((await item(c, growthId, c.member)).selfReview.nextFocus.text).toBe("第一次");
      expect((await execute(c, c.member, "forged.token")).statusCode).toBe(404);
    } finally {
      await c.t.close();
    }
  });
});

describe("MonthlyReview reads and notices", () => {
  it("lets an in-period Mission owner discuss without edit actions and includes comments in agent inputs", async () => {
    const c = await setup();
    try {
      const { growthId, capId } = await openReview(c);
      const comment = (body: string, clientId: string) => c.t.app.inject({ method: "POST", url: `/api/monthly-review-items/${capId}/comments`,
        headers: { cookie: c.member, origin: c.t.publicOrigin }, payload: { clientId, body } });
      expect((await readItem(c, capId, c.member)).statusCode).toBe(404);
      expect((await comment("看不到", randomUUID())).statusCode).toBe(404);
      await c.t.sql(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, battlefield_ids, outcome, source_ref, source_document_id, source_revision, source_title)
        VALUES ('review-participant', 1, 'review-participant', $1, '能力域 Mission', $2, $3, '[]', '目标', 'test', 'test', 1, 'test')`,
      [PERIOD, TEST_MEMBER.personId, CAPABILITY_ID]);
      const participant = await item(c, capId, c.member);
      expect(participant.viewer).toEqual({ isOwner: false, isCeo: false, isParticipant: true, canComment: true });
      expect(participant.participantNames).toEqual(["测试乙"]);
      expect(participant.actions).toEqual([]);
      expect((await c.t.app.inject({ method: "GET", url: `/api/conversations/monthly-review-item:${capId}/messages`, headers: { cookie: c.member } })).statusCode).toBe(200);
      expect(await proposeMonthlyReviewSuggestion(c.t.pool, capId, MEMBER_VIEWER,
        { field: "overall", text: "不能编辑", rationale: "" }, SEPT_15)).toMatchObject({ error: "FORBIDDEN" });
      const notices = (await c.t.app.inject({ method: "GET", url: "/api/me/monthly-reviews", headers: { cookie: c.member } })).json().notices;
      expect(notices).toContainEqual(expect.objectContaining({ kind: "item_participant",
        text: "9 月复盘 · 07 交付能力 · 邀请你讨论补充", href: `/me/reviews/items/${capId}` }));
      const clientId = randomUUID();
      const first = await comment("补充交付证据", clientId);
      expect(first.statusCode).toBe(200);
      expect((await comment("补充交付证据", clientId)).json()).toEqual(first.json());
      expect((await comment("改写同一个 clientId", clientId)).statusCode).toBe(409);
      expect((await item(c, capId, c.member)).comments).toEqual([first.json().comment]);
      await submit(c, capId, c.ceo);
      expect(c.agents.calls.assess.find((input) => input.subject.id === CAPABILITY_ID)?.comments).toEqual([
        expect.objectContaining({ author: TEST_MEMBER.personId, body: "补充交付证据" }),
      ]);
      await submit(c, growthId, c.member);
      await confirm(c, capId);
      expect((await comment("确认后", randomUUID())).statusCode).toBe(409);
      expect((await item(c, capId, c.member)).viewer.canComment).toBe(false);
      await confirm(c, growthId);
      expect(c.agents.calls.summarize[0].items.find((entry) => entry.subjectId === CAPABILITY_ID)?.comments).toEqual([
        expect.objectContaining({ body: "补充交付证据" }),
      ]);
    } finally { await c.t.close(); }
  });

  it("limits item reads to owner and CEO and projects notices for each", async () => {
    const c = await setup();
    try {
      const { growthId, capId } = await openReview(c);
      expect((await readItem(c, capId, c.member)).statusCode).toBe(404);
      expect((await readItem(c, "not-a-uuid", c.ceo)).statusCode).toBe(404);
      expect((await readItem(c, growthId, c.ceo)).statusCode).toBe(200);
      // 对话范围同样只给负责人和 CEO
      const conversation = (itemId: string, cookie: string) =>
        c.t.app.inject({ method: "GET", url: `/api/conversations/monthly-review-item:${itemId}/messages`, headers: { cookie } });
      expect((await conversation(growthId, c.member)).statusCode).toBe(200);
      expect((await conversation(capId, c.member)).statusCode).toBe(404);
      expect((await conversation(capId, c.ceo)).statusCode).toBe(200);

      const notices = async (cookie: string) =>
        (await c.t.app.inject({ method: "GET", url: "/api/me/monthly-reviews", headers: { cookie } })).json().notices;
      expect(await notices(c.member)).toEqual([expect.objectContaining({
        id: `monthly-review-item:${growthId}:todo`, kind: "item_todo", period: PERIOD,
        text: "9 月复盘待你完成 · 01 灯塔项目", href: `/me/reviews/items/${growthId}`,
      })]);
      expect(await notices(c.ceo)).toEqual([expect.objectContaining({
        kind: "item_todo", text: "9 月复盘待你完成 · 07 交付能力", href: `/reviews/items/${capId}`,
      })]);

      await submit(c, growthId, c.member);
      expect(await notices(c.member)).toEqual([]);
      const ceoNotices = await notices(c.ceo);
      expect(ceoNotices.map((notice: any) => [notice.kind, notice.text, notice.href])).toEqual([
        ["item_todo", "9 月复盘待你完成 · 07 交付能力", `/reviews/items/${capId}`],
        ["items_to_review", "9 月复盘：1 项待你处理", "/reviews/2026-09"],
      ]);
      await execute(c, c.ceo, actionId(await item(c, growthId, c.ceo), "monthly-review-item.return"), { reason: "再补证据" });
      expect((await notices(c.member)).map((notice: any) => notice.text)).toEqual(["9 月复盘被打回 · 01 灯塔项目"]);
    } finally {
      await c.t.close();
    }
  });
});

describe("Capability owner", () => {
  it("accepts ownerId on create and patch and projects the display name", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.loginCookie();
      const post = (payload: unknown) => t.app.inject({ method: "POST", url: "/api/config/capabilities", headers: { cookie, origin: t.publicOrigin }, payload });
      const base = { code: "08", sortOrder: 20, name: "研发能力", sixMonthOutcome: "六个月目标" };
      expect((await post({ ...base, ownerId: "person-unknown" })).statusCode).toBe(400);
      const created = await post({ ...base, ownerId: TEST_MEMBER.personId });
      expect(created.statusCode).toBe(201);
      const id = created.json().cards[0].objectRef.id as string;
      const list = async () => (await t.app.inject({ method: "GET", url: "/api/config/capabilities", headers: { cookie } })).json().capabilities
        .find((row: any) => row.id === id);
      expect(await list()).toMatchObject({ ownerId: TEST_MEMBER.personId, ownerDisplayName: "测试乙" });
      const patch = (payload: unknown) => t.app.inject({ method: "PATCH", url: `/api/config/capabilities/${id}`, headers: { cookie, origin: t.publicOrigin }, payload });
      expect((await patch({ ownerId: "person-unknown" })).statusCode).toBe(400);
      expect((await patch({ ownerId: "" })).statusCode).toBe(200);
      expect(await list()).toMatchObject({ ownerId: "", ownerDisplayName: "" });
      expect((await patch({ name: "研发能力二" })).statusCode).toBe(200);
      expect(await list()).toMatchObject({ ownerId: "", name: "研发能力二" });
    } finally {
      await t.close();
    }
  });
});
