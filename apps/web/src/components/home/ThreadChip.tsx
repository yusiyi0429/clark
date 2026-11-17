"use client";

/**
 * thread 小条（设计 6.6）：交出去的活挂在项目对话里交代的那一处（开工的位置、要你出手的那一块下面），一行：
 * 状态图标 · 名字 · 和会话面板同一个短状态（等你用 --judgment）· 没看过一颗蓝点（只有 unseen，没有条数）。
 * 电脑上点了在右边开这个子会话的 thread，中间的对话不动；手机上（没有右边的面板位）全屏打开那个子会话。
 */
import { useContext } from "react";
import type { SubSession } from "@/lib/home/types";
import { showUnseen } from "@/lib/home/seen";
import { subStatus } from "./SessionsPanel";
import type { SideDetail } from "./SideDetail";
import { StateIcon } from "./StateIcon";
import { SeenContext, subHref, subIcon } from "./SubRows";
import h from "@/styles/home.module.css";

/** 点小条、点会话面板里的行：有右边的面板位（电脑上的新首页）在右边开 thread，没有就去那个子会话。 */
export const threadOpener = (side: SideDetail | null, go: (href: string) => void) => (sub: Pick<SubSession, "kind" | "id">) =>
  (side ? side.openThread({ kind: sub.kind, id: sub.id }) : go(subHref(sub)));

export function ThreadChip({ sub, onOpen }: { sub: SubSession; onOpen: (sub: SubSession) => void }) {
  const opened = useContext(SeenContext);
  const unseen = showUnseen(sub.unseen, opened.seen, "sub", sub.id, sub.updatedAt);
  const status = subStatus(sub);
  return (
    <button type="button" className={h.thread} onClick={() => onOpen(sub)} data-testid="thread-chip">
      <StateIcon {...subIcon(sub)} />
      <span className={h.threadName}>{sub.title}</span>
      {status ? <span className={h.threadStatus} data-wait={status === "等你" ? "" : undefined}>{status}</span> : null}
      {unseen ? <i className={h.threadDot} aria-hidden data-testid="thread-dot" /> : null}
    </button>
  );
}
