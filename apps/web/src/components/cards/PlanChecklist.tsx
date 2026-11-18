"use client";

/**
 * 计划清单：子会话的计划条目（本机 plan 事件）和伙伴的计划清单（17.4，对话流的 plan 事件）共用。
 * 照 Claude Code（本人 11/16）：做完的打勾、字变淡，在做的转圈、字加粗，没开始的空圈；不划线。图标同新首页的状态图标（StateIcon）。
 * collapsed（伙伴这一轮结束，或被本人的新消息打断）收成一行「计划 n/m」，点开看全部。
 * finished（挂在已写完的回答上）：在做的不转，画成不动的空圈（本人 11/18）。
 */
import { useState } from "react";
import type { TLocalPlanEntry } from "@warmap/contracts";
import { StateIcon, type IconState } from "@/components/home/StateIcon";
import s from "@/styles/v2-session.module.css";

const ICON_OF: Record<TLocalPlanEntry["status"], { state: IconState; label: string }> = {
  completed: { state: "done", label: "已完成" },
  in_progress: { state: "running", label: "进行中" },
  pending: { state: "queued", label: "未开始" },
};
const UNFINISHED = { state: "queued", label: "未完成" } as const;

export function PlanChecklist({ entries, collapsed = false, finished = false }: { entries: readonly TLocalPlanEntry[]; collapsed?: boolean; finished?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const done = entries.filter((entry) => entry.status === "completed").length;
  if (collapsed && !open) {
    return <button type="button" className={s.planFold} aria-expanded={false} onClick={() => setOpen(true)} data-testid="plan-folded">计划 {done}/{entries.length}</button>;
  }
  return (
    <ol className={s.plan} data-testid="plan-checklist">
      {entries.map((entry, index) => <li key={index} data-status={entry.status}><StateIcon {...(finished && entry.status === "in_progress" ? UNFINISHED : ICON_OF[entry.status])} /><span>{entry.content}</span></li>)}
    </ol>
  );
}
