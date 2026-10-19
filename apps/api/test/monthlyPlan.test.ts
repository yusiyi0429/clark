import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  MonthlyPlanCardPayload,
  type TMonthlyDraftCandidate,
} from "@warmap/contracts";
import { buildApp } from "../src/app.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { createCompanyContext } from "../src/companyContext.js";
import { migrate } from "../src/migrate.js";
import { createMonthlyPlanService, type MonthlyDraftAgent, type MonthlyDraftAgentInput } from "../src/monthlyDraft.js";
import { signActionId } from "../src/actionToken.js";
import { createTestApp, createTestDb, seedTestAccess, testEnv, TEST_LOGIN, type TestApp } from "./helpers.js";

type FakeAgent = MonthlyDraftAgent & { calls: MonthlyDraftAgentInput[] };

const CAPABILITY_ID = "cap-delivery";

/** 当月能力 PCO 只能引用已登记能力，所以测试先落一条 CapabilityConfig。 */
async function seedCapability(t: TestApp): Promise<void> {
  await t.sql(
    `INSERT INTO capability_config (id, version, code, sort_order, name, "group", six_month_outcome)
     VALUES ($1, 1, '01', 10, '交付能力', '交付组织', '端到端交付六个月目标') ON CONFLICT (id) DO NOTHING`,
    [CAPABILITY_ID],
  );
}

function validCandidate(): TMonthlyDraftCandidate {
  return {
    companyOutcome: "完成渠道结构切换，锁定下半年交付节奏",
    battlefields: [{ battlefieldId: "growth", outcome: "增长战场完成渠道切换" }],
    capabilities: [{ capabilityId: CAPABILITY_ID, outcome: "交付能力完成第一个真实客户交付" }],
    todos: [
      {
        battlefieldId: "growth",
        title: "完成渠道合同复核",
        ownerId: "person-fixture-002",
        dueAt: "2026-06-20T00:00:00.000+08:00",
        sourceRef: "issue:00000000-0000-4000-8000-000000000001:decision",
      },
      { title: "整理公司级复盘材料", ownerId: "person-fixture-002", sourceRef: "monthly-plan:2026-05" },
    ],
  };
}

function fakeAgent(result: () => unknown = validCandidate): FakeAgent {
  const agent = {
    calls: [] as MonthlyDraftAgentInput[],
    async generate(input: MonthlyDraftAgentInput) {
      agent.calls.push(input);
      return { candidate: result(), runId: `draft-run-${agent.calls.length}` };
    },
  };
  return agent;
}

async function card(t: TestApp, cookie: string, planId: string): Promise<Record<string, any>> {
  const response = await t.app.inject({ method: "GET", url: `/api/cards/monthly-plans/${planId}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json().cards[0];
}

async function planAction(t: TestApp, cookie: string, planId: string, actionType: string): Promise<string> {
  const descriptor = (await card(t, cookie, planId)).actions.find((action: { actionType: string }) => action.actionType === actionType);
  expect(descriptor, `monthly plan 应提供 ${actionType}`).toBeTruthy();
  return descriptor.actionId as string;
}

async function execute(t: TestApp, cookie: string, actionId: string, input?: unknown) {
  return t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId, input },
  });
}

/** 创建当前 period 的 draft 并等待在途生成结束。 */
async function readyPlan(t: TestApp): Promise<string> {
  await seedCapability(t);
  const result = await t.monthlyPlans!.runScheduled();
  await t.monthlyPlans!.idle();
  expect(result.status).toBe("created");
  return result.planId!;
}

async function waitForGeneration(t: TestApp, planId: string, status: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const rows = await t.sql("SELECT generation->>'status' AS status FROM monthly_plans WHERE id = $1", [planId]);
    if (rows[0]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`plan ${planId} did not reach generation ${status}`);
}

async function driFeedback(t: TestApp, url: string, payload: unknown, token = t.env.driServiceToken) {
  return t.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
}

describe("MonthlyPlan Company Day scheduler", () => {
  it("creates at most one plan per Asia/Shanghai period and only catches up the missing period", async () => {
    const agent = fakeAgent();
    let now = new Date("2026-06-15T02:00:00Z"); // 上海 2026-06-15 10:00
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => now });
    try {
      const first = await t.monthlyPlans!.runScheduled();
      await t.monthlyPlans!.idle();
      expect(first).toMatchObject({ period: "2026-06", status: "created" });
      expect(await t.sql("SELECT period FROM monthly_plans")).toEqual([{ period: "2026-06" }]);
      expect((await t.sql("SELECT version FROM monthly_plans"))[0].version).toBeGreaterThan(1);

      // 重复触发不产生副本
      expect((await t.monthlyPlans!.runScheduled()).status).toBe("skipped");
      expect(await t.sql("SELECT id FROM monthly_plans")).toHaveLength(1);

      // 公司月跨月后为新的 period 创建，已有 period 保持不变
      now = new Date("2026-06-30T16:30:00Z"); // 上海 2026-07-01 00:30
      const next = await t.monthlyPlans!.runScheduled();
      await t.monthlyPlans!.idle();
      expect(next).toMatchObject({ period: "2026-07", status: "created" });
      expect((await t.sql("SELECT period FROM monthly_plans ORDER BY period")).map((row) => row.period)).toEqual(["2026-06", "2026-07"]);
    } finally {
      await t.close();
    }
  });
});

describe("MonthlyDraft Agent", () => {
  it("saves a strictly validated Candidate Material and keeps failure visible until an explicit retry", async () => {
    let calls = 0;
    const agent = fakeAgent(() => {
      calls += 1;
      // 第一次返回越界 candidate：模型不能靠散文或多余字段写入业务字段
      return calls === 1 ? { ...validCandidate(), extra: true } : validCandidate();
    });
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      let current = await card(t, cookie, planId);
      expect(Value.Check(MonthlyPlanCardPayload, current.payload)).toBe(true);
      expect(current.payload.generation.status).toBe("failed");
      expect(current.payload.generation.error.code).toBe("invalid_monthly_candidate");
      // 失败不静默生成空计划
      expect(current.payload.companyOutcome).toBe("");
      expect(current.payload.todos).toEqual([]);
      expect(calls).toBe(1); // 没有自动重试

      const retried = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.retry_draft"));
      expect(retried.statusCode).toBe(200);
      expect(retried.json().cards[0].payload.generation.status).toBe("running");
      await t.monthlyPlans!.idle();
      current = await card(t, cookie, planId);
      expect(current.payload.generation.status).toBe("ready");
      expect(current.payload.companyOutcome).toBe(validCandidate().companyOutcome);
      expect(current.payload.capabilities).toEqual([{ capabilityId: CAPABILITY_ID, outcome: "交付能力完成第一个真实客户交付" }]);
      expect(current.payload.todos.map((todo: { title: string }) => todo.title)).toEqual([
        "完成渠道合同复核",
        "整理公司级复盘材料",
      ]);
      expect(calls).toBe(2);

      // 未签发且生成成功后仍可由 CEO 主动重新生成
      const retryAction = (await card(t, cookie, planId)).actions.find((action: { actionType: string }) => action.actionType === "monthly-plan.retry_draft");
      expect(retryAction).toBeTruthy();
    } finally {
      await t.close();
    }
  });

  it("replaces a ready draft, clears its edits and checks, and replays one action only once", async () => {
    let revision = 0;
    const agent = fakeAgent(() => ({ ...validCandidate(), companyOutcome: `草案第 ${++revision} 版` }));
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const changed = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        companyOutcome: "CEO 修改版", note: "保留原核对", checkedItemIds: ["company"],
      });
      expect(changed.statusCode).toBe(200);
      const checked = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        checkedItemIds: ["company"],
      });
      expect(checked.statusCode).toBe(200);
      const retryAction = await planAction(t, cookie, planId, "monthly-plan.retry_draft");
      expect((await execute(t, cookie, retryAction)).statusCode).toBe(200);
      expect((await execute(t, cookie, retryAction)).statusCode).toBe(200);
      await t.monthlyPlans!.idle();
      const current = await card(t, cookie, planId);
      expect(current.payload.companyOutcome).toBe("草案第 2 版");
      expect(current.payload.status).toBe("draft");
      expect(current.payload.negotiation).toMatchObject({ edits: [], checkedItemIds: [], note: "" });
      expect(agent.calls).toHaveLength(2);
      expect(current.actions.some((action: { actionType: string }) => action.actionType === "monthly-plan.retry_draft")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("keeps the previous draft and checks when regeneration fails", async () => {
    let revision = 0;
    const agent = fakeAgent(() => ++revision === 1 ? validCandidate() : { ...validCandidate(), extra: true });
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const checked = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        checkedItemIds: ["company"], note: "CEO 原备注",
      });
      expect(checked.statusCode).toBe(200);
      const before = (await card(t, cookie, planId)).payload;
      expect((await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.retry_draft"))).statusCode).toBe(200);
      await t.monthlyPlans!.idle();
      const after = (await card(t, cookie, planId)).payload;
      expect(after.generation.status).toBe("failed");
      expect(after.companyOutcome).toBe(before.companyOutcome);
      expect(after.todos).toEqual(before.todos);
      expect(after.negotiation).toEqual(before.negotiation);
    } finally {
      await t.close();
    }
  });

  it("feeds confirmed directions, last period review and DRI feedback into the Draft Agent", async () => {
    const agent = fakeAgent();
    let now = new Date("2026-05-15T02:00:00Z");
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => now });
    try {
      const mayPlanId = await readyPlan(t);
      // 上月 DRI 反馈
      expect(
        (
          await driFeedback(t, "/api/dri/monthly-feedback", {
            externalId: "dri-retro-may",
            period: "2026-05",
            submitterPersonId: "person-fixture-002",
            sourceRef: "dri://retro/may",
            text: "渠道复核已完成",
            observedAt: "2026-05-20T00:00:00.000Z",
          })
        ).statusCode,
      ).toBe(201);
      // 已确认方向：DRI Issue → CEO 直接决定
      const cookie = await t.loginCookie();
      const imported = await t.app.inject({
        method: "POST",
        url: "/api/dri/issues",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` },
        payload: {
          externalId: "dri-issue-may",
          submitterPersonId: "person-fixture-002",
          title: "月球基地渠道投入是否调整",
          whyNow: "渠道窗口在六月关闭",
          sourceRef: "dri://planning/may",
          location: { level: "battlefield", battlefieldId: "growth" },
        },
      });
      const issue = imported.json().cards[0];
      const decide = issue.actions.find((action: { actionType: string }) => action.actionType === "issue.decide_override");
      const decided = await execute(t, cookie, decide.actionId, { decisionText: "六月前完成渠道投入调整", confirmOverride: true });
      expect(decided.statusCode).toBe(200);

      now = new Date("2026-06-01T02:00:00Z");
      await readyPlan(t);
      const input = agent.calls[1];
      expect(input.period).toBe("2026-06");
      expect(input.confirmedDirections).toEqual([
        expect.objectContaining({ title: "月球基地渠道投入是否调整", decisionText: "六月前完成渠道投入调整" }),
      ]);
      // 本体公司事实随已确认方向读取；测试环境没配后台授权人员，如实标出没读到，不用本地资料补
      expect(input.companyMemory).toEqual([]);
      expect(input.companyStatus).toBe("coverage_unavailable");
      expect(input.previousPlan).toMatchObject({ period: "2026-05" });
      expect(input.driFeedback).toEqual([expect.objectContaining({ externalId: "dri-retro-may", text: "渠道复核已完成" })]);
      expect(mayPlanId).toBeTruthy();
    } finally {
      await t.close();
    }
  });

  it("把 Company LTCO 与按 sortOrder 的战场长期目标/Mission 注入 Draft Agent input", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      await t.sql("UPDATE company_strategy_config SET ltco = $1 WHERE id = 'default'", ["用 Agent 重做组织结构，让每块战场都有负责人。"]);
      await t.sql("UPDATE battlefield_config SET code = '02', sort_order = 20, mission_anchors = $1::jsonb WHERE id = 'growth'", [
        JSON.stringify([{ code: "02-1", title: "TokenHub 进入生产化使用" }]),
      ]);
      await t.sql(
        `INSERT INTO battlefield_config (id, version, code, sort_order, name, six_month_outcome, mission_anchors)
         VALUES ('north', 1, '01', 10, '北方战场', '北方战场六个月目标', $1::jsonb)`,
        [JSON.stringify([{ code: "01-1", title: "未来组织范式设计与确认" }])],
      );
      await readyPlan(t);
      const input = agent.calls[0];
      expect(input.ltco).toBe("用 Agent 重做组织结构，让每块战场都有负责人。");
      // 按 sortOrder 升序，Mission 一并进入 input（真实进入 Agent 而不是只写在 prompt 里）
      expect(input.battlefields).toEqual([
        {
          battlefieldId: "north",
          code: "01",
          name: "北方战场",
          sixMonthOutcome: "北方战场六个月目标",
          missionAnchors: [{ code: "01-1", title: "未来组织范式设计与确认" }],
        },
        {
          battlefieldId: "growth",
          code: "02",
          name: "增长战场",
          sixMonthOutcome: "验证渠道结构与交付节奏，形成可复制的增长路径。",
          missionAnchors: [{ code: "02-1", title: "TokenHub 进入生产化使用" }],
        },
      ]);
    } finally {
      await t.close();
    }
  });
});

describe("MonthlyPlan negotiation", () => {
  it("edits company outcome, battlefield outcomes, ordinary todos and checks through a versioned Action", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const initial = await card(t, cookie, planId);
      expect(initial.payload.status).toBe("draft");

      const edit = {
        companyOutcome: "CEO 调整后的公司结果",
        battlefields: [{ battlefieldId: "growth", outcome: "增长战场聚焦渠道切换" }],
        todos: [
          { battlefieldId: "growth", title: "渠道合同复核", ownerId: "person-fixture-002", sourceRef: "issue:decision-1" },
          { title: "公司级复盘材料", ownerId: "person-fixture-002", sourceRef: "monthly-plan:2026-05" },
        ],
        note: "先对齐渠道，再复盘",
      };
      const updated = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), edit);
      expect(updated.statusCode).toBe(200);
      let current = updated.json().cards[0];
      expect(current.version).toBe(initial.version + 1);
      expect(current.payload.status).toBe("negotiating");
      expect(current.payload.companyOutcome).toBe(edit.companyOutcome);
      expect(current.payload.battlefields).toEqual(edit.battlefields);
      expect(current.payload.negotiation.note).toBe(edit.note);
      expect(current.payload.negotiation.edits.at(-1).fields).toEqual(
        expect.arrayContaining(["companyOutcome", "battlefields", "todos", "note"]),
      );

      const todos = current.payload.todos;
      expect(todos).toHaveLength(2);
      expect(todos[0]).toMatchObject({ battlefieldId: "growth", ownerId: "person-fixture-002", sourceRef: "issue:decision-1" });
      // 空 battlefieldId 表示公司级；不能通过 owner 反推战场
      expect(todos[1].battlefieldId).toBeUndefined();
      expect(todos[1].ownerId).toBe("person-fixture-002");
      expect(todos[1].sourceRef).toBe("monthly-plan:2026-05");
      // todo 没有执行状态
      expect(Object.keys(todos[1])).not.toContain("status");

      // 核对项必须是当前计划中的真实条目
      const check = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        checkedItemIds: ["company", `battlefield:growth`, `capability:${CAPABILITY_ID}`, `todo:${todos[0].id}`],
      });
      expect(check.statusCode).toBe(200);
      current = check.json().cards[0];
      expect(current.payload.negotiation.checkedItemIds).toEqual(["company", "battlefield:growth", `capability:${CAPABILITY_ID}`, `todo:${todos[0].id}`]);

      const badCheck = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        checkedItemIds: ["todo:not-a-todo"],
      });
      expect(badCheck.statusCode).toBe(400);
      expect(badCheck.json().code).toBe("INVALID_CHECKED_ITEM");
    } finally {
      await t.close();
    }
  });

  it("clears the check of the fields the CEO edits", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const initial = await card(t, cookie, planId);
      const todoId = initial.payload.todos[0].id as string;
      const checked = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        checkedItemIds: ["company", "battlefield:growth", `todo:${todoId}`],
      });
      expect(checked.json().cards[0].payload.negotiation.checkedItemIds).toEqual(["company", "battlefield:growth", `todo:${todoId}`]);

      // 被编辑的字段重新回到未核对；未编辑的战场核对保留
      const edited = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        companyOutcome: "改写后的公司结果",
        todos: [{ title: "新的公司级待办", ownerId: "person-fixture-002", sourceRef: "monthly-plan:2026-05" }],
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().cards[0].payload.negotiation.checkedItemIds).toEqual(["battlefield:growth"]);
    } finally {
      await t.close();
    }
  });

  it("refuses to edit while the draft is still generating", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent: MonthlyDraftAgent = {
      async generate() {
        await gate;
        return { candidate: validCandidate(), runId: "run-gated" };
      },
    };
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      await seedCapability(t);
      const created = await t.monthlyPlans!.runScheduled();
      const planId = created.planId!;
      await waitForGeneration(t, planId, "running");
      const cookie = await t.loginCookie();
      const current = await card(t, cookie, planId);
      // 生成中不提供会在写回时被静默覆盖的编辑 Action
      expect(current.actions.some((action: { actionType: string }) => action.actionType === "monthly-plan.update_draft")).toBe(false);
      const actionId = signActionId(t.env.sessionSecret, {
        actionType: "monthly-plan.update_draft",
        objectType: "monthly-plan",
        objectId: planId,
        objectVersion: current.version,
      });
      const refused = await execute(t, cookie, actionId, { note: "生成中" });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("MONTHLY_PLAN_DRAFT_RUNNING");
      release();
      await t.monthlyPlans!.idle();
    } finally {
      release?.();
      await t.monthlyPlans!.idle();
      await t.close();
    }
  });

  it("rejects unknown todo owners and stale versions, returning the latest Card", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const initial = await card(t, cookie, planId);
      const actionId = await planAction(t, cookie, planId, "monthly-plan.update_draft");

      const unknownOwner = await execute(t, cookie, actionId, {
        todos: [{ title: "无主待办", ownerId: "person-unknown", sourceRef: "dri://x" }],
      });
      expect(unknownOwner.statusCode).toBe(400);
      expect(unknownOwner.json().code).toBe("INVALID_OWNER");

      const accepted = await execute(t, cookie, actionId, { note: "第一版" });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().cards[0].version).toBe(initial.version + 1);

      // 同一 action 同一 input 幂等重放，不产生第二次编辑
      const replay = await execute(t, cookie, actionId, { note: "第一版" });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().cards[0].version).toBe(initial.version + 1);

      // 同一 stale action 不同 input：version 冲突并返回最新 Card
      const conflict = await execute(t, cookie, actionId, { note: "第二版" });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("VERSION_CONFLICT");
      expect(conflict.json().latestCard.version).toBe(initial.version + 1);
      expect(conflict.json().latestCard.payload.negotiation.note).toBe("第一版");
    } finally {
      await t.close();
    }
  });

  it("edits and checks the capability PCO, and rejects an unregistered capabilityId", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const initial = await card(t, cookie, planId);
      // 六个月目标只来自 CapabilityConfig，当月 PCO 不复制它
      expect(initial.payload.capabilities).toEqual([{ capabilityId: CAPABILITY_ID, outcome: "交付能力完成第一个真实客户交付" }]);
      expect(agent.calls[0].capabilities).toEqual([{ capabilityId: CAPABILITY_ID, name: "交付能力", sixMonthOutcome: "端到端交付六个月目标" }]);

      const edited = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        capabilities: [{ capabilityId: CAPABILITY_ID, outcome: "交付能力完成第二次真实客户交付" }],
      });
      expect(edited.statusCode).toBe(200);
      let current = edited.json().cards[0];
      expect(current.payload.capabilities).toEqual([{ capabilityId: CAPABILITY_ID, outcome: "交付能力完成第二次真实客户交付" }]);
      expect(current.payload.negotiation.edits.at(-1).fields).toContain("capabilities");

      const check = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        checkedItemIds: ["company", "battlefield:growth", `capability:${CAPABILITY_ID}`],
      });
      expect(check.statusCode).toBe(200);
      current = check.json().cards[0];
      expect(current.payload.negotiation.checkedItemIds).toEqual(["company", "battlefield:growth", `capability:${CAPABILITY_ID}`]);

      // 编辑能力结果会重新回到未核对，未编辑的公司/战场核对保留
      const cleared = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        capabilities: [{ capabilityId: CAPABILITY_ID, outcome: "第三次" }],
      });
      expect(cleared.json().cards[0].payload.negotiation.checkedItemIds).toEqual(["company", "battlefield:growth"]);

      const unknown = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        capabilities: [{ capabilityId: "cap-unknown", outcome: "未登记能力结果" }],
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().code).toBe("INVALID_CAPABILITY");
    } finally {
      await t.close();
    }
  });
});

describe("DRI monthly feedback", () => {
  it("appends externalId-deduplicated narrative feedback to the same MonthlyPlan behind the service token", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      const planId = await readyPlan(t);
      const payload = {
        externalId: "dri-feedback-1",
        period: "2026-06",
        submitterPersonId: "person-fixture-002",
        sourceRef: "dri://retro/1",
        text: "渠道复核已完成，需要下月资源",
        evidenceRef: "dri://evidence/1",
        observedAt: "2026-06-10T00:00:00.000Z",
        battlefieldId: "growth",
      };
      expect((await driFeedback(t, "/api/dri/monthly-feedback", payload, "wrong-token")).statusCode).toBe(401);
      expect((await t.app.inject({ method: "POST", url: "/api/dri/monthly-feedback", payload })).statusCode).toBe(401);

      const created = await driFeedback(t, "/api/dri/monthly-feedback", payload);
      expect(created.statusCode).toBe(201);
      let current = created.json().cards[0];
      expect(current.objectRef.id).toBe(planId);
      expect(current.payload.status).toBe("negotiating");
      expect(current.payload.negotiation.feedback).toHaveLength(1);
      const [feedback] = current.payload.negotiation.feedback;
      expect(feedback).toMatchObject({
        externalId: "dri-feedback-1",
        battlefieldId: "growth",
        text: payload.text,
        evidenceRef: payload.evidenceRef,
        observedAt: payload.observedAt,
        sourceRef: payload.sourceRef,
      });
      // 只包含文本、证据和 observedAt，没有 todo 执行状态
      expect(Object.keys(feedback).sort()).toEqual(
        ["battlefieldId", "evidenceRef", "externalId", "id", "observedAt", "sourceRef", "text"].sort(),
      );

      const replay = await driFeedback(t, "/api/dri/monthly-feedback", payload);
      expect(replay.statusCode).toBe(200);
      current = replay.json().cards[0];
      expect(current.payload.negotiation.feedback).toHaveLength(1);
      expect(current.payload.negotiation.feedback[0].id).toBe(feedback.id);

      const conflict = await driFeedback(t, "/api/dri/monthly-feedback", { ...payload, text: "不同内容" });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("DRI_FEEDBACK_EXTERNAL_ID_CONFLICT");
    } finally {
      await t.close();
    }
  });

  it("refuses DRI feedback on a confirmed plan", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      const planId = await readyPlan(t);
      await t.sql("UPDATE monthly_plans SET status = 'confirmed' WHERE id = $1", [planId]);
      const refused = await driFeedback(t, "/api/dri/monthly-feedback", {
        externalId: "dri-confirmed-1",
        period: "2026-06",
        submitterPersonId: "person-fixture-002",
        sourceRef: "dri://retro/4",
        text: "签发后反馈",
        observedAt: "2026-06-12T00:00:00.000Z",
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("MONTHLY_PLAN_CONFIRMED");
    } finally {
      await t.close();
    }
  });

  it("appends todo feedback without changing todo state and rejects unknown period, todo or submitter", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent, monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const before = await card(t, cookie, planId);
      const todoId = before.payload.todos[0].id as string;

      const created = await driFeedback(t, "/api/dri/todo-feedback", {
        externalId: "dri-todo-1",
        period: "2026-06",
        submitterPersonId: "person-fixture-002",
        sourceRef: "dri://todo/1",
        todoId,
        text: "合同复核还在进行",
        observedAt: "2026-06-12T00:00:00.000Z",
      });
      expect(created.statusCode).toBe(201);
      const after = created.json().cards[0];
      expect(after.payload.negotiation.feedback[0]).toMatchObject({ todoId, text: "合同复核还在进行" });
      // feedback 不修改 todo 本身
      expect(after.payload.todos).toEqual(before.payload.todos);

      const unknownTodo = await driFeedback(t, "/api/dri/todo-feedback", {
        externalId: "dri-todo-2",
        period: "2026-06",
        submitterPersonId: "person-fixture-002",
        sourceRef: "dri://todo/2",
        todoId: "todo-not-exist",
        text: "x",
        observedAt: "2026-06-12T00:00:00.000Z",
      });
      expect(unknownTodo.statusCode).toBe(400);
      expect(unknownTodo.json().code).toBe("INVALID_TODO");

      const unknownPeriod = await driFeedback(t, "/api/dri/monthly-feedback", {
        externalId: "dri-period-1",
        period: "2026-05",
        submitterPersonId: "person-fixture-002",
        sourceRef: "dri://retro/2",
        text: "x",
        observedAt: "2026-06-12T00:00:00.000Z",
      });
      expect(unknownPeriod.statusCode).toBe(422);
      expect(unknownPeriod.json().code).toBe("MONTHLY_PLAN_NOT_FOUND");

      const invalidPerson = await driFeedback(t, "/api/dri/monthly-feedback", {
        externalId: "dri-person-1",
        period: "2026-06",
        submitterPersonId: "person-fixture-001",
        sourceRef: "dri://retro/3",
        text: "x",
        observedAt: "2026-06-12T00:00:00.000Z",
      });
      expect(invalidPerson.statusCode).toBe(422);
      expect(invalidPerson.json().code).toBe("INVALID_SUBMITTER");
    } finally {
      await t.close();
    }
  });
});

describe("startup recovery of an interrupted MonthlyPlan draft", () => {
  it("marks an unfinished draft as failed on boot and does not auto retry", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const agent = fakeAgent();
      const service = createMonthlyPlanService({
        pool,
        peopleDirectory: loadPeopleDirectory(testEnv),
        company: createCompanyContext(testEnv),
        agent,
        now: () => new Date("2026-06-15T02:00:00Z"),
      });
      const app = await buildApp({ pool, env: testEnv, monthlyPlanService: service });
      try {
        const created = await service.runScheduled();
        await service.idle();
        const planId = created.planId!;
        // 模拟进程在草案运行前崩溃：单进程 runner 启动时任何未完成的 generation 都是中断
        await db.query("UPDATE monthly_plans SET generation = generation || $2::jsonb WHERE id = $1", [
          planId,
          JSON.stringify({ status: "pending", pendingSince: new Date().toISOString(), runId: null, error: null, generatedAt: null }),
        ]);
        expect(await service.recoverInterrupted()).toBe(1);

        await seedTestAccess(db);
        const login = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: testEnv.publicOrigin },
          payload: TEST_LOGIN,
        });
        const cookie = (login.headers["set-cookie"] as string).split(";")[0];
        const response = await app.inject({ method: "GET", url: `/api/cards/monthly-plans/${planId}`, headers: { cookie } });
        const current = response.json().cards[0];
        expect(current.payload.generation.status).toBe("failed");
        expect(current.payload.generation.error.code).toBe("monthly_draft_interrupted");
        expect(current.actions.some((action: { actionType: string }) => action.actionType === "monthly-plan.retry_draft")).toBe(true);

        // 再次恢复不重复改动，也不自动重跑 Agent
        expect(await service.recoverInterrupted()).toBe(0);
        expect(agent.calls).toHaveLength(1);
      } finally {
        await service.idle();
        await app.close();
      }
    });
  });
});

describe("MonthlyPlan projections", () => {
  it("reads Card, notification and Conversation scope from the same persisted MonthlyPlan", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { monthlyDraftAgent: agent });
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const detail = await card(t, cookie, planId);

      const notifications = await t.app.inject({ method: "GET", url: "/api/cards/notifications", headers: { cookie } });
      const notice = notifications.json().cards.find((candidate: { kind: string }) => candidate.kind === "monthly-plan");
      expect(notice).toBeTruthy();
      expect(notice.id).toBe(detail.id);
      expect(notice.version).toBe(detail.version);
      expect(notice.payload).toEqual(detail.payload);

      const scope = encodeURIComponent(`monthly-plan:${planId}`);
      const history = await t.app.inject({ method: "GET", url: `/api/conversations/${scope}/messages`, headers: { cookie } });
      expect(history.statusCode).toBe(200);
      expect(history.json().scope).toBe(`monthly-plan:${planId}`);

      const message = await t.app.inject({
        method: "POST",
        url: `/api/conversations/${scope}/messages`,
        headers: { cookie, origin: t.publicOrigin },
        payload: { message: "解释本月计划", references: [{ cardId: detail.id, version: detail.version }] },
      });
      expect(message.statusCode).toBe(200);

      const missing = await t.app.inject({
        method: "GET",
        url: `/api/conversations/${encodeURIComponent("monthly-plan:00000000-0000-4000-8000-000000000000")}/messages`,
        headers: { cookie },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
