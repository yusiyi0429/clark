import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  IssueLocation,
  RadarPromotionCandidate,
  type TCard,
  type TDriIssueImportRequest,
  type TIssueLocation,
} from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type IssueResearch = {
  status: "pending" | "running" | "ready" | "failed";
  pendingSince?: string;
  runId?: string | null;
  previousRunIds: string[];
  error?: { code: string; message: string; at: string } | null;
  doc?: unknown;
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
  promotion_fingerprint: string | null;
  created_at: Date;
  updated_at: Date;
};

const ISSUE_COLUMNS = [
  "id", "version", "origin", "origin_ref", "external_id", "request_fingerprint",
  "title", "location", "urgency", "status", "research", "promotion_fingerprint", "created_at", "updated_at",
];
const issueColumns = (prefix = "") => ISSUE_COLUMNS.map((column) => `${prefix}${column}`).join(", ");

/** 代码门槛：维度分下限与总分下限；模型不能输出最终结论（doc 03 §6）。 */
export const PROMOTION_MIN_DIMENSION = 3;
export const PROMOTION_MIN_TOTAL = 12;

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
 * 代码重新校验 Agent 提出的升级候选：CEO decision kind、至少两个不同选择、
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
  const total = dimensions.reduce<number>((sum, value) => sum + (value as number), 0);
  if (dimensions.some((value) => (value as number) < PROMOTION_MIN_DIMENSION) || total < PROMOTION_MIN_TOTAL) {
    return { ok: false, reason: `候选分值未达门槛 ${PROMOTION_MIN_TOTAL}` };
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

export function projectIssueCard(row: IssueRow): TCard {
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
      research: row.research,
    },
    navigation: [{ href: `/issues/${row.id}`, label: "Issue" }],
    conversation: { scope: `issue:${row.id}` },
    actions: [],
  };
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
 * `failed:trigger_not_started`，等待 CEO 显式重试，不自动调用模型。
 */
export async function recoverInterruptedResearch(
  q: Query,
  { now = () => new Date(), staleAfterMs = 15 * 60 * 1000 }: { now?: () => Date; staleAfterMs?: number } = {},
): Promise<number> {
  const cutoff = new Date(now().getTime() - staleAfterMs);
  const result = await q(
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
  return result.rowCount ?? 0;
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
      return { status: 200, card: projectIssueCard(row) };
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
        ? { status: 200, card: projectIssueCard(row) }
        : { status: 409, code: "DRI_EXTERNAL_ID_CONFLICT", message: "同一 externalId 已存在且内容不同" };
    }
    await client.query("COMMIT");
    const card = projectIssueCard(inserted.rows[0] as IssueRow);
    return { status: 201, card };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
