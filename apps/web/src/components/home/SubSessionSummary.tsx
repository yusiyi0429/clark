"use client";

import { ChevronRight } from "lucide-react";
import type { Project } from "@/lib/home/projects";
import type { SubSession } from "@/lib/home/types";
import { StateIcon } from "./StateIcon";
import { subHref, subIcon, subKey, subLetters, SubLetter } from "./LeftColumn";
import { subStage } from "./PlanDecision";
import s from "@/styles/sub-session-summary.module.css";

type ProjectSessions = Pick<Project, "id" | "name" | "subSessions">;

/** 复用首页每轮刷新的状态；这里只展示，不把停下一轮当作验收完成。 */
export function SubSessionSummary({ projects, other = [], grouped = true, go }: {
  projects: readonly ProjectSessions[];
  other?: readonly SubSession[];
  grouped?: boolean;
  go: (href: string) => void;
}) {
  const groups = projects.filter((project) => project.subSessions.length);
  const all = [...groups.flatMap((project) => project.subSessions), ...other];
  if (!all.length) return null;
  const running = all.filter((sub) => sub.state === "running").length;
  const reworking = all.filter((sub) => sub.state === "failed").length;
  const waiting = all.filter((sub) => sub.state === "waiting" && sub.waiting).length;
  const rows = (subs: readonly SubSession[]) => {
    const letters = subLetters([...subs]);
    return <ul className={s.list}>{subs.map((sub) => (
      <li key={subKey(sub)}>
        <button type="button" className={s.row} onClick={() => go(subHref(sub))} data-state={sub.state}>
          <StateIcon {...subIcon(sub)} {...(sub.state === "failed" ? { label: "重做中" } : {})} />
          {letters.has(subKey(sub)) ? <SubLetter letter={letters.get(subKey(sub))!} /> : <span />}
          <span className={s.title}>{sub.title}</span>
          <span className={s.stage} data-attention={sub.state === "waiting" && sub.waiting ? "" : undefined}>{subStage(sub)}</span>
        </button>
      </li>
    ))}</ul>;
  };
  return (
    <details className={s.root} data-testid="sub-session-summary">
      <summary className={s.toggle}>
        <ChevronRight size={14} aria-hidden className={s.chevron} />
        <span>子会话 {all.length}</span>
        {running ? <span className={s.count}>{running} 进行中</span> : null}
        {reworking ? <span className={s.count}>{reworking} 重做中</span> : null}
        {waiting ? <span className={s.attention}>{waiting} 等你</span> : null}
      </summary>
      <div className={s.body}>
        {groups.map((project) => <section key={project.id} aria-label={grouped ? project.name : "本项目子会话"}>
          {grouped ? <h2 className={s.project}>{project.name}</h2> : null}
          {rows(project.subSessions)}
        </section>)}
        {other.length ? <section aria-label="其他子会话"><h2 className={s.project}>其他</h2>{rows(other)}</section> : null}
      </div>
    </details>
  );
}
