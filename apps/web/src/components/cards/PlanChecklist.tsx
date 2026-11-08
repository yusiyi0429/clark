"use client";

/**
 * 计划清单：子会话的计划条目（本机 plan 事件）和伙伴的计划清单（17.4，对话流的 plan 事件）共用。
 * 做完的划掉、在做的加粗；collapsed（伙伴这一轮被本人的新消息打断）收成一行「计划 n/m」，点开看全部。
 */
import { useState } from "react";
import type { TLocalPlanEntry } from "@warmap/contracts";
import s from "@/styles/v2-session.module.css";

export function PlanChecklist({ entries, collapsed = false }: { entries: readonly TLocalPlanEntry[]; collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const done = entries.filter((entry) => entry.status === "completed").length;
  if (collapsed && !open) {
    return <button type="button" className={s.planFold} aria-expanded={false} onClick={() => setOpen(true)} data-testid="plan-folded">计划 {done}/{entries.length}</button>;
  }
  return <ol className={s.plan} data-testid="plan-checklist">{entries.map((entry, index) => <li key={index} data-status={entry.status}>{entry.content}</li>)}</ol>;
}
