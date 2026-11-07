import type { Pool, PoolClient } from "pg";
import type { TContinueTaskResponse, TTaskRef, TTaskSettlement } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import type { PlanTaskAccess } from "./planTaskAccess.js";
import { CardError } from "./taskCards.js";
import { pipelineScope } from "./taskPipelines.js";
import { renumberMission } from "./tasks.js";

/**
 * 跨月延续与了结（契约 taskContinuity.ts，设计《新首页》第 10 节）。天枢自己的对照和标记，不写本体。
 * 了结只有三种：本人确认完成（最新一版交付物交付了，之后没开返工卡）、到此为止（task_stops）、已延续（task_continuations）。
 */

/** 延续从哪来：Co-Agent 终版里带的「接着哪件」、本体里带的关系、本人定的。 */
export type ContinuationSource = "coagent" | "world" | "owner";

type RefRow = { task_id: string; name: string; mission_id: string; period: string | null };
const refOf = (row: RefRow): TTaskRef => ({ taskId: row.task_id, name: row.name, missionId: row.mission_id, period: row.period });

/**
 * 这几件 Task 怎么了结的（给 B 的 work-home、月份页）；没了结的不在表里。
 * 一件同时有几种时：已延续 > 确认完成 > 到此为止。确认完成的口径和 workHome 的 completedTimes 一样，by 是那一版的作者。
 */
export async function settlementsOf(q: Query, taskIds: string[]): Promise<Map<string, TTaskSettlement>> {
  const result = new Map<string, TTaskSettlement>();
  if (!taskIds.length) return result;
  const [stopped, completed, continued] = await Promise.all([
    q("SELECT task_id,decided_by,decided_at,note FROM task_stops WHERE task_id=ANY($1::text[])", [taskIds]),
    q(`SELECT v.task_id,v.delivered_at,v.author_id FROM (SELECT DISTINCT ON (task_id) task_id,delivered_at,author_id FROM deliverable_versions
        WHERE task_id=ANY($1::text[]) ORDER BY task_id,number DESC) v
      WHERE v.delivered_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.plan_task_id=v.task_id AND t.rework_of_card_id IS NOT NULL AND t.created_at>v.delivered_at)`, [taskIds]),
    q(`SELECT c.from_task_id,c.decided_by,c.decided_at,c.to_task_id AS task_id,c.to_task_name AS name,c.to_mission_id AS mission_id,m.period
      FROM task_continuations c LEFT JOIN missions m ON m.id=c.to_mission_id WHERE c.from_task_id=ANY($1::text[])`, [taskIds]),
  ]);
  for (const row of stopped.rows as { task_id: string; decided_by: string; decided_at: Date; note: string | null }[])
    result.set(row.task_id, { kind: "stopped", at: row.decided_at.toISOString(), by: row.decided_by, note: row.note, to: null });
  for (const row of completed.rows as { task_id: string; delivered_at: Date; author_id: string }[])
    result.set(row.task_id, { kind: "completed", at: row.delivered_at.toISOString(), by: row.author_id, note: null, to: null });
  for (const row of continued.rows as (RefRow & { from_task_id: string; decided_by: string | null; decided_at: Date })[])
    result.set(row.from_task_id, { kind: "continued", at: row.decided_at.toISOString(), by: row.decided_by, note: null, to: refOf(row) });
  return result;
}

/** 这几件 Task 是从哪件延续来的（月份页的「延续自 11 月的 X」）。 */
export async function continuedFrom(q: Query, taskIds: string[]): Promise<Map<string, TTaskRef>> {
  if (!taskIds.length) return new Map();
  const rows = (await q(`SELECT c.to_task_id,c.from_task_id AS task_id,c.from_task_name AS name,c.from_mission_id AS mission_id,m.period
    FROM task_continuations c LEFT JOIN missions m ON m.id=c.from_mission_id WHERE c.to_task_id=ANY($1::text[]) ORDER BY c.decided_at`, [taskIds])).rows as
    (RefRow & { to_task_id: string })[];
  return new Map(rows.map((row) => [row.to_task_id, refOf(row)]));
}

/** 顺着延续往下找，最后接到的那件（规划员还按旧 Task 报派活单时用）；没延续出去就是它自己。 */
export async function latestSuccessor(q: Query, taskId: string): Promise<string> {
  let current = taskId;
  // 延续不会成环（接的那件延续出去了就不能再接，见 continueTask），这里再兜一个上限。
  for (let hop = 0; hop < 24; hop++) {
    const next = (await q("SELECT to_task_id FROM task_continuations WHERE from_task_id=$1", [current])).rows[0] as { to_task_id: string } | undefined;
    if (!next) return current;
    current = next.to_task_id;
  }
  return current;
}

const lockTask = (client: PoolClient, taskId: string) => client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-continuity:${taskId}`]);

/**
 * 写一条延续：旧 Task（from）→ 新 Task（to），一个事务，可以重复调（第二次起什么都不挪，moved 全是 0）。调用方先核对两件都是本人负责的。
 * - 没做完的卡和事项（不含已完成、已退回的）、还开着的专题、还没进版本的待交付条目、没关的拆卡登记、要开工还没了结的登记、规划员的会话和它出的计划、
 *   还没处理的派活单草稿，改挂到新 Task（卡、专题、拆卡登记、计划连 Mission 一起换）。卡对的那条标准按原文在新 Task 的标准里重新找序号，找不到算「其他」。
 * - 新 Task 的管线接着用旧管线那段对话（Chat 的 task_pipelines、没接 Chat 时 scope 为 plan-task 的对话）；新 Task 已经开过管线的不动。
 * - 旧 Task 的约定（11 月的补充）复制一份给新 Task 当草稿（draft_from）；新 Task 已经有的不复制。
 * - 做完的卡、交付版本留在旧 Task 上（那是这个月的成绩）。旧 Task 定过到此为止的，以这次为准，撤掉。
 * 旧 Task 已经延续到别的 Task 了 409 ALREADY_CONTINUED；新 Task 自己已经延续出去了 409 TARGET_CONTINUED。
 */
export async function continueTask(pool: Pool, input: { from: PlanTaskAccess; to: PlanTaskAccess; source: ContinuationSource; decidedBy: string | null; now: Date }):
  Promise<TContinueTaskResponse> {
  const { from, to, now } = input;
  const fromId = from.task.taskId, toId = to.task.taskId, toMission = to.task.missionId;
  if (fromId === toId) throw new CardError(400, "INVALID_INPUT", "不能延续到同一件 Task");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const id of [fromId, toId].sort()) await lockTask(client, id);
    const existing = (await client.query("SELECT to_task_id FROM task_continuations WHERE from_task_id=$1", [fromId])).rows[0] as { to_task_id: string } | undefined;
    if (existing && existing.to_task_id !== toId) throw new CardError(409, "ALREADY_CONTINUED", "这件 Task 已经延续到别的 Task 了");
    if ((await client.query("SELECT 1 FROM task_continuations WHERE from_task_id=$1", [toId])).rowCount)
      throw new CardError(409, "TARGET_CONTINUED", "要接着做的那件 Task 已经延续出去了");
    await client.query("DELETE FROM task_stops WHERE task_id=$1", [fromId]);
    await client.query(`INSERT INTO task_continuations(from_task_id,to_task_id,source,decided_by,decided_at,from_mission_id,from_task_name,to_mission_id,to_task_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (from_task_id) DO NOTHING`,
    [fromId, toId, input.source, input.decidedBy, now, from.task.missionId, from.task.name, toMission, to.task.name]);

    // 挪走的事项排到新 Mission 最后（和建事项时一样先锁这个 Mission 的步骤号），原来所在的 Mission 也重排一次。
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-mission:${toMission}`]);
    const cards = await client.query(`WITH moved AS (SELECT id,mission_id FROM tasks WHERE plan_task_id=$1 AND status NOT IN ('done','returned') FOR UPDATE)
      UPDATE tasks t SET plan_task_id=$2,mission_id=$3,step_order=(SELECT COALESCE(max(step_order),0)+1 FROM tasks WHERE mission_id=$3),
        criterion_index=array_position($4::text[],t.criterion_text),
        criterion_text=CASE WHEN array_position($4::text[],t.criterion_text) IS NULL THEN NULL ELSE t.criterion_text END,
        version=t.version+1,updated_at=$5
      FROM moved WHERE t.id=moved.id RETURNING moved.mission_id AS old_mission`, [fromId, toId, toMission, to.criteria, now]);
    const touchedMissions = (cards.rows as { old_mission: string | null }[]).flatMap((row) => row.old_mission ? [row.old_mission] : []);
    if (cards.rowCount) for (const mission of new Set([...touchedMissions, toMission])) await renumberMission(client, mission);
    const topics = await client.query("UPDATE research_topics SET plan_task_id=$2,mission_id=$3,updated_at=$4 WHERE plan_task_id=$1 AND status='active'",
      [fromId, toId, toMission, now]);
    const pending = await client.query("UPDATE deliverable_pending_items SET plan_task_id=$2 WHERE plan_task_id=$1 AND version_id IS NULL", [fromId, toId]);
    // 同一个人在新 Task 上已经有没关的拆卡登记：旧的关掉，不重复。
    await client.query(`UPDATE card_split_requests s SET closed_at=$3 WHERE s.plan_task_id=$1 AND s.closed_at IS NULL
      AND EXISTS (SELECT 1 FROM card_split_requests o WHERE o.owner_id=s.owner_id AND o.plan_task_id=$2 AND o.closed_at IS NULL)`, [fromId, toId, now]);
    const splits = await client.query("UPDATE card_split_requests SET plan_task_id=$2,mission_id=$3,task_name=$4 WHERE plan_task_id=$1 AND closed_at IS NULL",
      [fromId, toId, toMission, to.task.name]);
    await client.query("UPDATE session_starts SET plan_task_id=$2 WHERE plan_task_id=$1 AND closed_at IS NULL", [fromId, toId]);
    const planners = await client.query("UPDATE local_runs SET plan_task_id=$2 WHERE kind='plan' AND plan_task_id=$1", [fromId, toId]);
    const drafts = await client.query("UPDATE card_drafts SET plan_task_id=$2 WHERE plan_task_id=$1 AND status='open' RETURNING plan_id", [fromId, toId]);
    // 计划跟着走：有没处理的草稿的、规划员会话已经挪过去的、还在排队或在拆的（新 Task 上已经有在拆的就不挪，同一个 Task 同时只拆一次）。
    await client.query(`UPDATE card_plans p SET plan_task_id=$2,mission_id=$3 WHERE p.plan_task_id=$1
      AND (p.id=ANY($4::uuid[]) OR p.run_id IN (SELECT id FROM local_runs WHERE kind='plan' AND plan_task_id=$2) OR p.status IN ('queued','running'))
      AND NOT (p.status IN ('queued','running') AND EXISTS (SELECT 1 FROM card_plans o WHERE o.plan_task_id=$2 AND o.status IN ('queued','running')))`,
    [fromId, toId, toMission, [...new Set((drafts.rows as { plan_id: string }[]).map((row) => row.plan_id))]]);

    const chatPipeline = await client.query(`UPDATE task_pipelines p SET plan_task_id=$2 WHERE p.plan_task_id=$1
      AND NOT EXISTS (SELECT 1 FROM task_pipelines o WHERE o.owner_id=p.owner_id AND o.plan_task_id=$2)`, [fromId, toId]);
    const ownPipeline = await client.query(`UPDATE conversations c SET scope=$2 WHERE c.scope=$1 AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM conversations o WHERE o.owner_id=c.owner_id AND o.scope=$2 AND o.deleted_at IS NULL AND o.archived_at IS NULL)`,
    [pipelineScope(fromId), pipelineScope(toId)]);

    const agreement = await client.query(`INSERT INTO task_agreement_notes(task_id,basis,criteria,exclusions,basis_hash,revision,updated_by,updated_at,draft_from)
      SELECT $2,basis,criteria,exclusions,basis_hash,1,$3,$4,$1 FROM task_agreement_notes WHERE task_id=$1 ON CONFLICT (task_id) DO NOTHING`,
    [fromId, toId, input.decidedBy ?? from.ownerId, now]);
    if (agreement.rowCount) await client.query(`INSERT INTO task_agreement_note_revisions(task_id,revision,basis,criteria,exclusions,basis_hash,updated_by,updated_at)
      SELECT task_id,revision,basis,criteria,exclusions,basis_hash,updated_by,updated_at FROM task_agreement_notes WHERE task_id=$1`, [toId]);

    const settlement = (await settlementsOf(client.query.bind(client), [fromId])).get(fromId)!;
    await client.query("COMMIT");
    return { taskId: fromId, settlement, moved: { cards: cards.rowCount ?? 0, topics: topics.rowCount ?? 0, pending: pending.rowCount ?? 0,
      splits: splits.rowCount ?? 0, planners: planners.rowCount ?? 0, drafts: drafts.rowCount ?? 0,
      pipeline: Boolean(chatPipeline.rowCount || ownPipeline.rowCount), agreement: Boolean(agreement.rowCount) } };
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally { client.release(); }
}

/** 到此为止（本人在 Task 上，或复盘时选了到此为止）：再定一次就覆盖时间和那句话。已经延续出去的 409 TASK_CONTINUED。 */
export async function stopTask(q: Query, taskId: string, decidedBy: string, note: string | null, now: Date): Promise<TTaskSettlement> {
  const stored = await q(`INSERT INTO task_stops(task_id,decided_by,decided_at,note) SELECT $1,$2,$3,$4
      WHERE NOT EXISTS (SELECT 1 FROM task_continuations WHERE from_task_id=$1)
    ON CONFLICT (task_id) DO UPDATE SET decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at,note=EXCLUDED.note`, [taskId, decidedBy, now, note]);
  if (!stored.rowCount) throw new CardError(409, "TASK_CONTINUED", "这件 Task 已经延续出去了，不用再定到此为止");
  return { kind: "stopped", at: now.toISOString(), by: decidedBy, note, to: null };
}

/** 撤销到此为止；本来就没定也算成功（返回 false）。 */
export async function unstopTask(q: Query, taskId: string): Promise<boolean> {
  return Boolean((await q("DELETE FROM task_stops WHERE task_id=$1", [taskId])).rowCount);
}
