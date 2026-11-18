import { randomUUID } from "node:crypto";
import type { TConversationCard } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

/**
 * 伙伴在主线派出去的活（本人 11/18，迁移 289 的 buddy_dispatches）：open_session 开了哪个会话，或 message_project 转给了哪个项目的对话。
 * 每次派活出一张派活卡（ConversationCard 的 buddy_dispatch），读历史时接回那一轮；从主线开的会话做完一轮时主线出一行（taskFeed.ts 的 partnerWorkEvents）。
 * 卡上的项目名、会话名照现在的（改过名跟着变），表里存的是派活那一刻的。
 */

export type DispatchCard = Extract<TConversationCard, { kind: "buddy_dispatch" }>;

type DispatchRow = { id: string; run_id: string | null; created_at: Date; project_id: string; project_name: string; topic_id: string | null; title: string | null };
const SELECT = `SELECT d.id::text,d.run_id,d.created_at,d.project_id::text,COALESCE(p.name,d.project_name) AS project_name,d.topic_id::text,COALESCE(r.title,d.title) AS title
  FROM buddy_dispatches d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN research_topics r ON r.id=d.topic_id`;
const card = (row: DispatchRow): DispatchCard => ({ kind: "buddy_dispatch", dispatchId: row.id, projectId: row.project_id, projectName: row.project_name,
  sub: row.topic_id ? { kind: "topic", id: row.topic_id, title: row.title ?? "" } : null });

/** 这个键已经派过的那一张（同一轮重放时用）；没有为 null。 */
export async function findDispatch(q: Query, ownerId: string, requestKey: string): Promise<DispatchCard | null> {
  const row = (await q(`${SELECT} WHERE d.owner_id=$1 AND d.request_key=$2`, [ownerId, requestKey])).rows[0] as DispatchRow | undefined;
  return row ? card(row) : null;
}

/** 记一次派活；同一个键已经记过就回那一张。 */
export async function recordDispatch(q: Query, input: {
  ownerId: string; requestKey: string; runId: string | null; conversationId: string | null;
  projectId: string; projectName: string; topic: { id: string; title: string } | null; now: Date;
}): Promise<DispatchCard> {
  await q(`INSERT INTO buddy_dispatches(id,owner_id,request_key,run_id,conversation_id,project_id,project_name,topic_id,title,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (owner_id,request_key) DO NOTHING`,
  [randomUUID(), input.ownerId, input.requestKey, input.runId, input.conversationId, input.projectId, input.projectName, input.topic?.id ?? null,
    input.topic?.title ?? null, input.now]);
  return (await findDispatch(q, input.ownerId, input.requestKey))!;
}

/** 读历史用：这些轮次里出的派活卡，带出的时间。 */
export async function dispatchCards(q: Query, ownerId: string, runIds: string[]): Promise<{ runId: string; createdAt: Date; card: DispatchCard }[]> {
  if (!runIds.length) return [];
  const rows = (await q(`${SELECT} WHERE d.owner_id=$1 AND d.run_id=ANY($2::text[]) ORDER BY d.created_at,d.id`, [ownerId, runIds])).rows as DispatchRow[];
  return rows.map((row) => ({ runId: row.run_id!, createdAt: row.created_at, card: card(row) }));
}
