import type { Pool } from "pg";
import type { JobHandler, RecurringJob } from "./jobs.js";
import { companyPeriod } from "./monthlyPlans.js";
import { logEvent } from "./observability.js";
import { loadWorldMissions, type WorldMissionReader } from "./worldMissionLoad.js";

/**
 * 每天从本体载入本月和下月的 Mission（设计 10.5，代替手动跑 missions:load-world）：和 scripts/load-world-missions.ts 同一个载入，
 * 只读本体，一个月一个事务；某个月失败整次作废，按公共后台任务的规矩稍后重试。
 * 只有 TIANSHU_AUTO_LOAD_MISSIONS=1 且本体配了才开（server.ts），缺省关。
 */
export const MISSION_AUTO_LOAD_KIND = "missions.load_world";
const DAY_MS = 86_400_000;

/** YYYY-MM 的下一个月。 */
const nextPeriod = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
};

/** 载入公司时区的本月和下月；返回两个月的载入报告。 */
export async function loadCurrentAndNextMissions(pool: Pool, world: WorldMissionReader, now: () => Date) {
  const current = companyPeriod(now());
  const reports = [];
  for (const period of [current, nextPeriod(current)]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const report = await loadWorldMissions(client.query.bind(client), world, { period, now });
      await client.query("COMMIT");
      logEvent({ event: "missions.load_world", status: "done", scope: report.scopeId, period, loaded: report.loaded.length,
        skipped: report.skipped.length, missing: report.missing.length });
      reports.push(report);
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    } finally { client.release(); }
  }
  return reports;
}

/** 给公共后台任务（jobs.ts）的：开了才有，每天一次。 */
export function missionAutoLoadJobs(options: { enabled: boolean; pool: Pool; world: WorldMissionReader | null; now: () => Date }):
  { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  const { enabled, pool, world, now } = options;
  if (!enabled || !world) return { handlers: {}, recurring: [] };
  return {
    handlers: { [MISSION_AUTO_LOAD_KIND]: async () => { await loadCurrentAndNextMissions(pool, world, now); } },
    recurring: [{ kind: MISSION_AUTO_LOAD_KIND, everyMs: DAY_MS }],
  };
}
