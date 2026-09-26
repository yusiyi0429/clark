"use client";

import { useLayoutEffect } from "react";

/**
 * HeroUI 自己的过渡（页签指示器、开关）不读 `prefers-reduced-motion`，读的是
 * `html[data-reduce-motion]`。跟着媒体查询同步，用户改系统设置无需刷新（clark 同）。
 */
export function ReduceMotionSync() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      root.dataset.reduceMotion = String(query.matches);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return null;
}
