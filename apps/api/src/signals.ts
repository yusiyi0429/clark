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
  source_type: "web" | "wechat-account";
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
};

const SIGNAL_COLUMNS = [
  "id", "version", "source_type", "source_fingerprint", "source_title", "source_url", "published_at",
  "excerpt", "source_ref", "anchor_id", "location", "summary", "strategic_impact", "evidence_quote", "unknowns", "score",
  "read_at", "saved_at", "dismissed_at", "collected_at",
];
const signalColumns = (prefix = "") => SIGNAL_COLUMNS.map((column) => `${prefix}${column}`).join(", ");

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
  const wechatConfigured = providers.wechat && wechatSources > 0;
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
    title: row.summary,
    badge: row.source_type === "wechat-account" ? "公众号" : "Web",
    payload: {
      source: {
        type: row.source_type,
        fingerprint: row.source_fingerprint,
        title: row.source_title,
        url: row.source_url,
        publishedAt: row.published_at.toISOString(),
        excerpt: row.excerpt,
        sourceRef: row.source_ref,
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

export async function getSignalCard(q: Query, id: string): Promise<TCard | null> {
  const result = await q(`SELECT ${signalColumns()} FROM signals WHERE id = $1`, [id]);
  return result.rowCount === 1 ? projectSignalCard(result.rows[0] as SignalRow) : null;
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
