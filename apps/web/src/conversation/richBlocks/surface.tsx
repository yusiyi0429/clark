"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * 富内容块所在的那一面（右列对话 / 首页对话层）：
 * - expanded：此刻是放大的（右列深度讨论、对话层放大），大块完整铺开；
 * - expand：能放大就给（≥1280 的右列、对话层）——缩略卡点了走它；不给（手机、窄屏）就从底部升起全屏 sheet。
 */
export type RichSurfaceValue = { expanded: boolean; expand?: () => void };

const RichSurfaceContext = createContext<RichSurfaceValue>({ expanded: false });

/** 值按 expanded / expand 记住：宿主流式中每帧重画，没变就不让每个富内容块跟着重画。 */
export function RichSurfaceProvider({ expanded, expand, children }: RichSurfaceValue & { children: ReactNode }) {
  const value = useMemo(() => ({ expanded, expand }), [expanded, expand]);
  return <RichSurfaceContext.Provider value={value}>{children}</RichSurfaceContext.Provider>;
}

export const useRichSurface = () => useContext(RichSurfaceContext);

/** 缩略卡点开去哪：能放大走放大（desk），否则底部 sheet。 */
export function expandRoute(surface: RichSurfaceValue): "desk" | "sheet" {
  return surface.expand ? "desk" : "sheet";
}

/** 这一块正文是不是流式中还在长的最后一块（Transcript 的 ArrivalBlock 给）：没收全的块画骨架，不退回原文。 */
const RichStreamContext = createContext(false);

export function RichStreamProvider({ open, children }: { open: boolean; children: ReactNode }) {
  return <RichStreamContext.Provider value={open}>{children}</RichStreamContext.Provider>;
}

export const useRichStreamOpen = () => useContext(RichStreamContext);
