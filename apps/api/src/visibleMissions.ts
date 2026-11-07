import type { Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";

/**
 * 看得见的 Mission（设计《新首页》10.3、10.9 第 2 条）：月份只是检查点，不按日历一刀切。
 * - 每个人「这个月」的 Mission：本月有就是本月的；本月一个都没有时退回这个人最近一个有 Mission 的月份。
 *   这个月已经从本体载入过（表里有本月的本体行）就不退回：本体里没有这个人的就是没有（斯一 10/24，和首页 homePlan.ownMissions 同一条）。
 * - 再加之前月份里还有没了结、在天枢里动过的 Task 的 Mission（carried）：这件 Task 下还挂着没做完的执行事项。
 * 不含占位的，不含之后月份的。每个带它的月份 period。
 */
export type VisibleMission = { id: string; code: string; title: string; ownerId: string; period: string; carried: boolean };

/** ownerId：只要这个人负责的 Mission；不给是全公司（每个人各按自己的「这个月」）。排序：月份从近到远，再按负责人、编号。 */
export async function visibleMissions(q: Query, now: Date, ownerId?: string): Promise<VisibleMission[]> {
  const rows = (await q(`WITH loaded AS (SELECT EXISTS (SELECT 1 FROM missions WHERE period=$1 AND world_object_id IS NOT NULL) AS v),
      shown AS (SELECT owner_id, CASE WHEN bool_or(period=$1) THEN $1 WHEN (SELECT v FROM loaded) THEN NULL ELSE max(period) END AS period
        FROM missions WHERE NOT placeholder AND period<=$1 AND ($2::text IS NULL OR owner_id=$2) GROUP BY owner_id),
      open_tasks AS (SELECT DISTINCT mission_id FROM tasks
        WHERE plan_task_id IS NOT NULL AND mission_id IS NOT NULL AND status IN ('not_started','in_progress'))
    SELECT m.id,m.code,m.title,m.owner_id,m.period,s.period IS NULL AS carried FROM missions m
      LEFT JOIN shown s ON s.owner_id=m.owner_id AND s.period=m.period
    WHERE NOT m.placeholder AND m.period<=$1 AND ($2::text IS NULL OR m.owner_id=$2)
      AND (s.period IS NOT NULL OR m.id IN (SELECT mission_id FROM open_tasks))
    ORDER BY m.period DESC,m.owner_id,m.code`, [companyPeriod(now), ownerId ?? null])).rows as
    { id: string; code: string; title: string; owner_id: string; period: string; carried: boolean }[];
  return rows.map((row) => ({ id: row.id, code: row.code, title: row.title, ownerId: row.owner_id, period: row.period, carried: row.carried }));
}
