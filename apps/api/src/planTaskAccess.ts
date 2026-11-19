import type { TReviewBasis } from "@warmap/contracts";
import { ownMissions, planTaskMissions } from "./homePlan.js";
import type { Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { readPlanTaskById, readPlanTasks, type PlanTask, type PlanTaskMission, type PlanTaskSource } from "./planTasks.js";
import { DeliverableError } from "./taskDeliverables.js";

/**
 * 找一个本体 Task，并说明看的人和它的关系（约定与对表 V1、Task 交付物共用）。
 * 能看：负责人、Mission 负责人、战场负责人（Mission 挂的战场由他负责）、CEO，再加约定里的认可人（认可人要读了约定才知道，由 taskAgreements.openPlanTask 补判）。
 * 能改（传版本、交付、改说明）：负责人；本体没登记负责人时是 Mission 负责人。改约定：负责人和 Mission 负责人。
 */

export type PlanTaskViewer = { personId: string; isCeo: boolean };

/** 看的人：是不是 CEO 按人员目录认，不看当前切在哪个视角。 */
export const planTaskViewer = (directory: PeopleDirectory, personId: string): PlanTaskViewer =>
  ({ personId, isCeo: directory.searchPeople(undefined).find((person) => person.personId === personId)?.roles.includes("ceo") ?? false });

/** 交付物按哪套标准评：有验收标准按验收标准，没有时按完成定义（算一条），两样都没有就不评。 */
export function taskBasis(task: PlanTask): { basis: TReviewBasis; criteria: string[] } {
  return task.criteria.length ? { basis: "acceptance", criteria: task.criteria }
    : task.doneDefinition ? { basis: "definition", criteria: [task.doneDefinition] } : { basis: "none", criteria: [] };
}

/**
 * 找到的 Task。viewerId / responsibleId / canEdit / basis / criteria 是交付物那边一直用的几项（canEdit = 负责人）。
 * ownerId 是负责人（没登记时是 Mission 负责人）；related 是看的人是负责人、Mission 负责人、战场负责人或 CEO 之一。
 */
export type PlanTaskAccess = {
  task: PlanTask; viewerId: string; responsibleId: string | null; canEdit: boolean; basis: TReviewBasis; criteria: string[];
  mission: { id: string; ownerId: string; battlefieldIds: string[] };
  ownerId: string;
  missionOwner: boolean;
  related: boolean;
};

/** 本人 Mission 以外的 Task 要读整个公司当期的 Mission：第一次读本体可能比首页那一组慢，多等一会儿，免得冷启动时报找不到。 */
export const LOCATE_BUDGET_MS = 8_000;

/** 公司当期（没有就是最近一个有 Mission 的月份）全部 Mission，读 Task 用。 */
async function companyMissions(q: Query, now: Date): Promise<PlanTaskMission[]> {
  const rows = (await q(`SELECT id,code,world_scope_id,world_object_id,world_domain_id FROM missions
    WHERE NOT placeholder AND period=(SELECT max(period) FROM missions WHERE period<=$1 AND NOT placeholder) ORDER BY code`, [companyPeriod(now)])).rows as
    { id: string; code: string; world_scope_id: string | null; world_object_id: string | null; world_domain_id: string | null }[];
  return rows.map((m) => ({ id: m.id, code: m.code,
    world: m.world_scope_id && m.world_object_id && m.world_domain_id ? { scopeId: m.world_scope_id, objectId: m.world_object_id, domainId: m.world_domain_id } : null }));
}

/**
 * 第三步，不按月份找（设计 10.3）：本体按 id 读一次这件 Task，按它的父引用找本地对应的 Mission（任意月份，同一对象有几行取月份最新的）。
 * 读不到、超时、父引用对不上本地 Mission 都为 null。
 */
async function taskById(q: Query, planTasks: PlanTaskSource, taskId: string): Promise<PlanTask | null> {
  const found = await readPlanTaskById(planTasks, taskId, LOCATE_BUDGET_MS);
  if (found?.missionId) return { ...found.task, missionId: found.missionId };
  if (!found?.parents.length) return null;
  const mission = (await q(`SELECT id FROM missions WHERE NOT placeholder AND world_object_id=ANY($1::text[]) ORDER BY period DESC, id LIMIT 1`,
    [found.parents])).rows[0] as { id: string } | undefined;
  return mission ? { ...found.task, missionId: mission.id } : null;
}

/**
 * 先在本人的 Mission 里找（和首页同一组，缓存是热的），找不到再在公司当期全部 Mission 里找，再找不到按 id 读本体（taskById，旧月份的 Task 走这一步）。
 * 都找不到抛 404；找到了不判能不能看，related 交给调用方（认可人还要看约定）。
 * 找到了顺手记下这件 Task 在哪个 Mission（plan_task_missions，「看得见的 Mission」用）。
 */
export async function locatePlanTask(q: Query, planTasks: PlanTaskSource, viewer: PlanTaskViewer, now: Date, taskId: string): Promise<PlanTaskAccess> {
  const own = await ownMissions(q, viewer.personId, companyPeriod(now));
  let task = (await readPlanTasks(planTasks, planTaskMissions(own.rows))).find((item) => item.taskId === taskId);
  if (!task) task = (await readPlanTasks(planTasks, await companyMissions(q, now), LOCATE_BUDGET_MS)).find((item) => item.taskId === taskId);
  if (!task) task = await taskById(q, planTasks, taskId) ?? undefined;
  const notFound = () => new DeliverableError(404, "NOT_FOUND", "找不到这个 Task");
  if (!task) throw notFound();
  const mission = (await q("SELECT owner_id, battlefield_ids FROM missions WHERE id=$1", [task.missionId])).rows[0] as { owner_id: string; battlefield_ids: string[] } | undefined;
  if (!mission) throw notFound();
  await q(`INSERT INTO plan_task_missions(task_id,mission_id,seen_at) VALUES($1,$2,$3)
    ON CONFLICT (task_id) DO UPDATE SET mission_id=EXCLUDED.mission_id,seen_at=EXCLUDED.seen_at WHERE plan_task_missions.mission_id<>EXCLUDED.mission_id`,
  [task.taskId, task.missionId, now]);
  const responsibleId = task.responsibleId ?? null;
  const ownerId = responsibleId ?? mission.owner_id;
  const missionOwner = mission.owner_id === viewer.personId;
  const battlefieldOwner = !missionOwner && ownerId !== viewer.personId && !viewer.isCeo && mission.battlefield_ids.length > 0
    && (await q("SELECT 1 FROM battlefield_config WHERE owner_id=$1 AND id=ANY($2::text[]) LIMIT 1", [viewer.personId, mission.battlefield_ids])).rows.length > 0;
  return { task, viewerId: viewer.personId, responsibleId, canEdit: ownerId === viewer.personId, ...taskBasis(task),
    mission: { id: task.missionId, ownerId: mission.owner_id, battlefieldIds: mission.battlefield_ids },
    ownerId, missionOwner, related: ownerId === viewer.personId || missionOwner || battlefieldOwner || viewer.isCeo };
}
