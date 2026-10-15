"use client";

import { useSyncExternalStore } from "react";
import { deskColumnWidth } from "./deskLayout";

function subscribe(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

/** 视口宽度。服务端那一帧按 0 算（不提供深度讨论），水合后再对。 */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, () => window.innerWidth, () => 0);
}

/** 此刻深度讨论的对话列宽度；<1280 为 null（不出 ⤢）。 */
export function useDeskColumnWidth(): number | null {
  return deskColumnWidth(useViewportWidth());
}
