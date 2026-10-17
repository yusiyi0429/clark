"use client";

import { useState } from "react";
import { Card } from "@heroui/react";
import { ArrowUpRight, Check, ChevronRight, Plus } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { monthDayTime } from "@/lib/companyTime";
import s from "@/components/tasks/tasks.module.css";

export type MemberTask = components["schemas"]["TaskView"];
export type TaskStatus = MemberTask["status"];
export const TASK_STATUS: Record<TaskStatus, string> = {
  not_started: "未启动", in_progress: "进行中", done: "完成", returned: "已退回",
};

/** 截止近的在前；无截止保持 API 原有顺序。 */
export function tasksByDue(tasks: MemberTask[]): MemberTask[] {
  return tasks.map((task, index) => ({ task, index })).sort((a, b) =>
    a.task.dueDate && b.task.dueDate ? a.task.dueDate.localeCompare(b.task.dueDate) || a.index - b.index
      : a.task.dueDate ? -1 : b.task.dueDate ? 1 : a.index - b.index).map(({ task }) => task);
}

export function dueLabel(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month} 月 ${day} 日前`;
}

/**
 * 首页「执行事项」：状态跟着推进人的动作自动走，完成只能在封面里验收（design-12），所以卡上没有状态按钮，也不再写「第 n 步」。
 * 外部工具替推进人提交了验收的，状态写「等你验收」。
 */
export function MemberTasks({ tasks, error, onNavigate }: {
  tasks: MemberTask[];
  error?: string | null;
  onNavigate?: (href: string, origin?: Element | null) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const open = tasks.filter((task) => task.status !== "done" && task.status !== "returned").length;
  const sorted = tasksByDue(tasks);
  const active = sorted.filter((task) => task.status !== "done");
  // 完成的收进「已完成」，默认折叠；最近更新的在前。
  const done = sorted.filter((task) => task.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section className={s.tasks} aria-label="执行事项">
    <div className={s.taskToolbar}><span>{open} 项执行事项在推进</span><Button variant="ghost" size="sm" onPress={(event) => onNavigate?.("/me/tasks/new", event.target as Element)}><Plus size={15} aria-hidden />开启执行事项</Button></div>
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    {active.length ? <div className={s.taskGrid}>{active.map((task) => {
      const href = `/me/tasks/${encodeURIComponent(task.id)}`;
      return <Card key={task.id} className={s.taskCard} data-task={task.id} data-origin={href} onClick={(event) => { if (!(event.target as Element).closest("button,a")) onNavigate?.(href, event.currentTarget); }}>
        <div className={s.taskTop}><span className={s.status} data-status={task.status}><span className={s.statusDot} aria-hidden />{task.awaitingAcceptance ? "等你验收" : TASK_STATUS[task.status]}</span>{task.status === "not_started" && task.startDate ? <span>计划 {dueLabel(task.startDate).replace("前", "开始")}</span> : task.dueDate ? <span>{dueLabel(task.dueDate)}</span> : null}</div>
        <h3><Button variant="ghost" className={s.taskTitle} aria-label={`查看详情：${task.title}`} onPress={(event) => onNavigate?.(href, event.target)}><span>{task.title}</span><ChevronRight size={17} aria-hidden /></Button></h3>
        {task.mission ? <Button variant="ghost" className={s.taskMission} aria-label={`横向切到个人任务：${task.mission.title}`} onPress={(event) => onNavigate?.(`/me/mission-cards/${encodeURIComponent(task.mission!.cardId)}`, event.target)}><span>{task.mission.title}</span><ArrowUpRight size={13} aria-hidden /></Button> : <span className={s.assignment}>{task.source === "meeting" && task.origin ? `会后分派 · ${task.origin.meetingTitle}` : "独立事项"}</span>}
        {task.startDate || task.dueDate ? <p className={s.dates}>{task.startDate ? `计划开始 ${task.startDate}` : ""}{task.startDate && task.dueDate ? " · " : ""}{task.dueDate ? `截止 ${task.dueDate}` : ""}</p> : null}
        {task.collaborators.length ? <p className={s.connections}>协作 · {task.collaborators.map((person) => person.name).join("、")}</p> : null}
        {task.status === "returned" && task.returnReason ? <p className={s.returned}>已退回：{task.returnReason}</p> : null}
        {task.latestProgress ? <p className={s.latestProgress} title={task.latestProgress.body.slice(0, 60)} aria-label={`最新进展：${task.latestProgress.body.slice(0, 60)}`}>
          最新进展 · {({ web: "网页", codex: "Codex", claude: "Claude Code", github: "GitHub", other: "外部工具" })[task.latestProgress.source]} · {monthDayTime(task.latestProgress.createdAt)}
        </p> : null}
      </Card>;
    })}</div> : tasks.length ? null : <p className={s.empty}>还没有执行事项</p>}
    {done.length ? <div className={s.doneGroup}>
      <button type="button" className={s.doneToggle} aria-expanded={showDone} onClick={() => setShowDone((value) => !value)}>
        <ChevronRight size={14} aria-hidden />已完成 {done.length}
      </button>
      {showDone ? <ul className={s.doneList}>{done.map((task) => {
        const href = `/me/tasks/${encodeURIComponent(task.id)}`;
        return <li key={task.id} className={s.doneItem}><button type="button" className={s.doneRow} data-origin={href} aria-label={`查看详情：${task.title}（已完成）`} onClick={(event) => onNavigate?.(href, event.currentTarget)}>
          <Check size={14} aria-hidden /><span className={s.doneTitle}>{task.title}</span>
          <span className={s.doneMeta}>{task.mission ? task.mission.title : task.source === "meeting" && task.origin ? `会后分派 · ${task.origin.meetingTitle}` : "独立事项"}</span>
        </button></li>;
      })}</ul> : null}
    </div> : null}
  </section>;
}
