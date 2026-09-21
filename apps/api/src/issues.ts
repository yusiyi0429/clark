import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  IssueDecideInput,
  IssueDecideOverrideInput,
  IssueDismissInput,
  IssueLocation,
  IssueRestoreInput,
  IssueRetryResearchInput,
  IssueRevokeReceiptInput,
  RadarPromotionCandidate,
  type TActionDescriptor,
  type TCard,
  type TDriIssueImportRequest,
  type TIssueLocation,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import { revokeEffect } from "./effects.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type IssueResearch = {
  status: "pending" | "running" | "ready" | "failed";
  pendingSince?: string;
  startedAt?: string;
  runId?: string | null;
  previousRunIds: string[];
  error?: { code: string; message: string; at: string } | null;
  doc?: unknown;
  /** 显式重跑 Action 的 fingerprint：重放不产生第二个 run。 */
  retryFingerprint?: string;
};

/** Issue 内嵌 Receipt：保存 CEO 最终文本、决定时预研状态与 override 事实。 */
export type IssueReceiptRow = {
  id: string;
  actionType: string;
  actionFingerprint: string;
  effectRef: string;
  decisionText: string;
  optionId?: string;
  researchStatusAtDecision: IssueResearch["status"];
  researchRunId?: string;
  override: boolean;
  /** 由 MeetingOutcome decision 确认产生的 Receipt 携带精确来源。 */
  source?: { kind: "meeting-item"; meetingId: string; outcomeItemId: string };
  createdAt: string;
  revokedAt?: string;
  revokedFingerprint?: string;
  revokeReason?: string;
};

export type IssueUrgency = {
  level: "red" | "yellow" | "gray";
  reason?: string;
  decisionBy?: string;
  /** 外部 red 的来源证据：连续引文与由该引文解析出的决定窗口。 */
  decisionByEvidence?: { quote: string; window: string };
};

export type IssueRow = {
  id: string;
  version: number;
  origin: "radar" | "dri";
  origin_ref: unknown;
  external_id: string | null;
  request_fingerprint: string | null;
  title: string;
  location: TIssueLocation;
  urgency: IssueUrgency;
  status: "pending" | "decided" | "dismissed";
  research: IssueResearch;
  receipts: IssueReceiptRow[];
  promotion_fingerprint: string | null;
  dismissed_at: Date | null;
  dismiss_reason: string | null;
  dismiss_fingerprint: string | null;
  restored_at: Date | null;
  restore_fingerprint: string | null;
  created_at: Date;
  updated_at: Date;
};

const ISSUE_COLUMNS = [
  "id", "version", "origin", "origin_ref", "external_id", "request_fingerprint",
  "title", "location", "urgency", "status", "research", "receipts", "promotion_fingerprint",
  "dismissed_at", "dismiss_reason", "dismiss_fingerprint", "restored_at", "restore_fingerprint", "created_at", "updated_at",
];
const issueColumns = (prefix = "") => ISSUE_COLUMNS.map((column) => `${prefix}${column}`).join(", ");

/** 预研从未启动的可见失败码；CEO 显式重试由 Ticket 08 提供。 */
export const TRIGGER_NOT_STARTED = "trigger_not_started";

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").replace(/[。！？!?.,，、；;：:]+$/u, "");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function normalizeLocation(location: TIssueLocation): TIssueLocation {
  // 多战场顺序不影响 fingerprint：排序后确定化（去重已由 schema 保证）
  if (location.level !== "company") return location;
  return { level: "company", relatedBattlefieldIds: [...location.relatedBattlefieldIds].sort() };
}

/**
 * promotion fingerprint = SHA-256(v1 + decisionKind + 规范化问题 + 规范化 location)。
 * 只保证确定性，不识别语义改写；真实重复率成为问题时再升级。
 */
export function promotionFingerprint(
  decisionKind: string,
  decisionQuestion: string,
  location: TIssueLocation,
): string {
  return createHash("sha256")
    .update(["v1", decisionKind, normalizeText(decisionQuestion), canonicalJson(normalizeLocation(location))].join("\n"))
    .digest("hex");
}

export type PromotionRejection = { ok: false; reason: string };
export type PromotionAccepted = {
  ok: true;
  promotion: {
    decisionKind: string;
    decisionQuestion: string;
    options: string[];
    location: TIssueLocation;
    urgency: IssueUrgency;
    fingerprint: string;
  };
};

/**
 * 代码重新校验 Agent 提出的升级候选：合法契约、至少两个不同选择、
 * 连续引文、合法 location、分值门槛与确定性去重指纹。模型不能决定最终门槛。
 */
export function assessPromotion(input: {
  promotion: unknown;
  excerpt: string;
  evidenceQuote: string;
  score: unknown;
}): PromotionAccepted | PromotionRejection {
  if (!Value.Check(RadarPromotionCandidate, input.promotion)) {
    return { ok: false, reason: "升级候选不符合 Radar promotion 契约" };
  }
  const promotion = input.promotion;
  if (!input.excerpt.includes(input.evidenceQuote)) {
    return { ok: false, reason: "候选引文不在来源 excerpt 内" };
  }
  const options: string[] = [];
  for (const option of promotion.options) {
    const normalized = normalizeText(option);
    if (normalized.length === 0) return { ok: false, reason: "升级选项为空" };
    if (!options.includes(normalized)) options.push(normalized);
  }
  if (options.length < 2) return { ok: false, reason: "升级候选少于两个不同选择" };

  const score = input.score as { relevance?: number; impact?: number; urgency?: number } | null;
  if (!score || typeof score !== "object") return { ok: false, reason: "候选分值为空" };
  const dimensions = [score.relevance, score.impact, score.urgency];
  if (dimensions.some((value) => !Number.isInteger(value) || (value as number) < 0 || (value as number) > 5)) {
    return { ok: false, reason: "候选分值超出范围" };
  }

  const urgency: IssueUrgency = { level: promotion.urgency.level };
  if (promotion.urgency.reason) urgency.reason = promotion.urgency.reason;
  if (promotion.urgency.decisionBy) {
    if (!Number.isFinite(Date.parse(promotion.urgency.decisionBy))) {
      return { ok: false, reason: "decisionBy 不是可解析时间" };
    }
    urgency.decisionBy = promotion.urgency.decisionBy;
  }
  if (promotion.urgency.level === "red") {
    const evidence = promotion.urgency.decisionByEvidence;
    if (!promotion.urgency.reason || !urgency.decisionBy || !evidence) {
      return { ok: false, reason: "red 候选缺少 decisionBy、reason 或来源证据" };
    }
    if (!input.excerpt.includes(evidence.quote)) {
      return { ok: false, reason: "red decisionByEvidence 引文不在来源 excerpt 内" };
    }
    const window = parseDecisionWindow(evidence.quote, companyYear(new Date(urgency.decisionBy)));
    if (!window) return { ok: false, reason: "red decisionByEvidence 无法解析出决定窗口" };
    urgency.decisionByEvidence = { quote: evidence.quote, window };
  }
  const location = normalizeLocation(promotion.location);
  if (!Value.Check(IssueLocation, location)) return { ok: false, reason: "升级归属不合法" };
  const locationError = locationDomainError(location);
  if (locationError) return { ok: false, reason: locationError };

  return {
    ok: true,
    promotion: {
      decisionKind: promotion.decisionKind,
      decisionQuestion: promotion.decisionQuestion,
      options,
      location,
      urgency,
      fingerprint: promotionFingerprint(promotion.decisionKind, promotion.decisionQuestion, location),
    },
  };
}

export function projectIssueCard(row: IssueRow, secret: string): TCard {
  return {
    schemaVersion: 1,
    id: `issue:${row.id}`,
    version: row.version,
    kind: "issue",
    objectRef: { type: "issue", id: row.id, version: row.version },
    title: row.title,
    badge: row.origin === "radar" ? "Radar" : "DRI",
    urgency: row.urgency.level === "red" ? "red" : "normal",
    payload: {
      origin: row.origin,
      originRef: row.origin_ref,
      status: row.status,
      location: row.location,
      urgency: row.urgency,
      research: projectResearch(row.research),
      receipts: row.receipts.map(projectReceipt),
      dismissedAt: row.dismissed_at?.toISOString() ?? null,
      dismissReason: row.dismiss_reason,
      ...(row.restored_at ? { restoredAt: row.restored_at.toISOString() } : {}),
    },
    navigation: [{ href: `/issues/${row.id}`, label: "Issue" }],
    conversation: { scope: `issue:${row.id}` },
    actions: issueActions(row, secret),
  };
}

/** research 只投影 CEO 可见字段；retryFingerprint 等内部幂等状态不进 payload。 */
function projectResearch(research: IssueResearch) {
  return {
    status: research.status,
    pendingSince: research.pendingSince,
    runId: research.runId,
    previousRunIds: research.previousRunIds,
    error: research.error ?? null,
    doc: research.doc,
  };
}

/** 只投影公开 Receipt 字段，不把 actionFingerprint 等内部幂等状态带到 Web。 */
function projectReceipt(receipt: IssueReceiptRow) {
  return {
    id: receipt.id,
    actionType: receipt.actionType,
    effectRef: receipt.effectRef,
    decisionText: receipt.decisionText,
    optionId: receipt.optionId,
    researchStatusAtDecision: receipt.researchStatusAtDecision,
    researchRunId: receipt.researchRunId,
    override: receipt.override,
    ...(receipt.source ? { source: receipt.source } : {}),
    createdAt: receipt.createdAt,
    revokedAt: receipt.revokedAt,
    revokeReason: receipt.revokeReason,
  };
}

/** Card 只暴露当前状态允许的 Action；服务端仍会重新校验状态。 */
function issueActions(row: IssueRow, secret: string): TActionDescriptor[] {
  const sign = (actionType: string, itemId?: string) => signActionId(secret, {
    actionType,
    objectType: "issue",
    objectId: row.id,
    objectVersion: row.version,
    itemId,
  });
  const actions: TActionDescriptor[] = [];
  if (row.status === "pending") {
    if (row.research.status !== "running") {
      actions.push({ actionId: sign("issue.retry_research"), actionType: "issue.retry_research", label: "重新预研" });
    }
    if (row.research.status === "ready") {
      actions.push({ actionId: sign("issue.decide"), actionType: "issue.decide", label: "直接决定" });
    } else if (row.research.status === "pending" || row.research.status === "failed") {
      actions.push({
        actionId: sign("issue.decide_override"),
        actionType: "issue.decide_override",
        label: "预研未完成时直接决定",
      });
    }
    actions.push({ actionId: sign("issue.dismiss"), actionType: "issue.dismiss", label: "移出议题" });
  }
  if (row.status === "dismissed") {
    actions.push({ actionId: sign("issue.restore"), actionType: "issue.restore", label: "恢复到待处理" });
  }
  if (row.status === "decided") {
    for (const receipt of row.receipts.filter((candidate) => !candidate.revokedAt)) {
      actions.push({
        actionId: sign("issue.revoke_receipt", receipt.id),
        actionType: "issue.revoke_receipt",
        label: "撤回决定",
        itemId: receipt.id,
      });
    }
  }
  // Ticket 09：Meeting 是 pending Issue 的可选决策路径（decided/dismissed 不再暴露）
  if (row.status === "pending") {
    actions.push(
      { actionId: sign("issue.create_meeting"), actionType: "issue.create_meeting", label: "新建 Meeting" },
      { actionId: sign("issue.join_meeting"), actionType: "issue.join_meeting", label: "加入已有 Meeting" },
    );
  }
  return actions;
}

/** 首页与通知共用同一持久对象：一次返回全部 pending Issue，Web 按 location/urgency 固定布局。 */
export async function listPendingIssueCards(q: Query, secret: string): Promise<TCard[]> {
  const result = await q(
    `SELECT ${issueColumns()} FROM issues
      WHERE status = 'pending'
      ORDER BY created_at, id`,
  );
  return (result.rows as IssueRow[]).map((row) => projectIssueCard(row, secret));
}

/**
 * 领域归属规则：一个 Issue 只有一个主 location；多战场必须使用 company。
 * Radar 与 DRI 共用同一规则，避免同一模型两个入口口径不一致。
 */
export function locationDomainError(location: TIssueLocation): string | null {
  if (location.level !== "company") return null;
  if (location.relatedBattlefieldIds.length === 1) {
    return "单一战场必须使用 battlefield 归属，company 用于跨战场议题";
  }
  return null;
}

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return Number(token);
  const tensIndex = token.indexOf("十");
  if (tensIndex === -1) return token.length === 1 ? CN_DIGITS[token] ?? null : null;
  const tens = tensIndex === 0 ? 1 : CN_DIGITS[token[tensIndex - 1]];
  const ones = tensIndex === token.length - 1 ? 0 : CN_DIGITS[token[tensIndex + 1]];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

/** 引文里写死的年份优先；否则用 decisionBy 所在的公司日历年。 */
const CHINESE_MONTH_DAY = /(?:(?<year>\d{4})年)?(?<month>[零一二两三四五六七八九十\d]{1,3})月(?<day>[零一二两三四五六七八九十\d]{1,3})[日号]/;

function decisionWindow(year: number, month: number | null, day: number | null): string | null {
  if (month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // 2月30日 这类不存在的日期不得被月进位静默改写成另一个日期
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * 从 red 的来源引文解析决定时间窗口；只接受明确的年月日写法（2026-06-01、6月1日、六月一日），
 * 不接受模糊语气，避免模型仅凭措辞制造红色通知。
 */
export function parseDecisionWindow(quote: string, fallbackYear: number): string | null {
  const iso = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(quote);
  if (iso) return decisionWindow(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const chinese = CHINESE_MONTH_DAY.exec(quote);
  if (!chinese?.groups) return null;
  return decisionWindow(
    chinese.groups.year ? Number(chinese.groups.year) : fallbackYear,
    cnNumber(chinese.groups.month),
    cnNumber(chinese.groups.day),
  );
}

/** Company Day 时区下的年份；跨年瞬间不得用 UTC 年推断公司日期。 */
function companyYear(date: Date): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric" }).format(date));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getIssueRow(q: Query, id: string): Promise<IssueRow | null> {
  // 路径参数先做形状校验：非 UUID 直接视为不存在，不让 PostgreSQL 报类型错误
  if (!UUID_PATTERN.test(id)) return null;
  const result = await q(`SELECT ${issueColumns()} FROM issues WHERE id = $1`, [id]);
  return result.rowCount === 1 ? result.rows[0] as IssueRow : null;
}

/**
 * 启动恢复：创建后、预研启动前崩溃留下的超时 pending research 标为
 * `failed:trigger_not_started`；进程重启时中断的 running research 标为 failed，
 * 两种都等待 CEO 显式重试，不自动调用模型。
 */
export async function recoverInterruptedResearch(
  q: Query,
  { now = () => new Date(), staleAfterMs = 15 * 60 * 1000 }: { now?: () => Date; staleAfterMs?: number } = {},
): Promise<number> {
  const cutoff = new Date(now().getTime() - staleAfterMs);
  const interrupted = await q(
    `UPDATE issues
        SET research = research || jsonb_build_object(
              'status', 'failed',
              'error', jsonb_build_object(
                'code', 'research_interrupted',
                'message', '预研在进程重启时中断，请显式重试',
                'at', now()
              ),
              'startedAt', NULL
            ),
            version = version + 1,
            updated_at = now()
      WHERE status = 'pending'
        AND research->>'status' = 'running'
        AND (research->>'startedAt')::timestamptz < $1`,
    [cutoff],
  );
  const notStarted = await q(
    `UPDATE issues
        SET research = jsonb_set(
              jsonb_set(research, '{status}', '"failed"'),
              '{error}',
              jsonb_build_object(
                'code', '${TRIGGER_NOT_STARTED}',
                'message', '预研在进程重启前未启动，请显式重试',
                'at', now()
              )
            ),
            version = version + 1,
            updated_at = now()
      WHERE status = 'pending'
        AND research->>'status' = 'pending'
        AND (research->>'pendingSince')::timestamptz < $1`,
    [cutoff],
  );
  return (interrupted.rowCount ?? 0) + (notStarted.rowCount ?? 0);
}

export type DriImportResult =
  | { status: 201 | 200; card: TCard }
  | { status: 400 | 409; code: string; message: string; fieldErrors?: Record<string, string> };

/**
 * DRI 服务导入：CompanyMemory MCP 稳定 personId 校验身份，domain 校验 location，
 * red 额外要求可解析 decisionBy 和 reason；相同 externalId 同内容返回原对象。
 */
export async function importDriIssue(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  body: TDriIssueImportRequest,
  secret: string,
): Promise<DriImportResult> {
  if (!companyMemory.searchPeople(undefined).some((person) => person.personId === body.submitterPersonId)) {
    return { status: 400, code: "INVALID_SUBMITTER", message: "提交人不在 company-people.v1 人员目录中", fieldErrors: { submitterPersonId: "unknown personId" } };
  }
  const location = normalizeLocation(body.location);
  if (!Value.Check(IssueLocation, location)) {
    return { status: 400, code: "INVALID_LOCATION", message: "归属不合法", fieldErrors: { location: "invalid location" } };
  }
  const locationError = locationDomainError(location);
  if (locationError) {
    return { status: 400, code: "INVALID_LOCATION", message: locationError, fieldErrors: { location: locationError } };
  }
  const urgency: IssueUrgency = { level: body.urgency?.level ?? "gray" };
  if (body.urgency?.reason) urgency.reason = body.urgency.reason;
  if (body.urgency?.decisionBy) {
    if (!Number.isFinite(Date.parse(body.urgency.decisionBy))) {
      return { status: 400, code: "INVALID_INPUT", message: "decisionBy 不是可解析时间", fieldErrors: { "urgency.decisionBy": "unparsable" } };
    }
    urgency.decisionBy = body.urgency.decisionBy;
  }
  if (urgency.level === "red" && (!urgency.decisionBy || !urgency.reason)) {
    return { status: 400, code: "INVALID_INPUT", message: "red 提交必须提供 decisionBy 和 reason" };
  }

  const requestFingerprint = createHash("sha256").update(canonicalJson({
    externalId: body.externalId,
    submitterPersonId: body.submitterPersonId,
    title: body.title,
    whyNow: body.whyNow,
    sourceRef: body.sourceRef,
    location,
    urgency,
  })).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT ${issueColumns()} FROM issues WHERE external_id = $1`,
      [body.externalId],
    );
    if (existing.rowCount === 1) {
      const row = existing.rows[0] as IssueRow;
      if (row.request_fingerprint !== requestFingerprint) {
        await client.query("ROLLBACK");
        return { status: 409, code: "DRI_EXTERNAL_ID_CONFLICT", message: "同一 externalId 已存在且内容不同" };
      }
      await client.query("ROLLBACK");
      return { status: 200, card: projectIssueCard(row, secret) };
    }

    const inserted = await client.query(
      `INSERT INTO issues
         (id, version, origin, origin_ref, external_id, request_fingerprint,
          title, location, urgency, status, research)
       VALUES ($1, 1, 'dri', $2::jsonb, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending', $8::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING ${issueColumns()}`,
      [
        randomUUID(),
        JSON.stringify({ externalId: body.externalId, submitterPersonId: body.submitterPersonId, whyNow: body.whyNow, sourceRef: body.sourceRef }),
        body.externalId,
        requestFingerprint,
        body.title,
        JSON.stringify(location),
        JSON.stringify(urgency),
        JSON.stringify({ status: "pending", pendingSince: new Date().toISOString(), runId: null, previousRunIds: [], error: null }),
      ],
    );
    // 并发下同一 externalId 先提交：返回已存在对象而不是第二份 Issue
    if (inserted.rowCount !== 1) {
      await client.query("ROLLBACK");
      const raced = await client.query(`SELECT ${issueColumns()} FROM issues WHERE external_id = $1`, [body.externalId]);
      if (raced.rowCount !== 1) return { status: 409, code: "DRI_EXTERNAL_ID_CONFLICT", message: "externalId 已被占用" };
      const row = raced.rows[0] as IssueRow;
      return row.request_fingerprint === requestFingerprint
        ? { status: 200, card: projectIssueCard(row, secret) }
        : { status: 409, code: "DRI_EXTERNAL_ID_CONFLICT", message: "同一 externalId 已存在且内容不同" };
    }
    await client.query("COMMIT");
    const card = projectIssueCard(inserted.rows[0] as IssueRow, secret);
    return { status: 201, card };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 已注册的 Issue Action 与其严格输入 schema；未列出的 actionType 一律 404。 */
const ISSUE_ACTION_INPUTS = {
  "issue.retry_research": IssueRetryResearchInput,
  "issue.decide": IssueDecideInput,
  "issue.decide_override": IssueDecideOverrideInput,
  "issue.dismiss": IssueDismissInput,
  "issue.restore": IssueRestoreInput,
  "issue.revoke_receipt": IssueRevokeReceiptInput,
} as const;

export type IssueActionOutcome =
  | { ok: true; card: TCard; startResearch?: { issueId: string; runId: string } }
  | { ok: false; status: 400 | 404 | 409; code: string; message: string; latestCard?: TCard };

function replayAlreadyProduced(row: IssueRow, actionType: string, itemId: string | undefined, fingerprint: string): boolean {
  switch (actionType) {
    case "issue.decide":
    case "issue.decide_override":
      return row.receipts.some((receipt) => receipt.actionFingerprint === fingerprint);
    case "issue.dismiss":
      return row.dismiss_fingerprint === fingerprint;
    case "issue.restore":
      return row.restore_fingerprint === fingerprint;
    case "issue.retry_research":
      return row.research.retryFingerprint === fingerprint;
    case "issue.revoke_receipt":
      return row.receipts.some((receipt) => receipt.id === itemId && receipt.revokedFingerprint === fingerprint);
    default:
      return false;
  }
}

/**
 * Issue Action 统一执行：fingerprint 幂等优先，再校验 version 与状态。
 * 只有这里能写 Organization Fact（decided/dismissed/Receipt）。
 */
export async function executeIssueAction(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
  input: unknown,
): Promise<IssueActionOutcome> {
  const schema = ISSUE_ACTION_INPUTS[scope.actionType as keyof typeof ISSUE_ACTION_INPUTS];
  if (!schema) return { ok: false, status: 404, code: "UNKNOWN_ACTION", message: "未注册的 actionType" };
  const payload = input ?? {};
  if (!Value.Check(schema, payload)) {
    return { ok: false, status: 400, code: "INVALID_INPUT", message: "Action 输入不符合契约" };
  }

  // Issue 页面遇到 meeting-item Receipt：必须委托统一 meeting revoker，不得直接改 Receipt
  if (scope.actionType === "issue.revoke_receipt") {
    const preview = await getIssueRow(pool.query.bind(pool), scope.objectId);
    const target = scope.itemId ? preview?.receipts.find((receipt) => receipt.id === scope.itemId) : undefined;
    if (preview && target?.effectRef.startsWith("meeting:")) {
      return revokeMeetingReceiptFromIssue(pool, secret, preview, target, scope.objectVersion, fingerprint, (payload as { reason?: string }).reason);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(`SELECT ${issueColumns()} FROM issues WHERE id = $1 FOR UPDATE`, [scope.objectId]);
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, code: "CARD_NOT_FOUND", message: "Issue 不存在" };
    }
    const row = locked.rows[0] as IssueRow;
    const current = () => projectIssueCard(row, secret);
    const conflict = async (code: string, message: string): Promise<IssueActionOutcome> => {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, code, message, latestCard: current() };
    };

    // 幂等重放优先于 version 校验
    if (replayAlreadyProduced(row, scope.actionType, scope.itemId, fingerprint)) {
      await client.query("COMMIT");
      return { ok: true, card: current() };
    }
    if (row.version !== scope.objectVersion) {
      return conflict("VERSION_CONFLICT", "对象已被修改，请基于最新 Card 重试");
    }

    const now = new Date().toISOString();

    if (scope.actionType === "issue.decide" || scope.actionType === "issue.decide_override") {
      const override = scope.actionType === "issue.decide_override";
      const decision = payload as { decisionText: string; optionId?: string };
      if (row.status !== "pending") return conflict("ISSUE_NOT_PENDING", "只有 pending Issue 可以决定");
      if (override) {
        if (row.research.status === "ready") return conflict("RESEARCH_READY", "预研已完成，请使用直接决定");
        if (row.research.status === "running") return conflict("RESEARCH_RUNNING", "预研进行中，不能覆盖决定");
        // override 契约没有 optionId：带 optionId 的请求已在 Value.Check 层被 400 拒绝
      } else {
        if (row.research.status !== "ready") {
          return conflict("RESEARCH_NOT_READY", "预研未完成，必须经二次确认执行 Research Override");
        }
        const options = (row.research.doc as { options?: { id: string }[] } | undefined)?.options ?? [];
        if (decision.optionId && !options.some((option) => option.id === decision.optionId)) {
          await client.query("ROLLBACK");
          return { ok: false, status: 400, code: "INVALID_INPUT", message: "建议选项不在当前 ResearchDoc 中" };
        }
      }
      const receiptId = randomUUID();
      const receipt: IssueReceiptRow = {
        id: receiptId,
        actionType: scope.actionType,
        actionFingerprint: fingerprint,
        effectRef: `issue:${row.id}:decision:${receiptId}`,
        decisionText: decision.decisionText,
        ...(decision.optionId ? { optionId: decision.optionId } : {}),
        researchStatusAtDecision: row.research.status,
        ...(row.research.runId ? { researchRunId: row.research.runId } : {}),
        override,
        createdAt: now,
      };
      const receipts = [...row.receipts, receipt];
      await client.query(
        "UPDATE issues SET status = 'decided', receipts = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1",
        [row.id, JSON.stringify(receipts)],
      );
      const card = projectIssueCard({ ...row, status: "decided", receipts, version: row.version + 1 }, secret);
      await client.query("COMMIT");
      return { ok: true, card };
    }

    if (scope.actionType === "issue.dismiss") {
      const { reason } = payload as { reason: string };
      if (row.status !== "pending") return conflict("ISSUE_NOT_PENDING", "只有 pending Issue 可以移出议题");
      await client.query(
        `UPDATE issues
            SET status = 'dismissed', dismissed_at = now(), dismiss_reason = $2,
                dismiss_fingerprint = $3, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [row.id, reason, fingerprint],
      );
      const card = projectIssueCard(
        { ...row, status: "dismissed", dismissed_at: new Date(now), dismiss_reason: reason, dismiss_fingerprint: fingerprint, version: row.version + 1 },
        secret,
      );
      await client.query("COMMIT");
      return { ok: true, card };
    }

    if (scope.actionType === "issue.restore") {
      if (row.status !== "dismissed") return conflict("ISSUE_NOT_DISMISSED", "只有 dismissed Issue 可以恢复");
      // 移出审计字段（dismissed_at/reason/fingerprint）保留不删；恢复另存审计指纹与时间。
      await client.query(
        `UPDATE issues
            SET status = 'pending', restored_at = now(), restore_fingerprint = $2,
                version = version + 1, updated_at = now()
          WHERE id = $1`,
        [row.id, fingerprint],
      );
      const card = projectIssueCard(
        { ...row, status: "pending", restored_at: new Date(now), restore_fingerprint: fingerprint, version: row.version + 1 },
        secret,
      );
      await client.query("COMMIT");
      return { ok: true, card };
    }

    if (scope.actionType === "issue.retry_research") {
      if (row.status !== "pending") return conflict("ISSUE_NOT_PENDING", "只有 pending Issue 可以重新预研");
      if (row.research.status === "running") return conflict("RESEARCH_RUNNING", "预研正在运行，等待本轮结束");
      const runId = randomUUID();
      const previousRunIds = [...row.research.previousRunIds];
      if (row.research.runId && !previousRunIds.includes(row.research.runId)) previousRunIds.push(row.research.runId);
      // 重跑整份替换当前 doc：旧输出只留在 AgentRun，不在 Issue 上拼接
      const research: IssueResearch = {
        status: "running",
        startedAt: now,
        runId,
        previousRunIds,
        error: null,
        retryFingerprint: fingerprint,
      };
      await client.query(
        "UPDATE issues SET research = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1",
        [row.id, JSON.stringify(research)],
      );
      const card = projectIssueCard({ ...row, research, version: row.version + 1 }, secret);
      await client.query("COMMIT");
      return { ok: true, card, startResearch: { issueId: row.id, runId } };
    }

    // issue.revoke_receipt
    const receiptId = scope.itemId;
    const target = receiptId ? row.receipts.find((receipt) => receipt.id === receiptId) : undefined;
    if (!target) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, code: "RECEIPT_NOT_FOUND", message: "Receipt 不存在" };
    }
    if (row.status !== "decided") return conflict("ISSUE_NOT_DECIDED", "只有 decided Issue 可以撤回 Receipt");
    if (target.revokedAt) {
      // 已撤回的 Receipt 用新 fingerprint 再撤：effect 已不存在，不产生第二次状态变更
      await client.query("COMMIT");
      return { ok: true, card: current() };
    }
    const revoked = await revokeEffect(client, target.effectRef, fingerprint, {
      reason: (payload as { reason?: string }).reason,
      at: now,
    });
    if (!revoked.ok) {
      if ("conflict" in revoked && revoked.conflict) return conflict("VERSION_CONFLICT", "对象已被修改，请基于最新 Card 重试");
      return conflict(revoked.code, revoked.message);
    }
    await client.query("COMMIT");
    // 此分支只处理 issue: Receipt；meeting: Receipt 已在前面委托 meeting revoker
    return { ok: true, card: projectIssueCard(revoked.target === "issue" ? revoked.issue : row, secret) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 从 Issue 页面撤回由 MeetingOutcome decision 写入的 Receipt：
 * 委托统一 revokeMeetingEffect，同步 Outcome item、Radar anchor 与 Meeting 派生状态。
 */
async function revokeMeetingReceiptFromIssue(
  pool: Pool,
  secret: string,
  issue: IssueRow,
  receipt: IssueReceiptRow,
  expectedIssueVersion: number,
  fingerprint: string,
  reason?: string,
): Promise<IssueActionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await revokeEffect(client, receipt.effectRef, fingerprint, {
      // 与 executeIssueAction 一致：用 Card 上的 Issue version 串行，不信任读到的行版本
      expectedIssueVersion,
      reason,
    });
    if (!result.ok) {
      await client.query("ROLLBACK");
      if ("conflict" in result && result.conflict) {
        return {
          ok: false,
          status: 409,
          code: "VERSION_CONFLICT",
          message: "对象已被修改，请基于最新 Card 重试",
          latestCard: result.latestIssue ? projectIssueCard(result.latestIssue, secret) : undefined,
        };
      }
      return { ok: false, status: 409, code: result.code, message: result.message };
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const updated = await getIssueRow(pool.query.bind(pool), issue.id);
  // Issue 不被删除，回退时保留原 Card
  return { ok: true, card: projectIssueCard(updated ?? issue, secret) };
}
