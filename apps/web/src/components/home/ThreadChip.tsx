"use client";

/**
 * thread 小条（设计 6.6）：交出去的活挂在项目对话里交代的那一处（开工的位置、要你出手的那一块下面），一行：
 * 状态图标 · 名字 · 和会话面板同一个短状态（等你用 --judgment）· 没看过一颗蓝点（只有 unseen，没有条数）。
 * 电脑上点了在右边开这个子会话的 thread，中间的对话不动；手机上（没有右边的面板位）全屏打开那个子会话。
 * 伙伴主线上（本人 11/18）名字前面多一段淡色「项目名 · 」；会话等着项目绑文件夹时短状态写「等你」。
 */
import { useContext } from "react";
import type { SubSession } from "@/lib/home/types";
import { showUnseen } from "@/lib/home/seen";
import { subStatus } from "./SessionsPanel";
import type { SideDetail } from "./SideDetail";
import { StateIcon } from "./StateIcon";
import { SeenContext, subHref, subIcon } from "./SubRows";
import type { View } from "./view";
import h from "@/styles/home.module.css";

/** 点小条、点会话面板里的行：有右边的面板位（电脑上的新首页）在右边开 thread，没有就去那个子会话。from：从主线开的会话所在的项目名。 */
export const threadOpener = (side: SideDetail | null, go: (href: string) => void) => (sub: Pick<SubSession, "kind" | "id">, from?: string) =>
  (side ? side.openThread({ kind: sub.kind, id: sub.id }, from) : go(subHref(sub)));

/** 伙伴主线上开会话（小条、事件行）：电脑上、首页数据里有这个会话，在右边开，回 true；手机上、首页数据里找不到的回 false，由调用方照旧跳过去。 */
export const rightOpener = (side: SideDetail | null, subs: readonly Pick<SubSession, "kind" | "id">[]) => (sub: Pick<SubSession, "kind" | "id">, from?: string) => {
  if (!side || !subs.some((entry) => entry.kind === sub.kind && entry.id === sub.id)) return false;
  side.openThread({ kind: sub.kind, id: sub.id }, from);
  return true;
};

/** 中间展示区现在就是这个子会话（同一张卡 / 同一个专题）：再点它的行或小条不在右边再开一份。 */
export const inCenter = (view: View, sub: Pick<SubSession, "kind" | "id">) =>
  (view.kind === "card" || view.kind === "topic") && view.kind === sub.kind && view.id === sub.id;

export function ThreadChip({ sub, onOpen, project, needsYou = false }: { sub: SubSession; onOpen: (sub: SubSession) => void; project?: string; needsYou?: boolean }) {
  const opened = useContext(SeenContext);
  const unseen = showUnseen(sub.unseen, opened.seen, "sub", sub.id, sub.updatedAt);
  const status = needsYou ? "等你" : subStatus(sub);
  return (
    <button type="button" className={h.thread} onClick={() => onOpen(sub)} data-testid="thread-chip">
      <StateIcon {...(needsYou ? { state: "waiting" as const } : subIcon(sub))} />
      <span className={h.threadName}>{project ? <span className={h.threadProject}>{`${project} · `}</span> : null}{sub.title}</span>
      {status ? <span className={h.threadStatus} data-wait={status === "等你" ? "" : undefined}>{status}</span> : null}
      {unseen ? <i className={h.threadDot} aria-hidden data-testid="thread-dot" /> : null}
    </button>
  );
}
