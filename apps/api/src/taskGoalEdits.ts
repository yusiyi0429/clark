import { randomUUID } from "node:crypto";
import type { Query } from "./meetingStore.js";
import { taskBasis } from "./planTaskAccess.js";
import type { PlanTask, PlanTaskSource } from "./planTasks.js";
import { CardError } from "./taskCards.js";

/**
 * 本人就地改的 Task 名字和完成标准（迁移 291，11/19 DRI 根据地，设计稿路 A）：天枢里先生效，天枢不写本体。
 * 在读 Task 的那一个来源（app.ts 建来源只有一处）外面包一层：本体读回来的 Task 套上本人的改动，首页、项目、拆卡、验收员、对表、复盘读到的都是改后的，
 * 已有的「目标改了」（goalChanges.ts）、约定补充按原文对（taskAgreements.ts align）、复盘预评按原文作废（monthReview.ts）都接得上。
 * 本体里带的约定（proof / acceptor）和标准按序号一一对应：标准一增删就按原文重新对上，新加的那条没有约定。
 * 「+ 添一件」（迁移 292）：本人在自己的 Mission 下新建的 Task 也从这一层出来（天枢自己的 id，added），所以能挂项目、拆卡、进复盘；它没有本体原文，改它就直接改它。
 */

type EditRow = { task_id: string; name: string | null; criteria: string[] | null };
/** 套上改动的 Task 带着这一样：本体里的原名字、原标准（按 taskBasis 算的那份），和哪一样改过。 */
export type TaskGoalEdit = { worldName: string; worldCriteria: string[]; name: boolean; criteria: boolean };
export type EditedPlanTask = PlanTask & { edit?: TaskGoalEdit; added?: boolean };
type AddedRow = { task_id: string; mission_id: string; owner_id: string; name: string; criteria: string[]; world_object_id: string | null };

/** 天枢里新加的 Task：负责人是加它的人，没有完成定义。 */
const addedTask = (row: AddedRow): EditedPlanTask => ({ taskId: row.task_id, missionId: row.mission_id, name: row.name, doneDefinition: null, criteria: row.criteria,
  responsibleId: row.owner_id, added: true });
const ADDED = "SELECT a.task_id,a.mission_id,a.owner_id,a.name,a.criteria,m.world_object_id FROM added_tasks a JOIN missions m ON m.id=a.mission_id";

async function editsOf(q: Query, taskIds: string[]): Promise<Map<string, EditRow>> {
  if (!taskIds.length) return new Map();
  const rows = (await q("SELECT task_id,name,criteria FROM task_goal_edits WHERE task_id=ANY($1::text[])", [taskIds])).rows as EditRow[];
  return new Map(rows.map((row) => [row.task_id, row]));
}

function apply<T extends Omit<PlanTask, "missionId">>(task: T, edit: EditRow | undefined): T & { edit?: TaskGoalEdit } {
  if (!edit) return task;
  const worldCriteria = taskBasis({ ...task, missionId: "" }).criteria;
  const criteria = edit.criteria ?? task.criteria;
  const realign = <V>(values: V[]) => criteria.map((text) => { const at = worldCriteria.indexOf(text); return at >= 0 ? values[at] ?? null : null; });
  const agreement = task.agreement && edit.criteria
    ? { ...task.agreement, proofs: realign(task.agreement.proofs), acceptorIds: realign(task.agreement.acceptorIds) } : task.agreement;
  return { ...task, name: edit.name ?? task.name, criteria, ...(agreement ? { agreement } : {}),
    edit: { worldName: task.name, worldCriteria, name: edit.name !== null, criteria: edit.criteria !== null } };
}

/** 读 Task 的来源外面包一层：套上本人的改动（按 id 读一件也套），补上这几个 Mission 下天枢里新加的。 */
export function withTaskGoalEdits(q: Query, source: PlanTaskSource): PlanTaskSource {
  const wrapped: PlanTaskSource = async (missions) => {
    const [tasks, added] = await Promise.all([source(missions), missions.length
      ? q(`${ADDED} WHERE a.mission_id=ANY($1::text[]) ORDER BY a.created_at,a.task_id`, [missions.map((mission) => mission.id)]) : Promise.resolve({ rows: [] })]);
    const edits = await editsOf(q, tasks.map((task) => task.taskId));
    return [...tasks.map((task) => apply(task, edits.get(task.taskId))), ...(added.rows as AddedRow[]).map(addedTask)];
  };
  // 按 id 读一件（跨月找 Task）：天枢里新加的从这里读（父引用是它所在 Mission 的本体对象），其余问本体再套上改动。
  wrapped.byId = async (taskId) => {
    const row = (await q(`${ADDED} WHERE a.task_id=$1`, [taskId])).rows[0] as AddedRow | undefined;
    if (row) { const { missionId: _missionId, ...task } = addedTask(row); return { parents: row.world_object_id ? [row.world_object_id] : [], task }; }
    const found = source.byId ? await source.byId(taskId) : null;
    return found ? { ...found, task: apply(found.task, (await editsOf(q, [taskId])).get(taskId)) } : null;
  };
  return wrapped;
}

/**
 * POST /api/me/months/:period/tasks：本人在自己这个月的 Mission 下添一件（天枢里的 Task，不写本体）。
 * 没有这个 Mission（或不是这个月的）404，不是本人的 Mission 403，名字空 400。
 */
export async function addTask(q: Query, personId: string, period: string, body: { missionId: string; name: string }, now: Date): Promise<{ taskId: string }> {
  const mission = (await q("SELECT owner_id FROM missions WHERE id=$1 AND period=$2 AND NOT placeholder", [body.missionId, period])).rows[0] as { owner_id: string } | undefined;
  if (!mission) throw new CardError(404, "NOT_FOUND", "这个月没有这个 Mission");
  if (mission.owner_id !== personId) throw new CardError(403, "FORBIDDEN", "只能在自己的 Mission 下添");
  const name = body.name.trim();
  if (!name) throw new CardError(400, "INVALID_INPUT", "名字不能空");
  const taskId = `ts-${randomUUID()}`;
  await q("INSERT INTO added_tasks(task_id,mission_id,owner_id,name,created_at) VALUES($1,$2,$3,$4,$5)", [taskId, body.missionId, personId, name, now]);
  return { taskId };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((text, index) => text === b[index]);

/**
 * PUT /api/me/tasks/:taskId/goal：存本人的改动（task 是套过改动的那件，调用方先核对是负责人）。
 * 没带的那一样照旧；名字、标准和本体一样就撤掉那一样，两样都和本体一样整条撤掉（「恢复」就是把原文存回去）。名字空、标准里有空的 400。
 */
export async function setTaskGoal(q: Query, task: EditedPlanTask, body: { name?: string; criteria?: string[] }, by: string, now: Date):
  Promise<{ taskId: string; name: string; criteria: string[] }> {
  if (task.added) return setAddedTask(q, task, body);
  const worldName = task.edit?.worldName ?? task.name;
  const worldCriteria = task.edit?.worldCriteria ?? taskBasis(task).criteria;
  const name = body.name === undefined ? (task.edit?.name ? task.name : null) : body.name.trim();
  if (name === "") throw new CardError(400, "INVALID_INPUT", "名字不能空");
  const criteria = body.criteria === undefined ? (task.edit?.criteria ? task.criteria : null) : body.criteria.map((text) => text.trim());
  if (criteria?.some((text) => !text)) throw new CardError(400, "INVALID_INPUT", "完成标准不能有空的");
  const nextName = name === null || name === worldName ? null : name;
  const nextCriteria = criteria === null || same(criteria, worldCriteria) ? null : criteria;
  if (nextName === null && nextCriteria === null) await q("DELETE FROM task_goal_edits WHERE task_id=$1", [task.taskId]);
  else await q(`INSERT INTO task_goal_edits(task_id,name,criteria,world_name,world_criteria,edited_by,edited_at) VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7)
    ON CONFLICT (task_id) DO UPDATE SET name=EXCLUDED.name,criteria=EXCLUDED.criteria,world_name=EXCLUDED.world_name,world_criteria=EXCLUDED.world_criteria,
      edited_by=EXCLUDED.edited_by,edited_at=EXCLUDED.edited_at`,
  [task.taskId, nextName, nextCriteria && JSON.stringify(nextCriteria), worldName, JSON.stringify(worldCriteria), by, now]);
  return { taskId: task.taskId, name: nextName ?? worldName, criteria: nextCriteria ?? worldCriteria };
}

/** 天枢里新加的那件：没有本体原文，名字、标准直接改它自己。 */
async function setAddedTask(q: Query, task: EditedPlanTask, body: { name?: string; criteria?: string[] }): Promise<{ taskId: string; name: string; criteria: string[] }> {
  const name = body.name === undefined ? task.name : body.name.trim();
  if (!name) throw new CardError(400, "INVALID_INPUT", "名字不能空");
  const criteria = body.criteria === undefined ? task.criteria : body.criteria.map((text) => text.trim());
  if (criteria.some((text) => !text)) throw new CardError(400, "INVALID_INPUT", "完成标准不能有空的");
  await q("UPDATE added_tasks SET name=$2,criteria=$3::jsonb WHERE task_id=$1", [task.taskId, name, JSON.stringify(criteria)]);
  return { taskId: task.taskId, name, criteria };
}
