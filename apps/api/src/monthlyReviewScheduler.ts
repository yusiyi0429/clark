import type { MonthlyReviewService } from "./monthlyReviewService.js";

/** 月末复盘 scheduler：tick 失败只记录，不抛出（定时器里的未处理拒绝会终止 API 进程）。 */
export function createMonthlyReviewScheduler(service: MonthlyReviewService, intervalMs = 60_000) {
  let timer: NodeJS.Timeout | undefined;
  const tick = () =>
    Promise.resolve(service.runScheduled()).then(
      () => undefined,
      (cause: unknown) => void console.warn(`monthly review scheduled run failed: ${(cause as Error).message || String(cause)}`),
    );
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
