import type { QueryResult } from "pg";
import type { TCard, TRadarSources, TSignalStateRequest } from "@warmap/contracts";
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
    return typeof src === "string" && src.startsWith("https://") && typeof after === "number" && Number.isInteger(after) && after >= 0
      ? [{ src, after }]
      : [];
  }).slice(0, 12);
}

/** 核心观点是 Signal 的卡片标题；UI 统一限制 30 个字符，避免长研判吞掉阅读首屏。 */
export function shortSignalTitle(summary: string): string {
  const chars = Array.from(summary);
  return chars.length > 30 ? `${chars.slice(0, 29).join("")}…` : summary;
}

/** 发布方来源的徽标用中文媒体名，如实标注归属，避免用站点搜索冒充发布方。 */
function outletBadge(sourceRef: unknown): string {
  const ref = sourceRef as { type?: string; outletName?: string } | null;
  return ref?.type === "outlet" && ref.outletName ? ref.outletName : "发布方";
}

export async function projectRadarCard(q: Query, providers: RadarService["providerStatus"]): Promise<TCard> {
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
  const outletCount = new Set(outletEntries.flatMap((source) => source.outlets)).size;
  const wechatConfigured = providers.wechat && wechatSources > 0;
  const outletConfigured = providers.outlets && outletCount > 0;
  return {
    schemaVersion: 1,
    id: "radar:default",
    version: row.version,
    kind: "radar",
    objectRef: { type: "radar", id: "default", version: row.version },
    title: "Radar",
    payload: {
      timezone: row.timezone,
      lookbackHours: row.lookback_hours,
      anchors: row.anchors,
      scheduledCompanyDay: row.scheduled_company_day,
      unreadCount: Number(row.unread),
      lastScheduledAt: row.last_scheduled_at?.toISOString() ?? null,
      lastRun: row.last_run,
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
        },
      },
    },
    navigation: [{ href: "/radar", label: "Radar" }],
    actions: [],
  };
}

export function projectSignalCard(row: SignalRow): TCard {
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
      },
      assessment: {
        anchorId: row.anchor_id,
        location: row.location,
        summary: row.summary,
        strategicImpact: row.strategic_impact,
        evidenceQuote: row.evidence_quote,
        unknowns: row.unknowns,
        score: row.score,
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
    if (new URL(row.source_url).protocol !== "https:") return null;
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
