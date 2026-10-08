import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import type {
  TActionDescriptor,
  TMonthlyPlanBattlefield,
  TMonthlyReviewAssessment,
  TMonthlyReviewComment,
  TMonthlyReviewConfirmationSource,
  TMonthlyReviewDecideLtcoInput,
  TMonthlyReviewField,
  TMonthlyReviewItemPayload,
  TMonthlyReviewItemRow,
  TMonthlyReviewItemStatus,
  TMonthlyReviewItemUpdateInput,
  TMonthlyReviewJudgment,
  TMonthlyReviewLtcoSuggestion,
  TMonthlyReviewNotice,
  TMonthlyReviewPayload,
  TMonthlyReviewResolveSuggestionInput,
  TMonthlyReviewReturnInput,
  TMonthlyReviewSelfReview,
  TMonthlyReviewStatus,
  TMonthlyReviewSubjectType,
  TMonthlyReviewSuggestion,
  TMonthlyReviewUpdateSummaryInput,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { MemoryPerson } from "./companyMemory.js";
import { ltoWindow } from "./monthlyCycle.js";
import { redraftPlanAfterReview } from "./monthlyPlans.js";
import { ensurePersonalReviewsInTransaction, personalReviewHref, type PersonalReviewDraftRun, type PersonalReviewRow } from "./personalReviews.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

type GenerationStatus = "none" | "pending" | "running" | "ready" | "failed";
type GenerationError = { code: string; message: string; at: string } | null;

export type StoredReviewSummary = {
  status: GenerationStatus;
  runId: string | null;
  error: GenerationError;
  overall: string;
  judgments: TMonthlyReviewJudgment[];
  nextFocus: string[];
  confirmedAt: string | null;
  confirmedBy: string | null;
};
export type StoredLtcoDecision = {
  decision: "keep" | "revise";
  ltcoBefore: string;
  ltcoAfter: string;
  units: { subjectType: TMonthlyReviewSubjectType; subjectId: string; before: string; after: string }[];
  decidedAt: string;
  decidedBy: string;
  planExisted: boolean;
};
type StoredAssessment = { status: GenerationStatus; runId: string | null; result: TMonthlyReviewAssessment | null; error: GenerationError };
type StoredHistoryEntry = {
  at: string;
  by: string;
  action: "submit" | "return" | "confirm";
  reason: string | null;
  selfReviewSnapshot: TMonthlyReviewSelfReview | null;
};

export type MonthlyReviewRow = {
  id: string;
  version: number;
  period: string;
  status: TMonthlyReviewStatus;
  /** import：飞书导入的复盘，复盘项起草后直接确认（只影响这一轮）。 */
  origin: "import" | null;
  summary: StoredReviewSummary;
  ltco_suggestion: TMonthlyReviewLtcoSuggestion | null;
  ltco_decision: StoredLtcoDecision | null;
  action_fingerprints: string[];
  created_at: Date;
  updated_at: Date;
};

/** 复盘项行；period 与 subject_* 由读取时关联复盘和注册表得到，不落库。 */
export type MonthlyReviewItemRecord = {
  id: string;
  review_id: string;
  version: number;
  subject_type: TMonthlyReviewSubjectType;
  subject_id: string;
  owner_id: string;
  owner_unassigned: boolean;
  target: string | null;
  status: TMonthlyReviewItemStatus;
  draft_run: { runId: string | null; error: GenerationError; suggestions?: boolean };
  self_review: TMonthlyReviewSelfReview | null;
  suggestions: TMonthlyReviewSuggestion[];
  return_reason: string | null;
  assessment: StoredAssessment;
  history: StoredHistoryEntry[];
  submitted_at: Date | null;
  confirmed_at: Date | null;
  confirmation_source: TMonthlyReviewConfirmationSource;
  action_fingerprints: string[];
  created_at: Date;
  updated_at: Date;
  period: string;
  subject_code: string;
  subject_name: string;
  six_month_outcome: string;
};

export type ReviewViewer = { personId: string; role: string };

const REVIEW_COLUMNS = "id, version, period, status, origin, summary, ltco_suggestion, ltco_decision, action_fingerprints, created_at, updated_at";
const ITEM_COLUMNS = [
  "id", "review_id", "version", "subject_type", "subject_id", "owner_id", "owner_unassigned", "target", "status", "draft_run",
  "self_review", "suggestions", "return_reason", "assessment", "history", "submitted_at", "confirmed_at", "confirmation_source",
  "action_fingerprints", "created_at", "updated_at",
];
const ITEM_SELECT = `SELECT ${ITEM_COLUMNS.map((column) => `i.${column}`).join(", ")}, r.period,
       COALESCE(b.code, cap.code, '') AS subject_code,
       COALESCE(b.name, cap.name, i.subject_id) AS subject_name,
       COALESCE(b.six_month_outcome, cap.six_month_outcome, '') AS six_month_outcome
  FROM monthly_review_items i
  JOIN monthly_reviews r ON r.id = i.review_id
  LEFT JOIN battlefield_config b ON i.subject_type = 'battlefield' AND b.id = i.subject_id
  LEFT JOIN capability_config cap ON i.subject_type = 'capability' AND cap.id = i.subject_id`;
const ITEM_ORDER = `ORDER BY CASE i.subject_type WHEN 'battlefield' THEN 0 ELSE 1 END,
  COALESCE(b.sort_order, cap.sort_order, 0), COALESCE(b.code, cap.code, ''), i.subject_id`;

const MONTHLY_REVIEW_FIELDS: TMonthlyReviewField[] = ["overall", "judgments", "nextFocus"];
const ALL_MONTHLY_REVIEW_FIELDS: TMonthlyReviewField[] = [...MONTHLY_REVIEW_FIELDS, "escalations"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITABLE: TMonthlyReviewItemStatus[] = ["draft", "returned"];

/** YYYY-MM 的下一个月。 */
function nextPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

function monthLabel(period: string): string {
  return `${Number(period.slice(5))} 月`;
}

/** overall 的第一句（按 。！？ 与换行切分），最多 80 字；还没有自评时为 null。 */
export function leadOf(selfReview: TMonthlyReviewSelfReview | null): string | null {
  const first = selfReview?.overall?.text.split(/[。！？\n]/).map((part) => part.trim()).find(Boolean);
  return first ? first.slice(0, 80) : null;
}

function emptySelfReview(): TMonthlyReviewSelfReview {
  return {
    overall: { text: "", sources: [] },
    judgments: { text: "", sources: [] },
    nextFocus: { text: "", sources: [] },
    escalations: { text: "", sources: [] },
  };
}

function currentSelfReview(value: TMonthlyReviewSelfReview): boolean {
  return ALL_MONTHLY_REVIEW_FIELDS.every((field) => value[field]?.text !== undefined)
    && !["achievement", "gaps", "causes", "nextAdjustments"].some((field) => field in value);
}

export async function getMonthlyReviewItem(q: Query, itemId: string): Promise<MonthlyReviewItemRecord | null> {
  if (!UUID_PATTERN.test(itemId)) return null;
  const result = await q(`${ITEM_SELECT} WHERE i.id = $1`, [itemId]);
  const row = result.rows[0] as MonthlyReviewItemRecord | undefined;
  if (row?.self_review && !currentSelfReview(row.self_review)) row.self_review = null;
  return row ?? null;
}

export async function listMonthlyReviewItems(q: Query, reviewId: string): Promise<MonthlyReviewItemRecord[]> {
  const rows = (await q(`${ITEM_SELECT} WHERE i.review_id = $1 ${ITEM_ORDER}`, [reviewId])).rows as MonthlyReviewItemRecord[];
  for (const row of rows) if (row.self_review && !currentSelfReview(row.self_review)) row.self_review = null;
  return rows;
}

export async function getMonthlyReviewRow(q: Query, reviewId: string): Promise<MonthlyReviewRow | null> {
  if (!UUID_PATTERN.test(reviewId)) return null;
  return ((await q(`SELECT ${REVIEW_COLUMNS} FROM monthly_reviews WHERE id = $1`, [reviewId])).rows[0] as MonthlyReviewRow | undefined) ?? null;
}

export async function getMonthlyReviewByPeriod(q: Query, period: string): Promise<MonthlyReviewRow | null> {
  return ((await q(`SELECT ${REVIEW_COLUMNS} FROM monthly_reviews WHERE period = $1`, [period])).rows[0] as MonthlyReviewRow | undefined) ?? null;
}

export async function readLtco(q: Query): Promise<string> {
  return ((await q("SELECT ltco FROM company_strategy_config WHERE id = 'default'")).rows[0]?.ltco as string | undefined) ?? "";
}

export async function listMonthlyReviewUnits(q: Query): Promise<TMonthlyReviewPayload["ltco"]["units"]> {
  const units: TMonthlyReviewPayload["ltco"]["units"] = [];
  for (const [table, subjectType] of [["battlefield_config", "battlefield"]] as const) {
    const rows = (await q(`SELECT id, code, name, six_month_outcome FROM ${table} ORDER BY sort_order, code, id`)).rows;
    for (const row of rows) units.push({ subjectType, subjectId: row.id as string, subjectCode: row.code as string,
      subjectName: row.name as string, current: row.six_month_outcome as string });
  }
  return units;
}

export async function monthlyReviewParticipantIds(q: Query, row: Pick<MonthlyReviewItemRecord, "review_id" | "subject_type" | "subject_id" | "owner_id">): Promise<string[]> {
  return (await q(`SELECT DISTINCT m.owner_id FROM missions m JOIN monthly_reviews r ON r.id = $1
    WHERE m.period = r.period AND m.owner_id <> $4 AND
      ($2 = 'battlefield' AND m.battlefield_ids @> jsonb_build_array($3::text)
        OR $2 = 'capability' AND m.capability_id = $3) ORDER BY m.owner_id`,
  [row.review_id, row.subject_type, row.subject_id, row.owner_id])).rows.map((entry) => entry.owner_id as string);
}

export async function canReadMonthlyReviewItem(q: Query, viewer: ReviewViewer, row: Pick<MonthlyReviewItemRecord, "review_id" | "subject_type" | "subject_id" | "owner_id">): Promise<boolean> {
  return viewer.personId === row.owner_id || viewer.role === "ceo" || (await monthlyReviewParticipantIds(q, row)).includes(viewer.personId);
}

export async function listMonthlyReviewComments(q: Query, itemId: string, people: Map<string, string>): Promise<TMonthlyReviewComment[]> {
  return (await q(`SELECT id, author_id, body, created_at FROM monthly_review_comments
    WHERE item_id = $1 ORDER BY created_at, id LIMIT 200`, [itemId])).rows.map((row) => ({
    id: row.id as string, authorId: row.author_id as string, authorName: people.get(row.author_id as string) ?? row.author_id as string,
    body: row.body as string, createdAt: (row.created_at as Date).toISOString(),
  }));
}

export async function createMonthlyReviewComment(pool: Pool, itemId: string, viewer: ReviewViewer,
  clientId: string, body: string, now: Date, people: Map<string, string>): Promise<{ comment: TMonthlyReviewComment } | MonthlyReviewActionError> {
  if (!UUID_PATTERN.test(itemId)) return { status: 404, code: "MONTHLY_REVIEW_ITEM_NOT_FOUND", message: "复盘项不存在或不可见" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query("SELECT * FROM monthly_review_items WHERE id = $1 FOR UPDATE", [itemId])).rows[0] as MonthlyReviewItemRecord | undefined;
    if (!row || !await canReadMonthlyReviewItem(client.query.bind(client), viewer, row)) {
      await client.query("ROLLBACK");
      return { status: 404, code: "MONTHLY_REVIEW_ITEM_NOT_FOUND", message: "复盘项不存在或不可见" };
    }
    if (row.status === "confirmed") {
      await client.query("ROLLBACK");
      return { status: 409, code: "MONTHLY_REVIEW_CONFIRMED", message: "已确认的复盘不能评论" };
    }
    const existing = (await client.query("SELECT id, item_id, body, created_at FROM monthly_review_comments WHERE author_id = $1 AND client_id = $2", [viewer.personId, clientId])).rows[0] as
      { id: string; item_id: string; body: string; created_at: Date } | undefined;
    if (existing && (existing.body !== body || existing.item_id !== itemId)) {
      await client.query("ROLLBACK");
      return { status: 409, code: "MONTHLY_REVIEW_COMMENT_CONFLICT", message: "clientId 已用于另一条评论" };
    }
    let saved = existing;
    if (!saved) {
      saved = (await client.query(
        "INSERT INTO monthly_review_comments (id, item_id, author_id, client_id, body, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (author_id, client_id) DO NOTHING RETURNING id, item_id, body, created_at",
        [randomUUID(), itemId, viewer.personId, clientId, body, now.toISOString()],
      )).rows[0] as typeof existing;
      if (!saved) {
        saved = (await client.query("SELECT id, item_id, body, created_at FROM monthly_review_comments WHERE author_id = $1 AND client_id = $2", [viewer.personId, clientId])).rows[0] as typeof existing;
        if (!saved || saved.body !== body || saved.item_id !== itemId) {
          await client.query("ROLLBACK");
          return { status: 409, code: "MONTHLY_REVIEW_COMMENT_CONFLICT", message: "clientId 已用于另一条评论" };
        }
      }
    }
    await client.query("COMMIT");
    return { comment: { id: saved.id, authorId: viewer.personId, authorName: people.get(viewer.personId) ?? viewer.personId,
      body: saved.body, createdAt: saved.created_at.toISOString() } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function itemAction(secret: string, row: Pick<MonthlyReviewItemRecord, "id" | "version">, actionType: string, label: string): TActionDescriptor {
  const scope: ActionScope = { actionType, objectType: "monthly-review-item", objectId: row.id, objectVersion: row.version };
  return { actionId: signActionId(secret, scope), actionType, label };
}

/** CEO 在当月还没有复盘时手动开启；slot 版本固定为 1。 */
export function monthlyReviewOpenAction(secret: string, period: string): TActionDescriptor {
  const actionType = "monthly-review.open";
  const scope: ActionScope = { actionType, objectType: "monthly-review-slot", objectId: period, objectVersion: 1 };
  return { actionId: signActionId(secret, scope), actionType, label: `开始 ${monthLabel(period)}复盘` };
}

function projectAssessment(assessment: StoredAssessment): TMonthlyReviewItemPayload["assessment"] {
  return { status: assessment.status, result: assessment.result, error: assessment.error };
}

export function projectMonthlyReviewItem(
  row: MonthlyReviewItemRecord,
  viewer: ReviewViewer,
  people: Map<string, string>,
  secret: string,
  participantIds: string[] = [],
  comments: TMonthlyReviewComment[] = [],
): TMonthlyReviewItemPayload {
  const isOwner = viewer.personId === row.owner_id;
  const isCeo = viewer.role === "ceo";
  const isParticipant = participantIds.includes(viewer.personId);
  const action = (actionType: string, label: string) => itemAction(secret, row, actionType, label);
  const actions: TActionDescriptor[] = [];
  if (isOwner && EDITABLE.includes(row.status)) {
    actions.push(action("monthly-review-item.update", "保存"), action("monthly-review-item.submit", "提交复盘"));
    if (row.suggestions.length > 0) actions.push(action("monthly-review-item.resolve_suggestion", "处理建议"));
  }
  if ((isOwner || isCeo) && row.status === "draft_failed") actions.push(action("monthly-review-item.retry_draft", "重新起草"));
  if (isCeo && row.status === "submitted") {
    actions.push(action("monthly-review-item.confirm", "确认"), action("monthly-review-item.return", "打回"));
    if (row.assessment.status === "failed") actions.push(action("monthly-review-item.retry_assessment", "重新评估"));
  }
  return {
    itemId: row.id,
    reviewId: row.review_id,
    period: row.period,
    version: row.version,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectCode: row.subject_code,
    subjectName: row.subject_name,
    ownerId: row.owner_id,
    ownerName: people.get(row.owner_id) ?? row.owner_id,
    ownerUnassigned: row.owner_unassigned,
    target: row.target,
    sixMonthOutcome: row.six_month_outcome,
    status: row.status,
    draftError: row.draft_run.error ?? null,
    selfReview: row.self_review,
    suggestions: row.suggestions,
    returnReason: row.return_reason,
    assessment: projectAssessment(row.assessment),
    history: row.history.map((entry) => ({
      at: entry.at,
      by: entry.by,
      byName: people.get(entry.by) ?? entry.by,
      action: entry.action,
      reason: entry.reason,
    })),
    comments,
    participantNames: participantIds.map((id) => people.get(id) ?? id),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    confirmationSource: row.confirmation_source,
    viewer: { isOwner, isCeo, isParticipant, canComment: row.status !== "confirmed" },
    conversationScope: `monthly-review-item:${row.id}`,
    actions,
  };
}

/** 总览行的 confirm / return 只给 CEO；总览本身只有 CEO 能读。 */
function projectItemRow(row: MonthlyReviewItemRecord, people: Map<string, string>, secret: string): TMonthlyReviewItemRow {
  return {
    itemId: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectCode: row.subject_code,
    subjectName: row.subject_name,
    ownerName: people.get(row.owner_id) ?? row.owner_id,
    ownerUnassigned: row.owner_unassigned,
    status: row.status,
    confirmationSource: row.confirmation_source,
    lead: leadOf(row.self_review),
    assessmentStatus: row.assessment.status,
    assessmentOverall: row.assessment.result?.overall ?? null,
    deviationCount: row.assessment.result?.deviations.length ?? 0,
    actions: row.status === "submitted"
      ? [itemAction(secret, row, "monthly-review-item.confirm", "确认"), itemAction(secret, row, "monthly-review-item.return", "打回")]
      : [],
  };
}

export function projectMonthlyReview(
  row: MonthlyReviewRow,
  items: MonthlyReviewItemRecord[],
  people: Map<string, string>,
  ltcoCurrent: string,
  secret: string,
  units: TMonthlyReviewPayload["ltco"]["units"] = [],
): TMonthlyReviewPayload {
  const action = (actionType: string, label: string): TActionDescriptor => {
    const scope: ActionScope = { actionType, objectType: "monthly-review", objectId: row.id, objectVersion: row.version };
    return { actionId: signActionId(secret, scope), actionType, label };
  };
  const actions: TActionDescriptor[] = [];
  if (row.status === "summarizing" && row.summary.status === "ready") {
    actions.push(action("monthly-review.update_summary", "保存公司复盘"), action("monthly-review.confirm_summary", "确认公司复盘"),
      action("monthly-review.retry_summary", "重新生成"));
  } else if (row.status === "summarizing" && row.summary.status === "failed") {
    actions.push(action("monthly-review.retry_summary", "重新生成"));
  } else if (row.status === "ltco_pending") {
    actions.push(action("monthly-review.decide_ltco", "决定 LTO"));
  }
  const decision = row.ltco_decision;
  return {
    reviewId: row.id,
    period: row.period,
    nextPeriod: nextPeriod(row.period),
    version: row.version,
    status: row.status,
    counts: {
      total: items.length,
      // 已提交按累计口径：已确认的项也算已提交
      submitted: items.filter((item) => item.status === "submitted" || item.status === "confirmed").length,
      confirmed: items.filter((item) => item.status === "confirmed").length,
      returned: items.filter((item) => item.status === "returned").length,
    },
    items: items.map((item) => projectItemRow(item, people, secret)),
    summary: {
      status: row.summary.status,
      error: row.summary.error ?? null,
      overall: row.summary.overall ?? "",
      judgments: row.summary.judgments,
      nextFocus: row.summary.nextFocus ?? [],
      confirmedAt: row.summary.confirmedAt ?? null,
    },
    ltco: {
      current: ltcoCurrent,
      window: ltoWindow(row.period),
      units: units.filter((unit) => unit.subjectType === "battlefield"),
      suggestion: row.ltco_suggestion ? { ...row.ltco_suggestion, units: row.ltco_suggestion.units.filter((unit) => unit.subjectType === "battlefield") } : null,
      decision: decision
        ? { decision: decision.decision, ltcoBefore: decision.ltcoBefore, ltcoAfter: decision.ltcoAfter, units: decision.units ?? [], decidedAt: decision.decidedAt, planExisted: decision.planExisted }
        : null,
    },
    actions,
  };
}

export type MonthlyReviewCreation = { created: boolean; reviewId: string; itemRuns: { itemId: string; runId: string }[]; personalRuns: PersonalReviewDraftRun[] };

/**
 * 为 period 建复盘和战场复盘项；已存在时返回现有复盘。
 * 注册表负责人为空时挂到 CEO 名下；target 取被复盘月份已签发计划里这一项的 PCO。
 */
export async function createMonthlyReview(pool: Pool, period: string, now: Date, people: MemoryPerson[]): Promise<MonthlyReviewCreation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const creation = await createMonthlyReviewInTransaction(client.query.bind(client), period, now, people);
    await client.query("COMMIT");
    return creation;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** createMonthlyReview 的事务内版本：导入复盘的 CLI 在同一个事务里接着写。 */
export async function createMonthlyReviewInTransaction(q: Query, period: string, now: Date, people: MemoryPerson[]): Promise<MonthlyReviewCreation> {
  const at = now.toISOString();
  await q("SELECT pg_advisory_xact_lock(hashtext($1))", ["monthly-review:create"]);
  const reviewId = randomUUID();
  const summary: StoredReviewSummary = { status: "none", runId: null, error: null, overall: "", judgments: [], nextFocus: [], confirmedAt: null, confirmedBy: null };
  const inserted = await q(
    `INSERT INTO monthly_reviews (id, version, period, status, summary, created_at, updated_at)
     VALUES ($1, 1, $2, 'collecting', $3::jsonb, $4, $4)
     ON CONFLICT (period) DO NOTHING RETURNING id`,
    [reviewId, period, JSON.stringify(summary), at],
  );
  if (inserted.rowCount !== 1) {
    const existing = await q("SELECT id FROM monthly_reviews WHERE period = $1", [period]);
    const personalRuns = await ensurePersonalReviewsInTransaction(q, existing.rows[0].id, people, now);
    return { created: false, reviewId: existing.rows[0].id as string, itemRuns: [], personalRuns };
  }
  const ceo = people.find((person) => person.roles.includes("ceo"))?.personId;
  const personalRuns = await ensurePersonalReviewsInTransaction(q, reviewId, people, now);
  const plan = (await q(
    "SELECT battlefields FROM monthly_plans WHERE period = $1 AND status = 'confirmed'",
    [period],
  )).rows[0] as { battlefields: TMonthlyPlanBattlefield[] } | undefined;
  const battlefields = (await q("SELECT id, owner_id FROM battlefield_config ORDER BY sort_order, code, id")).rows as { id: string; owner_id: string }[];
  const subjects = battlefields.map((row) => ({
    type: "battlefield" as const, ...row,
    target: plan?.battlefields.find((item) => item.battlefieldId === row.id)?.outcome ?? null,
  }));
  const itemRuns: MonthlyReviewCreation["itemRuns"] = [];
  for (const subject of subjects) {
    const owner = subject.owner_id || ceo;
    if (!owner) throw new Error("company-people.v1 没有 CEO，无法为待指派的复盘项指定负责人");
    const itemId = randomUUID();
    const runId = randomUUID();
    const waiting = !!(await q(`SELECT 1 FROM missions m JOIN personal_reviews p ON p.person_id=m.owner_id AND p.monthly_review_id=$1
      WHERE m.period=$2 AND m.battlefield_ids @> jsonb_build_array($3::text) LIMIT 1`,
    [reviewId, period, subject.id])).rowCount;
    await q(
      `INSERT INTO monthly_review_items
         (id, review_id, version, subject_type, subject_id, owner_id, owner_unassigned, target, status, draft_run, assessment, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $11, $8::jsonb, $9::jsonb, $10, $10)`,
      [
        itemId, reviewId, subject.type, subject.id, owner, !subject.owner_id, subject.target,
        JSON.stringify({ runId: waiting ? null : runId, error: null }),
        JSON.stringify({ status: "none", runId: null, result: null, error: null }),
        at, waiting ? "waiting" : "drafting",
      ],
    );
    if (!waiting) itemRuns.push({ itemId, runId });
  }
  return { created: true, reviewId, itemRuns, personalRuns };
}

export type MonthlyReviewEffect =
  | { type: "draft"; itemId: string; runId: string }
  | { type: "assess"; itemId: string; runId: string }
  | { type: "summary"; reviewId: string; runId: string }
  | { type: "next_plan"; period: string }
  | { type: "plan_draft"; planId: string; runId: string };
export type MonthlyReviewActionError = { status: number; code: string; message: string; fieldErrors?: Record<string, string> };
export type MonthlyReviewActionOutcome =
  | { ok: true; effects: MonthlyReviewEffect[] }
  | { conflict: true }
  | { error: MonthlyReviewActionError };

function reviewError(status: number, code: string, message: string, fieldErrors?: Record<string, string>): MonthlyReviewActionOutcome {
  return { error: { status, code, message, ...(fieldErrors ? { fieldErrors } : {}) } };
}
const forbidden = (message: string) => reviewError(403, "FORBIDDEN", message);

// ponytail: 幂等指纹列表随操作增长，超过上限丢弃最旧项；单项复盘的操作量有限
function appendFingerprint(existing: string[], fingerprint: string): string[] {
  return [...existing.filter((value) => value !== fingerprint), fingerprint].slice(-100);
}

/**
 * Action 通用事务：行锁 → 不可读的人拒绝 → 已产生效果直接返回（重放）→ 命中版本才继续。
 * 拒绝与冲突路径都结束事务，行锁不随连接泄漏回池。
 */
async function withLock<R extends { version: number; action_fingerprints: string[] }>(
  pool: Pool,
  table: "monthly_reviews" | "monthly_review_items",
  id: string,
  fingerprint: string,
  expectedVersion: number,
  readable: (row: R, client: PoolClient) => Promise<boolean> | boolean,
  run: (client: PoolClient, row: R, fingerprints: string) => Promise<MonthlyReviewActionOutcome>,
): Promise<MonthlyReviewActionOutcome> {
  if (!UUID_PATTERN.test(id)) return reviewError(404, "MONTHLY_REVIEW_NOT_FOUND", "复盘不存在");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 与个人复盘交齐衔接采用相同锁序，避免确认单元时与交齐互相等待。
    if (table === "monthly_review_items") await client.query(
      "SELECT id FROM monthly_reviews WHERE id=(SELECT review_id FROM monthly_review_items WHERE id=$1) FOR UPDATE", [id]);
    const found = await client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    const row = found.rows[0] as R | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return reviewError(404, "MONTHLY_REVIEW_NOT_FOUND", "复盘不存在");
    }
    if (!await readable(row, client)) {
      await client.query("ROLLBACK");
      return forbidden("没有权限处理这项复盘");
    }
    if (table === "monthly_review_items") {
      const item = row as R & ItemLockRow;
      if (item.self_review && !currentSelfReview(item.self_review)) item.self_review = null;
    }
    if (row.action_fingerprints.includes(fingerprint)) {
      await client.query("COMMIT");
      return { ok: true, effects: [] };
    }
    if (row.version !== expectedVersion) {
      await client.query("ROLLBACK");
      return { conflict: true };
    }
    const outcome = await run(client, row, JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint)));
    await client.query("ok" in outcome ? "COMMIT" : "ROLLBACK");
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

type ItemLockRow = Omit<MonthlyReviewItemRecord, "period" | "subject_code" | "subject_name" | "six_month_outcome">;

/** 复盘项动作：负责人 update / resolve_suggestion / submit，CEO return / confirm / retry_assessment，两者都可 retry_draft。 */
export async function executeMonthlyReviewItemAction(
  pool: Pool,
  viewer: ReviewViewer,
  scope: ActionScope,
  input: unknown,
  fingerprint: string,
  now: Date,
): Promise<MonthlyReviewActionOutcome> {
  const at = now.toISOString();
  return withLock<ItemLockRow>(pool, "monthly_review_items", scope.objectId, fingerprint, scope.objectVersion,
    (row, client) => canReadMonthlyReviewItem(client.query.bind(client), viewer, row),
    async (client, row, fingerprints) => {
      const isOwner = viewer.personId === row.owner_id;
      const isCeo = viewer.role === "ceo";
      const editable = EDITABLE.includes(row.status);
      const write = (assignments: string, params: unknown[]) => client.query(
        `UPDATE monthly_review_items SET ${assignments}, version = version + 1, updated_at = $2, action_fingerprints = $3::jsonb WHERE id = $1`,
        [row.id, at, fingerprints, ...params],
      );
      const history = (action: StoredHistoryEntry["action"], reason: string | null) =>
        JSON.stringify([...row.history, { at, by: viewer.personId, action, reason, selfReviewSnapshot: row.self_review }]);
      const notEditable = () => reviewError(409, "MONTHLY_REVIEW_ITEM_STATE", "当前状态不能修改这项复盘");

      switch (scope.actionType) {
        case "monthly-review-item.update": {
          if (!isOwner) return forbidden("只有负责人可以修改自评");
          if (!editable) return notEditable();
          const selfReview = structuredClone(row.self_review ?? emptySelfReview());
          for (const field of (input as TMonthlyReviewItemUpdateInput).fields) {
            selfReview[field.field] = { text: field.text, sources: field.sources ?? selfReview[field.field].sources };
          }
          await write("self_review = $4::jsonb", [JSON.stringify(selfReview)]);
          return { ok: true, effects: [] };
        }
        case "monthly-review-item.resolve_suggestion": {
          if (!isOwner) return forbidden("只有负责人可以处理改写建议");
          if (!editable) return notEditable();
          const { field, decision } = input as TMonthlyReviewResolveSuggestionInput;
          const suggestion = row.suggestions.find((item) => item.field === field);
          if (!suggestion) return reviewError(409, "MONTHLY_REVIEW_SUGGESTION_NOT_FOUND", "这一栏没有待处理的建议");
          const selfReview = structuredClone(row.self_review ?? emptySelfReview());
          if (decision === "adopt") selfReview[field] = { text: suggestion.text, sources: selfReview[field].sources };
          await write("self_review = $4::jsonb, suggestions = $5::jsonb", [
            JSON.stringify(selfReview), JSON.stringify(row.suggestions.filter((item) => item.field !== field)),
          ]);
          return { ok: true, effects: [] };
        }
        case "monthly-review-item.submit": {
          if (!isOwner) return forbidden("只有负责人可以提交复盘");
          if (!editable) return notEditable();
          const empty = MONTHLY_REVIEW_FIELDS.filter((field) => !row.self_review || row.self_review[field].text.trim() === "");
          if (empty.length > 0) {
            return reviewError(400, "MONTHLY_REVIEW_INCOMPLETE", "总体结果、关键经营判断和下周期经营重点都填写后才能提交", Object.fromEntries(empty.map((field) => [field, "required"])));
          }
          const runId = randomUUID();
          await write(
            `status = 'submitted', submitted_at = $4, return_reason = NULL, history = $5::jsonb, suggestions = '[]'::jsonb, assessment = $6::jsonb`,
            [at, history("submit", null), JSON.stringify({ status: "running", runId, result: null, error: null })],
          );
          return { ok: true, effects: [{ type: "assess", itemId: row.id, runId }] };
        }
        case "monthly-review-item.return": {
          if (!isCeo) return forbidden("只有 CEO 可以打回复盘");
          if (row.status !== "submitted") return notEditable();
          const reason = (input as TMonthlyReviewReturnInput).reason.trim();
          await write("status = 'returned', return_reason = $4, history = $5::jsonb", [reason, history("return", reason)]);
          return { ok: true, effects: [] };
        }
        case "monthly-review-item.confirm": {
          if (!isCeo) return forbidden("只有 CEO 可以确认复盘");
          if (row.status !== "submitted") return notEditable();
          await write("status = 'confirmed', confirmed_at = $4, confirmation_source = 'ceo', history = $5::jsonb", [at, history("confirm", null)]);
          return { ok: true, effects: await advanceMonthlyReviewIfReady(client.query.bind(client), row.review_id, now) };
        }
        case "monthly-review-item.retry_draft": {
          if (!isOwner && !isCeo) return forbidden("只有负责人或 CEO 可以重新起草");
          if (row.status !== "draft_failed") return notEditable();
          const runId = randomUUID();
          await write("status = 'drafting', draft_run = $4::jsonb", [JSON.stringify({ runId, error: null })]);
          return { ok: true, effects: [{ type: "draft", itemId: row.id, runId }] };
        }
        case "monthly-review-item.retry_assessment": {
          if (!isCeo) return forbidden("只有 CEO 可以重新评估");
          if (row.assessment.status !== "failed") return reviewError(409, "MONTHLY_REVIEW_ASSESSMENT_STATE", "评估没有失败，不需要重试");
          const runId = randomUUID();
          await write("assessment = $4::jsonb", [JSON.stringify({ status: "running", runId, result: null, error: null })]);
          return { ok: true, effects: [{ type: "assess", itemId: row.id, runId }] };
        }
        default:
          return reviewError(404, "UNKNOWN_ACTION", "无效 actionId");
      }
    });
}

/**
 * 个人复盘已交齐、单元已全确认才汇总；也覆盖部署前已确认的单元。调用方在事务内。
 * 导入的复盘里，有当月 Mission 的能力域项（导入时建的那几项）也要确认完。
 */
export async function advanceMonthlyReviewIfReady(q: Query, reviewId: string, now: Date): Promise<MonthlyReviewEffect[]> {
  const review = (await q("SELECT status FROM monthly_reviews WHERE id=$1 FOR UPDATE", [reviewId])).rows[0];
  if (review?.status !== "collecting") return [];
  const pending = await q(`SELECT 1 FROM monthly_review_items i JOIN monthly_reviews r ON r.id=i.review_id
    WHERE i.review_id=$1 AND i.status<>'confirmed' AND (i.subject_type='battlefield'
      OR r.origin='import' AND EXISTS (SELECT 1 FROM missions m WHERE m.period=r.period AND m.capability_id=i.subject_id))
    UNION ALL SELECT 1 FROM personal_reviews WHERE monthly_review_id=$1 AND status NOT IN ('submitted','skipped') LIMIT 1`, [reviewId]);
  if (pending.rowCount) return [];
  const runId = randomUUID();
  const summary: StoredReviewSummary = { status: "running", runId, error: null, overall: "", judgments: [], nextFocus: [], confirmedAt: null, confirmedBy: null };
  await q("UPDATE monthly_reviews SET status='summarizing',summary=$2::jsonb,version=version+1,updated_at=$3 WHERE id=$1",
    [reviewId, JSON.stringify(summary), now]);
  return [{ type: "summary", reviewId, runId }];
}

/**
 * 导入的复盘：起草成功直接确认，来源 import、不记确认人，不走负责人提交和 CEO 确认；随后看能否汇总。
 * 锁序与其他动作相同（先复盘后复盘项）；按 runId 条件写回，旧 run 不覆盖。
 */
export async function confirmImportedDraft(pool: Pool, reviewId: string, itemId: string, runId: string,
  selfReview: TMonthlyReviewSelfReview, now: Date): Promise<MonthlyReviewEffect[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM monthly_reviews WHERE id=$1 FOR UPDATE", [reviewId]);
    const confirmed = await client.query(`UPDATE monthly_review_items
        SET status='confirmed', self_review=$3::jsonb, confirmed_at=$4, confirmation_source='import',
            draft_run=jsonb_build_object('runId', $2::text, 'error', NULL), version=version+1, updated_at=$4
      WHERE id=$1 AND status='drafting' AND draft_run->>'runId'=$2`, [itemId, runId, JSON.stringify(selfReview), now]);
    const effects = confirmed.rowCount ? await advanceMonthlyReviewIfReady(client.query.bind(client), reviewId, now) : [];
    await client.query("COMMIT");
    return effects;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 复盘级动作（只有 CEO）：公司复盘的编辑、重生成、确认，以及 LTCO 决定。 */
export async function executeMonthlyReviewAction(
  pool: Pool,
  viewer: ReviewViewer,
  scope: ActionScope,
  input: unknown,
  fingerprint: string,
  now: Date,
): Promise<MonthlyReviewActionOutcome> {
  const at = now.toISOString();
  return withLock<MonthlyReviewRow>(pool, "monthly_reviews", scope.objectId, fingerprint, scope.objectVersion,
    () => viewer.role === "ceo",
    async (client, row, fingerprints) => {
      const write = (assignments: string, params: unknown[]) => client.query(
        `UPDATE monthly_reviews SET ${assignments}, version = version + 1, updated_at = $2, action_fingerprints = $3::jsonb WHERE id = $1`,
        [row.id, at, fingerprints, ...params],
      );
      const wrongState = () => reviewError(409, "MONTHLY_REVIEW_STATE", "当前状态不能执行这个操作");
      const summaryReady = row.status === "summarizing" && row.summary.status === "ready";
      switch (scope.actionType) {
        case "monthly-review.update_summary": {
          if (!summaryReady) return wrongState();
          const { overall, judgments, nextFocus } = input as TMonthlyReviewUpdateSummaryInput;
          const summary = { ...row.summary, overall, judgments, nextFocus };
          await write("summary = $4::jsonb", [JSON.stringify(summary)]);
          return { ok: true, effects: [] };
        }
        case "monthly-review.retry_summary": {
          if (row.status !== "summarizing" || (row.summary.status !== "failed" && row.summary.status !== "ready")) return wrongState();
          const runId = randomUUID();
          await write("summary = $4::jsonb", [JSON.stringify({ ...row.summary, status: "running", runId, error: null })]);
          return { ok: true, effects: [{ type: "summary", reviewId: row.id, runId }] };
        }
        case "monthly-review.confirm_summary": {
          if (!summaryReady) return wrongState();
          await write("status = 'ltco_pending', summary = $4::jsonb", [
            JSON.stringify({ ...row.summary, confirmedAt: at, confirmedBy: viewer.personId }),
          ]);
          return { ok: true, effects: [] };
        }
        case "monthly-review.decide_ltco": {
          if (row.status !== "ltco_pending") return wrongState();
          const decisionInput = input as TMonthlyReviewDecideLtcoInput;
          const strategy = await client.query("SELECT ltco FROM company_strategy_config WHERE id = 'default' FOR UPDATE");
          const ltcoBefore = (strategy.rows[0]?.ltco as string | undefined) ?? "";
          const ltcoAfter = decisionInput.decision === "revise" ? (decisionInput.ltco ?? ltcoBefore) : ltcoBefore;
          const units: StoredLtcoDecision["units"] = [];
          if (decisionInput.decision === "revise") {
            for (const unit of decisionInput.units ?? []) {
              if (unit.subjectType !== "battlefield") return reviewError(400, "INVALID_SUBJECT", "LTO 审视只包含公司与战场，能力域目标保持原样");
              const current = (await client.query("SELECT six_month_outcome FROM battlefield_config WHERE id = $1 FOR UPDATE", [unit.subjectId])).rows[0] as { six_month_outcome: string } | undefined;
              if (!current) return reviewError(400, "INVALID_SUBJECT", "长期目标对应的单元不存在");
              if (current.six_month_outcome === unit.sixMonthOutcome) continue;
              await client.query("UPDATE battlefield_config SET six_month_outcome = $2 WHERE id = $1", [unit.subjectId, unit.sixMonthOutcome]);
              units.push({ subjectType: unit.subjectType, subjectId: unit.subjectId, before: current.six_month_outcome, after: unit.sixMonthOutcome });
            }
            if (ltcoAfter === ltcoBefore && units.length === 0) return reviewError(400, "LTCO_NOTHING_CHANGED", "修订内容和现在一样；不改请选保持不变");
            if (ltcoAfter !== ltcoBefore) await client.query(
              "UPDATE company_strategy_config SET ltco = $1 WHERE id = 'default'",
              [ltcoAfter],
            );
          }
          const next = nextPeriod(row.period);
          await client.query("UPDATE company_strategy_config SET lto_window_start=$1,version=version+1,updated_at=$2 WHERE id='default'", [next, at]);
          await client.query("UPDATE battlefield_config SET lto_window_start=$1,version=version+1,updated_at=$2", [next, at]);
          const plan = await redraftPlanAfterReview(client.query.bind(client), next, at);
          const planExisted = plan !== null && plan.runId === null;
          const decision: StoredLtcoDecision = {
            decision: decisionInput.decision, ltcoBefore, ltcoAfter, units, decidedAt: at, decidedBy: viewer.personId, planExisted,
          };
          await write("status = 'closed', ltco_decision = $4::jsonb", [JSON.stringify(decision)]);
          return { ok: true, effects: !plan ? [{ type: "next_plan", period: next }]
            : plan.runId ? [{ type: "plan_draft", planId: plan.planId, runId: plan.runId }] : [] };
        }
        default:
          return reviewError(404, "UNKNOWN_ACTION", "无效 actionId");
      }
    });
}

export type ProposeSuggestionResult =
  | { ok: true; suggestion: TMonthlyReviewSuggestion }
  | { error: string; reason: string };

/**
 * 对话 agent 的改写建议：不经过 Action 签名，锁内校验只有负责人本人、且项在 draft / returned 时才写入。
 * 同一栏只保留一条，新的覆盖旧的；负责人点「采用」才写进自评。
 */
export async function proposeMonthlyReviewSuggestion(
  pool: Pool,
  itemId: string,
  viewer: ReviewViewer,
  input: { field: TMonthlyReviewField; text: string; rationale: string },
  now: Date,
): Promise<ProposeSuggestionResult> {
  if (!UUID_PATTERN.test(itemId)) return { error: "NOT_FOUND", reason: "复盘项不存在" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT owner_id, status, suggestions FROM monthly_review_items WHERE id = $1 FOR UPDATE", [itemId]);
    const row = found.rows[0] as { owner_id: string; status: TMonthlyReviewItemStatus; suggestions: TMonthlyReviewSuggestion[] } | undefined;
    const rejected = !row ? { error: "NOT_FOUND", reason: "复盘项不存在" }
      : row.owner_id !== viewer.personId ? { error: "FORBIDDEN", reason: "只有负责人本人的对话可以给出改写建议" }
      : !EDITABLE.includes(row.status) ? { error: "INVALID_STATE", reason: "这项复盘现在不能修改（只有草稿或被打回时可以）" }
      : null;
    if (rejected || !row) {
      await client.query("ROLLBACK");
      return rejected!;
    }
    const suggestion: TMonthlyReviewSuggestion = { field: input.field, text: input.text, rationale: input.rationale, createdAt: now.toISOString() };
    await client.query(
      "UPDATE monthly_review_items SET suggestions = $2::jsonb, version = version + 1, updated_at = $3 WHERE id = $1",
      [itemId, JSON.stringify([...row.suggestions.filter((item) => item.field !== input.field), suggestion]), now.toISOString()],
    );
    await client.query("COMMIT");
    return { ok: true, suggestion };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 通知投影：由未关闭复盘的当前状态现算，不写通知表。 */
export async function listMonthlyReviewNotices(q: Query, viewer: ReviewViewer): Promise<TMonthlyReviewNotice[]> {
  const reviews = (await q(`SELECT ${REVIEW_COLUMNS} FROM monthly_reviews WHERE status <> 'closed' ORDER BY period`)).rows as MonthlyReviewRow[];
  const isCeo = viewer.role === "ceo";
  const notices: TMonthlyReviewNotice[] = [];
  for (const review of reviews) {
    const month = monthLabel(review.period);
    const personal = (await q("SELECT * FROM personal_reviews WHERE monthly_review_id=$1 AND person_id=$2 AND status NOT IN ('submitted','skipped')", [review.id, viewer.personId])).rows[0] as PersonalReviewRow | undefined;
    if (personal) {
      const text = personal.status === "drafting" ? "Co-Agent 起草中" : personal.status === "draft_failed" ? "起草失败，重试"
        : personal.status === "draft" ? "草稿待你确认提交" : "写你的个人复盘";
      notices.push({ id: `personal-review:${personal.id}:todo`, kind: "personal_todo", period: review.period,
        text: `${month}复盘 · ${text}`, href: personalReviewHref(personal.id, isCeo), createdAt: personal.updated_at.toISOString() });
    }
    const items = await listMonthlyReviewItems(q, review.id);
    for (const item of items) {
      // 导入的复盘不走负责人提交：负责人没有待办
      if (item.subject_type !== "battlefield" || review.origin === "import") continue;
      if (item.owner_id !== viewer.personId || !["waiting", "drafting", "draft", "returned", "draft_failed"].includes(item.status)) continue;
      const subject = [item.subject_code, item.subject_name].filter(Boolean).join(" ");
      notices.push({
        id: `monthly-review-item:${item.id}:todo`,
        kind: "item_todo",
        period: review.period,
        text: item.status === "waiting" ? `${month}复盘 · 等大家交个人复盘 · ${subject}` : item.status === "returned" ? `${month}复盘被打回 · ${subject}` : `${month}复盘待你完成 · ${subject}`,
        href: isCeo ? `/reviews/items/${item.id}` : `/me/reviews/items/${item.id}`,
        createdAt: item.updated_at.toISOString(),
      });
    }
    if (!isCeo) continue;
    const submitted = items.filter((item) => item.subject_type === "battlefield" && item.status === "submitted");
    if (submitted.length > 0) {
      notices.push({
        id: `monthly-review:${review.id}:items`,
        kind: "items_to_review",
        period: review.period,
        text: `${month}复盘：${submitted.length} 项待你处理`,
        href: `/reviews/${review.period}`,
        createdAt: new Date(Math.max(...submitted.map((item) => item.updated_at.getTime()))).toISOString(),
      });
    }
    if (review.status === "summarizing" && review.summary.status === "ready") {
      notices.push({
        id: `monthly-review:${review.id}:summary`, kind: "summary_pending", period: review.period,
        text: `${month}公司复盘待你确认`, href: `/reviews/${review.period}`, createdAt: review.updated_at.toISOString(),
      });
    }
    if (review.status === "ltco_pending") {
      notices.push({
        id: `monthly-review:${review.id}:ltco`, kind: "ltco_pending", period: review.period,
        text: `${month}复盘已完成 · 待决定 LTO`, href: `/reviews/${review.period}/ltco`, createdAt: review.updated_at.toISOString(),
      });
    }
  }
  return notices;
}

export type PreviousMonthlyReview = {
  period: string;
  judgments: TMonthlyReviewJudgment[];
  items: { subjectType: TMonthlyReviewSubjectType; subjectId: string; subjectName: string; selfReview: TMonthlyReviewSelfReview | null }[];
} | null;

/** 下月计划草案的复盘输入：period 之前最新一份已关闭的复盘。 */
export async function loadPreviousReview(q: Query, period: string): Promise<PreviousMonthlyReview> {
  const review = (await q(
    "SELECT id, period, summary FROM monthly_reviews WHERE period < $1 AND status = 'closed' ORDER BY period DESC LIMIT 1",
    [period],
  )).rows[0] as { id: string; period: string; summary: StoredReviewSummary } | undefined;
  if (!review) return null;
  const items = await listMonthlyReviewItems(q, review.id);
  return {
    period: review.period,
    judgments: review.summary.judgments,
    items: items.map((item) => ({ subjectType: item.subject_type, subjectId: item.subject_id, subjectName: item.subject_name, selfReview: item.self_review })),
  };
}
