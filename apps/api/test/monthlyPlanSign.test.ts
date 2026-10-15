import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  BattlefieldCardPayload,
  MonthlyPlanCardPayload,
  type TMonthlyDraftCandidate,
} from "@warmap/contracts";
import { createCompanyContext } from "../src/companyContext.js";
import { type MonthlyDraftAgent, type MonthlyDraftAgentInput } from "../src/monthlyDraft.js";
import { createTestApp, testEnv, type TestApp } from "./helpers.js";

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
        sourceRef: "issue:decision-1",
      },
      { title: "整理公司级复盘材料", ownerId: "person-fixture-002", sourceRef: "monthly-plan:2026-05" },
    ],
  };
}

function fakeAgent(candidate: TMonthlyDraftCandidate = validCandidate()): FakeAgent {
  const agent = {
    calls: [] as MonthlyDraftAgentInput[],
    async generate(input: MonthlyDraftAgentInput) {
      agent.calls.push(input);
      return { candidate, runId: `draft-run-${agent.calls.length}` };
    },
  };
  return agent;
}

function appWith(candidate?: TMonthlyDraftCandidate) {
  return createTestApp({}, undefined, { monthlyDraftAgent: fakeAgent(candidate), monthlyNow: () => new Date("2026-06-15T02:00:00Z") });
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

async function readyPlan(t: TestApp): Promise<string> {
  await seedCapability(t);
  const result = await t.monthlyPlans!.runScheduled();
  await t.monthlyPlans!.idle();
  expect(result.status).toBe("created");
  return result.planId!;
}

/** 核对 company、每个战场结果、每个能力结果与每个普通待办，满足签发前置条件。 */
async function checkAll(t: TestApp, cookie: string, planId: string): Promise<Record<string, any>> {
  const current = await card(t, cookie, planId);
  const checkedItemIds = [
    "company",
    ...current.payload.battlefields.map((battlefield: { battlefieldId: string }) => `battlefield:${battlefield.battlefieldId}`),
    ...current.payload.capabilities.map((capability: { capabilityId: string }) => `capability:${capability.capabilityId}`),
    ...current.payload.todos.map((todo: { id: string }) => `todo:${todo.id}`),
  ];
  const response = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), { checkedItemIds });
  expect(response.statusCode).toBe(200);
  return response.json().cards[0];
}

async function sign(t: TestApp, cookie: string, planId: string) {
  return execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.sign"));
}

async function driFeedback(t: TestApp, payload: unknown, token = t.env.driServiceToken) {
  return t.app.inject({ method: "POST", url: "/api/dri/monthly-feedback", headers: { authorization: `Bearer ${token}` }, payload });
}

/** 直接改持久状态，模拟被后续写入污染的草案，验证签发会重新校验而不是相信旧核对。 */
async function patchPlan(
  t: TestApp,
  planId: string,
  patch: { companyOutcome?: string; battlefields?: unknown; capabilities?: unknown; todos?: unknown; checkedItemIds?: string[] },
): Promise<void> {
  await t.sql(
    `UPDATE monthly_plans
        SET company_outcome = COALESCE($2, company_outcome),
            battlefields = COALESCE($3::jsonb, battlefields),
            capabilities = COALESCE($6::jsonb, capabilities),
            todos = COALESCE($4::jsonb, todos),
            negotiation = CASE WHEN $5::jsonb IS NULL THEN negotiation
                               ELSE jsonb_set(negotiation, '{checkedItemIds}', $5::jsonb) END
      WHERE id = $1`,
    [
      planId,
      patch.companyOutcome ?? null,
      patch.battlefields ? JSON.stringify(patch.battlefields) : null,
      patch.todos ? JSON.stringify(patch.todos) : null,
      patch.checkedItemIds ? JSON.stringify(patch.checkedItemIds) : null,
      patch.capabilities ? JSON.stringify(patch.capabilities) : null,
    ],
  );
}

async function battlefieldCard(t: TestApp, cookie: string, battlefieldId: string): Promise<Record<string, any>> {
  const response = await t.app.inject({ method: "GET", url: "/api/cards/battlefields", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  const found = response.json().cards.find((candidate: { objectRef: { id: string } }) => candidate.objectRef.id === battlefieldId);
  expect(found, `battlefield ${battlefieldId} 应有 Card`).toBeTruthy();
  return found;
}

describe("MonthlyPlan signing authority and validation", () => {
  it("only a CEO session can sign; service identity and incomplete checks are refused", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const actionId = await planAction(t, cookie, planId, "monthly-plan.sign");

      const anonymous = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { origin: t.publicOrigin },
        payload: { actionId },
      });
      expect(anonymous.statusCode).toBe(401);

      const service = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { authorization: `Bearer ${t.env.driServiceToken}`, origin: t.publicOrigin },
        payload: { actionId },
      });
      expect(service.statusCode).toBe(401);

      // 必核对项不完整时不能签发
      const unchecked = await execute(t, cookie, actionId);
      expect(unchecked.statusCode).toBe(400);
      expect(unchecked.json().code).toBe("MONTHLY_PLAN_UNCHECKED_ITEMS");

      // 只核对公司结果也不够：战场结果与普通待办同样是必核对项
      const partial = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        checkedItemIds: ["company"],
      });
      expect(partial.statusCode).toBe(200);
      const stillUnchecked = await sign(t, cookie, planId);
      expect(stillUnchecked.statusCode).toBe(400);
      expect(stillUnchecked.json().code).toBe("MONTHLY_PLAN_UNCHECKED_ITEMS");
      expect(stillUnchecked.json().fieldErrors.missingItemIds).toContain("battlefield:growth");
      expect(stillUnchecked.json().fieldErrors.missingItemIds).toContain(`capability:${CAPABILITY_ID}`);
    } finally {
      await t.close();
    }
  });

  it("rolls the whole sign transaction back when Radar anchors cannot be refreshed", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      await checkAll(t, cookie, planId);
      await t.sql("DELETE FROM radar_config WHERE id = 'default'");

      const failed = await sign(t, cookie, planId);
      expect(failed.statusCode).toBe(500);

      const after = await card(t, cookie, planId);
      expect(after.payload.status).toBe("negotiating");
      expect(after.payload.confirmedAt).toBeNull();
      expect(after.payload.exports).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("re-validates persisted content, owner, sourceRef and battlefieldId at sign time", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      await checkAll(t, cookie, planId);

      await patchPlan(t, planId, {
        todos: [{ id: "todo-unknown-owner", title: "无主待办", ownerId: "person-unknown", sourceRef: "issue:1" }],
        checkedItemIds: ["company", "battlefield:growth", `capability:${CAPABILITY_ID}`, "todo:todo-unknown-owner"],
      });
      const owner = await sign(t, cookie, planId);
      expect(owner.statusCode).toBe(400);
      expect(owner.json().code).toBe("INVALID_OWNER");

      await patchPlan(t, planId, {
        todos: [{ id: "todo-no-source", title: "无来源待办", ownerId: "person-fixture-002", sourceRef: "" }],
        checkedItemIds: ["company", "battlefield:growth", `capability:${CAPABILITY_ID}`, "todo:todo-no-source"],
      });
      const source = await sign(t, cookie, planId);
      expect(source.statusCode).toBe(400);
      expect(source.json().code).toBe("INVALID_PLAN_CONTENT");

      // 能力结果同样在签发时重校：未登记 capabilityId 与空结果都拒绝
      await patchPlan(t, planId, {
        capabilities: [{ capabilityId: "cap-unknown", outcome: "未登记能力结果" }],
        todos: [],
        checkedItemIds: ["company", "battlefield:growth", "capability:cap-unknown"],
      });
      const capability = await sign(t, cookie, planId);
      expect(capability.statusCode).toBe(400);
      expect(capability.json().code).toBe("INVALID_CAPABILITY");

      await patchPlan(t, planId, {
        battlefields: [{ battlefieldId: "not-registered", outcome: "未注册战场结果" }],
        capabilities: [{ capabilityId: CAPABILITY_ID, outcome: " " }],
        todos: [],
        checkedItemIds: ["company", "battlefield:not-registered", `capability:${CAPABILITY_ID}`],
      });
      const battlefield = await sign(t, cookie, planId);
      expect(battlefield.statusCode).toBe(400);
      expect(battlefield.json().code).toBe("INVALID_PLAN_CONTENT");
    } finally {
      await t.close();
    }
  });

  it("refuses a stale version with the latest Card and replays the same Action idempotently", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const checked = await checkAll(t, cookie, planId);
      expect(checked.payload.status).toBe("negotiating");

      // 签发前捕获的 action 在计划被再次编辑后必须冲突并返回最新 Card
      const staleSign = await planAction(t, cookie, planId, "monthly-plan.sign");
      const bumped = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), { note: "签发前最后一版" });
      expect(bumped.statusCode).toBe(200);

      const conflict = await execute(t, cookie, staleSign);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("VERSION_CONFLICT");
      expect(conflict.json().latestCard.version).toBe(bumped.json().cards[0].version);
      expect(conflict.json().latestCard.payload.status).toBe("negotiating");

      // 当前版本签发成功；同一 Action 重放不产生第二份导出或第二组 anchors
      const currentSign = await planAction(t, cookie, planId, "monthly-plan.sign");
      const staleRegenerate = await planAction(t, cookie, planId, "monthly-plan.retry_draft");
      const signed = await execute(t, cookie, currentSign);
      expect(signed.statusCode).toBe(200);
      const confirmed = signed.json().cards[0];
      expect(confirmed.payload.status).toBe("confirmed");
      expect(confirmed.actions.some((action: { actionType: string }) => action.actionType === "monthly-plan.retry_draft")).toBe(false);
      const blockedRegenerate = await execute(t, cookie, staleRegenerate);
      expect(blockedRegenerate.statusCode).toBe(409);

      const replay = await execute(t, cookie, currentSign);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().cards[0].version).toBe(confirmed.version);
      expect(replay.json().cards[0].payload.exports).toEqual(confirmed.payload.exports);

      const radar = await t.app.inject({ method: "GET", url: "/api/cards/radar", headers: { cookie } });
      const ontology = (radar.json().cards[0].payload.anchors as { source?: string }[]).filter((anchor) => anchor.source === "ontology");
      expect(ontology).toHaveLength(2);
    } finally {
      await t.close();
    }
  });
});

describe("BattlefieldConfig registration", () => {
  it("rejects draft candidates, CEO edits and DRI feedback with an unregistered battlefieldId", async () => {
    // Draft Agent 候选越界 → 可见失败，不落库
    const badDraft = await appWith({
      ...validCandidate(),
      battlefields: [{ battlefieldId: "unknown", outcome: "未注册战场结果" }],
      todos: [],
    });
    try {
      const planId = await readyPlan(badDraft);
      const cookie = await badDraft.loginCookie();
      const current = await card(badDraft, cookie, planId);
      expect(current.payload.generation.status).toBe("failed");
      expect(current.payload.generation.error.code).toBe("invalid_monthly_candidate");
    } finally {
      await badDraft.close();
    }

    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      const edit = await execute(t, cookie, await planAction(t, cookie, planId, "monthly-plan.update_draft"), {
        battlefields: [{ battlefieldId: "unknown", outcome: "未注册战场结果" }],
      });
      expect(edit.statusCode).toBe(400);
      expect(edit.json().code).toBe("INVALID_BATTLEFIELD");

      const feedback = await driFeedback(t, {
        externalId: "fb-unknown", period: "2026-06", submitterPersonId: "person-fixture-002",
        sourceRef: "dri://fb/unknown", text: "越界反馈", observedAt: "2026-06-12T00:00:00.000Z", battlefieldId: "unknown",
      });
      expect(feedback.statusCode).toBe(400);
      expect(feedback.json().code).toBe("INVALID_BATTLEFIELD");
    } finally {
      await t.close();
    }
  });
});

describe("MonthlyPlan signing projections", () => {
  it("confirms one plan, projects it into battlefield/notification and rebuilds ontology Radar anchors", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      await checkAll(t, cookie, planId);

      const signed = await sign(t, cookie, planId);
      expect(signed.statusCode).toBe(200);
      const confirmed = signed.json().cards[0];
      expect(Value.Check(MonthlyPlanCardPayload, confirmed.payload)).toBe(true);
      expect(confirmed.payload.status).toBe("confirmed");
      expect(confirmed.payload.confirmedAt).toBeTruthy();
      expect(confirmed.actions.some((action: { actionType: string }) => action.actionType === "monthly-plan.sign")).toBe(false);

      // 普通待办生成真实 pending_export 状态，不进入执行生命周期
      expect(confirmed.payload.exports).toHaveLength(confirmed.payload.todos.length);
      expect(confirmed.payload.exports).toEqual(
        confirmed.payload.todos.map((todo: { id: string; title: string; ownerId: string }) =>
          expect.objectContaining({
            effectRef: `monthly-plan:2026-06:todo:${todo.id}`,
            todoId: todo.id,
            title: todo.title,
            ownerId: todo.ownerId,
            status: "pending_export",
            exportRef: null,
          }),
        ),
      );
      expect(JSON.stringify(confirmed.payload)).not.toMatch(/percent|progress|mission/i);

      // 通知与详情读取同一持久对象的同一 projector
      const detail = await card(t, cookie, planId);
      const notifications = await t.app.inject({ method: "GET", url: "/api/cards/notifications", headers: { cookie } });
      const notice = notifications.json().cards.find((candidate: { kind: string }) => candidate.kind === "monthly-plan");
      expect(notice.version).toBe(detail.version);
      expect(notice.payload).toEqual(detail.payload);
      expect(notice.payload.status).toBe("confirmed");

      // Radar 基础 anchors 来源为 ontology 且保留 originRef，不新增 monthly-plan source
      const radar = await t.app.inject({ method: "GET", url: "/api/cards/radar", headers: { cookie } });
      const anchors = radar.json().cards[0].payload.anchors as { id: string; source?: string; originRef?: string }[];
      const ontology = anchors.filter((anchor) => anchor.source === "ontology");
      expect(ontology.map((anchor) => anchor.id).sort()).toEqual(["ontology:company", "ontology:growth"]);
      expect(ontology.every((anchor) => anchor.originRef === "monthly-plan:2026-06")).toBe(true);
      expect(anchors.some((anchor) => anchor.source === "monthly-plan")).toBe(false);

      // 战场正面展示确认目标，背面只投影该战场的普通待办
      const growth = await battlefieldCard(t, cookie, "growth");
      expect(Value.Check(BattlefieldCardPayload, growth.payload)).toBe(true);
      expect(growth.payload.period).toBe("2026-06");
      expect(growth.payload.target).toBe("增长战场完成渠道切换");
      expect(growth.payload.todos.map((todo: { title: string }) => todo.title)).toEqual(["完成渠道合同复核"]);
      expect(growth.payload.todos[0].exportStatus).toBe("pending_export");
      // 公司级待办不进入单个战场背面
      expect(growth.payload.todos.some((todo: { title: string }) => todo.title === "整理公司级复盘材料")).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("projects pending issues, todos and the latest battlefield feedback by battlefieldId", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();

      // 同一计划的叙述性 feedback：公司级不进入战场背面，战场级取最新
      expect((await driFeedback(t, {
        externalId: "fb-old", period: "2026-06", submitterPersonId: "person-fixture-002",
        sourceRef: "dri://fb/old", text: "较早的战场反馈", observedAt: "2026-06-05T00:00:00.000Z", battlefieldId: "growth",
      })).statusCode).toBe(201);
      expect((await driFeedback(t, {
        externalId: "fb-new", period: "2026-06", submitterPersonId: "person-fixture-002",
        sourceRef: "dri://fb/new", text: "最新的战场反馈", observedAt: "2026-06-12T00:00:00.000Z", battlefieldId: "growth",
      })).statusCode).toBe(201);
      expect((await driFeedback(t, {
        externalId: "fb-company", period: "2026-06", submitterPersonId: "person-fixture-002",
        sourceRef: "dri://fb/company", text: "公司级反馈", observedAt: "2026-06-20T00:00:00.000Z",
      })).statusCode).toBe(201);

      await checkAll(t, cookie, planId);
      expect((await sign(t, cookie, planId)).statusCode).toBe(200);

      // pending Issue 按 location.battlefieldId 准确归属
      expect((await t.app.inject({
        method: "POST", url: "/api/dri/issues",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` },
        payload: {
          externalId: "issue-growth", submitterPersonId: "person-fixture-002", title: "渠道投入是否调整",
          whyNow: "渠道窗口在六月关闭", sourceRef: "dri://planning/growth",
          location: { level: "battlefield", battlefieldId: "growth" },
        },
      })).statusCode).toBe(201);
      expect((await t.app.inject({
        method: "POST", url: "/api/dri/issues",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` },
        payload: {
          externalId: "issue-company", submitterPersonId: "person-fixture-002", title: "公司级方向选择",
          whyNow: "需要公司级判断", sourceRef: "dri://planning/company",
          location: { level: "company", relatedBattlefieldIds: ["growth", "product"] },
        },
      })).statusCode).toBe(201);

      const growth = await battlefieldCard(t, cookie, "growth");
      expect(growth.payload.pendingIssues.map((issue: { title: string }) => issue.title)).toEqual(["渠道投入是否调整"]);
      expect(growth.payload.latestFeedback).toMatchObject({ text: "最新的战场反馈", observedAt: "2026-06-12T00:00:00.000Z", sourceRef: "dri://fb/new" });
      expect(growth.payload.latestFeedback.evidenceRef).toBeNull();
      // 本月全部战场级反馈按时间倒序，公司级不进入；卡片跳到战场二级页。
      expect(growth.payload.feedback.map((item: { text: string }) => item.text)).toEqual(["最新的战场反馈", "较早的战场反馈"]);
      expect(growth.navigation).toEqual([{ href: "/battlefields/growth", label: "Battlefield" }]);

      // 单个战场：与列表同一份投影；未登记的战场 404。
      const single = await t.app.inject({ method: "GET", url: "/api/cards/battlefields/growth", headers: { cookie } });
      expect(single.statusCode).toBe(200);
      expect(single.json().cards).toEqual([growth]);
      const missing = await t.app.inject({ method: "GET", url: "/api/cards/battlefields/nope", headers: { cookie } });
      expect(missing.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

describe("MonthlyPlan DRI export boundary", () => {
  it("keeps pending_export until a real channel acknowledges delivered or failed", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      await checkAll(t, cookie, planId);
      const signed = await sign(t, cookie, planId);
      expect(signed.statusCode).toBe(200);
      const exports = signed.json().cards[0].payload.exports as { effectRef: string; status: string }[];
      expect(exports.every((item) => item.status === "pending_export")).toBe(true);

      // 服务凭据边界
      expect((await t.app.inject({ method: "GET", url: "/api/dri/monthly-exports" })).statusCode).toBe(401);
      const listed = await t.app.inject({
        method: "GET", url: "/api/dri/monthly-exports?status=pending_export",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().exports).toHaveLength(2);

      const first = exports[0];
      const delivered = await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent(first.effectRef)}/delivered`,
        headers: { authorization: `Bearer ${t.env.driServiceToken}` }, payload: { exportRef: "dri-receipt-1" },
      });
      expect(delivered.statusCode).toBe(200);
      expect(delivered.json().exports.find((item: { effectRef: string }) => item.effectRef === first.effectRef))
        .toMatchObject({ effectRef: first.effectRef, status: "delivered", exportRef: "dri-receipt-1", error: null });

      // delivered 后重复回执是真正的无操作，不伪造撤回
      const versionBefore = (await card(t, cookie, planId)).version;
      const replay = await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent(first.effectRef)}/delivered`,
        headers: { authorization: `Bearer ${t.env.driServiceToken}` }, payload: { exportRef: "dri-receipt-1" },
      });
      expect(replay.statusCode).toBe(200);
      expect((await card(t, cookie, planId)).version).toBe(versionBefore);

      const second = exports[1];
      const failed = await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent(second.effectRef)}/failed`,
        headers: { authorization: `Bearer ${t.env.driServiceToken}` }, payload: { error: "DRI 渠道拒绝" },
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.json().exports.find((item: { effectRef: string }) => item.effectRef === second.effectRef))
        .toMatchObject({ status: "failed", error: "DRI 渠道拒绝", exportRef: null });

      const pending = await t.app.inject({
        method: "GET", url: "/api/dri/monthly-exports?status=pending_export",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` },
      });
      expect(pending.json().exports).toHaveLength(0);

      const unknown = await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent("monthly-plan:2026-06:todo:missing")}/delivered`,
        headers: { authorization: `Bearer ${t.env.driServiceToken}` }, payload: { exportRef: "x" },
      });
      expect(unknown.statusCode).toBe(404);

      // 战场背面展示真实导出状态（增长战场待办是签发顺序中的第一条）
      const growth = await battlefieldCard(t, cookie, "growth");
      expect(growth.payload.todos[0].exportStatus).toBe("delivered");
      expect(growth.payload.todos[0].exportRef).toBe("dri-receipt-1");
    } finally {
      await t.close();
    }
  });

  it("treats delivered as terminal and re-exports a failed todo only on an explicit call", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      await checkAll(t, cookie, planId);
      const signed = await sign(t, cookie, planId);
      const exports = signed.json().cards[0].payload.exports as { effectRef: string }[];
      const deliveredExport = exports[0];
      const failedExport = exports[1];
      const auth = { authorization: `Bearer ${t.env.driServiceToken}` };

      expect((await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent(deliveredExport.effectRef)}/delivered`,
        headers: auth, payload: { exportRef: "dri-receipt-1" },
      })).statusCode).toBe(200);
      expect((await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent(failedExport.effectRef)}/failed`,
        headers: auth, payload: { error: "渠道拒绝" },
      })).statusCode).toBe(200);

      // 乱序到达的 failed 回执不能覆盖已送达事实，也不清空真实回执
      const overwrite = await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent(deliveredExport.effectRef)}/failed`,
        headers: auth, payload: { error: "乱序回执" },
      });
      expect(overwrite.statusCode).toBe(409);
      expect(overwrite.json().code).toBe("EXPORT_ALREADY_DELIVERED");
      const afterOverwrite = (await card(t, cookie, planId)).payload.exports;
      expect(afterOverwrite.find((item: { effectRef: string }) => item.effectRef === deliveredExport.effectRef))
        .toMatchObject({ status: "delivered", exportRef: "dri-receipt-1", error: null });

      // failed 不能直接跳到 delivered：必须先显式再导出
      const skipReexport = await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent(failedExport.effectRef)}/delivered`,
        headers: auth, payload: { exportRef: "dri-receipt-2" },
      });
      expect(skipReexport.statusCode).toBe(409);
      expect(skipReexport.json().code).toBe("EXPORT_REEXPORT_REQUIRED");

      // failed 只有在显式再导出后才回到 pending_export
      const beforeReexport = await t.app.inject({
        method: "GET", url: "/api/dri/monthly-exports?status=pending_export", headers: auth,
      });
      expect(beforeReexport.json().exports).toHaveLength(0);
      const reexport = await t.app.inject({
        method: "POST", url: `/api/dri/monthly-exports/${encodeURIComponent(failedExport.effectRef)}/re-export`,
        headers: auth, payload: {},
      });
      expect(reexport.statusCode).toBe(200);
      expect(reexport.json().exports.find((item: { effectRef: string }) => item.effectRef === failedExport.effectRef))
        .toMatchObject({ status: "pending_export", error: null, exportRef: null });
    } finally {
      await t.close();
    }
  });
});

describe("MonthlyPlan signing boundaries", () => {
  it("does not create Todo entities, percentages, or write CompanyMemory", async () => {
    const t = await appWith();
    try {
      const planId = await readyPlan(t);
      const cookie = await t.loginCookie();
      await checkAll(t, cookie, planId);
      expect((await sign(t, cookie, planId)).statusCode).toBe(200);

      const tables = await t.sql(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND lower(table_name) IN ('todos','todo','battlefield_progress')`,
      );
      expect(tables).toEqual([]);

      const plan = await card(t, cookie, planId);
      expect(JSON.stringify(plan.payload)).not.toMatch(/percent|progress|mission/i);

      // CompanyMemory 只读：没有写入入口，签发不改变人员目录
      const memory = createCompanyContext(testEnv);
      const peopleBefore = memory.searchPeople(undefined).map((person) => person.personId).sort();
      expect(Object.keys(memory).every((key) => /^(list|search|get)/.test(key))).toBe(true);
      expect((await t.app.inject({ method: "GET", url: "/api/cards/battlefields", headers: { cookie } })).statusCode).toBe(200);
      expect(memory.searchPeople(undefined).map((person) => person.personId).sort()).toEqual(peopleBefore);
    } finally {
      await t.close();
    }
  });
});
