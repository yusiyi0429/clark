import type { QueryResult } from "pg";
import type { TCard, TRadarSources, TSignalStateRequest } from "@warmap/contracts";
import { RADAR_OUTLETS } from "@warmap/contracts";
import type { RadarService } from "./radar.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

type RadarRow = {
  version: number;
  timezone: string;
  lookback_hours: number;
  anchors: unknown;
  sources: TRadarSources;
  scheduled_company_day: string | null;
  last_scheduled_at: Date | null;
  last_run: unknown;
};

type SignalRow = {
  id: string;
  version: number;
  source_type: "web" | "wechat-account" | "outlet";
  source_fingerprint: string;
  source_title: string;
  source_url: string;
  published_at: Date;
  excerpt: string;
  source_ref: unknown;
  anchor_id: string;
  location: unknown;
  summary: string;
  strategic_impact: string;
  evidence_quote: string;
  unknowns: unknown;
  score: unknown;
  read_at: Date | null;
  saved_at: Date | null;
  dismissed_at: Date | null;
  collected_at: Date;
  source_images: unknown;
};

const SIGNAL_COLUMNS = [
  "id", "version", "source_type", "source_fingerprint", "source_title", "source_url", "published_at",
  "excerpt", "source_ref", "anchor_id", "location", "summary", "strategic_impact", "evidence_quote", "unknowns", "score",
  "read_at", "saved_at", "dismissed_at", "collected_at", "source_images",
];
const signalColumns = (prefix = "") => SIGNAL_COLUMNS.map((column) => `${prefix}${column}`).join(", ");

type SourceImage = { src: string; after: number };
function sourceImages(value: unknown): SourceImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image) => {
    if (!image || typeof image !== "object") return [];
    const { src, after } = image as { src?: unknown; after?: unknown };
    return typeof src === "string" && /^https?:\/\//.test(src) && typeof after === "number" && Number.isInteger(after) && after >= 0
      ? [{ src, after }]
      : [];
  }).slice(0, 12);
}

/** 核心观点是 Signal 的卡片标题；UI 统一限制 30 个字符，避免长研判吞掉阅读首屏。 */
export function shortSignalTitle(summary: string): string {
  const chars = Array.from(summary);
  return chars.length > 30 ? `${chars.slice(0, 29).join("")}…` : summary;
}

const FULL_TEXT_OUTLETS = new Set(RADAR_OUTLETS.filter((outlet) => outlet.fullText).map((outlet) => outlet.outletId));

/**
 * 原文是不是全文：先看采集时逐条记下的 sourceRef.fullText（公众号 read_article、发布方文章页、检索条目抓原文页）；
 * 没有这个字段的旧行退回目录推断——只有目录标了 fullText 的发布方（量子位）算全文，其余都是检索或 feed 给的摘录。
 */
export function isFullTextSource(sourceRef: unknown): boolean {
  const ref = sourceRef as { type?: string; outletId?: string; fullText?: unknown } | null;
  if (typeof ref?.fullText === "boolean") return ref.fullText;
  return ref?.type === "outlet" && typeof ref.outletId === "string" && FULL_TEXT_OUTLETS.has(ref.outletId);
}

/** 发布方来源的徽标用中文媒体名，如实标注归属，避免用站点搜索冒充发布方。 */
function outletBadge(sourceRef: unknown): string {
  const ref = sourceRef as { type?: string; outletName?: string } | null;
  return ref?.type === "outlet" && ref.outletName ? ref.outletName : "发布方";
}

/** `now` is the business clock (a demo session uses its pack date); date filters on the list count days from it. */
export async function projectRadarCard(q: Query, providers: RadarService["providerStatus"], now = new Date()): Promise<TCard> {
  const result = await q(
    `SELECT version, timezone, lookback_hours, anchors, sources, scheduled_company_day::text,
            last_scheduled_at, last_run,
            (SELECT count(*) FROM signals WHERE read_at IS NULL AND dismissed_at IS NULL) AS unread
       FROM radar_config WHERE id = 'default'`,
  );
  const row = result.rows[0] as RadarRow & { unread: string | number };
  const webSources = row.sources.sites.filter((source) => source.enabled).length;
  const wechatSources = row.sources.wechatAccounts.filter((source) => source.enabled).length;
  const outletSources = row.sources.outlets ?? [];
  const outletEntries = outletSources.filter((source) => source.enabled);
  const enabledOutlets = new Set(outletEntries.flatMap((source) => source.outlets));
  const outletCount = enabledOutlets.size;
  const wechatConfigured = providers.wechat && wechatSources > 0;
  const outletConfigured = providers.outlets && outletCount > 0;
  const latestSignals = await latestRadarSignals(q);
  const latestUnreadCount = await scannedUnreadCount(q);
  return {
    schemaVersion: 1,
    id: "radar:default",
    version: row.version,
    kind: "radar",
    objectRef: { type: "radar", id: "default", version: row.version },
    title: "Radar",
    payload: {
      timezone: row.timezone,
      businessDate: new Intl.DateTimeFormat("en-CA", { timeZone: row.timezone || "Asia/Shanghai" }).format(now),
      lookbackHours: row.lookback_hours,
      anchors: row.anchors,
      scheduledCompanyDay: row.scheduled_company_day,
      unreadCount: Number(row.unread),
      lastScheduledAt: row.last_scheduled_at?.toISOString() ?? null,
      lastRun: row.last_run,
      latestSignals,
      latestUnreadCount,
      sources: {
        web: {
          configured: providers.web && webSources > 0,
          sourceCount: webSources,
          message: providers.web && webSources > 0 ? "已配置" : "未配置 Web 来源",
        },
        wechat: {
          configured: wechatConfigured,
          sourceCount: wechatSources,
          message: wechatConfigured ? "已配置账号级微信公众号来源" : "未配置微信公众号账号级来源",
        },
        outlets: {
          configured: outletConfigured,
          sourceCount: outletCount,
          message: outletConfigured ? `已配置 ${outletCount} 家发布方级媒体来源` : "未配置发布方级媒体来源",
          // 已启用发布方的中文名：按目录顺序、去重，雷达卡据此列名单，不再写死
          names: RADAR_OUTLETS.filter((outlet) => enabledOutlets.has(outlet.outletId)).map((outlet) => outlet.name),
        },
      },
    },
    navigation: [{ href: "/radar", label: "Radar" }],
    actions: [],
  };
}

/** 原生 Radar 评分：relevance / impact / urgency 均为 0–5 整数（与 RadarCandidate.score 同一口径）。 */
export type SignalScore = { relevance: number; impact: number; urgency: number };
export type SignalScoreStatus = "assessed" | "unassessed";

const scoreDimension = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 5;

/** 只有三个维度都是合法原生分值时才算有分；其余（null、缺维度、越界）一律视为没有评分。 */
export function nativeSignalScore(score: unknown): SignalScore | null {
  if (!score || typeof score !== "object") return null;
  const { relevance, impact, urgency } = score as Record<string, unknown>;
  return scoreDimension(relevance) && scoreDimension(impact) && scoreDimension(urgency) ? { relevance, impact, urgency } : null;
}

/**
 * 评分是否来自真实研判：实时扫描的分值由 Radar Assess Agent 给出；预载（imported）信号只有在导入包附带
 * 有来源的研判（source_ref.scoreStatus = "assessed"）时才算已评估。旧版导入写入的 0/0/0 是占位，不是评估结果。
 */
export function signalScoreStatus(score: unknown, sourceRef: unknown): SignalScoreStatus {
  if (!nativeSignalScore(score)) return "unassessed";
  const ref = sourceRef as { imported?: unknown; scoreStatus?: unknown } | null;
  if (ref && typeof ref === "object" && ref.imported === true && ref.scoreStatus !== "assessed") return "unassessed";
  return "assessed";
}

type SignalScoreBasis = { rationale: string; assessedBy: string; assessedAt: string; sourceRef: string };

/** 导入研判的出处（谁、何时、依据什么给的分）；实时扫描信号没有这一项。 */
function signalScoreBasis(sourceRef: unknown): SignalScoreBasis | null {
  const basis = (sourceRef as { assessment?: unknown } | null)?.assessment as Partial<SignalScoreBasis> | undefined;
  if (!basis || typeof basis !== "object") return null;
  const { rationale, assessedBy, assessedAt, sourceRef: ref } = basis;
  return typeof rationale === "string" && typeof assessedBy === "string" && typeof assessedAt === "string" && typeof ref === "string"
    ? { rationale, assessedBy, assessedAt, sourceRef: ref }
    : null;
}

export type SignalImportance = "high" | "medium" | "low";

/** 原生重要度 = impact + urgency（0–10，与雷达页「按重要程度」同一口径）；未评估返回 null。 */
function importanceValue(score: unknown, sourceRef: unknown): number | null {
  const native = signalScoreStatus(score, sourceRef) === "assessed" ? nativeSignalScore(score) : null;
  return native ? native.impact + native.urgency : null;
}

/** 首页信号流的重要度三档：≥7 高、≥4 中、其余低；未评估为 null（不当作低）。 */
export function signalImportance(score: unknown, sourceRef: unknown): SignalImportance | null {
  const value = importanceValue(score, sourceRef);
  return value === null ? null : value >= 7 ? "high" : value >= 4 ? "medium" : "low";
}

/** 信号流里那一行的发布方：媒体写媒体名，公众号写账号名，检索来源写站点域名。 */
function signalPublisher(sourceType: SignalRow["source_type"], sourceRef: unknown, url: string): string {
  if (sourceType === "outlet") return outletBadge(sourceRef);
  if (sourceType === "wechat-account") {
    const name = (sourceRef as { accountName?: unknown } | null)?.accountName;
    return typeof name === "string" && name ? name : "公众号";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Web";
  } catch {
    return "Web";
  }
}

export type RadarLatestSignal = {
  id: string;
  title: string;
  source: string;
  publishedAt: string;
  importance: SignalImportance | null;
  read: boolean;
  /** 固定为 "scan"：信号流只收雷达实时扫描到的信号（首页据此判断接口已排除资料包预载的信号）。 */
  origin: "scan";
};

const LATEST_SIGNAL_LIMIT = 6;

/**
 * 资料包预载的信号（导入时 source_ref.imported = true）不进首页信号流：首页决策面只放真实信息，
 * 预载信号只在雷达页列出（10/14：雷达卡回到首页决策面，只显示实时扫描到的信号）。
 */
const SCANNED_ONLY = `coalesce(source_ref->>'imported', '') <> 'true'`;

/** 首页信号流里的未读数：实时扫描、未忽略、未读（不含资料包预载的信号）。 */
async function scannedUnreadCount(q: Query): Promise<number> {
  const result = await q(`SELECT count(*) AS unread FROM signals WHERE read_at IS NULL AND dismissed_at IS NULL AND ${SCANNED_ONLY}`);
  return Number((result.rows[0] as { unread: string | number } | undefined)?.unread ?? 0);
}

/**
 * 首页雷达卡的信号流：实时扫描到的、未忽略的信号按重要度高→低（未评估排最后）、再按发布时间新→旧，取前 6 条。
 * 标题与雷达页列表一样用原文标题；资料包预载的信号不在这里（SCANNED_ONLY）。
 */
async function latestRadarSignals(q: Query): Promise<RadarLatestSignal[]> {
  const result = await q(
    `SELECT id, source_type, source_title, source_url, published_at, source_ref, score, read_at
       FROM signals WHERE dismissed_at IS NULL AND ${SCANNED_ONLY}`,
  );
  type Row = Pick<SignalRow, "id" | "source_type" | "source_title" | "source_url" | "published_at" | "source_ref" | "score" | "read_at">;
  return (result.rows as Row[])
    .map((row) => ({ row, value: importanceValue(row.score, row.source_ref) }))
    .sort((left, right) => {
      if (left.value !== right.value) {
        if (left.value === null) return 1;
        if (right.value === null) return -1;
        return right.value - left.value;
      }
      return right.row.published_at.getTime() - left.row.published_at.getTime() || (left.row.id < right.row.id ? -1 : 1);
    })
    .slice(0, LATEST_SIGNAL_LIMIT)
    .map(({ row }) => ({
      id: row.id,
      title: row.source_title,
      source: signalPublisher(row.source_type, row.source_ref, row.source_url),
      publishedAt: row.published_at.toISOString(),
      importance: signalImportance(row.score, row.source_ref),
      read: row.read_at !== null,
      origin: "scan" as const,
    }));
}

export function projectSignalCard(row: SignalRow): TCard {
  const scoreStatus = signalScoreStatus(row.score, row.source_ref);
  return {
    schemaVersion: 1,
    id: `signal:${row.id}`,
    version: row.version,
    kind: "signal",
    objectRef: { type: "signal", id: row.id, version: row.version },
    title: shortSignalTitle(row.summary),
    badge: row.source_type === "wechat-account" ? "公众号" : row.source_type === "outlet" ? outletBadge(row.source_ref) : "Web",
    payload: {
      source: {
        type: row.source_type,
        fingerprint: row.source_fingerprint,
        title: row.source_title,
        url: row.source_url,
        publishedAt: row.published_at.toISOString(),
        excerpt: row.excerpt,
        sourceRef: row.source_ref,
        images: sourceImages(row.source_images),
        fullText: isFullTextSource(row.source_ref),
      },
      assessment: {
        anchorId: row.anchor_id,
        location: row.location,
        summary: row.summary,
        strategicImpact: row.strategic_impact,
        evidenceQuote: row.evidence_quote,
        unknowns: row.unknowns,
        // 未评估时 score 为 null：不把占位 0 分交给列表排序或对话上下文冒充研判结果。
        score: scoreStatus === "assessed" ? nativeSignalScore(row.score) : null,
        scoreStatus,
        scoreBasis: scoreStatus === "assessed" ? signalScoreBasis(row.source_ref) : null,
      },
      state: {
        read: row.read_at !== null,
        saved: row.saved_at !== null,
        dismissed: row.dismissed_at !== null,
      },
      collectedAt: row.collected_at.toISOString(),
    },
    navigation: [{ href: `/radar/signals/${row.id}`, label: "Signal" }],
    conversation: { scope: `signal:${row.id}` },
    actions: [],
  };
}

export async function listSignalCards(q: Query): Promise<TCard[]> {
  const result = await q(`SELECT ${signalColumns()} FROM signals ORDER BY collected_at DESC, id`);
  return (result.rows as SignalRow[]).map(projectSignalCard);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getSignalCard(q: Query, id: string): Promise<TCard | null> {
  // 路径/会话 scope 允许非 UUID 字符：先做形状校验，不让 PostgreSQL 报类型错误。
  if (!UUID_PATTERN.test(id)) return null;
  const result = await q(`SELECT ${signalColumns()} FROM signals WHERE id = $1`, [id]);
  return result.rowCount === 1 ? projectSignalCard(result.rows[0] as SignalRow) : null;
}

/** 图片只可来自已持久化的 Signal 原文，路由不接收 URL，避免成为开放代理。 */
export async function getSignalImageSource(q: Query, id: string, index: number): Promise<{ url: string; referer: string } | null> {
  if (!UUID_PATTERN.test(id) || !Number.isInteger(index) || index < 0 || index >= 12) return null;
  const result = await q("SELECT source_url, source_images FROM signals WHERE id = $1", [id]);
  const row = result.rows[0] as { source_url: string; source_images: unknown } | undefined;
  const image = row && sourceImages(row.source_images)[index];
  if (!image || !row) return null;
  try {
    if (!["https:", "http:"].includes(new URL(row.source_url).protocol)) return null;
  } catch {
    return null;
  }
  return { url: image.src, referer: row.source_url };
}

export async function setSignalState(q: Query, id: string, state: TSignalStateRequest): Promise<TCard | null> {
  // 只在实际状态变化时更新与递增 version，重复 PATCH 是真正的无操作
  const result = await q(
    `WITH next AS (
       SELECT s0.id, s0.read_at, s0.saved_at, s0.dismissed_at,
              CASE WHEN $2::boolean IS NULL THEN s0.read_at WHEN $2 THEN COALESCE(s0.read_at, now()) ELSE NULL END AS next_read,
              CASE WHEN $3::boolean IS NULL THEN s0.saved_at WHEN $3 THEN COALESCE(s0.saved_at, now()) ELSE NULL END AS next_saved,
              CASE WHEN $4::boolean IS NULL THEN s0.dismissed_at WHEN $4 THEN COALESCE(s0.dismissed_at, now()) ELSE NULL END AS next_dismissed
         FROM signals s0 WHERE s0.id = $1
     )
     UPDATE signals s
        SET read_at = next.next_read,
            saved_at = next.next_saved,
            dismissed_at = next.next_dismissed,
            version = s.version + 1,
            updated_at = now()
       FROM next
      WHERE s.id = next.id
        AND (s.read_at IS DISTINCT FROM next.next_read
          OR s.saved_at IS DISTINCT FROM next.next_saved
          OR s.dismissed_at IS DISTINCT FROM next.next_dismissed)
      RETURNING ${signalColumns("s.")}`,
    [id, state.read ?? null, state.saved ?? null, state.dismissed ?? null],
  );
  if (result.rowCount === 1) return projectSignalCard(result.rows[0] as SignalRow);
  return getSignalCard(q, id);
}
