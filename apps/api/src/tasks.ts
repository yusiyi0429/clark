import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TMeetingOutcomeItem, TPatchMyTaskRequest, TReturnMyTaskRequest, TTaskView } from "@warmap/contracts";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { insertNotification } from "./notifications.js";

type TaskRow = {
  id: string;
  version: number;
  title: string;
  status: TTaskView["status"];
  due_date: string | null;
  return_reason: string | null;
  origin_meeting_id: string | null;
  source_quote: string | null;
  meeting_title: string | null;
  lead_dri_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const TASK_SELECT = `
  SELECT t.id::text, t.version, t.title, t.status, t.due_date::text AS due_date, t.return_reason,
         t.origin_meeting_id::text, t.source_quote, m.title AS meeting_title, m.lead_dri_id, t.created_at, t.updated_at
    FROM tasks t
    LEFT JOIN meetings m ON m.id = t.origin_meeting_id`;

function projectTask(row: TaskRow): TTaskView {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    status: row.status,
    dueDate: row.due_date,
    returnReason: row.return_reason,
    origin: row.origin_meeting_id
      ? { type: "meeting", meetingId: row.origin_meeting_id, meetingTitle: row.meeting_title ?? "", quote: row.source_quote }
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 标题按字符截到 120，与库里 char_length 口径一致。 */
function taskTitle(text: string): string {
  return Array.from(text).slice(0, 120).join("");
}

/**
 * 会后推送一条 todo：负责人是 ownerPersonId（抽取已校验是参会人），没有负责人给主持人；
 * 负责人是 CEO 时不建执行事项（CEO 默认不接收），返回 null。
 * 同一会议条目已推送过时返回原执行事项，不重复建、不重复通知。
 */
export async function dispatchMeetingTodo(
  client: PoolClient,
  meeting: { id: string; leadDriId: string; ceoId: string },
  item: TMeetingOutcomeItem,
): Promise<string | null> {
  const ownerId = item.ownerPersonId ?? meeting.leadDriId;
  if (ownerId === meeting.ceoId) return null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tasks (id, title, due_date, status, owner_id, created_by, origin_meeting_id, origin_item_id, source_quote)
     VALUES ($1, $2, $3, 'not_started', $4, 'meeting', $5, $6, $7)
     ON CONFLICT (origin_meeting_id, origin_item_id) WHERE origin_meeting_id IS NOT NULL DO NOTHING
     RETURNING id::text`,
    [randomUUID(), taskTitle(item.text), item.dueDate ?? null, ownerId, meeting.id, item.id, item.quote],
  );
  if (inserted.rowCount === 0) {
    const existing = await client.query<{ id: string }>(
      "SELECT id::text FROM tasks WHERE origin_meeting_id = $1 AND origin_item_id = $2",
      [meeting.id, item.id],
    );
    return existing.rows[0].id;
  }
  const taskId = inserted.rows[0].id;
  await client.query(
    "INSERT INTO task_members (task_id, person_id, role, added_by) VALUES ($1, $2, 'owner', 'meeting')",
    [taskId, ownerId],
  );
  await insertNotification(client, { personId: ownerId, kind: "meeting_action_assigned", objectType: "task", objectId: taskId });
  return taskId;
}

/** 撤回会后推送：只在执行事项未开始时可用；执行事项与指向它的通知一起删除，不通知任何人。 */
export async function deleteDispatchedTask(
  client: PoolClient,
  taskId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const locked = await client.query<{ status: string }>("SELECT status FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
  if (locked.rowCount !== 1) return { ok: false, code: "TASK_NOT_FOUND", message: "执行事项不存在" };
  if (locked.rows[0].status !== "not_started") {
    return { ok: false, code: "TASK_ALREADY_STARTED", message: "执行事项已被负责人处理，不能撤回" };
  }
  await client.query("DELETE FROM notifications WHERE object_type = 'task' AND object_id = $1", [taskId]);
  await client.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  return { ok: true };
}

/** 我负责的执行事项，全部状态，新到旧。 */
export async function listMyTasks(q: Query, personId: string): Promise<TTaskView[]> {
  const result = await q(`${TASK_SELECT} WHERE t.owner_id = $1 ORDER BY t.created_at DESC, t.id`, [personId]);
  return (result.rows as TaskRow[]).map(projectTask);
}

export type TaskMutation =
  | { task: TTaskView }
  | { notFound: true }
  | { conflict: TTaskView };

async function lockMyTask(client: PoolClient, personId: string, taskId: string): Promise<TaskRow | null> {
  if (!UUID_PATTERN.test(taskId)) return null;
  const result = await client.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1 AND t.owner_id = $2 FOR UPDATE OF t`, [taskId, personId]);
  return result.rowCount === 1 ? result.rows[0] : null;
}

/** 只有负责人能改；锁行后校验 version，冲突时带回当前视图。 */
async function mutateMyTask(
  pool: Pool,
  personId: string,
  taskId: string,
  version: number,
  apply: (client: PoolClient, row: TaskRow) => Promise<void>,
): Promise<TaskMutation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockMyTask(client, personId, taskId);
    if (!row) {
      await client.query("ROLLBACK");
      return { notFound: true };
    }
    if (row.version !== version) {
      await client.query("ROLLBACK");
      return { conflict: projectTask(row) };
    }
    await apply(client, row);
    const updated = await client.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
    await client.query("COMMIT");
    return { task: projectTask(updated.rows[0]) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 改状态；从退回改回来时清掉退回原因。 */
export function updateMyTaskStatus(pool: Pool, personId: string, taskId: string, input: TPatchMyTaskRequest): Promise<TaskMutation> {
  return mutateMyTask(pool, personId, taskId, input.version, async (client) => {
    await client.query(
      "UPDATE tasks SET status = $2, return_reason = NULL, version = version + 1, updated_at = now() WHERE id = $1",
      [taskId, input.status],
    );
  });
}

/** 退回：记原因并通知会议主持人；主持人就是负责人本人时不给自己发通知。 */
export function returnMyTask(pool: Pool, personId: string, taskId: string, input: TReturnMyTaskRequest): Promise<TaskMutation> {
  return mutateMyTask(pool, personId, taskId, input.version, async (client, row) => {
    await client.query(
      "UPDATE tasks SET status = 'returned', return_reason = $2, version = version + 1, updated_at = now() WHERE id = $1",
      [taskId, input.reason],
    );
    if (row.lead_dri_id && row.lead_dri_id !== personId) {
      await insertNotification(client, { personId: row.lead_dri_id, kind: "task_returned", objectType: "task", objectId: taskId, actorId: personId });
    }
  });
}
