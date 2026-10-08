import type { TWeeklySyncReminder } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

const OFFSET = 8 * 3_600_000; // Asia/Shanghai，无夏令时

/** 读取时现算，不存通知：周五 18:00 到周日结束，本周（周一 00:00 起）没有外部 Agent 写入的进展就提醒。 */
export async function readWeeklySyncReminder(q: Query, personId: string, now: Date): Promise<TWeeklySyncReminder | null> {
  const local = new Date(now.getTime() + OFFSET);
  const day = local.getUTCDay();
  if (!(day === 6 || day === 0 || day === 5 && local.getUTCHours() >= 18)) return null;
  const weekStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (day + 6) % 7) - OFFSET);
  const synced = (await q("SELECT 1 FROM task_progress WHERE author_id=$1 AND source IN ('codex','claude','other') AND created_at>=$2 LIMIT 1", [personId, weekStart])).rows.length > 0;
  if (synced) return null;
  const connected = (await q("SELECT 1 FROM personal_tokens WHERE person_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2) LIMIT 1", [personId, now])).rows.length > 0;
  return { reason: connected ? "not_synced" : "no_connection" };
}
