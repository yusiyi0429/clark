import type { THomePlanActivity, THomePlanResponse } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { listPlanItems, milestoneDate, type PlanItem } from "./monthPlan.js";
import { companyPeriod } from "./monthlyPlans.js";
import { listPlanMarks } from "./planMarks.js";
import { readPlanTasks, type PlanTaskSource } from "./planTasks.js";
import { isWorkday, monthDays, weekOf } from "./workCalendar.js";
import { shanghaiDate } from "./workdays.js";

/** Mission 颜色按列表里的顺序取，第 5 个起循环。 */
const MISSION_COLORS = ["#2f63b0", "#2f8a7a", "#8a5cc2", "#c26a2f"];
/** 签定关口开头的日期（YYYY-MM-DD 或 M/D）连同后面的空白和分隔符（：: 、 -）。 */
const LEADING_DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})[\s：:、-]*/;

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

/** 进行中的事项最近一次动静之后过了几个工作日算停滞（只看有没有动静，和战场进展红线的「核实过的进展」是两回事）。 */
const IDLE_WORKDAYS = 3;
const DAY_MS = 86_400_000;

/** 最近一次动静的时间，和停滞时那天到今天的自然日数（没停滞为 null）。已提交等验收的球在验收人那边，不算停滞。 */
function activitySignal(item: PlanItem["item"], today: string): Pick<THomePlanActivity, "lastActivityAt" | "idleDays"> {
  const lastActivityAt = item.latestProgress?.createdAt ?? item.createdAt;
  if (item.status !== "in_progress" || item.awaitingAcceptance) return { lastActivityAt, idleDays: null };
  const last = shanghaiDate(new Date(lastActivityAt));
  let workdays = 0;
  for (let ms = Date.parse(`${last}T00:00:00Z`) + DAY_MS, end = Date.parse(`${today}T00:00:00Z`); ms <= end; ms += DAY_MS)
    if (isWorkday(new Date(ms).toISOString().slice(0, 10))) workdays += 1;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / DAY_MS);
  return { lastActivityAt, idleDays: workdays >= IDLE_WORKDAYS ? days : null };
}

/**
 * 已完成；挂在之前月份 Mission 下没做完的放本周、算逾期；
 * 之后＝开始在本周之后，或还没开始、没写开始日、截止在本周之后或没写；其余都在本周，截止早于本周一的算逾期。
 */
function placeActivity({ item, missionId }: PlanItem, weekStart: string, weekEnd: string, earlierMission: boolean): Pick<THomePlanActivity, "item" | "missionId" | "column" | "overdue"> {
  if (item.status === "done") return { item, missionId, column: "done", overdue: false };
  if (earlierMission) return { item, missionId, column: "week", overdue: true };
  if ((item.startDate !== null && item.startDate > weekEnd) ||
    (item.startDate === null && item.status === "not_started" && (item.dueDate === null || item.dueDate > weekEnd)))
    return { item, missionId, column: "later", overdue: false };
  return { item, missionId, column: "week", overdue: item.dueDate !== null && item.dueDate < weekStart };
}

/**
 * 成员首页的 Mission 计划视图：今天和本周按公司时区；回退到过去月份时 today 与本周仍是真实的今天。
 * 挂 Mission 的事项跟着显示的 Mission 走；独立事项按真实的本月加本周取，和这段有交集就列出。
 * 之前没做完的也列出（首页是唯一的事项清单）：截止早于这段的独立事项，和挂在显示月份之前 Mission 下的；后者 missionId 照留，Mission 行上只归「全部」。
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
    listPlanItems(q, person.personId, rows.map((m) => m.id), windowStart, windowEnd, deps.names, { period }),
    listPlanMarks(q, person.personId, rows.map((m) => m.id)),
  ]);
  const shown = new Set(rows.map((m) => m.id));
  return { period, fallbackFrom, today, weekStart, weekEnd, days, missions, gates, marks, tasks,
    activities: items.map((entry) => ({ ...placeActivity(entry, weekStart, weekEnd, entry.missionId !== null && !shown.has(entry.missionId)),
      ...activitySignal(entry.item, today) })) };
}
