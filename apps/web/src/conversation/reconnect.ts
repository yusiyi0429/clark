/**
 * 连接类失败（没连上、服务在重启、网络掉线）先自己恢复，不打扰一号位：按退避等一会儿再试，
 * 网络恢复或页面回到前台时立刻再试；超过时限仍不行才交给界面上的手动入口。
 */
const DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** 读对话记录：自己再试的时限。 */
export const HISTORY_RETRY_MS = 30_000;
/** 发消息、回答断线后接上：自己再试的时限。 */
export const RECONNECT_MS = 60_000;
/** 等这么久还没好才显示「正在连接 · N 秒」，短暂的抖动不闪字。 */
export const WAITING_VISIBLE_MS = 3_000;

/** 第 attempt 次（从 0 起）重试之前等多久。 */
export const backoff = (attempt: number) => DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)];

export const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** 等 ms 毫秒；网络恢复、页面回到前台或 signal 作废时提前结束。 */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const listens = typeof window !== "undefined" && typeof window.addEventListener === "function";
    const watchesPage = typeof document !== "undefined" && typeof document.addEventListener === "function";
    const onVisible = () => { if (document.visibilityState === "visible") done(); };
    const timer = setTimeout(done, ms);
    if (listens) window.addEventListener("online", done);
    if (watchesPage) document.addEventListener("visibilitychange", onVisible);
    signal?.addEventListener("abort", done);
    function done() {
      clearTimeout(timer);
      if (listens) window.removeEventListener("online", done);
      if (watchesPage) document.removeEventListener("visibilitychange", onVisible);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
