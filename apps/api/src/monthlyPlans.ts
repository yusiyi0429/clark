import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import {
  type TActionDescriptor,
  type TCard,
  type TDriMonthlyPlanFeedbackRequest,
  type TDriMonthlyPlanTodoFeedbackRequest,
  type TMonthlyPlanBattlefield,
  type TMonthlyPlanFeedback,
  type TMonthlyPlanGeneration,
  type TMonthlyPlanNegotiation,
  type TMonthlyPlanTodo,
  type TUpdateMonthlyPlanDraftRequest,
} from "@warmap/contracts";
import { canonicalJson, signActionId, type ActionScope } from "./actionToken.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

type MonthlyPlanStatus = "draft" | "negotiating" | "confirmed";

/** 内嵌 feedback 的幂等键只在存储层存在；Card 只投影 CEO 可见字段。 */
export type StoredMonthlyFeedback = TMonthlyPlanFeedback & { requestFingerprint: string };
type StoredMonthlyNegotiation = Omit<TMonthlyPlanNegotiation, "feedback"> & {
  feedback: StoredMonthlyFeedback[];
};

export type MonthlyPlanRow = {
  id: string;
  version: number;
  period: string;
  status: MonthlyPlanStatus;
  company_outcome: string;
  battlefields: TMonthlyPlanBattlefield[];
  todos: TMonthlyPlanTodo[];
  negotiation: StoredMonthlyNegotiation;
  generation: TMonthlyPlanGeneration;
  action_fingerprints: string[];
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const MONTHLY_PLAN_COLUMNS = [
  "id", "version", "period", "status", "company_outcome", "battlefields", "todos",
  "negotiation", "generation", "action_fingerprints", "confirmed_at", "created_at", "updated_at",
];
const monthlyPlanColumns = (prefix = "") => MONTHLY_PLAN_COLUMNS.map((column) => `${prefix}${column}`).join(", ");

export type MonthlyPlanActionError = { status: number; code: string; message: string; fieldErrors?: Record<string, string> };
type MonthlyPlanActionOutcome =
  | {
      card: TCard;
      conflict?: false;
      replayed?: boolean;
      /** 显式重试成功后交给 orchestrator 执行新 run；幂等重放不带。 */
      startDraft?: { planId: string; runId: string };
    }
  | { conflict: true; latestCard: TCard }
  | { error: MonthlyPlanActionError };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Company Day 时区下的公司月键：YYYY-MM。 */
export function companyPeriod(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}`;
}

export async function getMonthlyPlanRow(q: Query, id: string): Promise<MonthlyPlanRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const result = await q(`SELECT ${monthlyPlanColumns()} FROM monthly_plans WHERE id = $1`, [id]);
  return result.rowCount === 1 ? (result.rows[0] as MonthlyPlanRow) : null;
}

async function getMonthlyPlanByPeriod(q: Query, period: string): Promise<MonthlyPlanRow | null> {
  const result = await q(`SELECT ${monthlyPlanColumns()} FROM monthly_plans WHERE period = $1`, [period]);
  return result.rowCount === 1 ? (result.rows[0] as MonthlyPlanRow) : null;
}

export async function listMonthlyPlanRows(q: Query): Promise<MonthlyPlanRow[]> {
  const result = await q(`SELECT ${monthlyPlanColumns()} FROM monthly_plans ORDER BY period DESC`);
  return result.rows as MonthlyPlanRow[];
}

/** 通知与月度页面读取同一个持久对象的同一 projector。 */
export async function getMonthlyPlanNotice(q: Query, secret: string, now = new Date()): Promise<TCard | null> {
  const row = await getMonthlyPlanByPeriod(q, companyPeriod(now));
  return row ? projectMonthlyPlanCard(row, secret) : null;
}

/** checkable item 稳定 id：company、battlefield:<id>、todo:<id>。 */
function checkableItemIds(row: Pick<MonthlyPlanRow, "battlefields" | "todos">): string[] {
  return [
    "company",
    ...row.battlefields.map((battlefield) => `battlefield:${battlefield.battlefieldId}`),
    ...row.todos.map((todo) => `todo:${todo.id}`),
  ];
}

export function projectMonthlyFeedback(feedback: StoredMonthlyFeedback): TMonthlyPlanFeedback {
  const { requestFingerprint: _requestFingerprint, ...visible } = feedback;
  return visible;
}

export function projectMonthlyPlanCard(row: MonthlyPlanRow, secret: string): TCard {
  const action = (actionType: string, label: string): TActionDescriptor => {
    const scope: ActionScope = { actionType, objectType: "monthly-plan", objectId: row.id, objectVersion: row.version };
    return { actionId: signActionId(secret, scope), actionType, label };
  };
  const actions: TActionDescriptor[] = [];
  // 生成中不接受编辑：Agent 写回会整份替换草案内容
  if (row.status !== "confirmed" && row.generation.status !== "pending" && row.generation.status !== "running") {
    actions.push(action("monthly-plan.update_draft", "保存计划"));
  }
  if (row.status !== "confirmed" && row.generation.status === "failed") {
    actions.push(action("monthly-plan.retry_draft", "重试生成"));
  }
  return {
    schemaVersion: 1,
    id: `monthly-plan:${row.id}`,
    version: row.version,
    kind: "monthly-plan",
    objectRef: { type: "monthly-plan", id: row.id, version: row.version },
    title: `月度计划 ${row.period}`,
    badge: "MonthlyPlan",
    urgency: "normal",
    payload: {
      period: row.period,
      status: row.status,
      companyOutcome: row.company_outcome,
      battlefields: row.battlefields,
      todos: row.todos,
      negotiation: {
        edits: row.negotiation.edits,
        checkedItemIds: row.negotiation.checkedItemIds,
        feedback: row.negotiation.feedback.map(projectMonthlyFeedback),
        note: row.negotiation.note,
      },
      generation: {
        status: row.generation.status,
        pendingSince: row.generation.pendingSince,
        runId: row.generation.runId,
        previousRunIds: row.generation.previousRunIds,
        error: row.generation.error,
        generatedAt: row.generation.generatedAt,
      },
      confirmedAt: row.confirmed_at?.toISOString() ?? null,
    },
    navigation: [{ href: `/monthly-plans/${row.id}`, label: "MonthlyPlan" }],
    conversation: { scope: `monthly-plan:${row.id}` },
    actions,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// ponytail: 幂等指纹列表随操作增长，超过上限丢弃最旧项；单月计划操作量有限
function appendFingerprint(existing: string[], fingerprint: string): string[] {
  return [...existing.filter((value) => value !== fingerprint), fingerprint].slice(-100);
}

/**
 * Action 执行通用事务：行锁 → 已产生效果直接返回当前 Card → 命中 expectedVersion 才继续。
 * 拒绝与冲突路径必须结束事务，否则行锁随连接泄漏回池。
 */
async function withPlanLock(
  pool: Pool,
  planId: string,
  secret: string,
  fingerprint: string,
  expectedVersion: number,
  run: (client: PoolClient, row: MonthlyPlanRow) => Promise<MonthlyPlanActionOutcome>,
): Promise<MonthlyPlanActionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<MonthlyPlanRow>(
      `SELECT ${monthlyPlanColumns()} FROM monthly_plans WHERE id = $1 FOR UPDATE`,
      [planId],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "MONTHLY_PLAN_NOT_FOUND", message: "MonthlyPlan 不存在" } };
    }
    const row = result.rows[0];
    if (row.action_fingerprints.includes(fingerprint)) {
      await client.query("COMMIT");
      return { card: projectMonthlyPlanCard(row, secret), replayed: true };
    }
    if (row.version !== expectedVersion) {
      await client.query("ROLLBACK");
      return { conflict: true, latestCard: projectMonthlyPlanCard(row, secret) };
    }
    const outcome = await run(client, row);
    if (!("card" in outcome)) {
      await client.query("ROLLBACK").catch(() => undefined);
      return outcome;
    }
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function commit(client: PoolClient, row: MonthlyPlanRow, secret: string): Promise<{ card: TCard }> {
  await client.query("COMMIT");
  return { card: projectMonthlyPlanCard(row, secret) };
}

async function updatePlan(client: PoolClient, id: string, assignments: string, params: unknown[]): Promise<MonthlyPlanRow> {
  const result = await client.query<MonthlyPlanRow>(
    `UPDATE monthly_plans SET ${assignments}, updated_at = now() WHERE id = $1 RETURNING ${monthlyPlanColumns()}`,
    [id, ...params],
  );
  return result.rows[0];
}

function planError(status: number, code: string, message: string, fieldErrors?: Record<string, string>): MonthlyPlanActionOutcome {
  return { error: { status, code, message, ...(fieldErrors ? { fieldErrors } : {}) } };
}

/**
 * CEO versioned 编辑：公司结果、战场结果、普通 todo、核对项与 note。
 * 首次编辑把 draft 改 negotiating；todo owner 必须是 company-people.v1 稳定 personId。
 */
export async function executeUpdateMonthlyPlanDraft(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  secret: string,
  scope: ActionScope,
  input: TUpdateMonthlyPlanDraftRequest,
  fingerprint: string,
): Promise<MonthlyPlanActionOutcome> {
  return withPlanLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status === "confirmed") {
      return planError(409, "MONTHLY_PLAN_CONFIRMED", "已签发的 MonthlyPlan 不能再编辑");
    }
    // 生成中禁止编辑：Agent 成功写回会整份替换 companyOutcome/battlefields/todos
    if (row.generation.status === "pending" || row.generation.status === "running") {
      return planError(409, "MONTHLY_PLAN_DRAFT_RUNNING", "草案正在生成，请等待本轮结束后再编辑");
    }
    const people = new Set(companyMemory.searchPeople(undefined).map((person) => person.personId));
    for (const todo of input.todos ?? []) {
      if (!people.has(todo.ownerId)) {
        return planError(400, "INVALID_OWNER", "todo ownerId 不在 company-people.v1 人员目录中", { ownerId: "unknown personId" });
      }
      if (todo.dueAt && !Number.isFinite(Date.parse(todo.dueAt))) {
        return planError(400, "INVALID_DUE_AT", "dueAt 不是可解析时间", { dueAt: "unparsable" });
      }
    }
    const nextTodos: TMonthlyPlanTodo[] | undefined = input.todos?.map((todo) => {
      const { id, ...fields } = todo;
      return { id: id ?? `todo-${randomUUID()}`, ...fields };
    });

    const battlefields = input.battlefields ?? row.battlefields;
    const effectiveTodos = nextTodos ?? row.todos;
    const allowed = new Set(checkableItemIds({ battlefields, todos: effectiveTodos }));
    if (input.checkedItemIds) {
      const bad = input.checkedItemIds.find((itemId) => !allowed.has(itemId));
      if (bad) {
        return planError(400, "INVALID_CHECKED_ITEM", `核对项不存在: ${bad}`, { checkedItemIds: "unknown item" });
      }
    }
    // 被编辑的字段重新回到未核对；被删除条目的旧核对一并失效
    const clearedPrefixes = [
      ...(input.companyOutcome !== undefined ? ["company"] : []),
      ...(input.battlefields !== undefined ? ["battlefield:"] : []),
      ...(input.todos !== undefined ? ["todo:"] : []),
    ];
    const checkedItemIds = (input.checkedItemIds ?? row.negotiation.checkedItemIds)
      .filter((itemId) => !clearedPrefixes.some((prefix) => itemId === prefix || itemId.startsWith(prefix)))
      .filter((itemId) => allowed.has(itemId));

    const now = new Date().toISOString();
    const fields: string[] = [];
    if (input.companyOutcome !== undefined) fields.push("companyOutcome");
    if (input.battlefields !== undefined) fields.push("battlefields");
    if (input.todos !== undefined) fields.push("todos");
    if (input.checkedItemIds !== undefined) fields.push("checkedItemIds");
    if (input.note !== undefined) fields.push("note");
    const negotiation: StoredMonthlyNegotiation = {
      ...row.negotiation,
      checkedItemIds: unique(checkedItemIds),
      ...(input.note !== undefined ? { note: input.note } : {}),
      edits: fields.length > 0 ? [...row.negotiation.edits, { at: now, fields }] : row.negotiation.edits,
    };
    const status: MonthlyPlanStatus = row.status === "draft" ? "negotiating" : row.status;
    const updated = await updatePlan(
      client,
      row.id,
      `company_outcome = $2, battlefields = $3::jsonb, todos = $4::jsonb, negotiation = $5::jsonb,
       status = $6, version = version + 1, action_fingerprints = $7::jsonb`,
      [
        input.companyOutcome ?? row.company_outcome,
        JSON.stringify(battlefields),
        JSON.stringify(effectiveTodos),
        JSON.stringify(negotiation),
        status,
        JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint)),
      ],
    );
    return commit(client, updated, secret);
  });
}

/** 失败草案只能由 CEO 显式重试；重放同一 Action 不产生第二个 run。 */
export async function executeRetryMonthlyPlanDraft(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MonthlyPlanActionOutcome> {
  return withPlanLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status === "confirmed") {
      return planError(409, "MONTHLY_PLAN_CONFIRMED", "已签发的 MonthlyPlan 不能重新生成");
    }
    if (row.generation.status !== "failed") {
      return planError(409, "MONTHLY_PLAN_DRAFT_NOT_FAILED", "只有失败的草案可以显式重试");
    }
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const previousRunIds = [...row.generation.previousRunIds];
    if (row.generation.runId && !previousRunIds.includes(row.generation.runId)) previousRunIds.push(row.generation.runId);
    const generation: TMonthlyPlanGeneration = {
      status: "running",
      pendingSince: startedAt,
      runId,
      previousRunIds,
      error: null,
      generatedAt: null,
    };
    const updated = await updatePlan(
      client,
      row.id,
      "generation = $2::jsonb, version = version + 1, action_fingerprints = $3::jsonb",
      [JSON.stringify(generation), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return { ...(await commit(client, updated, secret)), startDraft: { planId: row.id, runId } };
  });
}

type DriMonthlyFeedbackResult =
  | { status: 201 | 200; card: TCard }
  | { status: 400 | 409 | 422; code: string; message: string; fieldErrors?: Record<string, string> };

/**
 * DRI 叙述性 feedback 追加：只写文本、证据和 observedAt，不修改 todo 执行状态。
 * 同一 period 内同一 externalId 同内容返回原结果，不同内容 409；feedback 内嵌在同一个 MonthlyPlan。
 * externalId 以 (period, externalId) 为幂等键，因为 feedback 没有独立实体。
 */
export async function appendDriMonthlyFeedback(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  body: TDriMonthlyPlanFeedbackRequest | TDriMonthlyPlanTodoFeedbackRequest,
  secret: string,
): Promise<DriMonthlyFeedbackResult> {
  const submitter = companyMemory.searchPeople(undefined).find((person) => person.personId === body.submitterPersonId);
  if (!submitter || !submitter.roles.includes("dri")) {
    return {
      status: 422,
      code: "INVALID_SUBMITTER",
      message: "submitterPersonId 不是 company-people.v1 中的 DRI",
      fieldErrors: { submitterPersonId: "unknown or non-dri personId" },
    };
  }
  if (!Number.isFinite(Date.parse(body.observedAt))) {
    return { status: 400, code: "INVALID_INPUT", message: "observedAt 不是可解析时间", fieldErrors: { observedAt: "unparsable" } };
  }
  const requestFingerprint = canonicalJson({
    externalId: body.externalId,
    period: body.period,
    submitterPersonId: body.submitterPersonId,
    sourceRef: body.sourceRef,
    text: body.text,
    evidenceRef: body.evidenceRef,
    observedAt: body.observedAt,
    battlefieldId: body.battlefieldId,
    todoId: "todoId" in body ? body.todoId : undefined,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<MonthlyPlanRow>(
      `SELECT ${monthlyPlanColumns()} FROM monthly_plans WHERE period = $1 FOR UPDATE`,
      [body.period],
    );
    if (found.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { status: 422, code: "MONTHLY_PLAN_NOT_FOUND", message: `period ${body.period} 还没有 MonthlyPlan`, fieldErrors: { period: "unknown period" } };
    }
    const row = found.rows[0];
    const existing = row.negotiation.feedback.find((feedback) => feedback.externalId === body.externalId);
    if (existing) {
      await client.query("ROLLBACK");
      if (existing.requestFingerprint !== requestFingerprint) {
        return { status: 409, code: "DRI_FEEDBACK_EXTERNAL_ID_CONFLICT", message: "同一 externalId 已存在且内容不同" };
      }
      return { status: 200, card: projectMonthlyPlanCard(row, secret) };
    }
    // 已签发计划不接受新的协商 feedback；签发后的处理留给 Ticket 13
    if (row.status === "confirmed") {
      await client.query("ROLLBACK");
      return { status: 409, code: "MONTHLY_PLAN_CONFIRMED", message: "已签发的 MonthlyPlan 不接受新的 DRI feedback" };
    }
    const todoId = "todoId" in body ? body.todoId : undefined;
    if (todoId && !row.todos.some((todo) => todo.id === todoId)) {
      await client.query("ROLLBACK");
      return { status: 400, code: "INVALID_TODO", message: "todoId 不属于该 MonthlyPlan", fieldErrors: { todoId: "unknown todo" } };
    }
    const feedback: StoredMonthlyFeedback = {
      id: randomUUID(),
      externalId: body.externalId,
      requestFingerprint,
      ...(todoId ? { todoId } : {}),
      ...(body.battlefieldId ? { battlefieldId: body.battlefieldId } : {}),
      text: body.text,
      ...(body.evidenceRef ? { evidenceRef: body.evidenceRef } : {}),
      observedAt: body.observedAt,
      sourceRef: body.sourceRef,
    };
    const negotiation: StoredMonthlyNegotiation = { ...row.negotiation, feedback: [...row.negotiation.feedback, feedback] };
    const status: MonthlyPlanStatus = row.status === "draft" ? "negotiating" : row.status;
    const updated = await updatePlan(
      client,
      row.id,
      "negotiation = $2::jsonb, status = $3, version = version + 1",
      [JSON.stringify(negotiation), status],
    );
    await client.query("COMMIT");
    return { status: 201, card: projectMonthlyPlanCard(updated, secret) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
