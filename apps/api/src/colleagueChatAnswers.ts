import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { HANDOFF_CATEGORIES, type AnswerCategory, type ColleagueAnswerAgent, type Turn } from "./colleagueAnswerAgent.js";
import { CHAT_ANSWER_JOB, chatAnswerKey, chatAccess } from "./colleagueChats.js";
import type { ScopeReader } from "./colleagueScope.js";
import type { JobHandler } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { maskSecrets } from "./secretPatterns.js";
import { answerForColleague, clientIdOf, within } from "./teamBuddyAnswers.js";
import { transact } from "./dbTransaction.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 同事对话里被问的人的伙伴逐句作答（colleague.chat-answer，设计稿第 2、4 节）。复用 answerForColleague；
 * 每一轮按来源重新核对往来：收回的、改过的、出处已不在可读范围里的伙伴句不进模型。授权在作答前、落答复时各查一次。
 */
export const THREAD_TURNS = 12;
export const TURN_CHARS = 2000;
export const SENSITIVE_REPLY = "这件事我说不了";
export const NO_BASIS_REPLY = "他放出来的资料里没有能答的";
/** 一次作答（挑材料加作答）整体限时。 */
const ANSWER_TIMEOUT_MS = 90_000;

export type ChatAnswerDeps = { pool: Pool; now: () => Date; directory: PeopleDirectory; people: () => ReadonlyMap<string, string>;
  reader: (ownerId: string) => ScopeReader; agent: ColleagueAnswerAgent };

type Message = { id: string; seq: string; author: "asker" | "asker_buddy" | "buddy" | "owner"; body: string; created_at: Date; corrects: string | null;
  sources: { itemId: string; label: string }[]; retracted_at: Date | null; answer_state: string | null; wait_reason: string | null; wait_closed_at: Date | null };
type Question = { id: string; chat_id: string; seq: string; author: "asker" | "asker_buddy"; answer_state: string | null; answer_started_at: Date | null;
  wait_reason: string | null; asker_id: string; owner_id: string };

const question = async (q: Query, messageId: string, lock: boolean) => (await q(`SELECT m.id,m.chat_id,m.seq,m.author,m.answer_state,m.answer_started_at,m.wait_reason,
    c.asker_id,c.owner_id FROM colleague_chat_messages m JOIN colleague_chats c ON c.id=m.chat_id WHERE m.id=$1 ${lock ? "FOR UPDATE OF m" : ""}`,
[messageId])).rows[0] as Question | undefined;

/**
 * 给模型的往来：触发句和它之前最近的 THREAD_TURNS - 1 句，旧的在前，每句截 TURN_CHARS。被改过的伙伴句换成那句更正（本人说的）；
 * 收回的、出处已不在目录里的伙伴句和问满的问句不取。pending：这段里还等本人回的问句。
 */
async function threadOf(q: Query, trigger: Question, catalog: ReadonlySet<string>): Promise<{ thread: Turn[]; pending: string[] }> {
  const rows = (await q("SELECT * FROM colleague_chat_messages WHERE chat_id=$1 ORDER BY seq", [trigger.chat_id])).rows as Message[];
  const corrections = new Map(rows.filter((row) => row.corrects).map((row) => [row.corrects!, row]));
  const turn = (by: Turn["by"], row: Message): Turn => ({ by, text: row.body.slice(0, TURN_CHARS), at: row.created_at.toISOString() });
  const thread = rows.filter((row) => BigInt(row.seq) <= BigInt(trigger.seq) && !row.corrects).flatMap((row): Turn[] => {
    if (row.author === "buddy") {
      const correction = corrections.get(row.id);
      if (correction) return [turn("owner", correction)];
      if (row.retracted_at || row.sources.some((source) => !catalog.has(source.itemId))) return [];
    }
    if (row.answer_state === "limited") return [];
    return [turn(row.author, row)];
  }).slice(-THREAD_TURNS);
  const pending = rows.filter((row) => row.answer_state !== null && row.wait_reason !== null && row.wait_closed_at === null).map((row) => row.body);
  return { thread, pending };
}

const isPayload = (payload: unknown): payload is { messageId: string } => {
  const value = payload as { messageId?: unknown } | null;
  return typeof value?.messageId === "string" && /^[0-9a-f-]{36}$/i.test(value.messageId);
};

/**
 * colleague.chat-answer 的处理：问句不在答（问本人、重试换了一轮、已答）就不动。没授权、模型出错或超时落「没答上来」，不进被问的人的等你；
 * 答出来的在一个事务里锁住问句重查状态、开始时间和授权再落伙伴句。要本人来的类别只在问的人自己问时开等待。
 */
export function colleagueChatAnswerJobs(deps: ChatAnswerDeps): Record<string, JobHandler> {
  const q: Query = deps.pool.query.bind(deps.pool);
  return {
    [CHAT_ANSWER_JOB]: async (payload) => {
      if (!isPayload(payload)) return;
      const start = await question(q, payload.messageId, false);
      if (start?.answer_state !== "answering" || !start.answer_started_at) return;
      const startedAt = start.answer_started_at;
      const fail = () => q("UPDATE colleague_chat_messages SET answer_state='failed' WHERE id=$1 AND answer_state='answering' AND answer_started_at=$2",
        [start.id, startedAt]);
      if (!(await chatAccess(q, deps.directory, start, start.author)).allowed) { await fail(); return; }
      const reader = deps.reader(start.owner_id);
      // 伙伴句的正文、出处、类别：挑不出能答的写 NO_BASIS_REPLY，敏感的写 SENSITIVE_REPLY、不留出处。
      let reply: [string, { itemId: string; label: string }[], AnswerCategory];
      try {
        reply = await within(ANSWER_TIMEOUT_MS, async (signal) => {
          const catalog = new Set((await reader.catalog()).entries.map((entry) => entry.itemId));
          const { thread, pending } = await threadOf(q, start, catalog);
          const result = await answerForColleague({ agent: deps.agent, reader, asker: deps.people().get(start.asker_id) ?? start.asker_id,
            today: shanghaiDate(deps.now()), thread, ref: start.id, signal, chat: { pending } });
          return result.kind === "empty" ? [NO_BASIS_REPLY, [], "no_basis"]
            : result.category === "sensitive" ? [SENSITIVE_REPLY, [], "sensitive"]
            : [maskSecrets(result.answer), result.sources.map((itemId, index) => ({ itemId, label: result.cited[index] })), result.category];
        });
      } catch (cause) {
        logEvent({ event: "colleague.chat_answer_failed", messageId: start.id, error: cause instanceof Error ? cause.message : String(cause) });
        await fail();
        return;
      }
      const [body, sources, category] = reply;
      await transact(deps.pool, async (tq) => {
        const still = await question(tq, start.id, true);
        if (still?.answer_state !== "answering" || still.answer_started_at?.getTime() !== startedAt.getTime()) return;
        if (!(await chatAccess(tq, deps.directory, still, still.author)).allowed) {
          await tq("UPDATE colleague_chat_messages SET answer_state='failed' WHERE id=$1", [still.id]);
          return;
        }
        const now = deps.now();
        const inserted = await tq(`INSERT INTO colleague_chat_messages (id,chat_id,author,body,client_id,created_at,reply_to,sources,category)
          VALUES ($1,$2,'buddy',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [randomUUID(), still.chat_id, body, clientIdOf(chatAnswerKey(still.id)), now, still.id, JSON.stringify(sources), category]);
        if (!inserted.rowCount) return;
        const wait = HANDOFF_CATEGORIES.has(category) && still.author === "asker" && still.wait_reason === null;
        await tq("UPDATE colleague_chat_messages SET answer_state='answered',wait_reason=COALESCE(wait_reason,$2),wait_at=COALESCE(wait_at,$3) WHERE id=$1",
          [still.id, wait ? category : null, wait ? now : null]);
        // 读取记录（补充条款 A3），照 buddyActions.ts read_colleague_material：同一读者、主人、份、天只留一行。
        for (const source of sources)
          await tq(`INSERT INTO colleague_reads(reader_id,owner_id,item_id,read_on,read_at) VALUES($1,$2,$3,($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,$4)
            ON CONFLICT (reader_id,owner_id,item_id,read_on) DO UPDATE SET read_at=EXCLUDED.read_at`, [still.asker_id, still.owner_id, source.itemId, now]);
        await tq("UPDATE colleague_chats SET last_message_at=$2 WHERE id=$1", [still.chat_id, now]);
      });
    },
  };
}
