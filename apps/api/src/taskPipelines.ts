import type { Pool } from "pg";
import type { ChatService, ChatViewer } from "./chatService.js";
import { ACTIVE_CONVERSATION_WHERE, ensureMainConversation } from "./conversations.js";
import type { Query } from "./meetingStore.js";
import { projectScope } from "./projects.js";

/**
 * 项目对话（契约 projects.ts，替换原来的 Task 管线）：每人每个项目一条单独的伙伴对话，scope 是 project:<projectId>，和总管线（global）各是各的历史。
 * - 接了 Chat：Chat 里单独一段，project_pipelines 记「项目 → 段」，总管线挑段时排除这些段（和以前 Task 管线的段，chatService.ts 的 pipelines）。
 * - 没接 Chat：天枢自己的对话，按 (owner_id, scope) 存在 conversations 里。
 * 视角固定 member：项目只在 DRI 工作台。
 */

/** 去 Chat 时的视角：不管本人当前在哪个视角，都按 member。 */
export const pipelineViewer = (personId: string): ChatViewer => ({ personId, role: "member" });

/** 本人在 Chat 里的项目对话那几段，加以前 Task 管线的段（都不进总管线）。 */
export async function pipelineConversationIds(q: Query, ownerId: string): Promise<Set<string>> {
  const rows = (await q("SELECT conversation_id FROM project_pipelines WHERE owner_id=$1 UNION SELECT conversation_id FROM task_pipelines WHERE owner_id=$1",
    [ownerId])).rows as { conversation_id: string }[];
  return new Set(rows.map((row) => row.conversation_id));
}

/** 这个人这个项目在 Chat 里的那一段（一人一段：交接以后原负责人那段留着只读，接手人另开一段）；还没开过为 null。 */
export async function projectPipelineConversation(q: Query, projectId: string, ownerId: string): Promise<string | null> {
  const rows = (await q("SELECT conversation_id FROM project_pipelines WHERE project_id=$1 AND owner_id=$2", [projectId, ownerId])).rows as { conversation_id: string }[];
  return rows[0]?.conversation_id ?? null;
}

/**
 * 这个项目的对话，第一次时建。调用方先核对项目是本人的（projects.ownProject）。
 * 接了 Chat：不占数据库连接等 Chat。在 Chat 的排队里（同一个人同一视角，chatService.ts 的 createConversation）再查一次、开一段、记下；
 * 记的时候这个项目已经登记了别的段（别的进程先记了）就用登记着的那段。created：这次新建的。
 */
export async function ensureProjectPipeline(deps: { pool: Pool; chat?: ChatService }, viewer: { personId: string }, projectId: string, requestId: string):
  Promise<{ conversationId: string; created: boolean }> {
  const owner = viewer.personId;
  const scope = projectScope(projectId);
  if (!deps.chat) {
    const existed = (await deps.pool.query(`SELECT 1 FROM conversations WHERE ${ACTIVE_CONVERSATION_WHERE} LIMIT 1`, [owner, scope])).rowCount;
    return { conversationId: await ensureMainConversation(deps.pool, owner, scope), created: !existed };
  }
  const q: Query = deps.pool.query.bind(deps.pool);
  const found = await projectPipelineConversation(q, projectId, owner);
  if (found) return { conversationId: found, created: false };
  return deps.chat.createConversation(pipelineViewer(owner), requestId, {
    existing: () => projectPipelineConversation(q, projectId, owner),
    register: async (id) => {
      const inserted = (await q("INSERT INTO project_pipelines (project_id, owner_id, conversation_id) VALUES ($1, $2, $3) ON CONFLICT (project_id, owner_id) DO NOTHING",
        [projectId, owner, id])).rowCount;
      // 没插进去：这个项目已经登记了，读那一条（project_pipelines 不删行）。
      return inserted ? id : (await projectPipelineConversation(q, projectId, owner)) as string;
    },
  });
}
