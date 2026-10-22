import type { THomePlanActivity, THomePlanResponse } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { listPlanItems, milestoneDate, type PlanItem } from "./monthPlan.js";
import { companyPeriod } from "./monthlyPlans.js";
import { listPlanMarks } from "./planMarks.js";
import { readPlanTasks, type PlanTaskSource } from "./planTasks.js";
import { monthDays, weekOf } from "./workCalendar.js";
import { shanghaiDate } from "./workdays.js";

/** Mission 颜色按列表里的顺序取，第 5 个起循环。 */
const MISSION_COLORS = ["#2f63b0", "#2f8a7a", "#8a5cc2", "#c26a2f"];
/** 签定关口开头的日期（YYYY-MM-DD 或 M/D）连同后面的空白。 */
const LEADING_DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\s*/;

type MissionRow = { id: string; code: string; title: string; card_id: string | null; milestones: string[] };

/** 本人这个月的 Mission（不含占位的），不要求任务卡已确认；本月一个都没有时回退到之前最近一个有 Mission 的月份。 */
async function ownMissions(q: Query, ownerId: string, current: string): Promise<{ period: string; fallbackFrom: string | null; rows: MissionRow[] }> {
  const select = `SELECT id,code,title,personal_mission_card_id::text AS card_id,milestones
    FROM missions WHERE owner_id=$1 AND period=$2 AND NOT placeholder ORDER BY code`;
  const rows = (await q(select, [ownerId, current])).rows as MissionRow[];
  if (rows.length) return { period: current, fallbackFrom: null, rows };
  const previous = (await q("SELECT max(period) AS period FROM missions WHERE owner_id=$1 AND period<$2 AND NOT placeholder", [ownerId, current])).rows[0].period as string | null;
  if (!previous) return { period: current, fallbackFrom: null, rows: [] };
  return { period: previous, fallbackFrom: previous, rows: (await q(select, [ownerId, previous])).rows as MissionRow[] };
}

/** 已完成；之后＝开始在本周之后，或没写日期也没开始；其余都在本周，截止早于本周一的算逾期。 */
function placeActivity({ item, missionId }: PlanItem, weekStart: string, weekEnd: string): THomePlanActivity {
  if (item.status === "done") return { item, missionId, column: "done", overdue: false };
  if ((item.startDate !== null && item.startDate > weekEnd) || (item.startDate === null && item.dueDate === null && item.status === "not_started"))
    return { item, missionId, column: "later", overdue: false };
  return { item, missionId, column: "week", overdue: item.dueDate !== null && item.dueDate < weekStart };
}

/**
 * 成员首页的 Mission 计划视图：今天和本周按公司时区；回退到过去月份时 today 与本周仍是真实的今天。
 * 挂 Mission 的事项跟着显示的 Mission 走；独立事项按真实的本月加本周取，和这段有交集就列出。
 */
export async function readHomePlan(q: Query, person: { personId: string }, now: Date,
  deps: { planTasks: PlanTaskSource; names: Map<string, string> }): Promise<THomePlanResponse> {
  const today = shanghaiDate(now);
  const { weekStart, weekEnd } = weekOf(today);
  const current = companyPeriod(now);
  const { period, fallbackFrom, rows } = await ownMissions(q, person.personId, current);
  const days = monthDays(period);
  const monthEnd = monthDays(current).at(-1)!.date;
  const windowStart = weekStart < `${current}-01` ? weekStart : `${current}-01`;
  const windowEnd = weekEnd > monthEnd ? weekEnd : monthEnd;
  const missions = rows.map((m, index) => ({ missionId: m.id, code: m.code, title: m.title, cardId: m.card_id, color: MISSION_COLORS[index % MISSION_COLORS.length] }));
  // 关口只留落在显示月份里的。
  const gates = rows.flatMap((m) => m.milestones.flatMap((text) => {
    const date = milestoneDate(text, period);
    return date?.startsWith(`${period}-`) ? [{ missionId: m.id, date, label: text.replace(LEADING_DATE, "").trim() }] : [];
  }));
  const [tasks, items, marks] = await Promise.all([
    readPlanTasks(deps.planTasks, rows.map(({ id, code }) => ({ id, code }))),
    listPlanItems(q, person.personId, rows.map((m) => m.id), windowStart, windowEnd, deps.names, "overlap"),
    listPlanMarks(q, person.personId, rows.map((m) => m.id)),
  ]);
  return { period, fallbackFrom, today, weekStart, weekEnd, days, missions, gates, marks, tasks,
    activities: items.map((entry) => placeActivity(entry, weekStart, weekEnd)) };
}
