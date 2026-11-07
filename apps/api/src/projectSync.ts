import type { Pool, PoolClient } from "pg";
import type { Query } from "./meetingStore.js";
import { detectGoalChanges } from "./goalChanges.js";
import { createProject, goalsOf, linkGoal, projectScope } from "./projects.js";

/**
 * 首页每次读之前把项目理顺（设计《新首页》16.4、16.5）：
 * 1. 上线迁移（每人一次，project_bootstraps）：按「看得见的 Mission」每张建一个同名项目（同名的 Mission 合成一个），下面本人负责的 Task 都挂上去；
 *    原来按 Task 存的管线对话按时间并进项目对话（天枢自己的对话挪消息、按时间重新编号；Chat 里的段不能合，取最早那段当项目对话，其余记进报告）。
 *    挂接时间取那件 Task 的月初，它的管线更早开过就取第一句的时间，项目对话里的分隔线落在它的第一句前面。
 * 2. 自动挂接：树上还没挂的 Task（本人取下来过的不算），按这个顺序找本人没归档的项目：延续关系里上一件挂的项目 → 之前月份同名、同 Mission 名的那件挂的项目
 *    → 上线迁移时按它所在 Mission 建的项目（迁移时本体没读到、后来才读到的 Task）。都找不到就留给本人在「本月」里选。
 * 敲定生效、从本体载入的 Task 都在下一次读首页时挂上；挂接时间是挂上的那一刻。
 * 3. 月中（16.4）：本月挂上的 Task 改了或取消了，有还没做完的子会话时记一个「停掉 / 留着」的选项框（goalChanges.ts）。
 */

export type SyncMission = { id: string; title: string; period: string };
export type SyncTask = { taskId: string; missionId: string; name: string; criteria?: string[] };

/** 公司时区那个月的 1 号 0 点。 */
const periodStart = (period: string) => new Date(`${period}-01T00:00:00+08:00`);

/**
 * 把这几件 Task 的旧管线并进项目对话。天枢自己的对话：最早那条改成项目的 scope，其余的消息挪过来，全部按时间重新编号（同时刻按原来的先后），挪空的软删；
 * 模型侧的历史（runtime_entries）留最早那条的。Chat 的段（task_pipelines）：最早那段记成项目对话，其余的只记进报告。
 */
async function mergePipelines(client: PoolClient, ownerId: string, projectId: string, taskIds: string[], now: Date) {
  const scopes = taskIds.map((id) => `plan-task:${id}`);
  const own = (await client.query(`SELECT id::text FROM conversations WHERE owner_id=$1 AND scope=ANY($2::text[]) AND deleted_at IS NULL
    ORDER BY created_at,id`, [ownerId, scopes])).rows as { id: string }[];
  if (own.length) {
    const [target, ...rest] = own.map((row) => row.id);
    await client.query("UPDATE conversations SET scope=$2 WHERE id=$1", [target, projectScope(projectId)]);
    if (rest.length) {
      // 先整体挪到 100 万以上避开主键，再按时间编回 1..n。
      for (const [index, id] of [target, ...rest].entries()) await client.query("UPDATE conversation_messages SET conversation_id=$1,sequence=sequence+$3 WHERE conversation_id=$2",
        [target, id, (index + 1) * 1_000_000]);
      await client.query(`UPDATE conversation_messages m SET sequence=r.rn FROM (SELECT sequence,row_number() OVER (ORDER BY created_at,sequence) AS rn
        FROM conversation_messages WHERE conversation_id=$1) r WHERE m.conversation_id=$1 AND m.sequence=r.sequence`, [target]);
      await client.query("UPDATE conversations SET deleted_at=$2 WHERE id=ANY($1::uuid[])", [rest, now]);
    }
  }
  const chat = (await client.query("SELECT conversation_id FROM task_pipelines WHERE owner_id=$1 AND plan_task_id=ANY($2::text[]) ORDER BY created_at,conversation_id",
    [ownerId, taskIds])).rows as { conversation_id: string }[];
  if (chat.length) await client.query("INSERT INTO project_pipelines(project_id,owner_id,conversation_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [projectId, ownerId, chat[0].conversation_id]);
  return { conversations: own.length, chatPipelines: chat.length ? 1 : 0, unmergedChat: chat.slice(1).map((row) => row.conversation_id) };
}

/** 这件 Task 的旧管线第一句（或 Chat 那段登记）的时间，没有为 null。 */
async function firstPipelineAt(client: PoolClient, ownerId: string, taskId: string): Promise<Date | null> {
  const row = (await client.query(`SELECT least((SELECT min(m.created_at) FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.owner_id=$1 AND c.scope=$2 AND c.deleted_at IS NULL),(SELECT min(created_at) FROM task_pipelines WHERE owner_id=$1 AND plan_task_id=$3)) AS at`,
  [ownerId, `plan-task:${taskId}`, taskId])).rows[0] as { at: Date | null };
  return row.at;
}

type Report = { projects: { projectId: string; name: string; missions: string[]; tasks: string[]; conversations: number; chatPipelines: number; unmergedChat: string[] }[] };

/** 上线迁移：本人还没做过才做（同一个人同时两次读首页只做一次）。 */
async function bootstrap(pool: Pool, ownerId: string, missions: SyncMission[], tasks: SyncTask[], now: Date): Promise<void> {
  if ((await pool.query("SELECT 1 FROM project_bootstraps WHERE person_id=$1", [ownerId])).rowCount) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-bootstrap:${ownerId}`]);
    if ((await client.query("SELECT 1 FROM project_bootstraps WHERE person_id=$1", [ownerId])).rowCount) { await client.query("ROLLBACK"); return; }
    const q: Query = client.query.bind(client);
    const linked = await goalsOf(q, ownerId);
    const report: Report = { projects: [] };
    const byName = new Map<string, Report["projects"][number]>();
    for (const mission of missions) {
      const name = mission.title.trim().slice(0, 60) || "未命名项目";
      let entry = byName.get(name);
      if (!entry) {
        const project = await createProject(q, ownerId, name, now, mission.id);
        entry = { projectId: project.id, name, missions: [], tasks: [], conversations: 0, chatPipelines: 0, unmergedChat: [] };
        byName.set(name, entry);
        report.projects.push(entry);
      }
      entry.missions.push(mission.id);
      for (const task of tasks.filter((item) => item.missionId === mission.id && !linked.has(item.taskId))) {
        const first = await firstPipelineAt(client, ownerId, task.taskId);
        const start = periodStart(mission.period);
        await linkGoal(q, { projectId: entry.projectId, ownerId, task, source: "migration", now, linkedAt: first && first < start ? first : start });
        entry.tasks.push(task.taskId);
      }
    }
    for (const entry of report.projects) if (entry.tasks.length) Object.assign(entry, await mergePipelines(client, ownerId, entry.projectId, entry.tasks, now));
    await client.query("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,$2,$3)", [ownerId, now, JSON.stringify(report)]);
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally { client.release(); }
}

/** 一件还没挂的 Task 该挂到哪个项目（本人的、没归档的）；找不到为 null。 */
async function autoProject(q: Query, ownerId: string, task: SyncTask): Promise<string | null> {
  const row = (await q(`SELECT COALESCE(
      (SELECT g.project_id FROM task_continuations c JOIN project_goals g ON g.task_id=c.from_task_id JOIN projects p ON p.id=g.project_id
        WHERE c.to_task_id=$2 AND p.owner_id=$1 AND p.archived_at IS NULL),
      (SELECT g.project_id FROM project_goals g JOIN projects p ON p.id=g.project_id JOIN missions m ON m.id=$3
        WHERE g.task_name=$4 AND g.mission_title=m.title AND g.period<m.period AND p.owner_id=$1 AND p.archived_at IS NULL ORDER BY g.period DESC,g.linked_at DESC LIMIT 1),
      (SELECT p.id FROM projects p WHERE p.origin_mission_id=$3 AND p.owner_id=$1 AND p.archived_at IS NULL ORDER BY p.created_at LIMIT 1)) AS project_id`,
  [ownerId, task.taskId, task.missionId, task.name])).rows[0] as { project_id: string | null };
  return row.project_id;
}

/** 读首页前调：先做上线迁移（没做过的话），再给树上还没挂的 Task 自动挂。 */
export async function syncProjects(pool: Pool, ownerId: string, missions: SyncMission[], tasks: SyncTask[], now: Date): Promise<void> {
  await bootstrap(pool, ownerId, missions, tasks, now);
  const q: Query = pool.query.bind(pool);
  const linked = await goalsOf(q, ownerId);
  for (const task of tasks) {
    if (linked.has(task.taskId)) continue;
    const projectId = await autoProject(q, ownerId, task);
    if (projectId) await linkGoal(q, { projectId, ownerId, task, source: "auto", now });
  }
  await detectGoalChanges(q, ownerId, tasks, now);
}
