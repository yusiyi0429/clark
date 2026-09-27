"use client";

import { Card } from "@heroui/react";
import { ArrowUpRight, ChevronRight, Plus } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
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

export function MemberTasks({ tasks, busyId, error, onStatus, onNavigate }: {
  tasks: MemberTask[];
  busyId?: string | null;
  error?: string | null;
  onStatus: (task: MemberTask, status: TaskStatus) => void;
  onNavigate?: (href: string, origin?: Element | null) => void;
}) {
  const open = tasks.filter((task) => task.status !== "done" && task.status !== "returned").length;
  return <section className={s.tasks} aria-label="执行事项">
    <div className={s.taskToolbar}><span>{open} 项执行事项在推进</span><Button variant="ghost" size="sm" onPress={(event) => onNavigate?.("/me/tasks/new", event.target)}><Plus size={15} aria-hidden />开启执行事项</Button></div>
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    {tasks.length ? <div className={s.taskGrid}>{tasksByDue(tasks).map((task) => {
      const href = `/me/tasks/${encodeURIComponent(task.id)}`;
      return <Card key={task.id} className={s.taskCard} data-task={task.id} data-origin={href} data-waiting={!!task.waitingOn} onClick={(event) => { if (!(event.target as Element).closest("button,a")) onNavigate?.(href, event.currentTarget); }}>
        <div className={s.taskTop}><span className={s.status} data-status={task.status}><span className={s.statusDot} aria-hidden />{TASK_STATUS[task.status]}</span>{task.status === "not_started" && task.startDate ? <span>计划 {dueLabel(task.startDate).replace("前", "开始")}</span> : task.dueDate ? <span>{dueLabel(task.dueDate)}</span> : null}</div>
        <h3><Button variant="ghost" className={s.taskTitle} aria-label={`查看详情：${task.title}`} onPress={(event) => onNavigate?.(href, event.target)}><span>{task.title}</span><ChevronRight size={17} aria-hidden /></Button></h3>
        {task.mission ? <><Button variant="ghost" className={s.taskMission} aria-label={`横向切到个人任务：${task.mission.title}`} onPress={(event) => onNavigate?.(`/me/mission-cards/${encodeURIComponent(task.mission!.cardId)}`, event.target)}><span>{task.mission.title}</span><ArrowUpRight size={13} aria-hidden /></Button><span className={s.assignment}>第 {task.mission.step} 步，共 {task.mission.steps} 步</span></> : <span className={s.assignment}>{task.source === "meeting" && task.origin ? `会后分派 · ${task.origin.meetingTitle}` : "独立事项"}</span>}
        {task.waitingOn ? <p className={s.waiting}>等上一步：{task.waitingOn.title}</p> : null}
        {task.startDate || task.dueDate ? <p className={s.dates}>{task.startDate ? `计划开始 ${task.startDate}` : ""}{task.startDate && task.dueDate ? " · " : ""}{task.dueDate ? `截止 ${task.dueDate}` : ""}</p> : null}
        {task.collaborators.length ? <p className={s.connections}>协作 · {task.collaborators.map((person) => person.name).join("、")}</p> : null}
        {task.status === "returned" && task.returnReason ? <p className={s.returned}>已退回：{task.returnReason}</p> : null}
        {task.status !== "returned" ? <div className={s.taskActions} role="group" aria-label={`${task.title}的状态`}>{(["not_started", "in_progress", "done"] as const).map((status) => <Button key={status} variant="ghost" size="sm" aria-pressed={task.status === status} isDisabled={busyId === task.id || task.status === status} onPress={() => onStatus(task, status)}>{TASK_STATUS[status]}</Button>)}</div> : null}
      </Card>;
    })}</div> : <p className={s.empty}>暂无执行事项。你可以开启一件事，会后分派也会显示在这里。</p>}
  </section>;
}
