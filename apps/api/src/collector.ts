import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { TCollectorDevice, TCollectorHeartbeatRequest, TCollectorInventory, TCollectorReportRequest, TCollectorSourceState, TCollectorStatusResponse } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { collectorConsentGranted } from "./collectorDistill.js";

/** 本机采集器的身份：人和令牌都取自 collector 个人令牌，请求体里不带人。 */
export type CollectorIdentity = { personId: string; tokenId: string };

const upsertSources = async (q: Query, who: CollectorIdentity, device: TCollectorDevice, version: string, sources: TCollectorSourceState[], now: Date) => {
  for (const s of sources) {
    await q(`INSERT INTO collector_health(person_id,device_id,source,device_name,platform,collector_version,first_seen_at,last_attempt_at,
        last_success_at,coverage_until,last_new_evidence_at,source_status,error_code,health)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,CASE WHEN $10='ok' THEN $7::timestamptz END,$8,$9,$10,$11,'green')
      ON CONFLICT (person_id,device_id,source) DO UPDATE SET device_name=EXCLUDED.device_name, platform=EXCLUDED.platform,
        collector_version=EXCLUDED.collector_version, last_attempt_at=EXCLUDED.last_attempt_at,
        last_success_at=COALESCE(EXCLUDED.last_success_at, collector_health.last_success_at),
        coverage_until=GREATEST(collector_health.coverage_until, EXCLUDED.coverage_until),
        last_new_evidence_at=GREATEST(collector_health.last_new_evidence_at, EXCLUDED.last_new_evidence_at),
        source_status=EXCLUDED.source_status, error_code=EXCLUDED.error_code,
        health=CASE WHEN EXCLUDED.source_status='ok' THEN 'green' ELSE collector_health.health END`,
    [who.personId, device.id, s.source, device.name, device.platform, version, now, s.coverageUntil, s.lastNewEvidenceAt, s.status, s.errorCode]);
  }
};

/**
 * 心跳可以带上当天的完整盘点（本机清单）；工作段只走上报。
 * 本人同意采集之前（D-18）本机清单一律不收，回给采集器 consent=false，采集器据此不做盘点；同意之后下一次检查才盘点。
 */
export async function recordHeartbeat(pool: Pool, who: CollectorIdentity, body: TCollectorHeartbeatRequest, now: Date) {
  const consent = await collectorConsentGranted(pool.query.bind(pool), who.personId);
  const inventory = consent ? body.inventory : undefined;
  if (!inventory) {
    await upsertSources(pool.query.bind(pool), who, body.device, body.version, body.sources, now);
    return { receivedAt: now.toISOString(), consent };
  }
  await inTransaction(pool, async (q) => {
    await upsertSources(q, who, body.device, body.version, body.sources, now);
    await upsertInventory(q, who, body.device.id, inventory, now);
  });
  return { receivedAt: now.toISOString(), consent };
}

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

const upsertInventory = async (q: Query, who: CollectorIdentity, deviceId: string, inventory: TCollectorInventory, now: Date) => {
  const sql = `INSERT INTO local_inventory(person_id,device_id,kind,item_key,detail,read_at,first_seen_at,last_seen_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (person_id,device_id,kind,item_key) DO UPDATE SET detail=EXCLUDED.detail,
      read_at=GREATEST(local_inventory.read_at, EXCLUDED.read_at), last_seen_at=EXCLUDED.last_seen_at`;
  for (const task of inventory.scheduledTasks)
    await q(sql, [who.personId, deviceId, "scheduled_task", task.name, JSON.stringify({ schedule: task.schedule, command: task.command }), null, now]);
  for (const doc of inventory.feishuDocs)
    await q(sql, [who.personId, deviceId, "feishu_doc", doc.url, JSON.stringify({ title: doc.title }), doc.readAt, now]);
  for (const file of inventory.memoryFiles ?? [])
    await q(sql, [who.personId, deviceId, "memory_file", file.path, JSON.stringify({ source: file.source, bytes: file.bytes, modifiedAt: file.modifiedAt }), null, now]);
  // 每份清单都是这台设备当时的完整盘点：定时任务、记忆文件以最近一次为准（last_seen_at 早于 scanned_at 的已经不在本机）。
  await q(`INSERT INTO collector_scans(person_id,device_id,scanned_at) VALUES($1,$2,$3)
    ON CONFLICT (person_id,device_id) DO UPDATE SET scanned_at=EXCLUDED.scanned_at`, [who.personId, deviceId, now]);
};

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

export type ReportResult = { ok: true; accepted: number; duplicates: number; receivedAt: string } | { ok: false; message: string };

/** 一次上报在一个事务里落库：工作段按 (人, client_event_id) 幂等，重放只计入 duplicates。 */
export async function recordReport(pool: Pool, who: CollectorIdentity, body: TCollectorReportRequest, now: Date): Promise<ReportResult> {
  if (Date.parse(body.windowEnd) < Date.parse(body.windowStart)) return { ok: false, message: "windowEnd 早于 windowStart" };
  if (body.items.some((item) => Date.parse(item.endedAt) < Date.parse(item.startedAt))) return { ok: false, message: "工作段的 endedAt 早于 startedAt" };
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    let accepted = 0;
    for (const item of body.items) {
      const inserted = await q(`INSERT INTO collector_items(id,person_id,device_id,token_id,report_kind,client_event_id,source,started_at,ended_at,summary,links,task_hint,received_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (person_id,client_event_id) DO NOTHING RETURNING id`,
      [randomUUID(), who.personId, body.device.id, who.tokenId, body.kind, item.clientEventId, item.source, item.startedAt, item.endedAt,
        item.summary, JSON.stringify(item.links), item.taskHint, now]);
      accepted += inserted.rows.length;
    }
    await upsertSources(q, who, body.device, body.version, body.sources, now);
    // 旧版采集器把本机清单夹在上报里：同样要本人同意过才收（工作段为空的上报不经过路由里的同意检查）。
    if (body.inventory && await collectorConsentGranted(q, who.personId)) await upsertInventory(q, who, body.device.id, body.inventory, now);
    await client.query("COMMIT");
    return { ok: true, accepted, duplicates: body.items.length - accepted, receivedAt: now.toISOString() };
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { client.release(); }
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

/** 服务端探测：按最近一次成功同步（没有就按首次出现）算工作日小时数，只写状态，不发提醒。本机没装的来源不探测。 */
export async function probeCollectorHealth(q: Query, now: Date) {
  const rows = (await q(`SELECT person_id,device_id,source,health,COALESCE(last_success_at,first_seen_at) AS since
    FROM collector_health WHERE source_status<>'not_found'`)).rows as { person_id: string; device_id: string; source: string; health: string; since: Date }[];
  for (const row of rows) {
    const health = collectorHealthOf(workdayHours(row.since, now));
    await q("UPDATE collector_health SET health=$4,health_checked_at=$5 WHERE person_id=$1 AND device_id=$2 AND source=$3",
      [row.person_id, row.device_id, row.source, health, now]);
  }
}

/** 与其他后台任务一样是进程内 setInterval，每 15 分钟探测一次。 */
export function createCollectorHealthScheduler(pool: Pool, now = () => new Date(), intervalMs = 15 * 60_000) {
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try { await probeCollectorHealth(pool.query.bind(pool), now()); }
    catch (cause) { console.warn(`collector health probe failed: ${(cause as Error).message || String(cause)}`); }
  };
  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref();
    },
    close() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** 一行安装命令拉取的文件：两个安装脚本和安装脚本再下载的三个 Python 文件，都在仓库的 tools/collector 下，不含任何令牌。 */
const COLLECTOR_DIR = join(import.meta.dirname, "..", "..", "..", "tools", "collector");
export const COLLECTOR_FILES = ["install-windows.ps1", "install-macos.sh", "tkos_collector.py", "collect_sessions.py", "sanitize.py"] as const;
export type CollectorFileName = typeof COLLECTOR_FILES[number];

export async function readCollectorFile(name: CollectorFileName, dir = COLLECTOR_DIR): Promise<string> {
  // PowerShell 从字符串建脚本块时不认 BOM；统一去掉，也统一成 LF。
  return (await readFile(join(dir, name), "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}
