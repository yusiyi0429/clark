"use client";

/**
 * 「在做什么」那一行（照 Claude Code，本人 11/16；调查见 .scratch/plan-activity-20261116/claude-activity-indicator.md）：
 * 一个字符动画（· ✢ ✶ ✻ ✽ 来回，1.2 秒一圈，强调色，减少动态效果时停在第一帧）、在做什么、这一轮的用时（每秒走）、有细节时行尾 › 点开看。
 * 子会话（SessionTranscript）和新首页的伙伴、项目对话（WorkTimeline）共用这几块。
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { TLocalPlanEntry } from "@warmap/contracts";
import { duration } from "@/lib/home/derive";
import { ICON } from "@/components/home/StateIcon";
import h from "@/styles/home.module.css";
import s from "@/styles/v2-session.module.css";

/** 同 Claude Code 桌面版的字符转圈（ion 包里 code-spinner：五个字竖排，CSS 一格一格往上推再推回来）。 */
export const MARK_FRAMES = ["·", "✢", "✶", "✻", "✽"] as const;

export function WorkingMark({ label }: { label: string }) {
  return (
    <span className={s.mark} role="img" aria-label={label}>
      <span aria-hidden>{MARK_FRAMES.map((frame) => <i key={frame}>{frame}</i>)}</span>
    </span>
  );
}

/** 这一轮跑了多久，每秒走一下。 */
export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className={`${s.stepsTook} ${h.num}`}>{duration(since, now)}</span>;
}

/** 计划里在做的那句：第一条在做的（几条同时在做时取最前面那条，同 Claude 的计划标题）。 */
export function planDoing(plan: readonly TLocalPlanEntry[] | null | undefined): string | null {
  return plan?.find((entry) => entry.status === "in_progress")?.content ?? null;
}

/** 一整行（伙伴、项目对话用；子会话的那一段过程自己拼这几块）。detail：点开看的（这一轮的步骤），没有就不给 ›。 */
export function ActivityLine({ text, since, detail }: { text: string | null; since: string | null; detail?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const head = <>
    <WorkingMark label="进行中" />
    {text ? <span className={s.stepsSummary} role="status">{text}</span> : null}
    {since ? <Elapsed since={since} /> : null}
    {detail ? <ChevronRight {...ICON} className={h.chevron} data-open={open ? "" : undefined} /> : null}
  </>;
  return (
    <div className={`${s.steps} ${s.activity}`} data-open={open ? "" : undefined} data-testid="activity-line">
      {detail ? <button type="button" className={s.stepsHead} aria-expanded={open} onClick={() => setOpen(!open)}>{head}</button> : <div className={s.step}>{head}</div>}
      {detail ? <div className={s.stepsBody} inert={!open}><div>{detail}</div></div> : null}
    </div>
  );
}
