"use client";

/**
 * 成员首页的执行事项（clark `dri/surface.tsx` 的 TaskSection）：平铺成一格一格的卡，按截止排 —— 截止近的在前，没有截止的
 * 放后面、保持原来的先后。卡上写状态、来处（来自哪场会）和会上原话；推进它的两颗小钮在卡底（执行事项的详情页在第 4 步）。
 * 退回在通知栏那张卡上做（要写原因），这里只写「已退回：原因」。
 */

import { Card } from "@heroui/react";
import { Button } from "ts-design/primitives";
import s from "@/styles/member-tasks.module.css";

export type TaskStatus = "not_started" | "in_progress" | "done" | "returned";

export interface MemberTask {
  id: string;
  version: number;
  title: string;
  status: TaskStatus;
  dueDate: string | null;
  returnReason: string | null;
  origin: { type: "meeting"; meetingId: string; meetingTitle: string; quote: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export const TASK_STATUS: Record<TaskStatus, string> = {
  not_started: "未开始",
  in_progress: "推进中",
  done: "已完成",
  returned: "已退回",
};

/** 截止近的在前；没有截止的放后面，保持原来的先后（新的在前）。 */
export function tasksByDue(tasks: MemberTask[]): MemberTask[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      if (a.task.dueDate && b.task.dueDate) return a.task.dueDate.localeCompare(b.task.dueDate) || a.index - b.index;
      if (a.task.dueDate) return -1;
      if (b.task.dueDate) return 1;
      return a.index - b.index;
    })
    .map(({ task }) => task);
}

/** 截止写成「9 月 30 日前」。 */
export function dueLabel(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month} 月 ${day} 日前`;
}

export function MemberTasks({
  tasks,
  busyId,
  error,
  onStatus,
}: {
  tasks: MemberTask[];
  /** 正在改状态的那一张。 */
  busyId?: string | null;
  error?: string | null;
  onStatus: (task: MemberTask, status: TaskStatus) => void;
}) {
  const open = tasks.filter((task) => task.status !== "done" && task.status !== "returned").length;
  return (
    <section className={s.tasks} aria-label="执行事项">
      <div className={s.taskToolbar}>
        <span>{open} 项执行事项在推进</span>
      </div>
      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}
      {tasks.length ? (
        <div className={s.taskGrid}>
          {tasksByDue(tasks).map((task) => (
            <Card key={task.id} className={s.taskCard} data-task={task.id}>
              <div className={s.taskTop}>
                <span className={s.status} data-status={task.status}>
                  <span className={s.statusDot} aria-hidden="true" />
                  {TASK_STATUS[task.status]}
                </span>
                {task.dueDate ? <span className={s.due}>{dueLabel(task.dueDate)}</span> : null}
              </div>
              <h3>{task.title}</h3>
              {task.origin ? <span className={s.assignment}>来自会议「{task.origin.meetingTitle}」</span> : null}
              {task.origin?.quote ? <blockquote className={s.quote}>{task.origin.quote}</blockquote> : null}
              {task.status === "returned" && task.returnReason ? <p className={s.returned}>已退回：{task.returnReason}</p> : null}
              {task.status === "not_started" || task.status === "in_progress" ? (
                <div className={s.taskActions}>
                  {task.status === "not_started" ? (
                    <Button variant="ghost" size="sm" isDisabled={busyId === task.id} onPress={() => onStatus(task, "in_progress")}>
                      开始推进
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" data-emphasis isDisabled={busyId === task.id} onPress={() => onStatus(task, "done")}>
                    标记完成
                  </Button>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      ) : (
        <p className={s.empty}>暂无执行事项。会后分给你的事会出现在这里，通知栏同时提醒。</p>
      )}
    </section>
  );
}
