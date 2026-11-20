import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AnswerInput, ColleagueAnswerAgent, Turn } from "./colleagueAnswerAgent.js";
import type { ScopeReader } from "./colleagueScope.js";
import type { JobHandler } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { buddyAnswerKey, TEAM_BUDDY_ANSWER_JOB, transact, type BuddyAnswerTrigger } from "./teamDeliveries.js";
import { BUDDY_NOT_ANSWERED } from "./teamDeliveryInbox.js";
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
const NO_MATERIALS = "没有可读的资料";

/** 「标题（月/日）」，日期按公司时区；没有更新时间的只写标题。 */
const cite = (item: { title: string; updatedAt: string | null }) => {
  if (!item.updatedAt) return item.title;
  const [, month, day] = shanghaiDate(new Date(item.updatedAt)).split("-");
  return `${item.title}（${Number(month)}/${Number(day)}）`;
};

/** 一次代答（不碰库，T8 的评测直接调）。被问的人的名字取 reader.owner.name。empty：目录是空的，或挑出来的一份都读不到。 */
export async function answerForColleague(input: { agent: ColleagueAnswerAgent; reader: ScopeReader; asker: string; today: string; thread: Turn[]; ref: string;
  signal: AbortSignal }): Promise<{ kind: "answer"; text: string; handoff: string | null; sources: string[] } | { kind: "empty" }> {
  const { agent, reader, asker, today, thread, ref, signal } = input;
  const owner = reader.owner.name;
  const { entries } = await reader.catalog();
  if (!entries.length) return { kind: "empty" };
  const catalog = entries.map(({ itemId, kind, title, updatedAt }) => ({ itemId, kind, title, updatedAt }));
  const known = new Set(catalog.map((entry) => entry.itemId));
  const picked = [...new Set((await agent.pick({ owner, asker, today, thread, catalog }, ref, signal)).itemIds)].filter((id) => known.has(id)).slice(0, PICK_MAX);
  const materials: AnswerInput["materials"] = [];
  let left = MATERIALS_CHARS;
  for (const id of picked) {
    if (left <= 0) break;
    const read = await reader.read(id, 0, Math.min(MATERIAL_CHARS, left));
    if (!read) continue;
    materials.push({ itemId: read.itemId, kind: read.kind, title: read.title, updatedAt: read.updatedAt, text: read.text, truncated: read.truncated });
    left -= read.text.length;
  }
  if (!materials.length) return { kind: "empty" };
  const candidate = await agent.answer({ owner, asker, today, thread, materials }, ref, signal);
  const used = [...new Set(candidate.sources)].filter((id) => materials.some((item) => item.itemId === id));
  const cited = used.map((id) => cite(materials.find((item) => item.itemId === id)!));
  return { kind: "answer", text: cited.length ? `${candidate.answer}\n\n出处：${cited.join("；")}` : candidate.answer,
    handoff: candidate.handoff ? candidate.reason : null, sources: used };
}

export type BuddyAnswerDeps = { pool: Pool; now: () => Date; people: () => ReadonlyMap<string, string>; reader: (ownerId: string) => ScopeReader;
  agent: ColleagueAnswerAgent };

const sha = (input: string) => createHash("sha256").update(input).digest("hex");
/** 同一个触发只落一条伙伴答复：client_id 由去重键算出（重试的作业也用同一个）。 */
const clientIdOf = (key: string) => {
  const hex = sha(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** 这位收件人还在等伙伴答这一次：是征集、他是收件人、在「伙伴在答」、他那段往来最新一条正是触发的那条（首问是还没有回复）。 */
async function waiting(q: Query, trigger: BuddyAnswerTrigger, lock: boolean) {
  const row = (await q(`SELECT r.initiator_id,r.body,r.sent_at,
      (SELECT p.id FROM team_delivery_replies p WHERE p.request_id=r.id AND p.recipient_id=rr.person_id ORDER BY p.seq DESC LIMIT 1) AS latest
    FROM requests r JOIN request_recipients rr ON rr.request_id=r.id
    WHERE r.id=$1 AND r.team_kind='question' AND rr.person_id=$2 AND rr.team_delivery_error IS NULL AND rr.buddy_state='answering'
    ${lock ? "FOR UPDATE OF rr" : ""}`, [trigger.requestId, trigger.recipientId])).rows[0] as
    { initiator_id: string; body: string; sent_at: Date; latest: string | null } | undefined;
  return row && row.latest === trigger.triggerId ? row : null;
}

const isTrigger = (payload: unknown): payload is BuddyAnswerTrigger => {
  const value = payload as Partial<BuddyAnswerTrigger> | null;
  return typeof value?.requestId === "string" && /^[0-9a-f-]{36}$/i.test(value.requestId) && typeof value.recipientId === "string"
    && (value.triggerId === null || typeof value.triggerId === "string");
};

/** 一次代答整体限时：到点就中止，并以超时失败。 */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const cause = new Error("代答超时"); controller.abort(cause); reject(cause); }, ms);
  });
  try { return await Promise.race([work(controller.signal), timeout]); } finally { clearTimeout(timer); }
}

/**
 * team.buddy-answer 的处理：人和关系从库里重读，不信载荷以外的东西。模型出错、超时、挑不出材料都由这里落「没答上来」（不进被问的人的等你，
 * 问的人可以重试或问本人），不靠作业的退避重试。答出来的在一个事务里重查条件再落。
 */
export function teamBuddyAnswerJobs(deps: BuddyAnswerDeps): Record<string, JobHandler> {
  const q: Query = deps.pool.query.bind(deps.pool);
  const fail = (trigger: BuddyAnswerTrigger, note: string) => q("UPDATE request_recipients SET buddy_state='failed',buddy_note=$3 " +
    "WHERE request_id=$1 AND person_id=$2 AND buddy_state='answering'", [trigger.requestId, trigger.recipientId, note]);
  return {
    [TEAM_BUDDY_ANSWER_JOB]: async (payload) => {
      if (!isTrigger(payload)) return;
      const trigger = { requestId: payload.requestId, recipientId: payload.recipientId, triggerId: payload.triggerId };
      const start = await waiting(q, trigger, false);
      if (!start) return;
      const names = deps.people();
      const thread: Turn[] = [{ by: "asker", text: start.body, at: start.sent_at.toISOString() }];
      let result: Awaited<ReturnType<typeof answerForColleague>>;
      try {
        result = await within(ANSWER_TIMEOUT_MS, (signal) => answerForColleague({ agent: deps.agent, reader: deps.reader(trigger.recipientId),
          asker: names.get(start.initiator_id) ?? start.initiator_id, today: shanghaiDate(deps.now()), thread, ref: trigger.requestId, signal }));
      } catch (cause) {
        logEvent({ event: "team.buddy_answer_failed", requestId: trigger.requestId, error: cause instanceof Error ? cause.message : String(cause) });
        await fail(trigger, BUDDY_NOT_ANSWERED);
        return;
      }
      if (result.kind === "empty") { await fail(trigger, NO_MATERIALS); return; }
      const { text, handoff } = result;
      await transact(deps.pool, async (tq) => {
        if (!(await waiting(tq, trigger, true))) return;
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
