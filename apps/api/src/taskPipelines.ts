import type { Pool } from "pg";
import type { ChatService, ChatViewer } from "./chatService.js";
import { ACTIVE_CONVERSATION_WHERE, ensureMainConversation } from "./conversations.js";
import type { Query } from "./meetingStore.js";

/**
 * Task 管线（契约 workHome.ts）：每人每件 Task 一条单独的伙伴对话，scope 是 plan-task:<taskId>，和总管线（global）各是各的历史。
 * - 接了 Chat：Chat 里单独一段，task_pipelines 记「人 × Task → 段」，总管线挑段时排除这些段（chatService.ts 的 pipelines）。
 * - 没接 Chat：天枢自己的对话，按 (owner_id, scope) 存在 conversations 里，不往 task_pipelines 写。
 * 视角固定 member：Task 管线只在 DRI 工作台。
 */

export const pipelineScope = (taskId: string) => `plan-task:${taskId}`;
/** 去 Chat 时的视角：不管本人当前在哪个视角，都按 member（Task 管线那几段都在 member 视角下）。 */
export const pipelineViewer = (personId: string): ChatViewer => ({ personId, role: "member" });

/** 本人在 Chat 里的 Task 管线那几段。 */
export async function pipelineConversationIds(q: Query, ownerId: string): Promise<Set<string>> {
  const rows = (await q("SELECT conversation_id FROM task_pipelines WHERE owner_id = $1", [ownerId])).rows as { conversation_id: string }[];
  return new Set(rows.map((row) => row.conversation_id));
}

/** 这件 Task 在 Chat 里的那一段；还没开过为 null。 */
export async function taskPipelineConversation(q: Query, ownerId: string, taskId: string): Promise<string | null> {
  const rows = (await q("SELECT conversation_id FROM task_pipelines WHERE owner_id = $1 AND plan_task_id = $2", [ownerId, taskId])).rows as { conversation_id: string }[];
  return rows[0]?.conversation_id ?? null;
}

/**
 * 这件 Task 的管线对话，第一次时建。调用方先核对本人是负责人（boardTask）。
 * 接了 Chat：不占数据库连接等 Chat。在 Chat 的排队里（同一个人同一视角，chatService.ts 的 createConversation）再查一次、开一段、记下；
 * 记的时候这件已经登记了别的段（别的进程先记了）就用登记着的那段。
 * created：这次新建的。
 */
export async function ensureTaskPipeline(deps: { pool: Pool; chat?: ChatService }, viewer: { personId: string }, taskId: string, requestId: string):
  Promise<{ conversationId: string; created: boolean }> {
  const owner = viewer.personId;
  const scope = pipelineScope(taskId);
  if (!deps.chat) {
    const existed = (await deps.pool.query(`SELECT 1 FROM conversations WHERE ${ACTIVE_CONVERSATION_WHERE} LIMIT 1`, [owner, scope])).rowCount;
    return { conversationId: await ensureMainConversation(deps.pool, owner, scope), created: !existed };
  }
  const q: Query = deps.pool.query.bind(deps.pool);
  const found = await taskPipelineConversation(q, owner, taskId);
  if (found) return { conversationId: found, created: false };
  return deps.chat.createConversation(pipelineViewer(owner), requestId, {
    existing: () => taskPipelineConversation(q, owner, taskId),
    register: async (id) => {
      const inserted = (await q("INSERT INTO task_pipelines (owner_id, plan_task_id, conversation_id) VALUES ($1, $2, $3) ON CONFLICT (owner_id, plan_task_id) DO NOTHING",
        [owner, taskId, id])).rowCount;
      // 没插进去：这件已经登记了，读那一条（task_pipelines 不删行）。
      return inserted ? id : (await taskPipelineConversation(q, owner, taskId)) as string;
    },
  });
}
