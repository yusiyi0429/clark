import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TProject, TProjectDetailResponse, TProjectGoal, TProjectGoalVerdict, TProjectTransfer } from "@warmap/contracts";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { CardError } from "./taskCards.js";
import { settlementsOf } from "./taskContinuity.js";

/**
 * 项目和每月目标（契约 projects.ts，设计《新首页》第 16 节）：项目常驻，本体的 Task 每月挂到一个项目上（project_goals，迁移 245）。
 * 卡、专题、交付版本跟着它的 Task 挂的项目（挂上、移走时一起改 project_id），不挂 Task 的活直接记项目。
 */

export const projectScope = (projectId: string) => `project:${projectId}`;
export const PROJECT_SCOPE_PREFIX = "project:";

/** 一张卡（tasks 的别名 alias）在哪个项目：Task 挂着的项目优先，其次是卡自己记的。 */
export const CARD_PROJECT = (alias: string) =>
  `COALESCE((SELECT g.project_id FROM project_goals g WHERE g.task_id=${alias}.plan_task_id),${alias}.project_id)`;

type ProjectRow = { id: string; owner_id: string; name: string; origin_mission_id: string | null; archived_at: Date | null; created_at: Date; updated_at: Date;
  last_activity_at?: Date | null; permission_mode: TProject["permissionMode"]; auto_relay_limit: number | null; auto_relay_paused_at: Date | null };
type GoalRow = { task_id: string; project_id: string | null; owner_id: string; period: string; mission_id: string; mission_title: string | null; task_name: string;
  source: TProjectGoal["source"]; linked_at: Date };

const iso = (time: Date | null | undefined) => time ? new Date(time).toISOString() : null;
/** transfer：正在转交的那一份，或本人交出去了的那一份（这时本人这边算归档，archivedAt 是接手的时间）。 */
export const projectView = (row: ProjectRow, transfer: TProjectTransfer | null = null): TProject => ({ projectId: row.id, name: row.name,
  archivedAt: transfer?.status === "accepted" ? transfer.decidedAt : iso(row.archived_at), createdAt: iso(row.created_at)!,
  lastActivityAt: iso(row.last_activity_at), transfer, permissionMode: row.permission_mode, autoRelayLimit: row.auto_relay_limit });

/** 最近一次动静：挂接、项目里的卡和事项、专题（建项目本身不算，没有为 null）。 */
const LAST_ACTIVITY = `(SELECT max(at) FROM (
    SELECT g.linked_at AS at FROM project_goals g WHERE g.project_id=p.id
    UNION ALL SELECT t.updated_at FROM tasks t WHERE t.owner_id=p.owner_id AND ${CARD_PROJECT("t")}=p.id
    UNION ALL SELECT r.updated_at FROM research_topics r WHERE r.owner_id=p.owner_id
      AND COALESCE((SELECT g.project_id FROM project_goals g WHERE g.task_id=r.plan_task_id),r.project_id)=p.id) a)`;

/**
 * GET /api/me/projects：本人负责的项目，加本人交出去了的（16.7，算归档、只读）；没归档的在前，各自按最近动静（没有就按建的时间）从近到远。
 * transfers：本人项目正在转交的、本人交出去了的（transfer.ts 的 openTransfers、handedAway 转好的）。
 */
export async function listProjects(q: Query, ownerId: string, transfers: (projectIds: string[]) => Promise<Map<string, TProjectTransfer>>): Promise<TProject[]> {
  const rows = (await q(`SELECT p.*,${LAST_ACTIVITY} AS last_activity_at FROM projects p WHERE p.owner_id=$1
    OR EXISTS (SELECT 1 FROM project_transfers t WHERE t.project_id=p.id AND t.from_id=$1 AND t.status='accepted')`, [ownerId])).rows as ProjectRow[];
  const byProject = await transfers(rows.map((row) => row.id));
  const views = rows.map((row) => projectView(row, byProject.get(row.id) ?? null));
  const at = (view: TProject) => Date.parse(view.lastActivityAt ?? view.createdAt);
  return views.sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || at(b) - at(a) || a.projectId.localeCompare(b.projectId));
}

/**
 * 能看这个项目的：现在的负责人，和交出去之前负责过的人（16.7，只读）。current 是现在的负责人。
 * 不是 uuid、没有、和本人无关都 404。改动（改名、挂接、开对话、发消息）只认 ownProject。
 */
export async function projectReader(q: Query, personId: string, projectId: string): Promise<{ row: ProjectRow; current: boolean }> {
  const row = UUID_PATTERN.test(projectId) ? (await q(`SELECT p.*,${LAST_ACTIVITY} AS last_activity_at FROM projects p WHERE p.id=$1 AND (p.owner_id=$2
    OR EXISTS (SELECT 1 FROM project_transfers t WHERE t.project_id=p.id AND t.from_id=$2 AND t.status='accepted'))`, [projectId, personId])).rows[0] as ProjectRow | undefined
    : undefined;
  if (!row) throw new CardError(404, "NOT_FOUND", "找不到这个项目");
  return { row, current: row.owner_id === personId };
}

/** 负责过这个项目的人（现在的，加交出去之前的）：项目动态读他们的卡。 */
export async function projectOwners(q: Query, projectId: string): Promise<string[]> {
  return ((await q(`SELECT owner_id AS id FROM projects WHERE id=$1 UNION SELECT from_id FROM project_transfers WHERE project_id=$1 AND status='accepted'`,
    [projectId])).rows as { id: string }[]).map((row) => row.id);
}

/** 本人的项目；不是 uuid、没有、不是本人的都 404。 */
export async function ownProject(q: Query, ownerId: string, projectId: string): Promise<ProjectRow> {
  const row = UUID_PATTERN.test(projectId)
    ? (await q(`SELECT p.*,${LAST_ACTIVITY} AS last_activity_at FROM projects p WHERE p.id=$1 AND p.owner_id=$2`, [projectId, ownerId])).rows[0] as ProjectRow | undefined
    : undefined;
  if (!row) throw new CardError(404, "NOT_FOUND", "找不到这个项目");
  return row;
}

export async function createProject(q: Query, ownerId: string, name: string, now: Date, originMissionId: string | null = null): Promise<ProjectRow> {
  return (await q(`INSERT INTO projects(id,owner_id,name,origin_mission_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING *,NULL::timestamptz AS last_activity_at`,
    [randomUUID(), ownerId, name.trim(), originMissionId, now])).rows[0] as ProjectRow;
}

/** PATCH：改名、归档、恢复（只有现在的负责人）。回的项目不带转交（网页按需另读）。 */
export async function updateProject(q: Query, ownerId: string, projectId: string,
  patch: { name?: string; archived?: boolean; permissionMode?: TProject["permissionMode"]; autoRelayLimit?: number | null }, now: Date): Promise<TProject> {
  await ownProject(q, ownerId, projectId);
  // 自动接力的上限（18 节第 12 条）：带了才改；改成不限、或比已经接力的次数大，就恢复自动触发。
  const limit = patch.autoRelayLimit !== undefined;
  await q(`UPDATE projects SET name=COALESCE($3,name),archived_at=CASE WHEN $4::boolean IS NULL THEN archived_at WHEN $4 THEN COALESCE(archived_at,$5) ELSE NULL END,
    permission_mode=COALESCE($6,permission_mode),auto_relay_limit=CASE WHEN $7 THEN $8::int ELSE auto_relay_limit END,
    auto_relay_paused_at=CASE WHEN $7 AND ($8::int IS NULL OR $8::int>auto_relay_count) THEN NULL ELSE auto_relay_paused_at END,
    auto_relay_asked=CASE WHEN $7 AND ($8::int IS NULL OR $8::int>auto_relay_count) THEN false ELSE auto_relay_asked END,
    updated_at=$5 WHERE id=$1 AND owner_id=$2`,
  [projectId, ownerId, patch.name?.trim() ?? null, patch.archived ?? null, now, patch.permissionMode ?? null, limit, limit ? patch.autoRelayLimit : null]);
  return projectView(await ownProject(q, ownerId, projectId));
}

/** 要挂上的一件 Task：本体的 Task（名字、所在 Mission），月份和 Mission 名从本地 Mission 取。 */
export type GoalTask = { taskId: string; missionId: string; name: string };

/**
 * 把一件 Task 挂到项目上（已经挂在别处就移过来）：卡、事项、专题、交付版本跟着改 project_id。调用方先核对项目和 Task 都是本人的。
 * linkedAt 默认是现在（项目对话里的分隔线出在这一刻）；上线迁移传那件 Task 的月初或它的管线第一句的时间。
 */
export async function linkGoal(q: Query, input: { projectId: string; ownerId: string; task: GoalTask; source: TProjectGoal["source"]; now: Date; linkedAt?: Date }):
  Promise<GoalRow> {
  const { task } = input;
  const mission = (await q("SELECT period,title FROM missions WHERE id=$1", [task.missionId])).rows[0] as { period: string; title: string } | undefined;
  const row = (await q(`INSERT INTO project_goals(task_id,project_id,owner_id,period,mission_id,mission_title,task_name,source,linked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (task_id) DO UPDATE SET project_id=EXCLUDED.project_id,owner_id=EXCLUDED.owner_id,period=EXCLUDED.period,mission_id=EXCLUDED.mission_id,
      mission_title=EXCLUDED.mission_title,task_name=EXCLUDED.task_name,source=EXCLUDED.source,
      linked_at=CASE WHEN project_goals.project_id IS NOT DISTINCT FROM EXCLUDED.project_id THEN project_goals.linked_at ELSE EXCLUDED.linked_at END
    RETURNING *`, [task.taskId, input.projectId, input.ownerId, mission?.period ?? companyPeriod(input.now), task.missionId, mission?.title ?? null, task.name,
    input.source, input.linkedAt ?? input.now])).rows[0] as GoalRow;
  await q("UPDATE tasks SET project_id=$2 WHERE plan_task_id=$1 AND owner_id=$3", [task.taskId, input.projectId, input.ownerId]);
  await q("UPDATE research_topics SET project_id=$2 WHERE plan_task_id=$1 AND owner_id=$3", [task.taskId, input.projectId, input.ownerId]);
  await q("UPDATE deliverable_versions SET project_id=$2 WHERE task_id=$1 AND author_id=$3", [task.taskId, input.projectId, input.ownerId]);
  return row;
}

/** 取下来：留一条 project_id 为空的记录，这件不再自动挂，回到「本月」里等本人选。挂的不是这个项目 404。 */
export async function unlinkGoal(q: Query, ownerId: string, projectId: string, taskId: string): Promise<void> {
  await ownProject(q, ownerId, projectId);
  const done = (await q("UPDATE project_goals SET project_id=NULL,source='owner' WHERE task_id=$1 AND project_id=$2", [taskId, projectId])).rowCount;
  if (!done) throw new CardError(404, "NOT_FOUND", "这件 Task 没挂在这个项目上");
}

/** 本人的挂接（含取下来的，project_id 为空）。 */
export async function goalsOf(q: Query, ownerId: string): Promise<Map<string, GoalRow>> {
  const rows = (await q("SELECT * FROM project_goals WHERE owner_id=$1", [ownerId])).rows as GoalRow[];
  return new Map(rows.map((row) => [row.task_id, row]));
}

/** 判定：照 taskContinuity 的了结（确认完成、到此为止、已延续），没了结是 open。 */
export async function verdicts(q: Query, taskIds: string[]): Promise<Map<string, TProjectGoalVerdict>> {
  const settled = await settlementsOf(q, taskIds);
  return new Map(taskIds.map((id) => [id, settled.get(id)?.kind ?? "open"] as const));
}

export const goalView = (row: GoalRow, verdict: TProjectGoalVerdict): TProjectGoal => ({ taskId: row.task_id, taskName: row.task_name, missionId: row.mission_id,
  missionTitle: row.mission_title, period: row.period, verdict, source: row.source, linkedAt: row.linked_at.toISOString() });

/** GET /api/me/projects/:projectId：目标历史，月份从近到远，同一个月按挂上的先后。交出去之前负责过的人也能看（只读）。 */
export async function projectDetail(q: Query, personId: string, projectId: string, now: Date, transfer: (projectId: string) => Promise<TProjectTransfer | null>):
  Promise<TProjectDetailResponse> {
  const { row: project } = await projectReader(q, personId, projectId);
  const rows = (await q("SELECT * FROM project_goals WHERE project_id=$1 ORDER BY period DESC,linked_at,task_id", [project.id])).rows as GoalRow[];
  const verdict = await verdicts(q, rows.map((row) => row.task_id));
  return { project: projectView(project, await transfer(project.id)), period: companyPeriod(now), goals: rows.map((row) => goalView(row, verdict.get(row.task_id)!)) };
}

/** 一个项目挂过的 Task（全部月份）。 */
export async function projectGoalRows(q: Query, projectId: string): Promise<GoalRow[]> {
  return (await q("SELECT * FROM project_goals WHERE project_id=$1 ORDER BY linked_at,task_id", [projectId])).rows as GoalRow[];
}

/** Chat 的页面上下文（pageGuides.ts）：本人的项目名和挂着、没了结的 Task 名；不是本人的为 null。 */
export async function projectPageFacts(q: Query, ownerId: string, projectId: string): Promise<{ name: string; goals: string[] } | null> {
  const project = await ownProject(q, ownerId, projectId).catch(() => null);
  if (!project) return null;
  const rows = (await q("SELECT task_id,task_name FROM project_goals WHERE project_id=$1 ORDER BY period DESC,linked_at", [projectId])).rows as
    { task_id: string; task_name: string }[];
  const settled = await settlementsOf(q, rows.map((row) => row.task_id));
  return { name: project.name, goals: rows.filter((row) => !settled.has(row.task_id)).map((row) => row.task_name) };
}

export type { GoalRow, ProjectRow };
export type ProjectTx = Pool | PoolClient;
