import { randomUUID } from "node:crypto";
import { CHAT_PUSH_REASONS, type TChatView, type TChatWaitReason, type TCorrectChatMessageRequest, type TOwnerChatMessageRequest } from "@warmap/contracts";
import { ChatError, chatFor, readChat, type ChatDeps } from "./colleagueChats.js";
import type { Query } from "./meetingStore.js";
import { maskSecrets } from "./secretPatterns.js";
import { transact } from "./dbTransaction.js";

/**
 * 被问的人（主人）在来问他的对话里（设计稿第 4 节）：回某一句、改伙伴答的一句、收回伙伴答的一句；等你一段一行、逐句结清。
 * 只认这段的 owner_id；说的话落库前过 maskSecrets，按 client_id 幂等。
 */
const noMessage = () => new ChatError(404, "NOT_FOUND", "对话或这句话不存在");
type Chat = { id: string; asker_id: string; owner_id: string };

async function ownerAction(deps: ChatDeps, viewer: string, chatId: string, work: (q: Query, chat: Chat, now: Date) => Promise<void>): Promise<TChatView> {
  const chat = await chatFor(deps, viewer, chatId);
  if (chat.owner_id !== viewer) throw noMessage();
  await transact(deps.pool, (q) => work(q, chat, deps.now()));
  return readChat(deps, viewer, "from", chat.asker_id);
}

const said = (text: string) => {
  const body = maskSecrets(text.trim());
  if (!body) throw new ChatError(400, "INVALID_INPUT", "请写要说的话");
  return body;
};
/** 这个 clientId 落过主人句了：重复提交，什么都不改。 */
const replayed = async (q: Query, chatId: string, clientId: string) =>
  (await q("SELECT 1 FROM colleague_chat_messages WHERE chat_id=$1 AND author='owner' AND client_id=$2", [chatId, clientId])).rows.length > 0;
const insertOwner = (q: Query, chatId: string, clientId: string, body: string, now: Date, link: { replyTo?: string | null; corrects?: string }) =>
  q(`INSERT INTO colleague_chat_messages (id,chat_id,author,body,client_id,created_at,reply_to,corrects) VALUES ($1,$2,'owner',$3,$4,$5,$6,$7)
    ON CONFLICT (chat_id,author,client_id) DO NOTHING`, [randomUUID(), chatId, body, clientId, now, link.replyTo ?? null, link.corrects ?? null]);
const touch = (q: Query, chatId: string, now: Date) => q("UPDATE colleague_chats SET last_message_at=$2 WHERE id=$1", [chatId, now]);
/** 这段里的伙伴句，锁住；不是就 404。 */
async function buddyLine(q: Query, chatId: string, messageId: string) {
  const row = (await q("SELECT id,reply_to,retracted_at FROM colleague_chat_messages WHERE id=$1 AND chat_id=$2 AND author='buddy' FOR UPDATE",
    [messageId, chatId])).rows[0] as { id: string; reply_to: string | null; retracted_at: Date | null } | undefined;
  if (!row) throw noMessage();
  return row;
}

/**
 * 回一句：replyTo 没给回最早一句还等他的问句（没有就是单说一句）。那句还等着就结清；伙伴还没答的改成答了，作答作业落伙伴句前重查会放手。
 */
export const sendOwnerMessage = (deps: ChatDeps, viewer: string, chatId: string, input: TOwnerChatMessageRequest) =>
  ownerAction(deps, viewer, chatId, async (q, chat, now) => {
    const body = said(input.text);
    const target = (input.replyTo
      ? await q("SELECT id FROM colleague_chat_messages WHERE id=$1 AND chat_id=$2 AND answer_state IS NOT NULL FOR UPDATE", [input.replyTo, chat.id])
      : await q("SELECT id FROM colleague_chat_messages WHERE chat_id=$1 AND wait_reason IS NOT NULL AND wait_closed_at IS NULL ORDER BY seq LIMIT 1 FOR UPDATE",
        [chat.id])).rows[0] as { id: string } | undefined;
    if (input.replyTo && !target) throw noMessage();
    // 同一 clientId 落过（重复提交）就什么都不改。
    if (!(await insertOwner(q, chat.id, input.clientId, body, now, { replyTo: target?.id })).rowCount) return;
    if (target) await q(`UPDATE colleague_chat_messages SET answer_state='answered',
      wait_closed_at=CASE WHEN wait_reason IS NOT NULL THEN COALESCE(wait_closed_at,$2) END WHERE id=$1`, [target.id, now]);
    await touch(q, chat.id, now);
  });

/** 改伙伴答的一句：收回了的 404，改过的 409；补上看过，它答的那句还等着就结清。 */
export const correctChatMessage = (deps: ChatDeps, viewer: string, chatId: string, messageId: string, input: TCorrectChatMessageRequest) =>
  ownerAction(deps, viewer, chatId, async (q, chat, now) => {
    const body = said(input.text);
    const line = await buddyLine(q, chat.id, messageId);
    if (await replayed(q, chat.id, input.clientId)) return;
    if (line.retracted_at) throw noMessage();
    if ((await q("SELECT 1 FROM colleague_chat_messages WHERE corrects=$1", [line.id])).rows.length)
      throw new ChatError(409, "ALREADY_CORRECTED", "这句已经改过了");
    await insertOwner(q, chat.id, input.clientId, body, now, { corrects: line.id });
    await q("UPDATE colleague_chat_messages SET seen_at=COALESCE(seen_at,$2) WHERE id=$1", [line.id, now]);
    if (line.reply_to) await q("UPDATE colleague_chat_messages SET wait_closed_at=$2 WHERE id=$1 AND wait_reason IS NOT NULL AND wait_closed_at IS NULL",
      [line.reply_to, now]);
    await touch(q, chat.id, now);
  });

/** 收回伙伴答的一句；收回过的照旧成功。 */
export const retractChatMessage = (deps: ChatDeps, viewer: string, chatId: string, messageId: string) =>
  ownerAction(deps, viewer, chatId, async (q, chat, now) => {
    const line = await buddyLine(q, chat.id, messageId);
    await q("UPDATE colleague_chat_messages SET retracted_at=COALESCE(retracted_at,$2) WHERE id=$1", [line.id, now]);
  });

/**
 * 主人的等你：一段一行。title、reason、at 取最早一句还等他的问句；pushAt、pushReason 取还等着、原因要推飞书的问句里最晚开始等的那句（没有为 null）。
 */
export async function listChatWaiting(q: Query, ownerId: string):
  Promise<{ chatId: string; askerId: string; title: string; reason: TChatWaitReason; at: string; pushAt: string | null; pushReason: TChatWaitReason | null }[]> {
  const rows = (await q(`SELECT c.id,c.asker_id,first.body,first.wait_reason,first.wait_at,push.wait_at AS push_at,push.wait_reason AS push_reason
    FROM colleague_chats c JOIN LATERAL (SELECT body,wait_reason,wait_at FROM colleague_chat_messages m
      WHERE m.chat_id=c.id AND m.wait_reason IS NOT NULL AND m.wait_closed_at IS NULL ORDER BY m.seq LIMIT 1) first ON true
    LEFT JOIN LATERAL (SELECT wait_at,wait_reason FROM colleague_chat_messages m
      WHERE m.chat_id=c.id AND m.wait_closed_at IS NULL AND m.wait_reason=ANY($2::text[]) ORDER BY m.wait_at DESC,m.seq DESC LIMIT 1) push ON true
    WHERE c.owner_id=$1 ORDER BY first.wait_at,c.id`, [ownerId, CHAT_PUSH_REASONS])).rows as
    { id: string; asker_id: string; body: string; wait_reason: TChatWaitReason; wait_at: Date; push_at: Date | null; push_reason: TChatWaitReason | null }[];
  return rows.map((row) => ({ chatId: row.id, askerId: row.asker_id, title: row.body, reason: row.wait_reason, at: row.wait_at.toISOString(),
    pushAt: row.push_at?.toISOString() ?? null, pushReason: row.push_reason }));
}
