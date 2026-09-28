import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TAppendTaskProgressRequest, TTaskProgressEntry, TTaskProgressSource } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { canReadTask } from "./tasks.js";

type Row = { id: string; task_id: string; author_id: string; source: TTaskProgressSource; body: string;
  links: TTaskProgressEntry["links"]; created_at: Date };
export const projectTaskProgress = (row: Row, names: Map<string, string>): TTaskProgressEntry => ({
  id: row.id, taskId: row.task_id, author: { personId: row.author_id, name: names.get(row.author_id) ?? row.author_id },
  source: row.source, body: row.body, links: row.links, createdAt: row.created_at.toISOString(),
});

export async function listTaskProgress(q: Query, taskId: string, names: Map<string, string>): Promise<TTaskProgressEntry[]> {
  const rows = (await q("SELECT id::text,task_id::text,author_id,source,body,links,created_at FROM task_progress WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50", [taskId])).rows as Row[];
  return rows.map((row) => projectTaskProgress(row, names));
}

type Result = { entry: TTaskProgressEntry } | { error: { status: 404 | 409; code: string; message: string } };
export async function appendTaskProgress(pool: Pool, taskId: string, authorId: string, source: TTaskProgressSource,
  input: TAppendTaskProgressRequest, names: Map<string, string>, tokenId: string | null = null): Promise<Result> {
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-progress:${authorId}:${input.clientEventId}`]);
    if (!await canReadTask(q, taskId, authorId)) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "TASK_NOT_FOUND", message: "找不到这件执行事项" } };
    }
    const prior = (await q("SELECT id::text,task_id::text,author_id,source,body,links,created_at FROM task_progress WHERE author_id=$1 AND client_event_id=$2", [authorId, input.clientEventId])).rows[0] as Row | undefined;
    const links = input.links ?? [];
    if (prior) {
      await client.query("COMMIT");
      return prior.task_id === taskId && prior.body === input.body && JSON.stringify(prior.links) === JSON.stringify(links)
        ? { entry: projectTaskProgress(prior, names) }
        : { error: { status: 409, code: "CLIENT_EVENT_CONFLICT", message: "这次进展编号已用于其他内容" } };
    }
    const row = (await q(`INSERT INTO task_progress(id,task_id,author_id,source,body,links,token_id,client_event_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id::text,task_id::text,author_id,source,body,links,created_at`,
    [randomUUID(), taskId, authorId, source, input.body, JSON.stringify(links), tokenId, input.clientEventId])).rows[0] as Row;
    await client.query("COMMIT");
    return { entry: projectTaskProgress(row, names) };
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { client.release(); }
}
