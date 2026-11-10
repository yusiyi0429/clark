import type { TConversationHistory, TConversationScope } from "@warmap/contracts";
import type { ChatService } from "./chatService.js";
import { getConversationHistory } from "./conversations.js";
import type { Query } from "./meetingStore.js";
import { projectScope } from "./projects.js";
import { pipelineViewer, projectPipelineConversation } from "./taskPipelines.js";

/**
 * 本人原话（设计《新首页》16.8，契约 cardSplits.ts 的 SourceWords）：登记拆卡时存下这次依据的本人原话，规划员交派活单时只能从里面原样摘，
 * 云端核对；派活单、卡、开工和验收的交代都带上。
 */

/** 登记拆卡的请求体可以不带（旧网页不带）：没带当成 {}，免得 Fastify 按 schema 挡掉。 */
export const emptyBodyAsObject = async (req: { body: unknown }) => { if (req.body === undefined || req.body === null) req.body = {}; };

/** 最多存最近几条。 */
export const SOURCE_TURNS = 5;

/** 拆卡的对象：一件 Task，或一个没挂 Task 的项目。 */
export type SplitTarget = { taskId: string | null; projectId: string | null };

/**
 * 拆卡那几块按序号插进项目对话（17.2 第 29 条）：网页没带时，读这个项目（拆 Task 的是它挂的项目）的对话现在最后一条消息的 sequence。
 * 不在项目里、对话还没有消息、读不到为 null。
 */
export function lastSequenceReader(deps: { q: Query; chat?: ChatService; conversationTurnTimeoutMs: number }) {
  const history = projectHistoryReader(deps);
  return async (ownerId: string, target: SplitTarget, requestId: string): Promise<number | null> => {
    const projectId = target.projectId ?? ((await deps.q("SELECT project_id::text FROM project_goals WHERE task_id=$1 AND owner_id=$2", [target.taskId, ownerId])).rows[0]
      ?.project_id as string | null | undefined) ?? null;
    if (!projectId) return null;
    return (await history(projectId, ownerId, requestId).catch(() => null))?.messages.at(-1)?.sequence ?? null;
  };
}

/**
 * 本机规划员的派活单第一次报上来、云端建派活单这一下的序号（17.2 第 29 条）：最近一次登记被认领了（网页先删登记再开规划员）、
 * 还没给别的派活单用过，这次就是照它开的，用它记的，并记下给了这份派活单（planId）；不然是这台电脑连着本机时直接开的（不经过登记），
 * 用这一下项目对话的最后一条（current）。
 */
export async function localPlanSequence(q: Query, ownerId: string, target: SplitTarget, planId: string, current: number | null): Promise<number | null> {
  const row = (await q(`SELECT id,after_sequence,closed_at IS NOT NULL AND plan_id IS NULL AS claimed FROM card_split_requests
    WHERE owner_id=$1 AND ${target.taskId ? "plan_task_id=$2" : "project_id=$2 AND plan_task_id IS NULL"} ORDER BY created_at DESC,id DESC LIMIT 1`,
  [ownerId, target.taskId ?? target.projectId])).rows[0] as { id: string; after_sequence: number | null; claimed: boolean } | undefined;
  if (!row?.claimed) return current;
  await q("UPDATE card_split_requests SET plan_id=$2 WHERE id=$1", [row.id, planId]);
  return row.after_sequence;
}

/** 网页按钮带上来的那段话：去掉首尾空白，空的当没说。 */
export const typedWords = (words: string | undefined): string[] | undefined => words === undefined ? undefined : words.trim() ? [words.trim()] : [];

/** 这个 Task 或项目最近一次登记拆卡存下的原话（开着的、开过规划员去掉了的都算）；没有为空数组。 */
export async function latestSplitWords(q: Query, ownerId: string, target: SplitTarget): Promise<string[]> {
  const row = (await q(`SELECT source_words FROM card_split_requests WHERE owner_id=$1 AND ${target.taskId ? "plan_task_id=$2" : "project_id=$2 AND plan_task_id IS NULL"}
    ORDER BY created_at DESC,id DESC LIMIT 1`, [ownerId, target.taskId ?? target.projectId])).rows[0] as { source_words: string[] } | undefined;
  return row?.source_words ?? [];
}

/**
 * 规划员摘的片段核对：每段去掉首尾空白后必须是某条原话的子串。有一段不是、或者一段都没摘，整件改用整条原话；原话为空就是空。
 */
export function checkedWords(originals: string[], excerpts: string[] | undefined): string[] {
  if (!originals.length) return [];
  const pieces = (excerpts ?? []).map((text) => text.trim());
  if (!pieces.length || pieces.some((piece) => !piece || !originals.some((original) => original.includes(piece)))) return originals;
  return [...new Set(pieces)];
}

/** 交代里的「本人原话」一段（引用样式，一条一块）；没有原话不写。 */
export const wordsLines = (words: string[], note?: string): string[] => words.length
  ? ["## 本人原话", "", ...(note ? [note, ""] : []), ...words.flatMap((text) => [...text.split("\n").map((line) => `> ${line}`), ""])]
  : [];

/** 读本人那段项目对话：接了 Chat 读 Chat 里的那条，没接读天枢自己 scope 为 project:<id> 的对话。 */
export type ProjectHistory = (projectId: string, ownerId: string, requestId: string) => Promise<TConversationHistory>;
export function projectHistoryReader(deps: { q: Query; chat?: ChatService; conversationTurnTimeoutMs: number }): ProjectHistory {
  return async (projectId, ownerId, requestId) => {
    const scope = projectScope(projectId) as TConversationScope;
    if (deps.chat) {
      const conversationId = await projectPipelineConversation(deps.q, projectId, ownerId);
      // Chat 的历史和天枢自己的对话同一个形状（chatService.ts 翻好了），scope 是这条项目对话。
      return conversationId ? await deps.chat.history(pipelineViewer(ownerId), requestId, { conversationId, scope, projectId }) as TConversationHistory
        : { scope, messages: [] };
    }
    return getConversationHistory(deps.q, ownerId, scope, deps.conversationTurnTimeoutMs);
  };
}

/**
 * 伙伴登记拆卡时的原话：本人在这个项目对话里说的话（拆 Task 的取 Task 挂的项目），上一次登记拆它之后的，最多最近 5 条，旧的在前。
 * 没挂项目、对话读不到都当没说。
 */
export async function recentOwnerWords(q: Query, history: ProjectHistory, ownerId: string, target: SplitTarget, requestId: string): Promise<string[]> {
  const projectId = target.projectId ?? (target.taskId
    ? (await q("SELECT project_id::text FROM project_goals WHERE task_id=$1 AND owner_id=$2", [target.taskId, ownerId])).rows[0]?.project_id as string | null | undefined
    : null);
  if (!projectId) return [];
  const since = (await q(`SELECT max(created_at) AS at FROM card_split_requests WHERE owner_id=$1 AND ${target.taskId ? "plan_task_id=$2" : "project_id=$2 AND plan_task_id IS NULL"}`,
    [ownerId, target.taskId ?? target.projectId])).rows[0]?.at as Date | null;
  const messages = await history(projectId, ownerId, requestId).then((result) => result.messages).catch(() => []);
  return messages.filter((message) => message.role === "user" && (!since || new Date(message.createdAt) > since) && message.content.trim())
    .map((message) => message.content.trim()).slice(-SOURCE_TURNS);
}
