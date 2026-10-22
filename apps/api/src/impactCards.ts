import { randomUUID } from "node:crypto";
import type {
  TImpactAction, TImpactAskWho, TImpactBasisChoice, TImpactCardView, TImpactConfidence, TImpactPlanWrite, TImpactSource, TImpactTarget, TImpactTrigger, TRequestStep,
} from "@warmap/contracts";
import type { ImpactAgent, ImpactAskInput } from "./impactAgent.js";
import { decisionStatement, type MeetingDecisionRow } from "./meetingDecisionView.js";
import { impactCandidates, type InterpretationContext } from "./meetingContext.js";
import type { Query } from "./meetingStore.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 影响卡的读取、追问与「和我无关」。
 * delivered 的卡对应一条 kind = impact 的请求（接收人是收卡的人）。会议决定不再往下推新卡（会后只有会议卡一个入口）；
 * 旧会议推过的卡照旧能读、追问；文档变更卡的落库在 docChanges.ts。
 */
/** 文档变更卡（trigger_kind = doc_change）：这个人依据的旧文档、确认依据时的版本，推送时的作者与确认人。 */
export type ImpactDocBasis = {
  key: string; relation: "revision" | "supersede"; title: string; url: string | null; revision: string | null; revisedAt: string | null;
  authorName: string; decidedByName: string;
};
export type ImpactCardRow = {
  id: string; person_id: string; trigger_kind: "meeting_decision" | "doc_change"; trigger_id: string; trigger_revision: number; meeting_id: string | null;
  status: TImpactCardView["status"]; title: string; impact: string; action: TImpactAction; targets: TImpactTarget[]; why: string;
  sources: TImpactSource[]; ask_who: TImpactAskWho[]; confidence: TImpactConfidence; agent_judged: boolean;
  correction_of: string | null; correction_note: string | null; request_id: string | null;
  plan_write: Omit<TImpactPlanWrite, "status"> | null; plan_status: TImpactPlanWrite["status"] | null;
  irrelevant_reason: string | null; irrelevant_at: Date | null; created_at: Date; updated_at: Date;
  doc_basis: ImpactDocBasis | null; basis_choice: TImpactBasisChoice | null;
};
export type NewImpactCard = Pick<ImpactCardRow, "person_id" | "title" | "impact" | "action" | "targets" | "why" | "sources" | "ask_who" | "confidence" | "agent_judged" | "correction_of" | "correction_note">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const step = (label: string, status: TRequestStep["status"], result: string | null = null): TRequestStep => ({ label, status, result });

/** 请求正文：卡面原样，接收人在请求列表、飞书里看到的都是这一段。 */
export function impactRequestBody(card: Pick<NewImpactCard, "impact" | "action" | "correction_note">): string {
  const due = card.action.due ? `（${card.action.due.slice(5).replace("-", "/")} 前）` : "";
  return [
    ...(card.correction_note ? [`**更正**：${card.correction_note}`, ""] : []),
    card.impact,
    "",
    card.action.kind === "do" ? `**要做**：${card.action.text}${due}` : card.action.text,
  ].join("\n");
}

export function projectImpactCard(row: ImpactCardRow, ctx: {
  trigger: TImpactTrigger; agentJudged: boolean; superseded: boolean;
  questions: { id: string; question: string; answer: string | null; created_at: Date }[];
}): TImpactCardView {
  return {
    id: row.id, status: row.status, title: row.title, impact: row.impact, action: row.action, targets: row.targets, why: row.why,
    sources: row.sources, askWho: row.ask_who,
    trigger: ctx.trigger,
    agentJudged: ctx.agentJudged,
    correction: row.correction_of && row.correction_note ? { of: row.correction_of, note: row.correction_note } : null,
    superseded: ctx.superseded,
    confidence: row.confidence,
    planWrite: row.plan_write && row.plan_status ? { ...row.plan_write, status: row.plan_status } : null,
    basisChoice: row.basis_choice,
    questions: ctx.questions.map((item) => ({ id: item.id, question: item.question, answer: item.answer, createdAt: item.created_at.toISOString() })),
    requestId: row.request_id,
    createdAt: row.created_at.toISOString(),
  };
}

type DocChangeTriggerRow = { id: string; title: string; doc_ref: string; effective_on: string | null; transition_until: string | null; keep_existing: boolean | null };

async function docChangeOf(q: Query, id: string): Promise<DocChangeTriggerRow | undefined> {
  return (await q(`SELECT id::text, title, doc_ref, to_char(effective_on, 'YYYY-MM-DD') AS effective_on, to_char(transition_until, 'YYYY-MM-DD') AS transition_until, keep_existing
    FROM doc_changes WHERE id = $1`, [id])).rows[0] as DocChangeTriggerRow | undefined;
}

/** 卡的触发：会上的一条决定，或一次文档变更（修订 / 取代了他依据的旧文档）。 */
async function triggerOf(q: Query, row: ImpactCardRow): Promise<{ trigger: TImpactTrigger; agentJudged: boolean } | null> {
  if (row.trigger_kind === "doc_change") {
    const change = await docChangeOf(q, row.trigger_id);
    if (!change || !row.doc_basis) return null;
    const basis = row.doc_basis;
    return { agentJudged: false, trigger: {
      kind: "doc_change", id: change.id, relation: basis.relation, newDoc: { title: change.title, url: change.doc_ref },
      oldDoc: { title: basis.title, url: basis.url, revision: basis.revision, revisedAt: basis.revisedAt },
      authorName: basis.authorName, decidedByName: basis.decidedByName,
      effectiveOn: change.effective_on, transitionUntil: change.transition_until, keepExisting: change.keep_existing,
    } };
  }
  const decision = (await q("SELECT * FROM meeting_decisions WHERE id = $1", [row.trigger_id])).rows[0] as MeetingDecisionRow | undefined;
  if (!decision) return null;
  const meeting = (await q("SELECT title FROM meetings WHERE id = $1", [decision.meeting_id])).rows[0] as { title: string };
  const decidedBy = decision.tier === "strategic" ? "ceo" : decision.status === "agent_judged" ? "agent" : "host";
  return {
    trigger: { kind: "meeting_decision", id: decision.id, revision: row.trigger_revision, meetingId: decision.meeting_id,
      meetingTitle: meeting.title, statement: decisionStatement(decision), tier: decision.tier, decidedBy },
    // 现在仍是代判（主持人后来确认了就不再标）。
    agentJudged: decision.status === "agent_judged",
  };
}

/** 文档变更用一句话说清楚：《新》修订 / 取代了《旧》。 */
export function docChangeStatement(basis: Pick<ImpactDocBasis, "relation" | "title">, newTitle: string): string {
  return basis.relation === "revision" ? `《${newTitle}》是《${basis.title}》的新版本` : `《${newTitle}》取代了《${basis.title}》`;
}

export async function impactCardView(q: Query, row: ImpactCardRow): Promise<TImpactCardView | null> {
  const trigger = await triggerOf(q, row);
  if (!trigger) return null;
  const superseded = Boolean((await q("SELECT 1 FROM impact_cards WHERE correction_of = $1 LIMIT 1", [row.id])).rowCount);
  const questions = row.request_id
    ? (await q("SELECT id::text, question, answer, created_at FROM request_questions WHERE request_id = $1 ORDER BY created_at, id", [row.request_id])).rows
    : [];
  return projectImpactCard(row, { ...trigger, superseded, questions: questions as never });
}
const viewOf = impactCardView;

/** 收卡的人读自己的卡（按请求 id）：打开即把这条请求的通知标为已读。 */
export async function readImpactCardByRequest(q: Query, requestId: string, viewerId: string): Promise<TImpactCardView | null> {
  if (!UUID.test(requestId)) return null;
  const row = (await q("SELECT * FROM impact_cards WHERE request_id = $1 AND person_id = $2", [requestId, viewerId])).rows[0] as ImpactCardRow | undefined;
  if (!row) return null;
  await q("UPDATE notifications SET read_at = now() WHERE person_id = $1 AND object_type = 'request' AND object_id = $2 AND read_at IS NULL", [viewerId, requestId]);
  return viewOf(q, row);
}

export async function ownCard(q: Query, cardId: string, viewerId: string): Promise<ImpactCardRow | null> {
  if (!UUID.test(cardId)) return null;
  return ((await q("SELECT * FROM impact_cards WHERE id = $1 AND person_id = $2 AND status <> 'shadow'", [cardId, viewerId])).rows[0] as ImpactCardRow | undefined) ?? null;
}

/** 「和我无关」：卡收起（对应请求标为本人已处理，不通知拍板的人），原因留作质量信号；重复点幂等。 */
export async function markImpactCardIrrelevant(q: Query, cardId: string, viewerId: string, reason: string | undefined): Promise<TImpactCardView | null> {
  const row = await ownCard(q, cardId, viewerId);
  if (!row) return null;
  const updated = (await q(
    `UPDATE impact_cards SET status = 'irrelevant', irrelevant_reason = $3, irrelevant_at = now(), updated_at = now()
      WHERE id = $1 AND person_id = $2 AND status = 'delivered' RETURNING *`,
    [cardId, viewerId, reason?.trim() || null],
  )).rows[0] as ImpactCardRow | undefined;
  if (row.request_id) await closeRequestFor(q, row.request_id, viewerId);
  return viewOf(q, updated ?? row);
}

/** 本人处理完这张卡：对应请求标为本人已处理（不通知发起人）；所有人都处理完时请求收尾。 */
export async function closeRequestFor(q: Query, requestId: string, viewerId: string): Promise<void> {
  await q(`UPDATE request_recipients SET status = 'done', done_by = $2, done_at = now() WHERE request_id = $1 AND person_id = $2 AND status = 'pending'`, [requestId, viewerId]);
  await q(`UPDATE requests SET status = 'done', updated_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM request_recipients WHERE request_id = $1 AND status = 'pending')`, [requestId]);
}

/**
 * 卡上追问：Agent 结合这张卡、这条决定和本人手上的事回答，问答留在卡上（request_questions，答案即时写入，不打扰拍板的人）。
 * 步骤：读卡片 → 查你手上的事 → 回答。
 */
export async function askImpactCard(q: Query, agent: ImpactAgent, input: {
  cardId: string; viewerId: string; question: string; now: Date; names: Map<string, string>; context: () => Promise<InterpretationContext>;
}): Promise<{ steps: TRequestStep[]; card: TImpactCardView } | { error: { status: number; code: string; message: string } } | null> {
  const row = await ownCard(q, input.cardId, input.viewerId);
  if (!row || !row.request_id) return null;
  const source = await askSource(q, row, input.names);
  if (!source) return null;
  const previous = (await q("SELECT question, answer FROM request_questions WHERE request_id = $1 ORDER BY created_at, id", [row.request_id])).rows as { question: string; answer: string | null }[];
  const person = (await impactCandidates(q, await input.context(), input.names)).find((candidate) => candidate.personId === input.viewerId) ?? null;
  let answer: string;
  try {
    answer = (await agent.answer({
      today: shanghaiDate(input.now), question: input.question,
      card: { title: row.title, impact: row.impact, action: row.action, why: row.why, targets: row.targets.map((target) => ({ type: target.type, title: target.title })) },
      decision: source,
      askWho: row.ask_who.map((item) => ({ name: item.displayName, role: item.role })),
      person, previousQuestions: previous.slice(-5),
    }, { cardId: row.id, personId: input.viewerId }, AbortSignal.timeout(60_000))).slice(0, 2000);
  } catch {
    return { error: { status: 503, code: "IMPACT_ASK_FAILED", message: "没有答出来，请重试" } };
  }
  if (!answer) return { error: { status: 503, code: "IMPACT_ASK_FAILED", message: "没有答出来，请重试" } };
  await q(
    `INSERT INTO request_questions (id, request_id, asker_id, question, answer, answered_at, fingerprint) VALUES ($1, $2, $3, $4, $5, now(), $6)`,
    [randomUUID(), row.request_id, input.viewerId, input.question.slice(0, 1000), answer, `impact-ask:${randomUUID()}`],
  );
  const card = await viewOf(q, row);
  return { steps: [step("读卡片", "done"), step("查你手上的事", "done", person ? `${person.tasks.length} 个 Task` : "没查到"), step("回答", "done")], card: card! };
}

/** 追问时交给 Agent 的「这件事」：会上的决定，或文档变更（只有标题与元数据，没有正文）。 */
async function askSource(q: Query, row: ImpactCardRow, names: Map<string, string>): Promise<ImpactAskInput["decision"] | null> {
  if (row.trigger_kind === "doc_change") {
    const change = await docChangeOf(q, row.trigger_id);
    if (!change || !row.doc_basis) return null;
    return { statement: docChangeStatement(row.doc_basis, change.title), meetingTitle: "文档变更", quote: null, speaker: null,
      decidedBy: row.doc_basis.decidedByName === row.doc_basis.authorName ? `作者 ${row.doc_basis.authorName}` : `旧文档负责人 ${row.doc_basis.decidedByName}` };
  }
  const decision = (await q("SELECT * FROM meeting_decisions WHERE id = $1", [row.trigger_id])).rows[0] as MeetingDecisionRow | undefined;
  if (!decision) return null;
  const meeting = (await q("SELECT title FROM meetings WHERE id = $1", [decision.meeting_id])).rows[0] as { title: string };
  return { statement: decisionStatement(decision), meetingTitle: meeting.title, quote: decision.quote, speaker: decision.speaker_id ? names.get(decision.speaker_id) ?? null : null,
    decidedBy: decision.tier === "strategic" ? "CEO" : decision.status === "agent_judged" ? "Agent 代判，主持人尚未确认" : "主持人" };
}
