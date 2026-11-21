import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";

/**
 * 采集器原文的收尾。本机采集器已整体下线（新阶段 spec §5.1），服务端不再整理原文；已经整理出来的结果（collector_progress）留着只读。
 * 已收到的原文（collector_items.summary）照收到 14 天清空的规则走完，连同当初整理那次 Agent 运行留在 agent_runs 里的输入。
 */

export const RAW_RETENTION_DAYS = 14;

export async function collectorConsentGranted(q: Query, personId: string): Promise<boolean> {
  return (await q("SELECT 1 FROM collector_consents WHERE person_id=$1 AND granted", [personId])).rowCount === 1;
}

/** 收到满 14 天的原文清空；整理那次 Agent 运行存下的输入（里面有原文）一并清空。 */
export async function purgeExpiredRaw(q: Query, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 86_400_000);
  const purged = await q("UPDATE collector_items SET summary=NULL, raw_purged_at=$2 WHERE summary IS NOT NULL AND received_at < $1", [cutoff, now]);
  await q(`UPDATE agent_runs SET input_snapshot=jsonb_build_object('purged', true, 'reason', 'collector raw retention')
    WHERE kind='collector-distill' AND started_at < $1 AND NOT (input_snapshot ? 'purged')`, [cutoff]);
  return purged.rowCount ?? 0;
}

/** 与其他后台任务一样是进程内 setInterval，每 5 分钟清理一次到期原文。 */
export function createCollectorRawPurgeScheduler(pool: Pool, now = () => new Date(), intervalMs = 5 * 60_000) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const tick = async () => {
    if (running) return running;
    running = (async () => {
      try { await purgeExpiredRaw(pool.query.bind(pool), now()); }
      catch (cause) { console.warn(`collector raw purge failed: ${(cause as Error).message || String(cause)}`); }
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    tick,
    start() { if (timer) return; void tick(); timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); },
    async close() { if (timer) clearInterval(timer); timer = undefined; await running; },
  };
}
