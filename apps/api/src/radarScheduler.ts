import type { RadarService } from "./radar.js";

/**
 * @param after 公司定时扫描结束（busy 除外，完成、跳过、失败都算）之后再做的事：排个人雷达（ADR-0021）。
 * 公司扫描只在每个 Company Day 的第一个 tick 真正跑，之后每分钟只是一条小查询，API 白天重启也能补扫。
 */
export function createRadarScheduler(radar: RadarService, intervalMs = 60_000, after?: () => Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  /** tick 失败只记录，不抛出：定时器里的未处理拒绝会终止 API 进程。两段各自捕获，互不影响。 */
  const tick = async (): Promise<void> => {
    let busy = false;
    try {
      const result = await radar.runScheduled();
      busy = result.status === "busy";
      if (result.status === "failed") console.warn(`radar scheduled scan failed: ${result.warnings.join("; ")}`);
    } catch (cause) {
      console.warn(`radar scheduled scan threw: ${(cause as Error).message || String(cause)}`);
    }
    if (busy || !after) return;
    try {
      await after();
    } catch (cause) {
      console.warn(`personal radar scheduling threw: ${(cause as Error).message || String(cause)}`);
    }
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
