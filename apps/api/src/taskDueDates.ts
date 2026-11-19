import type { Query } from "./meetingStore.js";
import { CardError } from "./taskCards.js";

/**
 * Task 的验收时间点（迁移 290）：天枢里按 Task 存的唯一一份，不要求挂项目。本月页、项目详情、伙伴改的都是这里；
 * 首页、项目、月份页读也读这里，没存的退回 Mission 的节点（monthPlan.ts missionGate）。本体 0.3 的 Task 没有日期，不写本体。
 */

/** 是不是一个真的日期（YYYY-MM-DD，2 月 30 日这类不算）。 */
export const realDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

/** 这几件 Task 存过的验收时间点。 */
export async function taskDueDates(q: Query, taskIds: string[]): Promise<Map<string, string>> {
  if (!taskIds.length) return new Map();
  const rows = (await q("SELECT task_id,due_date FROM task_due_dates WHERE task_id=ANY($1::text[])", [taskIds])).rows as { task_id: string; due_date: string }[];
  return new Map(rows.map((row) => [row.task_id, row.due_date]));
}

/** 存一件 Task 的验收时间点；null 不存了（退回 Mission 的节点）。日期不对 400。调用方先核对谁能改。 */
export async function setTaskDueDate(q: Query, taskId: string, dueDate: string | null): Promise<void> {
  if (dueDate !== null && !realDate(dueDate)) throw new CardError(400, "INVALID_INPUT", "截止日不是一个真的日期");
  if (dueDate === null) await q("DELETE FROM task_due_dates WHERE task_id=$1", [taskId]);
  else await q("INSERT INTO task_due_dates(task_id,due_date) VALUES($1,$2) ON CONFLICT (task_id) DO UPDATE SET due_date=EXCLUDED.due_date", [taskId, dueDate]);
}
