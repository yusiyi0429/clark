"use client";

import { useSyncExternalStore } from "react";

/**
 * 新首页的手机排布只看宽度（5.4.1、5.7）：≤959 单栏；960 以上三栏，平板横放、触屏电脑也是三栏。
 * 粗指针只管热区放大（--touch-hit），不换排布，也不当成「这台不能开本机程序」。
 */
export const PHONE_QUERY = "(max-width: 959px)";

const subscribe = (notify: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const snapshot = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;

/** 服务端渲染与首帧按电脑；挂载后按真实宽度。 */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
