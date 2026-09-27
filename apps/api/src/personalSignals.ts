import type { TMemberRadarBrief, TPersonalRadarRun, TPersonalSignal, TPersonalSignalBrief, TSessionRole, TSignalStateRequest } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { isFullTextSource } from "./signals.js";

/** 个人信号（ADR-0021）：单独存表，所有读取都带 person_id = 本人；不存在或属于别人一律当作没有。 */
type PersonalSignalRow = {
  id: string;
  source_type: "web" | "outlet" | "list";
  source_title: string;
  source_url: string;
  published_at: Date | null;
  listed_on: string | null;
  excerpt: string;
  source_ref: unknown;
  direction_id: string;
  direction_text: string;
  summary: string;
  reason: string;
  evidence_quote: string;
  relevance: number;
  read_at: Date | null;
  saved_at: Date | null;
  dismissed_at: Date | null;
  collected_at: Date;
};

const COLUMNS = [
  "id", "source_type", "source_title", "source_url", "published_at", "listed_on", "excerpt", "source_ref", "direction_id",
  "direction_text", "summary", "reason", "evidence_quote", "relevance", "read_at", "saved_at", "dismissed_at", "collected_at",
];
// 上榜日按日期原样返回，不经过时区换算
const columns = (prefix = "") => COLUMNS.map((column) => (column === "listed_on" ? `${prefix}listed_on::text AS listed_on` : `${prefix}${column}`)).join(", ");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 来源标签：发布方写中文名，其余写网址主机。 */
export function sourceLabel(sourceRef: unknown, url: string): string {
  const ref = sourceRef as { type?: string; outletName?: string } | null;
  return ref?.type === "outlet" && ref.outletName ? ref.outletName : new URL(url).hostname.replace(/^www\./, "");
}

function projectBrief(row: PersonalSignalRow): TPersonalSignalBrief {
  return {
    id: row.id,
    source: {
      type: row.source_type,
      label: sourceLabel(row.source_ref, row.source_url),
      title: row.source_title,
      url: row.source_url,
      publishedAt: row.published_at?.toISOString() ?? null,
      listedOn: row.listed_on,
    },
    direction: { id: row.direction_id, text: row.direction_text },
    summary: row.summary,
    reason: row.reason,
    relevance: row.relevance,
    state: { read: row.read_at !== null, saved: row.saved_at !== null, dismissed: row.dismissed_at !== null },
    collectedAt: row.collected_at.toISOString(),
  };
}

function projectSignal(row: PersonalSignalRow): TPersonalSignal {
  return { ...projectBrief(row), excerpt: row.excerpt, fullText: isFullTextSource(row.source_ref), evidenceQuote: row.evidence_quote };
}

/** 本人没隐藏的信号，按收集时间倒序。 */
export async function listPersonalSignals(q: Query, personId: string, limit: number): Promise<TPersonalSignalBrief[]> {
  const result = await q(
    `SELECT ${columns()} FROM person_radar_signals WHERE person_id = $1 AND dismissed_at IS NULL ORDER BY collected_at DESC, id LIMIT $2`,
    [personId, limit],
  );
  return (result.rows as PersonalSignalRow[]).map(projectBrief);
}

export async function getPersonalSignal(q: Query, personId: string, id: string): Promise<TPersonalSignal | null> {
  // 路径参数允许任意字符：先做形状校验，不让 PostgreSQL 报类型错误
  if (!UUID_PATTERN.test(id)) return null;
  const result = await q(`SELECT ${columns()} FROM person_radar_signals WHERE id = $1 AND person_id = $2`, [id, personId]);
  return result.rows[0] ? projectSignal(result.rows[0] as PersonalSignalRow) : null;
}

/** 已读、收藏、隐藏各自独立；只在状态真的变化时写。 */
export async function setPersonalSignalState(q: Query, personId: string, id: string, state: TSignalStateRequest): Promise<TPersonalSignal | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const result = await q(
    `WITH next AS (
       SELECT s0.id,
              CASE WHEN $3::boolean IS NULL THEN s0.read_at WHEN $3 THEN COALESCE(s0.read_at, now()) ELSE NULL END AS next_read,
              CASE WHEN $4::boolean IS NULL THEN s0.saved_at WHEN $4 THEN COALESCE(s0.saved_at, now()) ELSE NULL END AS next_saved,
              CASE WHEN $5::boolean IS NULL THEN s0.dismissed_at WHEN $5 THEN COALESCE(s0.dismissed_at, now()) ELSE NULL END AS next_dismissed
         FROM person_radar_signals s0 WHERE s0.id = $1 AND s0.person_id = $2
     )
     UPDATE person_radar_signals s
        SET read_at = next.next_read, saved_at = next.next_saved, dismissed_at = next.next_dismissed, updated_at = now()
       FROM next
      WHERE s.id = next.id
        AND (s.read_at IS DISTINCT FROM next.next_read
          OR s.saved_at IS DISTINCT FROM next.next_saved
          OR s.dismissed_at IS DISTINCT FROM next.next_dismissed)
      RETURNING ${columns("s.")}`,
    [id, personId, state.read ?? null, state.saved ?? null, state.dismissed ?? null],
  );
  if (result.rowCount === 1) return projectSignal(result.rows[0] as PersonalSignalRow);
  return getPersonalSignal(q, personId, id);
}

/** 本人未读且未隐藏的条数。 */
export async function countUnreadPersonalSignals(q: Query, personId: string): Promise<number> {
  const result = await q(
    "SELECT count(*)::int AS count FROM person_radar_signals WHERE person_id = $1 AND read_at IS NULL AND dismissed_at IS NULL",
    [personId],
  );
  return result.rows[0].count as number;
}

/** 首页雷达小组件：看的人是 CEO，或本人雷达没开（包括从没保存过）时为 null。 */
export async function readMemberRadarBrief(q: Query, person: { personId: string; role: TSessionRole }, now: Date): Promise<TMemberRadarBrief | null> {
  if (person.role === "ceo") return null;
  const radar = (await q("SELECT enabled, last_run FROM person_radar WHERE person_id = $1", [person.personId])).rows[0] as
    { enabled: boolean; last_run: TPersonalRadarRun | null } | undefined;
  if (!radar?.enabled) return null;
  const [unreadCount, highlights] = await Promise.all([
    countUnreadPersonalSignals(q, person.personId),
    // 最近 7 天未隐藏的，相关度优先、再按时间，最多 3 条
    q(
      `SELECT ${columns()} FROM person_radar_signals
        WHERE person_id = $1 AND dismissed_at IS NULL AND collected_at >= $2::timestamptz - interval '7 days'
        ORDER BY relevance DESC, collected_at DESC, id LIMIT 3`,
      [person.personId, now],
    ),
  ]);
  return { lastRun: radar.last_run, unreadCount, highlights: (highlights.rows as PersonalSignalRow[]).map(projectBrief) };
}
