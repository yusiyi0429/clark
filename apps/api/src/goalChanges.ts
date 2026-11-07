import { randomUUID } from "node:crypto";
import type { TProjectGoalChangedItem } from "@warmap/contracts";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { ownProject } from "./projects.js";
import { cancelStart } from "./sessionStarts.js";
import { CardError } from "./taskCards.js";

/**
 * 新首页 16.4 月中（契约 projects.ts 的 ProjectGoalChangedItem，迁移 248）：本月挂在项目上的 Task 在本体里改了（名字或验收标准）或取消了，项目不动；
 * 项目里和它有关、还没做完的子会话（挂这件 Task 的、没完成没退回的卡和还开着的专题）还在时，记一个选项框「停掉 / 留着」。
 * 首页每次读、理顺项目时查（projectSync.ts）。
 */

type ChangeRow = { id: string; project_id: string; owner_id: string; task_id: string; task_name: string; change: "changed" | "cancelled";
  sessions: TProjectGoalChangedItem["sessions"]; detected_at: Date; answer: "stop" | "keep" | null; answered_at: Date | null };
type GoalRow = { task_id: string; project_id: string; mission_id: string; task_name: string; criteria: string[] | null };
export type ChangeTask = { taskId: string; missionId: string; name: string; criteria?: string[] };

export const changeView = (row: ChangeRow): TProjectGoalChangedItem => ({ kind: "goal_changed", id: row.id, at: row.detected_at.toISOString(), taskId: row.task_id,
  taskName: row.task_name, change: row.change, sessions: row.sessions, answer: row.answer, answeredAt: row.answered_at?.toISOString() ?? null });

/** 这件 Task 下本人还没做完的卡和还开着的专题。 */
async function openSessions(q: Query, ownerId: string, taskId: string): Promise<TProjectGoalChangedItem["sessions"]> {
  return (await q(`SELECT 'card' AS kind,id::text,title FROM tasks WHERE plan_task_id=$1 AND owner_id=$2 AND status NOT IN ('done','returned')
    UNION ALL SELECT 'topic',id::text,title FROM research_topics WHERE plan_task_id=$1 AND owner_id=$2 AND status='active'`, [taskId, ownerId])).rows as
    TProjectGoalChangedItem["sessions"];
}

/**
 * 对照本体这次读到的 Task（tasks，本人负责的）查本月挂在项目上的：
 * - 改了：名字或验收标准和快照不一样（快照还没记过的先记下，不算改动），快照换成新的；
 * - 取消了：这次没读到它，而同一个 Mission 别的 Task 读到了（整个 Mission 都没读到时可能是本体没读出来，不算）。取消只记一次。
 * 有还没做完的子会话才记选项框。
 */
export async function detectGoalChanges(q: Query, ownerId: string, tasks: ChangeTask[], now: Date): Promise<void> {
  const goals = (await q("SELECT task_id,project_id::text,mission_id,task_name,criteria FROM project_goals WHERE owner_id=$1 AND period=$2 AND project_id IS NOT NULL",
    [ownerId, companyPeriod(now)])).rows as GoalRow[];
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const missions = new Set(tasks.map((task) => task.missionId));
  const raise = async (goal: GoalRow, change: "changed" | "cancelled", name: string) => {
    const sessions = await openSessions(q, ownerId, goal.task_id);
    if (!sessions.length) return;
    await q(`INSERT INTO project_goal_changes(id,project_id,owner_id,task_id,task_name,change,sessions,detected_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      ON CONFLICT DO NOTHING`, [randomUUID(), goal.project_id, ownerId, goal.task_id, name, change, JSON.stringify(sessions), now]);
  };
  for (const goal of goals) {
    const task = byId.get(goal.task_id);
    if (!task) {
      if (missions.has(goal.mission_id)) await raise(goal, "cancelled", goal.task_name);
      continue;
    }
    const criteria = task.criteria ?? [];
    if (goal.criteria === null || (task.name === goal.task_name && JSON.stringify(criteria) === JSON.stringify(goal.criteria))) {
      if (goal.criteria === null) await q("UPDATE project_goals SET criteria=$2::jsonb WHERE task_id=$1", [goal.task_id, JSON.stringify(criteria)]);
      continue;
    }
    await q("UPDATE project_goals SET task_name=$2,criteria=$3::jsonb WHERE task_id=$1", [goal.task_id, task.name, JSON.stringify(criteria)]);
    await raise(goal, "changed", task.name);
  }
}

/** 项目动态里的选项框，从旧到新。 */
export async function goalChangeItems(q: Query, projectId: string): Promise<TProjectGoalChangedItem[]> {
  return ((await q("SELECT * FROM project_goal_changes WHERE project_id=$1 ORDER BY detected_at,id", [projectId])).rows as ChangeRow[]).map(changeView);
}

/** 本人这几个项目里还没答的（等你）。 */
export async function openGoalChanges(q: Query, ownerId: string, projectIds: string[]): Promise<(TProjectGoalChangedItem & { projectId: string })[]> {
  if (!projectIds.length) return [];
  return ((await q("SELECT * FROM project_goal_changes WHERE owner_id=$1 AND answer IS NULL AND project_id=ANY($2::uuid[]) ORDER BY detected_at,id",
    [ownerId, projectIds])).rows as ChangeRow[]).map((row) => ({ ...changeView(row), projectId: row.project_id }));
}

/** POST /api/me/projects/:projectId/goal-changes/:id：项目负责人答一次。停掉：还没有电脑接下的开工登记了结掉（在跑的由网页在本机停）。 */
export async function answerGoalChange(q: Query, ownerId: string, projectId: string, id: string, answer: "stop" | "keep", now: Date): Promise<TProjectGoalChangedItem> {
  const project = await ownProject(q, ownerId, projectId);
  const row = UUID_PATTERN.test(id) ? (await q("SELECT * FROM project_goal_changes WHERE id=$1 AND project_id=$2", [id, project.id])).rows[0] as ChangeRow | undefined
    : undefined;
  if (!row) throw new CardError(404, "NOT_FOUND", "找不到这个选项框");
  const updated = (await q("UPDATE project_goal_changes SET answer=$2,answered_at=$3 WHERE id=$1 AND answer IS NULL RETURNING *", [id, answer, now])).rows[0] as
    ChangeRow | undefined;
  if (!updated) throw new CardError(409, "ALREADY_ANSWERED", "已经答过了");
  if (answer === "stop") for (const session of row.sessions) await cancelStart(q, ownerId, session.kind, session.id, now);
  return changeView(updated);
}
