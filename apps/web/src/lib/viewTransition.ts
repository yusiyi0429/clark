import { useState } from "react";

/** 与 clark-main `components/ceo-warmap/view-transition.ts` 同一套约定：
 *  方向写在 `html[data-notice-transition]`，CSS 据此选打开 / 关闭时长并暂停会抢快照的布局过渡。 */

type ViewTransition = { finished: Promise<void>; ready?: Promise<void> };
type TransitionDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => ViewTransition };

export type TransitionDirection = "open" | "close";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Same-document View Transitions（Safari 18+ / Chromium 111+）；减少动效时不使用。 */
export function supportsViewTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as TransitionDocument).startViewTransition === "function" &&
    !prefersReducedMotion()
  );
}

/** 组件挂载时是否正处在一次转场中（只取一次）。被转场形变进来的元素不能再播放自己的入场动画。 */
export function useMountedDuringViewTransition(): boolean {
  const [mounted] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.noticeTransition !== undefined,
  );
  return mounted;
}

/** 路由导航需要等待服务端返回：旧快照保持到 `settle()` 被调用（新路由已提交）为止，最长 3 秒。 */
const ROUTE_SETTLE_TIMEOUT = 3000;

/**
 * 在一次 View Transition 中完成一次路由切换。`begin(settle)` 负责发起导航，
 * 新状态提交后调用 `settle()`，浏览器随即截取新快照。不支持时直接执行并立即 settle。
 */
export function runRouteTransition(direction: TransitionDirection, begin: (settle: () => void) => void): Promise<void> {
  const doc = document as TransitionDocument;
  if (!supportsViewTransition() || !doc.startViewTransition) {
    begin(() => {});
    return Promise.resolve();
  }
  const root = document.documentElement;
  root.dataset.noticeTransition = direction;
  const clear = () => {
    if (root.dataset.noticeTransition === direction) delete root.dataset.noticeTransition;
  };
  try {
    const transition = doc.startViewTransition(
      () =>
        new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, ROUTE_SETTLE_TIMEOUT);
          begin(() => {
            window.clearTimeout(timer);
            resolve();
          });
        }),
    );
    // 跳过快照时 ready 会 reject，但状态更新仍会完成；单独吞掉，快速开合不泄漏 rejection。
    void transition.ready?.catch(() => {});
    return transition.finished.then(clear, clear);
  } catch {
    clear();
    begin(() => {});
    return Promise.resolve();
  }
}
