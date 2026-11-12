"use client";

/**
 * 右边的面板位（第 73 条）：平时没有，要看东西时出一个面板，关掉就完全没有。同一时间只放一样——
 * 会话详情（detail）、文件预览（file，含「改动」）、后台任务（tasks）；再开一样就替掉前一样。
 * 新首页桌面给这个上下文（手机、老页面没有，照旧在原处切）。详情、文件由会话自己画，经 SideContent 挂进面板。
 * 放大（wide）：面板占满中间和右边，对话收起；换一样或关掉就回到并排。
 */
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type PanelKind = "detail" | "file" | "tasks";

export type SideDetail = {
  /** 面板里现在是不是这个会话的详情。 */
  open: boolean;
  /** 详情：不给参数是开关来回切。 */
  toggle: (open?: boolean) => void;
  /** 面板里放详情、文件的那一块（放着这两样时才有）。 */
  node: HTMLElement | null;
  /** 面板里现在放的是哪一样；没有面板为 null。 */
  shown: PanelKind | null;
  show: (kind: PanelKind | null) => void;
  wide: boolean;
  setWide: (wide: boolean) => void;
};

export const SideDetailContext = createContext<SideDetail | null>(null);
export const useSideDetail = () => useContext(SideDetailContext);

/** 面板里放着这一样时把内容挂进去（不给 kind 是详情）。 */
export function SideContent({ side, kind = "detail", children }: { side: SideDetail; kind?: Exclude<PanelKind, "tasks">; children: ReactNode }) {
  return side.shown === kind && side.node ? createPortal(children, side.node) : null;
}
