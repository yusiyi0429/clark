import type { Pool } from "pg";
import type { TCollectorStatusResponse } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { collectorConsentGranted } from "./collectorDistill.js";

export async function inTransaction(pool: Pool, work: (q: Query) => Promise<void>) {
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    await work(q);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { client.release(); }
}

/**
 * 本人的采集器状态：设备取自心跳与上报（collector_health），盘点数只算每台设备最近一次盘点里还在的定时任务、记忆文件；
 * 飞书文档是累计读过的。
 */
export async function readCollectorStatus(q: Query, personId: string): Promise<TCollectorStatusResponse> {
  const [consent, devices, scans, counts] = await Promise.all([
    collectorConsentGranted(q, personId),
    q(`SELECT device_id, max(device_name) AS name, max(platform) AS platform, max(last_attempt_at) AS last_seen_at
      FROM collector_health WHERE person_id=$1 GROUP BY device_id ORDER BY max(last_attempt_at) DESC`, [personId]),
    q("SELECT max(scanned_at) AS scanned_at FROM collector_scans WHERE person_id=$1", [personId]),
    q(`SELECT i.kind, count(DISTINCT i.item_key)::int AS n FROM local_inventory i
      LEFT JOIN collector_scans s ON s.person_id=i.person_id AND s.device_id=i.device_id
      WHERE i.person_id=$1 AND (i.kind='feishu_doc' OR i.last_seen_at >= s.scanned_at) GROUP BY i.kind`, [personId]),
  ]);
  const count = (kind: string) => (counts.rows as { kind: string; n: number }[]).find((row) => row.kind === kind)?.n ?? 0;
  const scannedAt = scans.rows[0]?.scanned_at as Date | null | undefined;
  return {
    consent,
    devices: (devices.rows as { device_id: string; name: string; platform: string; last_seen_at: Date }[])
      .map((row) => ({ id: row.device_id, name: row.name, platform: row.platform, lastSeenAt: row.last_seen_at.toISOString() })),
    scannedAt: scannedAt ? scannedAt.toISOString() : null,
    inventory: { scheduledTasks: count("scheduled_task"), feishuDocs: count("feishu_doc"), memoryFiles: count("memory_file") },
  };
}

const DAY = 86_400_000, BEIJING = 8 * 3_600_000;
/** from 到 to 之间落在工作日（北京时间周一到周五）的小时数；节假日不计入。 */
export function workdayHours(from: Date, to: Date): number {
  let ms = 0;
  for (let t = from.getTime(); t < to.getTime();) {
    const dayStart = Math.floor((t + BEIJING) / DAY) * DAY;
    const next = Math.min(to.getTime(), dayStart + DAY - BEIJING);
    const weekday = new Date(dayStart).getUTCDay();
    if (weekday !== 0 && weekday !== 6) ms += next - t;
    t = next;
  }
  return ms / 3_600_000;
}

export const collectorHealthOf = (hours: number) => hours > 50 ? "red" : hours > 26 ? "yellow" : "green";
