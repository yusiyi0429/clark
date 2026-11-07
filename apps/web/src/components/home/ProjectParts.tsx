"use client";

/**
 * 项目页的几块（新首页设计 16.3）：
 * - 页头右边：绑定的文件夹 chip、「详情」；
 * - 页头下的目标条：每件挂着的本月 Task 一行，写名字、截止、「标准 1/3」，点开逐条看；没有目标时不画；
 * - 对话里换月份的分隔线「11 月目标：{Task 名}」。
 * 标准逐条达没达到读 GET /api/plan-tasks/:taskId/check（evidenced 算达到）；读不到就只写「标准 N 条」。
 */
import { useEffect, useState } from "react";
import { Check, ChevronRight, Circle, Info } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import { projectInfoHref, type Project, type ProjectGoal } from "@/lib/home/projects";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

type Criterion = { text: string; met: boolean };

/** 一件 Task 的完成标准和达没达到：先用计划里的标准，对表读到了换成逐条的结论。 */
function useCriteria(taskId: string, fallback: string[]): { criteria: Criterion[]; checked: boolean } {
  const [checked, setChecked] = useState<Criterion[] | null>(null);
  useEffect(() => {
    let alive = true;
    void browserApi.GET("/api/plan-tasks/{taskId}/check", { params: { path: { taskId } } }).then(({ data }) => {
      if (alive && data) setChecked(data.criteria.map((entry) => ({ text: entry.text, met: entry.status === "evidenced" })));
    }, () => undefined);
    return () => { alive = false; };
  }, [taskId]);
  return checked ? { criteria: checked, checked: true } : { criteria: fallback.map((text) => ({ text, met: false })), checked: false };
}

function GoalLine({ goal, criteria: planned }: { goal: ProjectGoal; criteria: string[] }) {
  const [open, setOpen] = useState(false);
  const { criteria, checked } = useCriteria(goal.taskId, planned);
  const met = criteria.filter((entry) => entry.met).length;
  return (
    <li className={h.goal}>
      <button type="button" className={h.goalMain} aria-expanded={open} onClick={() => setOpen(!open)} disabled={!criteria.length} data-testid="project-goal">
        <ChevronRight size={14} strokeWidth={1.8} aria-hidden className={h.chevron} data-open={open ? "" : undefined} />
        <span className={h.goalName}>{goal.name}</span>
        {goal.due ? <span className={`${h.goalMeta} ${h.num}`}>{goal.due} 验收</span> : null}
        {criteria.length ? <span className={`${h.goalMeta} ${h.num}`}>{checked ? `标准 ${met}/${criteria.length}` : `标准 ${criteria.length} 条`}</span> : null}
      </button>
      {open ? (
        <ul className={h.criteria}>
          {criteria.map((entry, index) => (
            <li key={`${index}:${entry.text}`} data-met={entry.met ? "" : undefined}>{entry.met ? <Check {...ICON} aria-label="达到" /> : <Circle {...ICON} aria-label="还没达到" />}{entry.text}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** 页头下的目标条：本月挂着的 Task 一件一行。criteriaOf 给计划里写的完成标准。 */
export function GoalBar({ project, criteriaOf }: { project: Project; criteriaOf: (taskId: string) => string[] }) {
  if (!project.current.length) return null;
  return (
    <ul className={h.goalBar} aria-label="本月目标" data-testid="goal-bar">
      {project.current.map((goal) => <GoalLine key={goal.taskId} goal={goal} criteria={criteriaOf(goal.taskId)} />)}
    </ul>
  );
}

/** 页头右边：文件夹 chip（点了进详情绑文件夹）、「详情」。 */
export function ProjectTrail({ project, go }: { project: Project; go: (href: string) => void }) {
  return (
    <>
      {project.folder ? <button type="button" className={h.statusChip} title="文件夹" onClick={() => go(projectInfoHref(project.id))}>{project.folder}</button> : null}
      <button type="button" className={h.icon} aria-label="详情" title="详情" onClick={() => go(projectInfoHref(project.id))} data-testid="project-detail"><Info {...ICON} /></button>
    </>
  );
}

/** 对话里换月份的分隔线：「11 月目标：{Task 名}」（居中，两边发丝线）。 */
export function MonthRule({ goal }: { goal: ProjectGoal }) {
  return <p className={h.monthRule} role="separator" data-testid="month-rule">{Number(goal.period.slice(5))} 月目标：{goal.name}</p>;
}
