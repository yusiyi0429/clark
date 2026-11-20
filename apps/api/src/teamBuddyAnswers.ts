import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AnswerCategory, AnswerInput, ColleagueAnswerAgent, Turn } from "./colleagueAnswerAgent.js";
import type { ScopeReader } from "./colleagueScope.js";
import type { JobHandler } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { buddyAnswerKey, TEAM_BUDDY_ANSWER_JOB, transact, type BuddyAnswerTrigger } from "./teamDeliveries.js";
import { BUDDY_NOT_ANSWERED, latestReply } from "./teamDeliveryInbox.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 同事来问，被问的人的伙伴先答（方案二，R5、R13、R14，补充条款 A7、A8）。只单向引用 teamDeliveries.ts。
 * 材料只从 scopeReader 取；答复落在同一张卡上，来源记成伙伴，不改收件人的 status、done_by。
 */

const PICK_MAX = 6;
const MATERIAL_CHARS = 12_000;
const MATERIALS_CHARS = 48_000;
/** 一次代答（挑材料加作答）整体限时。 */
const ANSWER_TIMEOUT_MS = 90_000;
/** 挑不出能答的材料时自动转本人，卡上和他的等你里写的原因（本人 11/20：资料里没有就自动转本人）。 */
const NO_MATERIALS = "放出来的资料里没有能答的";

/** 「标题（月/日）」，日期按公司时区；没有更新时间的只写标题。 */
const cite = (item: { title: string; updatedAt: string | null }) => {
  if (!item.updatedAt) return item.title;
  const [, month, day] = shanghaiDate(new Date(item.updatedAt)).split("-");
  return `${item.title}（${Number(month)}/${Number(day)}）`;
};

type ColleagueQuestion = { agent: ColleagueAnswerAgent; reader: ScopeReader; asker: string; today: string; thread: Turn[]; ref: string; signal: AbortSignal };
type ColleagueAnswer = { kind: "answer"; text: string; handoff: string | null; sources: string[] };
type ChatExtras = { answer: string; cited: string[]; category: AnswerCategory };

/**
 * 一次代答（不碰库，T8 的评测直接调）。被问的人的名字取 reader.owner.name。empty：目录是空的，或挑出来的一份都读不到。
 * 给了 chat（同事对话）：目录空也挑；挑材料判成寒暄就不带材料作答；pending 交给作答；结果另带 answer（不带出处）、cited（「标题（M/D）」，和 sources 一一对应）、category。
 */
export function answerForColleague(input: ColleagueQuestion & { chat: { pending: string[] } }): Promise<(ColleagueAnswer & ChatExtras) | { kind: "empty" }>;
export function answerForColleague(input: ColleagueQuestion): Promise<ColleagueAnswer | { kind: "empty" }>;
export async function answerForColleague(input: ColleagueQuestion & { chat?: { pending: string[] } }): Promise<(ColleagueAnswer & Partial<ChatExtras>) | { kind: "empty" }> {
  const { agent, reader, asker, today, thread, ref, signal, chat } = input;
  const owner = reader.owner.name;
  const { entries } = await reader.catalog();
  if (!entries.length && !chat) return { kind: "empty" };
  const catalog = entries.map(({ itemId, kind, title, updatedAt, under }) => ({ itemId, kind, title, updatedAt, under }));
  const known = new Set(catalog.map((entry) => entry.itemId));
  const pick = await agent.pick({ owner, asker, today, thread, catalog }, ref, signal);
  const smalltalk = Boolean(chat && pick.smalltalk);
  const picked = smalltalk ? [] : [...new Set(pick.itemIds)].filter((id) => known.has(id)).slice(0, PICK_MAX);
  const materials: AnswerInput["materials"] = [];
  let left = MATERIALS_CHARS;
  for (const id of picked) {
    if (left <= 0) break;
    const read = await reader.read(id, 0, Math.min(MATERIAL_CHARS, left));
    if (!read) continue;
    materials.push({ itemId: read.itemId, kind: read.kind, title: read.title, updatedAt: read.updatedAt, text: read.text, truncated: read.truncated });
    left -= read.text.length;
  }
  if (!materials.length && !smalltalk) return { kind: "empty" };
  const candidate = await agent.answer({ owner, asker, today, thread, pending: chat?.pending ?? [], materials }, ref, signal);
  const used = [...new Set(candidate.sources)].filter((id) => materials.some((item) => item.itemId === id));
  const cited = used.map((id) => cite(materials.find((item) => item.itemId === id)!));
  return { kind: "answer", text: cited.length ? `${candidate.answer}\n\n出处：${cited.join("；")}` : candidate.answer,
    handoff: candidate.handoff ? candidate.reason : null, sources: used, ...(chat ? { answer: candidate.answer, cited, category: candidate.category } : {}) };
}

export type BuddyAnswerDeps = { pool: Pool; now: () => Date; people: () => ReadonlyMap<string, string>; reader: (ownerId: string) => ScopeReader;
  agent: ColleagueAnswerAgent };

const sha = (input: string) => createHash("sha256").update(input).digest("hex");
/** 同一个触发只落一条伙伴答复：client_id 由去重键算出（重试的作业也用同一个）。 */
export const clientIdOf = (key: string) => {
  const hex = sha(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * 这位收件人还在等伙伴答这一次：是征集、他是收件人、在「伙伴在答」、他那段往来最新一条（更正不算）正是触发的那条（首问是还没有回复）。
 * 连着追问两次时，第一次的作业到这里就不是最新一条了，什么都不写；在答时被问的人更正了旧答复，照常答。
 */
async function waiting(q: Query, trigger: BuddyAnswerTrigger, lock: boolean) {
  const row = (await q(`SELECT r.initiator_id,r.body,r.sent_at,rr.buddy_asked_at,latest.id AS latest
    FROM requests r JOIN request_recipients rr ON rr.request_id=r.id LEFT JOIN LATERAL (${latestReply("r.id", "rr.person_id")}) latest ON true
    WHERE r.id=$1 AND r.team_kind='question' AND rr.person_id=$2 AND rr.team_delivery_error IS NULL AND rr.buddy_state='answering'
    ${lock ? "FOR UPDATE OF rr" : ""}`, [trigger.requestId, trigger.recipientId])).rows[0] as
    { initiator_id: string; body: string; sent_at: Date; buddy_asked_at: Date; latest: string | null } | undefined;
  return row && row.latest === trigger.triggerId ? row : null;
}

/** 给模型的往来：原问题，之后这位收件人那段的每条回复按先后（追问、补充说明是问的人；伙伴答的是伙伴；其余是被问的人本人）。 */
async function threadOf(q: Query, trigger: BuddyAnswerTrigger, start: { body: string; sent_at: Date }): Promise<Turn[]> {
  const rows = (await q("SELECT status,origin,body,created_at FROM team_delivery_replies WHERE request_id=$1 AND recipient_id=$2 ORDER BY seq",
    [trigger.requestId, trigger.recipientId])).rows as { status: string; origin: string; body: string; created_at: Date }[];
  return [{ by: "asker", text: start.body, at: start.sent_at.toISOString() }, ...rows.map((row): Turn => ({
    by: row.origin === "buddy" ? "buddy" : row.status === "follow_up" || row.status === "clarification" ? "asker" : "owner",
    text: row.body, at: row.created_at.toISOString() }))];
}

const isTrigger = (payload: unknown): payload is BuddyAnswerTrigger => {
  const value = payload as Partial<BuddyAnswerTrigger> | null;
  return typeof value?.requestId === "string" && /^[0-9a-f-]{36}$/i.test(value.requestId) && typeof value.recipientId === "string"
    && (value.triggerId === null || typeof value.triggerId === "string");
};

/** 一次代答整体限时：到点就中止，并以超时失败。 */
export async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const cause = new Error("代答超时"); controller.abort(cause); reject(cause); }, ms);
  });
  try { return await Promise.race([work(controller.signal), timeout]); } finally { clearTimeout(timer); }
}

/**
 * team.buddy-answer 的处理：人和关系从库里重读，不信载荷以外的东西。模型出错、超时由这里落「没答上来」（不进被问的人的等你，
 * 问的人可以重试或问本人），不靠作业的退避重试；挑不出能答的材料直接转本人（进他的等你）。答出来的在一个事务里重查条件再落。
 * 落「没答上来」、转本人和落答复都比对作业开始时的 buddy_asked_at：问的人在这期间点了重试（换了一轮），旧作业什么都不写。
 */
export function teamBuddyAnswerJobs(deps: BuddyAnswerDeps): Record<string, JobHandler> {
  const q: Query = deps.pool.query.bind(deps.pool);
  const settle = (trigger: BuddyAnswerTrigger, askedAt: Date, state: "failed" | "handoff", note: string) => q("UPDATE request_recipients " +
    "SET buddy_state=$3,buddy_note=$4 WHERE request_id=$1 AND person_id=$2 AND buddy_state='answering' AND buddy_asked_at=$5",
  [trigger.requestId, trigger.recipientId, state, note, askedAt]);
  return {
    [TEAM_BUDDY_ANSWER_JOB]: async (payload) => {
      if (!isTrigger(payload)) return;
      const trigger = { requestId: payload.requestId, recipientId: payload.recipientId, triggerId: payload.triggerId };
      const start = await waiting(q, trigger, false);
      if (!start) return;
      const names = deps.people();
      const askedAt = start.buddy_asked_at;
      const thread = await threadOf(q, trigger, start);
      let result: Awaited<ReturnType<typeof answerForColleague>>;
      try {
        result = await within(ANSWER_TIMEOUT_MS, (signal) => answerForColleague({ agent: deps.agent, reader: deps.reader(trigger.recipientId),
          asker: names.get(start.initiator_id) ?? start.initiator_id, today: shanghaiDate(deps.now()), thread, ref: trigger.requestId, signal }));
      } catch (cause) {
        logEvent({ event: "team.buddy_answer_failed", requestId: trigger.requestId, error: cause instanceof Error ? cause.message : String(cause) });
        await settle(trigger, askedAt, "failed", BUDDY_NOT_ANSWERED);
        return;
      }
      if (result.kind === "empty") { await settle(trigger, askedAt, "handoff", NO_MATERIALS); return; }
      const { text, handoff } = result;
      await transact(deps.pool, async (tq) => {
        const still = await waiting(tq, trigger, true);
        if (still?.buddy_asked_at.getTime() !== askedAt.getTime()) return;
        // fingerprint 照 replyTeamDelivery 的算法（没有附件）。
        const fingerprint = sha(JSON.stringify(["answered", trigger.recipientId, text, [], []]));
        const inserted = await tq(`INSERT INTO team_delivery_replies(id,request_id,recipient_id,author_id,client_id,fingerprint,status,body,created_at,origin)
          VALUES($1,$2,$3,$3,$4,$5,'answered',$6,$7,'buddy') ON CONFLICT DO NOTHING`,
        [randomUUID(), trigger.requestId, trigger.recipientId, clientIdOf(buddyAnswerKey(trigger)), fingerprint, text, deps.now()]);
        if (!inserted.rowCount) return;
        await tq("UPDATE request_recipients SET buddy_state=$3,buddy_note=$4 WHERE request_id=$1 AND person_id=$2",
          [trigger.requestId, trigger.recipientId, handoff ? "handoff" : "answered", handoff]);
      });
    },
  };
}
