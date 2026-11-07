import type { Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";

/**
 * 看得见的 Mission（设计《新首页》10.3、10.9 第 2 条）：月份只是检查点，不按日历一刀切。
 * - 每个人「这个月」的 Mission：本月有就是本月的；这个人本月一个都没有时退回他自己最近一个有 Mission 的月份。按人判断，
 *   别人的本月 Mission 已经从本体载入了也照样退回：M2 是一个人一个人写进本体的，按「有人载入了就都不退回」的话，第一条写进去那一刻其他人会一起变空（11/07 用户定）。
 * - 再加还有没了结、在天枢里动过的 Task 的 Mission（carried）。
 *   动过：挂过执行事项或卡（退回的不算）、开过专题、出过交付版本、开过 Task 管线（管线没有 Mission，按 plan_task_missions 记的对上）。
 *   了结：本人确认完成（最新一版交付了、之后没开返工卡）、到此为止、已延续（taskContinuity.ts）。
 * 不含占位的，不含之后月份的。每个带它的月份 period；openTaskIds 是这个 Mission 下没了结、动过的 Task。
 */
export type VisibleMission = { id: string; code: string; title: string; ownerId: string; period: string; carried: boolean; openTaskIds: string[] };

/**
 * 看谁的：
 * - 不给：全公司（每个人各按自己的「这个月」，加全公司没了结的）；伙伴全局上下文、会议解读用。
 * - { ownerId }：这个人负责的 Mission（这个月的，加里面有没了结 Task 的）；能挂执行事项的 Mission 用。
 * - { personId }：这个人左栏要的（work-home）：他这个月的 Mission，加里面有他动过、没了结的 Task 的 Mission（谁负责的都算）；
 *   openTaskIds 只算他动过的。
 */
export type VisibleScope = { ownerId: string } | { personId: string };

/** 没了结的 Task（SQL 条件，column 是 Task id 所在的列）。和 taskContinuity.settlementsOf 同一个口径。 */
export const UNSETTLED = (column: string) => `NOT EXISTS (SELECT 1 FROM task_stops x WHERE x.task_id=${column})
  AND NOT EXISTS (SELECT 1 FROM task_continuations x WHERE x.from_task_id=${column})
  AND NOT EXISTS (SELECT 1 FROM deliverable_versions v WHERE v.task_id=${column} AND v.delivered_at IS NOT NULL
    AND v.number=(SELECT max(w.number) FROM deliverable_versions w WHERE w.task_id=${column})
    AND NOT EXISTS (SELECT 1 FROM tasks r WHERE r.plan_task_id=${column} AND r.rework_of_card_id IS NOT NULL AND r.created_at>v.delivered_at))`;

/** 排序：月份从近到远，再按负责人、编号。 */
export async function visibleMissions(q: Query, now: Date, scope?: VisibleScope): Promise<VisibleMission[]> {
  const owner = scope && "ownerId" in scope ? scope.ownerId : null;
  const person = scope && "personId" in scope ? scope.personId : null;
  const rows = (await q(`WITH shown AS (SELECT owner_id, CASE WHEN bool_or(period=$1) THEN $1 ELSE max(period) END AS period
        FROM missions WHERE NOT placeholder AND period<=$1 AND ($2::text IS NULL OR owner_id=$2) GROUP BY owner_id),
      touched AS (
        SELECT plan_task_id AS task_id,mission_id,owner_id AS person_id FROM tasks WHERE plan_task_id IS NOT NULL AND mission_id IS NOT NULL AND status<>'returned'
        UNION SELECT plan_task_id,mission_id,owner_id FROM research_topics WHERE plan_task_id IS NOT NULL
        UNION SELECT task_id,mission_id,author_id FROM deliverable_versions
        UNION SELECT p.plan_task_id,k.mission_id,p.owner_id FROM task_pipelines p JOIN plan_task_missions k ON k.task_id=p.plan_task_id
        UNION SELECT k.task_id,k.mission_id,c.owner_id FROM conversations c JOIN plan_task_missions k ON c.scope='plan-task:'||k.task_id
          WHERE c.scope LIKE 'plan-task:%' AND c.deleted_at IS NULL),
      open AS (SELECT DISTINCT t.task_id,t.mission_id FROM touched t WHERE ($3::text IS NULL OR t.person_id=$3) AND ${UNSETTLED("t.task_id")})
    SELECT m.id,m.code,m.title,m.owner_id,m.period,s.period IS NULL AS carried,
      COALESCE(array_agg(o.task_id ORDER BY o.task_id) FILTER (WHERE o.task_id IS NOT NULL),'{}') AS open_task_ids
    FROM missions m LEFT JOIN shown s ON s.owner_id=m.owner_id AND s.period=m.period LEFT JOIN open o ON o.mission_id=m.id
    WHERE NOT m.placeholder AND m.period<=$1 AND (s.period IS NOT NULL OR (o.task_id IS NOT NULL AND ($4::text IS NULL OR m.owner_id=$4)))
    GROUP BY m.id,m.code,m.title,m.owner_id,m.period,s.period
    ORDER BY m.period DESC,m.owner_id,m.code`, [companyPeriod(now), owner ?? person, person, owner])).rows as
    { id: string; code: string; title: string; owner_id: string; period: string; carried: boolean; open_task_ids: string[] }[];
  return rows.map((row) => ({ id: row.id, code: row.code, title: row.title, ownerId: row.owner_id, period: row.period, carried: row.carried,
    openTaskIds: row.open_task_ids }));
}
