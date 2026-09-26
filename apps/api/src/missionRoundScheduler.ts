import type { Pool } from "pg";
import { closeDueRounds } from "./missionRounds.js";

/** 截止快照不依赖有人打开页面；同一应用时钟在仓储拿到锁后取值。 */
export function createMissionRoundScheduler(pool: Pool, now = () => new Date(), intervalMs = 60_000) {
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try { await closeDueRounds(pool, now); }
    catch (cause) { console.warn(`mission round scheduled close failed: ${(cause as Error).message || String(cause)}`); }
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
