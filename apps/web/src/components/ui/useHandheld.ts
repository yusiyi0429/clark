"use client";

import { useSyncExternalStore } from "react";

/** 手持与触屏：和全站 --touch-hit 同一条线（≤959 或粗指针）。下拉、月历在这里改成底部 sheet。 */
export const HANDHELD_QUERY = "(max-width: 959px), (pointer: coarse)";

const subscribe = (notify: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(HANDHELD_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const snapshot = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(HANDHELD_QUERY).matches;

/** 服务端渲染与首帧按电脑（浮层）；挂载后按真实媒体查询。 */
export function useHandheld(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
