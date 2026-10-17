import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TCollectorDevice, TCollectorHeartbeatRequest, TCollectorInventory, TCollectorReportRequest, TCollectorSourceState } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

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

export async function recordHeartbeat(q: Query, who: CollectorIdentity, body: TCollectorHeartbeatRequest, now: Date) {
  await upsertSources(q, who, body.device, body.version, body.sources, now);
  return { receivedAt: now.toISOString() };
}

const upsertInventory = async (q: Query, who: CollectorIdentity, deviceId: string, inventory: TCollectorInventory, now: Date) => {
  const sql = `INSERT INTO local_inventory(person_id,device_id,kind,item_key,detail,read_at,first_seen_at,last_seen_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (person_id,device_id,kind,item_key) DO UPDATE SET detail=EXCLUDED.detail,
      read_at=GREATEST(local_inventory.read_at, EXCLUDED.read_at), last_seen_at=EXCLUDED.last_seen_at`;
  for (const task of inventory.scheduledTasks)
    await q(sql, [who.personId, deviceId, "scheduled_task", task.name, JSON.stringify({ schedule: task.schedule, command: task.command }), null, now]);
  for (const doc of inventory.feishuDocs)
    await q(sql, [who.personId, deviceId, "feishu_doc", doc.url, JSON.stringify({ title: doc.title }), doc.readAt, now]);
};

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
    if (body.inventory) await upsertInventory(q, who, body.device.id, body.inventory, now);
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
