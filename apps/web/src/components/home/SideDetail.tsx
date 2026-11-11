"use client";

/**
 * 右栏里的会话详情（11/11，照 Claude Code 桌面版页头按钮在右侧栏打开）：子会话、议题会话、项目对话页头的信息按钮不再换掉对话，
 * 而是在右栏打开这个会话的详情；再点一次或关掉，右栏回到这台电脑和后台任务。
 * 新首页桌面三栏给这个上下文（手机、老页面没有，照旧在原处切）。内容由会话自己画，经 SideContent 挂进右栏。
 */
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type SideDetail = {
  /** 右栏现在是不是这个会话的详情。 */
  open: boolean;
  /** 不给参数是开关来回切。 */
  toggle: (open?: boolean) => void;
  /** 右栏里放详情的那一块（详情开着时才有）。 */
  node: HTMLElement | null;
};

export const SideDetailContext = createContext<SideDetail | null>(null);
export const useSideDetail = () => useContext(SideDetailContext);

/** 详情开着时把内容挂进右栏。 */
export function SideContent({ side, children }: { side: SideDetail; children: ReactNode }) {
  return side.open && side.node ? createPortal(children, side.node) : null;
}
