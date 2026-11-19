import type { Query } from "./meetingStore.js";
import { missionGate } from "./monthPlan.js";
import { shanghaiDate } from "./workdays.js";
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

/**
 * 「原」验收时间点（迁移 293，本人 11/19 定）：没单独定日子的 Task，天枢第一次读到它时把当时最近的 Mission 节点记下来，之后不往后滚。
 * 基准日：这个 Mission 还没有哪件 Task 被记过（上线前就有的那批、或这个 Mission 刚进天枢）取 Mission 进天枢的日子，之后才出现的取今天。
 * Mission 没写节点的不记（之后写了节点、第一次读到时再记）。返回这几件 Task 的「原」（没有的不在里面）。
 */
export async function plannedDueDates(q: Query, tasks: { taskId: string; missionId: string }[], now: Date): Promise<Map<string, string>> {
  if (!tasks.length) return new Map();
  const read = async () => new Map(((await q("SELECT task_id,due_date FROM task_planned_due_dates WHERE task_id=ANY($1::text[])", [tasks.map((task) => task.taskId)])).rows as
    { task_id: string; due_date: string }[]).map((row) => [row.task_id, row.due_date]));
  const known = await read();
  const missing = tasks.filter((task) => !known.has(task.taskId));
  if (!missing.length) return known;
  const missions = new Map(((await q(`SELECT m.id,m.period,m.milestones,m.created_at,EXISTS (SELECT 1 FROM task_planned_due_dates p WHERE p.mission_id=m.id) AS seen
    FROM missions m WHERE m.id=ANY($1::text[])`, [[...new Set(missing.map((task) => task.missionId))]])).rows as
    { id: string; period: string; milestones: string[]; created_at: Date; seen: boolean }[]).map((row) => [row.id, row]));
  const today = shanghaiDate(now);
  for (const task of missing) {
    const mission = missions.get(task.missionId);
    // 基准日不晚于今天（Mission 进天枢的日子按公司时区算）。
    const entered = mission ? shanghaiDate(mission.created_at) : today;
    const due = mission ? missionGate(mission.milestones, mission.period, mission.seen || entered > today ? today : entered) : null;
    if (due) await q(`INSERT INTO task_planned_due_dates(task_id,mission_id,due_date,recorded_at) VALUES($1,$2,$3,$4) ON CONFLICT (task_id) DO NOTHING`,
      [task.taskId, task.missionId, due, now]);
  }
  return read();
}

/** 验收时间点：本人改的（唯一一份）优先，没有用记下的「原」。 */
export async function effectiveDueDates(q: Query, tasks: { taskId: string; missionId: string }[], now: Date): Promise<Map<string, string>> {
  const [stored, planned] = await Promise.all([taskDueDates(q, tasks.map((task) => task.taskId)), plannedDueDates(q, tasks, now)]);
  return new Map([...planned, ...stored]);
}
