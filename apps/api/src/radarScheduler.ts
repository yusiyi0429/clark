import type { RadarService } from "./radar.js";

export function createRadarScheduler(radar: RadarService, intervalMs = 60_000) {
  let timer: NodeJS.Timeout | undefined;
  /** tick 失败只记录，不抛出：定时器里的未处理拒绝会终止 API 进程。 */
  const tick = () => radar.runScheduled().then(
    (result) => (result.status === "failed" ? void console.warn(`radar scheduled scan failed: ${result.warnings.join("; ")}`) : undefined),
    (cause: unknown) => void console.warn(`radar scheduled scan threw: ${(cause as Error).message || String(cause)}`),
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
