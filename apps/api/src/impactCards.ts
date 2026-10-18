import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  TImpactAction, TImpactAskWho, TImpactCardView, TImpactConfidence, TImpactPlanWrite, TImpactSource, TImpactTarget, TRequestStep,
} from "@warmap/contracts";
import type { FeishuNotify } from "./feishu/notify.js";
import type { ImpactAgent } from "./impactAgent.js";
import { decisionStatement, type MeetingDecisionRow } from "./meetingDecisionView.js";
import { impactCandidates, type InterpretationContext } from "./meetingContext.js";
import type { Query } from "./meetingStore.js";
import { insertNotification } from "./notifications.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 影响卡的落库、推送、读取、追问与「和我无关」。
 * 推送复用送达通道：delivered 的卡对应一条 kind = impact 的请求（发起人是拍板的人：主持人，战略项是 CEO；接收人是收卡的人），
 * 通知栏用 request_received，飞书通知用 feishu.notify。影子卡（shadow）只落库，不建请求、不打扰人。
 */
export type ImpactCardRow = {
  id: string; person_id: string; trigger_kind: "meeting_decision"; trigger_id: string; trigger_revision: number; meeting_id: string | null;
  status: TImpactCardView["status"]; title: string; impact: string; action: TImpactAction; targets: TImpactTarget[]; why: string;
  sources: TImpactSource[]; ask_who: TImpactAskWho[]; confidence: TImpactConfidence; agent_judged: boolean;
  correction_of: string | null; correction_note: string | null; request_id: string | null;
  plan_write: Omit<TImpactPlanWrite, "status"> | null; plan_status: TImpactPlanWrite["status"] | null;
  irrelevant_reason: string | null; irrelevant_at: Date | null; created_at: Date; updated_at: Date;
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

/**
 * 一版卡同一个事务里落库并推送：live 且置信度不是 low 的推送（建请求、通知、飞书），其余记成影子卡。
 * 同一个人、同一个触发、同一版只出一张（唯一约束兜底，重放不重复推）。
 */
export async function insertImpactCards(client: PoolClient, input: {
  decision: Pick<MeetingDecisionRow, "id" | "revision" | "meeting_id" | "statement" | "final_statement">;
  initiatorId: string;
  cards: NewImpactCard[];
  mode: "live" | "shadow";
  notify?: FeishuNotify;
  pathFor: (personId: string, kind: "request" | "meeting", id: string) => string;
  meetingTitle: string;
}): Promise<ImpactCardRow[]> {
  const inserted: ImpactCardRow[] = [];
  for (const card of input.cards) {
    const live = input.mode === "live" && card.confidence !== "low";
    const id = randomUUID();
    let requestId: string | null = null;
    if (live) {
      requestId = randomUUID();
      await client.query(
        `INSERT INTO requests (id, kind, initiator_id, prompt, title, body, status, sent_at) VALUES ($1, 'impact', $2, $3, $4, $5, 'open', now())`,
        [requestId, input.initiatorId, decisionStatement(input.decision).slice(0, 2000), card.title.slice(0, 200), impactRequestBody(card).slice(0, 20000)],
      );
      await client.query("INSERT INTO request_recipients (request_id, person_id) VALUES ($1, $2)", [requestId, card.person_id]);
    }
    const row = await client.query<ImpactCardRow>(
      `INSERT INTO impact_cards (id, person_id, trigger_kind, trigger_id, trigger_revision, meeting_id, status, title, impact, action, targets, why, sources, ask_who,
         confidence, agent_judged, correction_of, correction_note, request_id)
       VALUES ($1, $2, 'meeting_decision', $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18)
       ON CONFLICT (person_id, trigger_kind, trigger_id, trigger_revision) DO NOTHING RETURNING *`,
      [id, card.person_id, input.decision.id, input.decision.revision, input.decision.meeting_id, live ? "delivered" : "shadow",
        card.title, card.impact, JSON.stringify(card.action), JSON.stringify(card.targets), card.why, JSON.stringify(card.sources),
        JSON.stringify(card.ask_who), card.confidence, card.agent_judged, card.correction_of, card.correction_note, requestId],
    );
    if (!row.rowCount) {
      if (requestId) await client.query("DELETE FROM requests WHERE id = $1", [requestId]);
      continue;
    }
    inserted.push(row.rows[0]);
    if (!requestId) continue;
    await insertNotification(client, { personId: card.person_id, kind: "request_received", objectType: "request", objectId: requestId, actorId: input.initiatorId });
    await input.notify?.({
      personId: card.person_id,
      title: card.correction_of ? `更正 · ${card.title}` : card.title,
      body: `${impactRequestBody({ ...card, correction_note: card.correction_note })}\n\n来自会议「${input.meetingTitle}」`,
      links: [{ label: "查看", path: input.pathFor(card.person_id, "request", requestId) }],
    }, `impact:${row.rows[0].id}`);
  }
  return inserted;
}

export function projectImpactCard(row: ImpactCardRow, ctx: {
  decision: MeetingDecisionRow; meetingTitle: string; ceoId: string; superseded: boolean;
  questions: { id: string; question: string; answer: string | null; created_at: Date }[];
}): TImpactCardView {
  const decidedBy = ctx.decision.tier === "strategic" ? "ceo" : ctx.decision.status === "agent_judged" ? "agent" : "host";
  return {
    id: row.id, status: row.status, title: row.title, impact: row.impact, action: row.action, targets: row.targets, why: row.why,
    sources: row.sources, askWho: row.ask_who,
    trigger: { kind: "meeting_decision", id: ctx.decision.id, revision: row.trigger_revision, meetingId: ctx.decision.meeting_id,
      meetingTitle: ctx.meetingTitle, statement: decisionStatement(ctx.decision), tier: ctx.decision.tier, decidedBy },
    // 现在仍是代判（主持人后来确认了就不再标）。
    agentJudged: ctx.decision.status === "agent_judged",
    correction: row.correction_of && row.correction_note ? { of: row.correction_of, note: row.correction_note } : null,
    superseded: ctx.superseded,
    confidence: row.confidence,
    planWrite: row.plan_write && row.plan_status ? { ...row.plan_write, status: row.plan_status } : null,
    questions: ctx.questions.map((item) => ({ id: item.id, question: item.question, answer: item.answer, createdAt: item.created_at.toISOString() })),
    requestId: row.request_id,
    createdAt: row.created_at.toISOString(),
  };
}

async function viewOf(q: Query, row: ImpactCardRow): Promise<TImpactCardView | null> {
  const decision = (await q("SELECT * FROM meeting_decisions WHERE id = $1", [row.trigger_id])).rows[0] as MeetingDecisionRow | undefined;
  if (!decision) return null;
  const meeting = (await q("SELECT title, ceo_participant_id FROM meetings WHERE id = $1", [decision.meeting_id])).rows[0] as { title: string; ceo_participant_id: string };
  const superseded = Boolean((await q("SELECT 1 FROM impact_cards WHERE correction_of = $1 LIMIT 1", [row.id])).rowCount);
  const questions = row.request_id
    ? (await q("SELECT id::text, question, answer, created_at FROM request_questions WHERE request_id = $1 ORDER BY created_at, id", [row.request_id])).rows
    : [];
  return projectImpactCard(row, { decision, meetingTitle: meeting.title, ceoId: meeting.ceo_participant_id, superseded, questions: questions as never });
}

/** 收卡的人读自己的卡（按请求 id）：打开即把这条请求的通知标为已读。 */
export async function readImpactCardByRequest(q: Query, requestId: string, viewerId: string): Promise<TImpactCardView | null> {
  if (!UUID.test(requestId)) return null;
  const row = (await q("SELECT * FROM impact_cards WHERE request_id = $1 AND person_id = $2", [requestId, viewerId])).rows[0] as ImpactCardRow | undefined;
  if (!row) return null;
  await q("UPDATE notifications SET read_at = now() WHERE person_id = $1 AND object_type = 'request' AND object_id = $2 AND read_at IS NULL", [viewerId, requestId]);
  return viewOf(q, row);
}

async function ownCard(q: Query, cardId: string, viewerId: string): Promise<ImpactCardRow | null> {
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
  if (row.request_id) {
    await q(`UPDATE request_recipients SET status = 'done', done_by = $2, done_at = now() WHERE request_id = $1 AND person_id = $2 AND status = 'pending'`, [row.request_id, viewerId]);
    await q(`UPDATE requests SET status = 'done', updated_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM request_recipients WHERE request_id = $1 AND status = 'pending')`, [row.request_id]);
  }
  return viewOf(q, updated ?? row);
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
  const decision = (await q("SELECT * FROM meeting_decisions WHERE id = $1", [row.trigger_id])).rows[0] as MeetingDecisionRow;
  const meeting = (await q("SELECT title FROM meetings WHERE id = $1", [decision.meeting_id])).rows[0] as { title: string };
  const previous = (await q("SELECT question, answer FROM request_questions WHERE request_id = $1 ORDER BY created_at, id", [row.request_id])).rows as { question: string; answer: string | null }[];
  const person = (await impactCandidates(q, await input.context(), input.names)).find((candidate) => candidate.personId === input.viewerId) ?? null;
  let answer: string;
  try {
    answer = (await agent.answer({
      today: shanghaiDate(input.now), question: input.question,
      card: { title: row.title, impact: row.impact, action: row.action, why: row.why, targets: row.targets.map((target) => ({ type: target.type, title: target.title })) },
      decision: { statement: decisionStatement(decision), meetingTitle: meeting.title, quote: decision.quote, speaker: decision.speaker_id ? input.names.get(decision.speaker_id) ?? null : null,
        decidedBy: decision.tier === "strategic" ? "CEO" : decision.status === "agent_judged" ? "Agent 代判，主持人尚未确认" : "主持人" },
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
