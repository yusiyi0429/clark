"use client";

import { useEffect, useState } from "react";

/** 系统要求减少动态效果（读不到媒体查询时当作不要求）。 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type Presence = { open: boolean; leaving: boolean };

/**
 * 退场：开着 → 关上的那一刻进入「正在离开」（还挂着、播退场动画），时间到再卸载；
 * 离开途中又打开，直接回到开着。减少动态效果时不留退场，立刻卸载。
 */
export function nextPresence(previous: Presence, open: boolean, reduced: boolean): Presence {
  if (open === previous.open) return previous;
  return { open, leaving: !open && !reduced };
}

/** 关上后多挂 `ms` 毫秒播退场动画：`mounted` 决定渲不渲，`leaving` 给退场样式（data-leaving）。 */
export function useExitPresence(open: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [presence, setPresence] = useState<Presence>({ open, leaving: false });
  // 在渲染里同步派生（React 认可的「随 props 调整 state」）：关上的这一帧就已是 leaving，不会先空一帧。
  const next = nextPresence(presence, open, prefersReducedMotion());
  if (next !== presence) setPresence(next);
  const leaving = next.leaving;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setPresence((current) => (current.open ? current : { open: false, leaving: false })), ms);
    return () => clearTimeout(timer);
  }, [leaving, ms]);
  return { mounted: open || leaving, leaving: !open && leaving };
}
