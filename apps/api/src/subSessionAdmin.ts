import type { Pool } from "pg";
import type { TArchivedSubSession, TSubSessionKind, TUpdateSubSessionRequest } from "@warmap/contracts";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { ownProject } from "./projects.js";
import { lettersFor } from "./subSessionLetters.js";
import { CardError } from "./taskCards.js";
import { ACTIVE } from "./workers.js";

/**
 * 项目和子会话那一行的「…」菜单（17.2 第 35 条，契约 workHome.ts 的 UpdateSubSessionRequest、projects.ts 的项目删除）。
 * 子会话是带岗位或交给 Claude Code 的卡（tasks）和专题（research_topics）；删除同伙伴的 delete_sub_session，进回收站（trashed_at），30 天后真删。
 */

const SUB_CARD = "(role_id IS NOT NULL OR executor='claude_code')";
const table = (kind: TSubSessionKind) => (kind === "card" ? "tasks" : "research_topics");
const runColumn = (kind: TSubSessionKind) => (kind === "card" ? "task_id" : "topic_id");

type SubRow = { title: string; archived: boolean };
/** 本人的、不在回收站里的子会话；不是本人的、没有的 404。 */
async function ownSub(q: Query, ownerId: string, kind: TSubSessionKind, id: string): Promise<SubRow> {
  const row = !UUID_PATTERN.test(id) ? undefined : (await q(kind === "card"
    ? `SELECT title,archived_at IS NOT NULL AS archived FROM tasks WHERE id=$1 AND owner_id=$2 AND trashed_at IS NULL AND ${SUB_CARD}`
    : "SELECT title,status='archived' AS archived FROM research_topics WHERE id=$1 AND owner_id=$2 AND trashed_at IS NULL", [id, ownerId])).rows[0] as SubRow | undefined;
  if (!row) throw new CardError(404, "NOT_FOUND", "没有这个子会话");
  return row;
}

/** 最近一次本机执行还在跑（含排队、停着等回话）。 */
async function running(q: Query, kind: TSubSessionKind, id: string): Promise<boolean> {
  const row = (await q(`SELECT state FROM local_runs WHERE ${runColumn(kind)}=$1 ORDER BY started_at DESC,id LIMIT 1`, [id])).rows[0] as { state: string } | undefined;
  return Boolean(row && ACTIVE.has(row.state));
}
const closeStarts = (q: Query, kind: TSubSessionKind, ids: string[], now: Date) =>
  q(`UPDATE session_starts SET closed_at=$2 WHERE ${kind === "card" ? "card_id" : "topic_id"}=ANY($1::uuid[]) AND closed_at IS NULL`, [ids, now]);

export async function updateSubSession(q: Query, ownerId: string, kind: TSubSessionKind, id: string, input: TUpdateSubSessionRequest, now: Date): Promise<void> {
  const sub = await ownSub(q, ownerId, kind, id);
  const title = input.title?.trim();
  if (input.title !== undefined && !title) throw new CardError(400, "INVALID_TITLE", "名字不能为空");
  if (title && kind === "topic" && title.length > 60) throw new CardError(400, "TITLE_TOO_LONG", "专题的名字最长 60 字");
  if (input.archived && !sub.archived) {
    if (await running(q, kind, id)) throw new CardError(409, "SUB_SESSION_RUNNING", `「${sub.title}」还在跑，先停掉再归档`);
    await closeStarts(q, kind, [id], now);
  }
  const archived = input.archived === undefined ? null : input.archived;
  if (kind === "card")
    await q(`UPDATE tasks SET title=COALESCE($2,title),archived_at=CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN COALESCE(archived_at,$4) ELSE NULL END,
      updated_at=$4 WHERE id=$1`, [id, title ?? null, archived, now]);
  else
    await q(`UPDATE research_topics SET title=COALESCE($2,title),status=CASE WHEN $3::boolean IS NULL THEN status WHEN $3 THEN 'archived' ELSE 'active' END,
      updated_at=$4 WHERE id=$1`, [id, title ?? null, archived, now]);
}

export async function deleteSubSession(q: Query, ownerId: string, kind: TSubSessionKind, id: string, now: Date): Promise<void> {
  const sub = await ownSub(q, ownerId, kind, id);
  if (await running(q, kind, id)) throw new CardError(409, "SUB_SESSION_RUNNING", `「${sub.title}」还在跑，先停掉再删`);
  await q(`UPDATE ${table(kind)} SET trashed_at=$2 WHERE id=$1`, [id, now]);
  await closeStarts(q, kind, [id], now);
}

/** 归档了的子会话，新归档的在前（专题没有单独的归档时间，用最后改动的时间）。 */
export async function listArchivedSubSessions(q: Query, ownerId: string): Promise<TArchivedSubSession[]> {
  // 所在项目同首页（subSessionLetters.ts 的 subProject）：挂着的 Task 在哪个项目，没挂 Task 的看自己的 project_id。
  const rows = (await q(`SELECT 'card' AS kind,t.id::text,t.title,p.id::text AS project_id,p.name AS project_name,t.archived_at AS at FROM tasks t
      LEFT JOIN project_goals g ON g.task_id=t.plan_task_id AND g.owner_id=t.owner_id LEFT JOIN projects p ON p.id=COALESCE(g.project_id,t.project_id)
      WHERE t.owner_id=$1 AND t.archived_at IS NOT NULL AND t.trashed_at IS NULL AND (t.role_id IS NOT NULL OR t.executor='claude_code')
    UNION ALL SELECT 'topic',r.id::text,r.title,p.id::text,p.name,r.updated_at FROM research_topics r
      LEFT JOIN project_goals g ON g.task_id=r.plan_task_id AND g.owner_id=r.owner_id LEFT JOIN projects p ON p.id=COALESCE(g.project_id,r.project_id)
      WHERE r.owner_id=$1 AND r.status='archived' AND r.trashed_at IS NULL
    ORDER BY at DESC,id`, [ownerId])).rows as { kind: TSubSessionKind; id: string; title: string; project_id: string | null; project_name: string | null; at: Date }[];
  const letters = await lettersFor(q, rows.flatMap((row) => (row.project_id ? [{ projectId: row.project_id, kind: row.kind, id: row.id }] : [])));
  return rows.map((row) => ({ kind: row.kind, id: row.id, title: row.title, letter: letters.get(`${row.kind}:${row.id}`) ?? null, projectId: row.project_id,
    projectName: row.project_name, archivedAt: row.at.toISOString() }));
}

/**
 * 删掉项目（撤不回，见契约）：只有负责人；有子会话或规划员在跑 409 PROJECT_BUSY，正在转交 409 PROJECT_TRANSFERRING，都不删任何东西。
 * 直接放在项目里的子会话（project_id 是它）进回收站；挂着的 Task 照「取下来」处理（不再自动挂回别的项目），Task 下面的卡、专题跟着 Task 留下；
 * 自己做的事项、交付物版本靠外键置空留下；其余靠外键一起删掉。
 */
export async function deleteProject(pool: Pool, ownerId: string, projectId: string, now: Date): Promise<void> {
  const q: Query = pool.query.bind(pool);
  await ownProject(q, ownerId, projectId);
  if ((await q("SELECT 1 FROM project_transfers WHERE project_id=$1 AND status IN ('preparing','sent')", [projectId])).rowCount)
    throw new CardError(409, "PROJECT_TRANSFERRING", "这个项目正在转交，先撤回转交再删");
  const cards = (await q(`SELECT id::text,title FROM tasks WHERE project_id=$1 AND trashed_at IS NULL AND ${SUB_CARD}`, [projectId])).rows as { id: string; title: string }[];
  const topics = (await q("SELECT id::text,title FROM research_topics WHERE project_id=$1 AND trashed_at IS NULL", [projectId])).rows as { id: string; title: string }[];
  const busy: { kind: TSubSessionKind; id: string; title: string }[] = [];
  for (const [kind, rows] of [["card", cards], ["topic", topics]] as const)
    for (const row of rows) if (await running(q, kind, row.id)) busy.push({ kind, ...row });
  const planning = (await q("SELECT state FROM local_runs WHERE kind='plan' AND project_id=$1", [projectId])).rows.some((row) => ACTIVE.has(row.state as string));
  if (busy.length || planning) {
    const letters = await lettersFor(q, busy.map((sub) => ({ projectId, kind: sub.kind, id: sub.id })));
    const names = [...busy.map((sub) => { const letter = letters.get(`${sub.kind}:${sub.id}`); return letter ? `${letter} · ${sub.title}` : sub.title; }),
      ...(planning ? ["规划员（在拆卡）"] : [])];
    throw new CardError(409, "PROJECT_BUSY", `还有在跑的：${names.join("、")}，先停掉再删`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE tasks SET trashed_at=$2 WHERE project_id=$1 AND trashed_at IS NULL AND ${SUB_CARD}`, [projectId, now]);
    await client.query("UPDATE research_topics SET trashed_at=$2 WHERE project_id=$1 AND trashed_at IS NULL", [projectId, now]);
    const run = client.query.bind(client) as Query;
    await closeStarts(run, "card", cards.map((row) => row.id), now);
    await closeStarts(run, "topic", topics.map((row) => row.id), now);
    await client.query("UPDATE project_goals SET project_id=NULL,source='owner' WHERE project_id=$1", [projectId]);
    await client.query("UPDATE conversations SET deleted_at=$2 WHERE scope=$1 AND deleted_at IS NULL", [`project:${projectId}`, now]);
    await client.query("DELETE FROM work_seen WHERE kind='project' AND object_id=$1", [projectId]);
    await client.query("DELETE FROM projects WHERE id=$1", [projectId]);
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally { client.release(); }
}
