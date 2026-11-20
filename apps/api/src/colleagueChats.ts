import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TChatListResponse, TChatMessage, TChatPerson, TChatRow, TChatView, TMainLine } from "@warmap/contracts";
import { colleagueAccess, isCovered, type ColleagueAccess } from "./colleagueAccess.js";
import { listFriendRequests, relationOf } from "./colleagueFriends.js";
import { readBuddy } from "./buddy.js";
import { enqueueJob } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { maskSecrets } from "./secretPatterns.js";
import { transact } from "./teamDeliveries.js";
import { ANSWERING_TIMEOUT_MS } from "./teamDeliveryInbox.js";

/**
 * 同事对话（设计稿第 2、5 节）：一段 = 问的人 × 被问的人的伙伴，同一对只有一段。每句问话入一个 colleague.chat-answer 作业（作答在 Task 4）；
 * 能不能问只在 colleagueAccess 判。人和伙伴说的话落库前过 maskSecrets。
 */
export const CHAT_ANSWER_JOB = "colleague.chat-answer";
/** 同一对每天、被问的人每天合计（Asia/Shanghai）；寒暄也占，重试不重扣，问满那句不占。 */
export const CHAT_DAILY_PER_PAIR = 10;
export const CHAT_DAILY_PER_OWNER = 20;
export const chatAnswerKey = (messageId: string) => `${CHAT_ANSWER_JOB}:${messageId}`;

/** people：真人的名字；directory：整份人员目录（覆盖、授权按它判）；dispatchNow：jobs 的 runNow，入队提交后立即跑。 */
export type ChatDeps = { q: Query; pool: Pool; now: () => Date; directory: PeopleDirectory; people: ReadonlyMap<string, string>;
  dispatchNow?: (jobId: string) => Promise<unknown> };
export class ChatError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const noPerson = () => new ChatError(404, "PERSON_NOT_FOUND", "人员目录里没有这个人");
const noChat = () => new ChatError(404, "NOT_FOUND", "对话或这句话不存在");

type Chat = { id: string; asker_id: string; owner_id: string };
type Row = { id: string; seq: string; author: TChatMessage["author"]; body: string; created_at: Date; reply_to: string | null; corrects: string | null;
  sources: { label: string }[]; seen_at: Date | null; retracted_at: Date | null; answer_state: Exclude<TChatMessage["answer"], null> | null;
  answer_started_at: Date | null; wait_reason: NonNullable<TChatMessage["wait"]>["reason"] | null; wait_at: Date | null; wait_closed_at: Date | null };

/** 问的人自己问查 ask，他的伙伴替他问查 agent_ask。 */
export const chatAccess = (q: Query, directory: PeopleDirectory, chat: { asker_id: string; owner_id: string }, author: "asker" | "asker_buddy"): Promise<ColleagueAccess> =>
  colleagueAccess(q, directory, chat.asker_id, chat.owner_id, author === "asker_buddy" ? "agent_ask" : "ask");

/** 伙伴在答超过 ANSWERING_TIMEOUT_MS 读成没答上来。 */
const stuck = (row: Pick<Row, "answer_state" | "answer_started_at">, now: Date) => row.answer_state === "failed" ||
  (row.answer_state === "answering" && (row.answer_started_at?.getTime() ?? 0) < now.getTime() - ANSWERING_TIMEOUT_MS);

/** 作业入队提交后，给了 dispatchNow 就立即派出去；作业照常排着兜底（同 teamDeliveries.ts dispatchBuddy）。 */
async function dispatch(deps: ChatDeps, dedupeKey: string | null) {
  if (!deps.dispatchNow || !dedupeKey) return;
  const job = (await deps.q("SELECT id::text FROM jobs WHERE dedupe_key=$1 AND status='pending'", [dedupeKey])).rows[0] as { id: string } | undefined;
  if (job) void deps.dispatchNow(job.id).catch((error: Error) => console.warn(`colleague chat answer dispatch failed, left to jobs: ${error.message}`));
}

export async function sendChatMessage(deps: ChatDeps, asker: string, ownerId: string,
  input: { clientId: string; text: string; via?: "main"; author?: "asker_buddy"; runId?: string | null }): Promise<{ chatId: string; messageId: string; state: "answering" | "limited" }> {
  const text = maskSecrets(input.text.trim());
  if (!text) throw new ChatError(400, "INVALID_INPUT", "请写要问的话");
  const author = input.author ?? "asker";
  const access = await chatAccess(deps.q, deps.directory, { asker_id: asker, owner_id: ownerId }, author);
  if (!access.allowed) throw access.reason ? new ChatError(409, "NOT_OPENED", "他没开放这一项") : noPerson();
  const now = deps.now();
  const sent = await transact(deps.pool, async (q) => {
    // 同一位被问的人的名额串行数，事务结束释放。占名额的是开始答过的句子（answer_started_at 有值）：问满那句不写它，点了问本人也不写，所以不占。
    await q("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["colleague-chat/" + ownerId]);
    await q(`INSERT INTO colleague_chats (id,asker_id,owner_id,created_at,last_message_at) VALUES ($1,$2,$3,$4,$4)
      ON CONFLICT (asker_id,owner_id) DO NOTHING`, [randomUUID(), asker, ownerId, now]);
    const chatId = (await q("SELECT id FROM colleague_chats WHERE asker_id=$1 AND owner_id=$2", [asker, ownerId])).rows[0].id as string;
    const existing = (await q("SELECT id,answer_state FROM colleague_chat_messages WHERE chat_id=$1 AND author=$2 AND client_id=$3",
      [chatId, author, input.clientId])).rows[0];
    if (existing) return { chatId, messageId: existing.id as string, state: existing.answer_state === "limited" ? "limited" as const : "answering" as const, key: null };
    const used = (await q(`SELECT count(*)::int AS total,count(*) FILTER (WHERE m.chat_id=$3)::int AS pair FROM colleague_chat_messages m
      JOIN colleague_chats c ON c.id=m.chat_id WHERE c.owner_id=$1 AND m.answer_started_at IS NOT NULL
      AND date_trunc('day',m.created_at AT TIME ZONE 'Asia/Shanghai')=date_trunc('day',$2::timestamptz AT TIME ZONE 'Asia/Shanghai')`,
    [ownerId, now, chatId])).rows[0] as { total: number; pair: number };
    const limited = used.pair >= CHAT_DAILY_PER_PAIR || used.total >= CHAT_DAILY_PER_OWNER;
    const messageId = randomUUID();
    await q(`INSERT INTO colleague_chat_messages (id,chat_id,author,body,client_id,created_at,via,run_id,answer_state,answer_started_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [messageId, chatId, author, text, input.clientId, now, input.via ?? "chat", input.runId ?? null,
      limited ? "limited" : "answering", limited ? null : now]);
    await q("UPDATE colleague_chats SET last_message_at=$2 WHERE id=$1", [chatId, now]);
    if (limited) return { chatId, messageId, state: "limited" as const, key: null };
    await enqueueJob(q, { kind: CHAT_ANSWER_JOB, dedupeKey: chatAnswerKey(messageId), payload: { messageId } });
    return { chatId, messageId, state: "answering" as const, key: chatAnswerKey(messageId) };
  });
  await dispatch(deps, sent.key);
  return { chatId: sent.chatId, messageId: sent.messageId, state: sent.state };
}

const personOf = (deps: ChatDeps, personId: string): TChatPerson =>
  ({ personId, displayName: deps.people.get(personId) ?? personId, left: !isCovered(deps.directory, personId) });
const buddyOf = async (q: Query, personId: string) => {
  const buddy = await readBuddy(q, personId);
  return buddy ? { name: buddy.name, form: buddy.form } : null;
};

/** 一段的句子：更正挂在被改伙伴句的 correction 上；问的人这边收回的伙伴句不给正文。 */
function project(rows: Row[], side: "with" | "from", now: Date): TChatMessage[] {
  const corrections = new Map(rows.filter((row) => row.corrects).map((row) => [row.corrects!, row]));
  return rows.filter((row) => !row.corrects).map((row) => {
    const correction = corrections.get(row.id);
    return {
      id: row.id, author: row.author, text: side === "with" && row.retracted_at ? "" : row.body, at: row.created_at.toISOString(), replyTo: row.reply_to,
      sources: row.sources.map((source) => source.label),
      answer: row.answer_state && stuck(row, now) ? "failed" : row.answer_state,
      wait: row.wait_reason ? { reason: row.wait_reason, at: row.wait_at!.toISOString(), closed: row.wait_closed_at !== null } : null,
      seen: row.seen_at !== null, retracted: row.retracted_at !== null,
      correction: correction ? { id: correction.id, text: correction.body, at: correction.created_at.toISOString() } : null,
    };
  });
}

const chatRows = async (q: Query, chatId: string) => (await q("SELECT * FROM colleague_chat_messages WHERE chat_id=$1 ORDER BY seq", [chatId])).rows as Row[];

export async function readChat(deps: ChatDeps, viewer: string, side: "with" | "from", peerId: string): Promise<TChatView> {
  if (viewer === peerId || !isCovered(deps.directory, viewer)) throw noPerson();
  const [asker, owner] = side === "with" ? [viewer, peerId] : [peerId, viewer];
  const chat = (await deps.q("SELECT id FROM colleague_chats WHERE asker_id=$1 AND owner_id=$2", [asker, owner])).rows[0] as { id: string } | undefined;
  if (!chat && (side === "from" || !isCovered(deps.directory, peerId))) throw side === "from" ? noChat() : noPerson();
  const rows = chat ? await chatRows(deps.q, chat.id) : [];
  const firstWaiting = side === "from" ? rows.find((row) => row.answer_state !== null && row.wait_reason !== null && row.wait_closed_at === null)?.id ?? null : null;
  return { id: chat?.id ?? null, side, peer: personOf(deps, peerId), peerBuddy: await buddyOf(deps.q, peerId),
    relation: await relationOf(deps.q, viewer, peerId), messages: project(rows, side, deps.now()), firstWaiting };
}

type ListRow = { id: string; asker_id: string; owner_id: string; author: TChatRow["last"]["author"]; body: string; created_at: Date; unread: boolean; waiting: number };

/** 我去问的（mine）、来问我的（inbound，要我出面的在前）、加好友的请求。看的人不被覆盖就什么都没有。 */
export async function listChats(deps: ChatDeps, viewer: string): Promise<TChatListResponse> {
  if (!isCovered(deps.directory, viewer)) return { mine: [], inbound: [], requests: [] };
  const rows = (await deps.q(`SELECT c.id,c.asker_id,c.owner_id,last.author,last.body,last.created_at,
      (c.asker_id=$1 AND EXISTS (SELECT 1 FROM colleague_chat_messages m LEFT JOIN colleague_chat_messages q ON q.id=m.reply_to
        WHERE m.chat_id=c.id AND m.seq>COALESCE(r.last_seq,0) AND (m.author='owner' OR (m.author='buddy' AND q.author='asker')))) AS unread,
      (SELECT count(*)::int FROM colleague_chat_messages m WHERE m.chat_id=c.id AND m.wait_reason IS NOT NULL AND m.wait_closed_at IS NULL) AS waiting
    FROM colleague_chats c LEFT JOIN colleague_chat_reads r ON r.chat_id=c.id AND r.person_id=$1
    JOIN LATERAL (SELECT seq,author,body,created_at FROM colleague_chat_messages m WHERE m.chat_id=c.id AND m.retracted_at IS NULL ORDER BY m.seq DESC LIMIT 1) last ON true
    WHERE c.asker_id=$1 OR c.owner_id=$1 ORDER BY last.created_at DESC,last.seq DESC`, [viewer])).rows as ListRow[];
  const toRow = async (row: ListRow, peerId: string): Promise<TChatRow> => ({
    id: row.id, peer: personOf(deps, peerId), peerBuddy: await buddyOf(deps.q, peerId),
    last: { author: row.author, text: [...row.body].slice(0, 80).join(""), at: row.created_at.toISOString() }, unread: row.unread, waiting: row.waiting,
  });
  const mine: TChatRow[] = [], inbound: TChatRow[] = [];
  for (const row of rows) {
    if (row.asker_id === viewer) mine.push(await toRow(row, row.owner_id));
    else inbound.push(await toRow(row, row.asker_id));
  }
  inbound.sort((a, b) => Number(b.waiting > 0) - Number(a.waiting > 0));
  const requests = (await listFriendRequests(deps.q, deps.directory, viewer)).map((request) => ({ person: personOf(deps, request.personId), at: request.at }));
  return { mine, inbound, requests };
}

/** 主线留痕：本人从伙伴主线发出的问句最近 50 条，旧的在前；本人自己问的不带原文（主线只留一行），伙伴替他问的带发出去的原文。 */
export async function listMainLines(deps: ChatDeps, viewer: string): Promise<TMainLine[]> {
  if (!isCovered(deps.directory, viewer)) return [];
  const rows = (await deps.q(`SELECT m.id,m.chat_id,c.owner_id,m.author,m.body,m.created_at FROM colleague_chat_messages m JOIN colleague_chats c ON c.id=m.chat_id
    WHERE c.asker_id=$1 AND m.via='main' AND m.author IN ('asker','asker_buddy') ORDER BY m.seq DESC LIMIT 50`, [viewer])).rows as
    { id: string; chat_id: string; owner_id: string; author: TMainLine["author"]; body: string; created_at: Date }[];
  return rows.reverse().map((row) => ({ chatId: row.chat_id, messageId: row.id, peer: personOf(deps, row.owner_id), author: row.author,
    text: row.author === "asker_buddy" ? row.body : null, at: row.created_at.toISOString() }));
}

/** 看的人是这段的问的人或主人、且还被覆盖；否则和没有这段一样。 */
export async function chatFor(deps: ChatDeps, viewer: string, chatId: string): Promise<Chat> {
  const chat = (await deps.q("SELECT id,asker_id,owner_id FROM colleague_chats WHERE id=$1", [chatId])).rows[0] as Chat | undefined;
  if (!chat || (chat.asker_id !== viewer && chat.owner_id !== viewer) || !isCovered(deps.directory, viewer)) throw noChat();
  return chat;
}

/** 读到最新：记 last_seq；主人读时把伙伴句标成他看过。 */
export async function markChatRead(deps: ChatDeps, viewer: string, chatId: string): Promise<void> {
  const chat = await chatFor(deps, viewer, chatId);
  const now = deps.now();
  await deps.q(`INSERT INTO colleague_chat_reads (chat_id,person_id,last_seq,read_at)
    SELECT $1,$2,max(seq),$3 FROM colleague_chat_messages WHERE chat_id=$1
    ON CONFLICT (chat_id,person_id) DO UPDATE SET last_seq=GREATEST(colleague_chat_reads.last_seq,EXCLUDED.last_seq),read_at=EXCLUDED.read_at`, [chatId, viewer, now]);
  if (chat.owner_id === viewer)
    await deps.q("UPDATE colleague_chat_messages SET seen_at=$2 WHERE chat_id=$1 AND author='buddy' AND seen_at IS NULL", [chatId, now]);
}

/** 问的人对这段里的一句动手：锁住这句，交给 work 改。 */
async function askerAction(deps: ChatDeps, viewer: string, chatId: string, messageId: string, work: (q: Query, row: Row, now: Date) => Promise<string | null>) {
  const chat = await chatFor(deps, viewer, chatId);
  if (chat.asker_id !== viewer) throw noChat();
  const key = await transact(deps.pool, async (q) => {
    const row = (await q("SELECT * FROM colleague_chat_messages WHERE id=$1 AND chat_id=$2 FOR UPDATE", [messageId, chatId])).rows[0] as Row | undefined;
    if (!row) throw noChat();
    return work(q, row, deps.now());
  });
  await dispatch(deps, key);
  return readChat(deps, viewer, "with", chat.owner_id);
}

/** 重试：问满的不行；没答上来的（出错或超时）重排，不重扣名额；其余没卡住。 */
export const retryChatMessage = (deps: ChatDeps, viewer: string, chatId: string, messageId: string) => askerAction(deps, viewer, chatId, messageId, async (q, row, now) => {
  if (row.answer_state === "limited") throw new ChatError(409, "CHAT_LIMIT", "今天问满了");
  if (!stuck(row, now)) throw new ChatError(409, "NOT_STUCK", "这句没有卡住");
  const key = `${chatAnswerKey(row.id)}:retry-${now.getTime()}`;
  await q("UPDATE colleague_chat_messages SET answer_state='answering',answer_started_at=$2 WHERE id=$1", [row.id, now]);
  await enqueueJob(q, { kind: CHAT_ANSWER_JOB, dedupeKey: key, payload: { messageId: row.id } });
  return key;
});

/** 问本人：伙伴句挂到它答的问句上。本人回过了不能再点；伙伴答了但说没依据、没把握的改成找本人；在答、没答上来、问满的改成找本人。 */
export const askChatOwner = (deps: ChatDeps, viewer: string, chatId: string, messageId: string) => askerAction(deps, viewer, chatId, messageId, async (q, picked, now) => {
  const row = picked.author === "buddy" && picked.reply_to
    ? (await q("SELECT * FROM colleague_chat_messages WHERE id=$1 AND chat_id=$2 FOR UPDATE", [picked.reply_to, chatId])).rows[0] as Row | undefined
    : picked;
  if (!row || row.answer_state === null) throw noChat();
  if (row.wait_closed_at) throw new ChatError(409, "ALREADY_ANSWERED", "他本人已经回了这句");
  const rewait = row.wait_reason === null || row.wait_reason === "no_basis" || row.wait_reason === "unsure";
  await q(`UPDATE colleague_chat_messages SET wait_reason=CASE WHEN $2::boolean THEN 'asked_owner' ELSE wait_reason END,wait_at=CASE WHEN $2::boolean THEN $3::timestamptz ELSE wait_at END,
    answer_state=CASE WHEN answer_state IN ('answering','failed','limited') THEN 'asked_owner' ELSE answer_state END WHERE id=$1`, [row.id, rewait, now]);
  return null;
});
