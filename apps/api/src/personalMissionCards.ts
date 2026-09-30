import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TCard, TCreateMissionCardFeedbackRequest, TMissionCardCorrectionView, TMissionCardFeedbackView, TMissionCardField, TMissionCardGroupView, TMissionCardPayload, TMissionRoundSummary, TPersonalMissionCardMission, TPersonalMissionCardPayload, TThreadMember, TSetMissionCardOwnerConfirmationRequest } from "@warmap/contracts";
import type { MemoryPerson } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { canApprove, closeIfDue, correctionPeriodClosed, getMissionRoundRow, missionCardWriteProblem, pendingMissionCardAnnotations, projectMissionRoundCard, type MissionRoundPerson, type MissionRoundRow } from "./missionRounds.js";
import { fieldText, getMissionRow, projectMissionCard } from "./missions.js";
export { fieldText } from "./missions.js";
import { signActionId } from "./actionToken.js";

type PersonalRow = { id: string; round_id: string; owner_id: string; role_label: string | null; member_ids: string[]; owner_confirmed_at: Date | null };
type FeedbackRow = {
  id: string; seq: string | number; card_id: string; mission_id: string | null; field: TMissionCardField | null;
  kind: "comment" | "quote" | "suggestion"; author_id: string; client_id: string; body: string;
  quote: string | null; proposed: string | null; original: string | null; source_version: number | null;
  basis: "draft" | "candidate"; late: boolean; window_seq: number; created_at: Date;
};
type Review = { id: string; feedback_ids: string[]; superseded_at: Date | null; note: string | null };
type Discussion = { feedback: FeedbackRow[]; review: Review | null; decisions: Map<string, "accept" | "decline">; stale: Set<string> };
export type CorrectionRow = {
  id: string; round_id: string; card_id: string; mission_id: string; field: TMissionCardField;
  original: string; proposed: string; reason: string; author_id: string; client_id: string; direct: boolean;
  status: "pending" | "applied" | "rejected"; decided_by: string | null; decided_at: Date | null; note: string | null;
  applied_version: number | null; created_at: Date;
};
type Failure = { error: { status: number; code: string; message: string } };
const fail = (status: number, code: string, message: string): Failure => ({ error: { status, code, message } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const compact = (text: string) => text.replace(/\s+/g, " ").trim();

/** Stored membership and current approval authority are both checked on every access. */
export async function visiblePersonalMissionCard(q: Query, person: MissionRoundPerson, cardId: string): Promise<{ card: PersonalRow; round: MissionRoundRow } | null> {
  if (!UUID.test(cardId)) return null;
  const card = (await q("SELECT id,round_id,owner_id,role_label,member_ids,owner_confirmed_at FROM personal_mission_cards WHERE id=$1", [cardId])).rows[0] as PersonalRow | undefined;
  const round = card ? await getMissionRoundRow(q, card.round_id) : null;
  return card && round && (card.member_ids.includes(person.personId) || canApprove(person, round)) ? { card, round } : null;
}
function members(card: PersonalRow, people: MemoryPerson[]): TThreadMember[] {
  return card.member_ids.map((personId) => ({ personId, displayName: people.find((p) => p.personId === personId)?.displayName ?? personId, title: personId === card.owner_id ? "卡片负责人" : null }));
}
async function discussion(q: Query, round: MissionRoundRow, cardId: string): Promise<Discussion> {
  const feedback = (await q("SELECT * FROM mission_card_feedback WHERE card_id=$1 ORDER BY seq", [cardId])).rows as FeedbackRow[];
  // During a reopened window the previous verdicts remain visible, while the document is the draft.
  const review = (await q("SELECT id,feedback_ids,superseded_at,note FROM mission_round_reviews WHERE round_id=$1 ORDER BY window_seq DESC LIMIT 1", [round.id])).rows[0] as Review | undefined;
  const decisions = review ? (await q("SELECT feedback_id,decision FROM mission_review_decisions WHERE review_id=$1", [review.id])).rows as { feedback_id: string; decision: "accept" | "decline" }[] : [];
  const stale = new Set<string>();
  for (const item of feedback) if (item.kind === "suggestion" && item.mission_id && item.field) {
    const mission = await getMissionRow(q, item.mission_id);
    if (!mission || fieldText(projectMissionCard(mission, "", new Map()).payload as TMissionCardPayload, item.field) !== item.original) stale.add(item.id);
  }
  return { feedback, review: review ?? null, decisions: new Map(decisions.map((r) => [r.feedback_id, r.decision])), stale };
}
function projectFeedback(item: FeedbackRow, data: Discussion, round: MissionRoundRow, people: MemoryPerson[], person: MissionRoundPerson, secret: string): TMissionCardFeedbackView {
  const decision = data.decisions.get(item.id) ?? null;
  const included = data.review?.feedback_ids.includes(item.id) ?? false;
  let verdict: TMissionCardFeedbackView["verdict"];
  if (round.status === "open" && data.review?.superseded_at && included && decision) {
    verdict = { text: `前次${decision === "decline" ? "未采纳" : item.kind === "suggestion" ? "已采纳" : "已纳入核对"} · 继续讨论时沿用`, tone: decision === "decline" ? "decline" : "accept" };
  } else if (item.late && !included && !(round.status === "open" && (!round.closes_at || item.created_at < round.closes_at))) verdict = { text: "讨论结束后留言 · 待后续审核", tone: "late" };
  else if (decision === "decline") verdict = { text: "未采纳", tone: "decline" };
  else if (decision === "accept") verdict = { text: item.kind !== "suggestion" ? "已纳入核对" : round.status === "confirmed" ? "已采纳" : "已采纳 · 拍板前可能变化", tone: "accept" };
  else if (item.late) verdict = { text: "讨论结束后留言 · 已纳入审核", tone: "wait" };
  else verdict = { text: round.status === "open" ? "讨论中" : "待拍板人处理", tone: round.status === "open" ? "open" : "wait" };
  const actionable = round.status === "reviewing" && included && !data.review?.superseded_at && canApprove(person, round);
  const acceptBlockedReason = item.kind === "suggestion" && data.stale.has(item.id) ? "提交建议后这段正文已修改，不能直接采纳" : item.kind === "suggestion" && included && data.feedback.some((other) => other.id !== item.id && other.kind === "suggestion"
    && other.mission_id === item.mission_id && other.field === item.field && data.review?.feedback_ids.includes(other.id) && data.decisions.get(other.id) === "accept")
    ? "同一字段已采纳另一条" : null;
  return { id: item.id, seq: Number(item.seq), missionId: item.mission_id, field: item.field, kind: item.kind,
    authorId: item.author_id, authorName: people.find((p) => p.personId === item.author_id)?.displayName ?? item.author_id,
    body: item.body, quote: item.quote, proposed: item.proposed, original: item.original, sourceVersion: item.source_version,
    basis: item.basis, late: item.late, round: item.window_seq, createdAt: item.created_at.toISOString(), verdict, decision, acceptBlockedReason,
    actions: actionable ? [{ actionType: "mission-round.decide", itemId: item.id, label: "处理意见", actionId: signActionId(secret, {
      actionType: "mission-round.decide", objectType: "mission-round", objectId: round.id, objectVersion: round.version, itemId: item.id,
    }) }] : [] };
}
/** stale 按当前正文判断：申请之后这个字段又改过，就不能直接采纳。 */
export function projectCorrection(row: CorrectionRow, missions: TPersonalMissionCardMission[], people: MemoryPerson[]): TMissionCardCorrectionView {
  const name = (personId: string) => people.find((p) => p.personId === personId)?.displayName ?? personId;
  const mission = missions.find((item) => item.missionId === row.mission_id);
  return { id: row.id, missionId: row.mission_id, field: row.field, original: row.original, proposed: row.proposed, reason: row.reason,
    authorId: row.author_id, authorName: name(row.author_id), direct: row.direct, status: row.status,
    decidedBy: row.decided_by, decidedByName: row.decided_by ? name(row.decided_by) : null, decidedAt: row.decided_at?.toISOString() ?? null,
    note: row.note, appliedVersion: row.applied_version,
    stale: row.status === "pending" && (!mission || fieldText(mission, row.field) !== row.original), createdAt: row.created_at.toISOString() };
}
async function documentMissions(q: Query, cardId: string, people: MemoryPerson[], secret: string, data: Discussion, candidate: boolean): Promise<TPersonalMissionCardMission[]> {
  const ids = (await q("SELECT id FROM missions WHERE personal_mission_card_id=$1 ORDER BY code,id", [cardId])).rows as { id: string }[];
  const names = new Map(people.map((p) => [p.personId, p.displayName]));
  const selfEdits = (await q(`SELECT DISTINCT r.mission_id,r.field FROM mission_card_revisions r JOIN personal_mission_cards c ON c.id=r.card_id
    WHERE r.card_id=$1 AND r.author_id=c.owner_id`, [cardId])).rows as { mission_id: string; field: TMissionCardField }[];
  const result: TPersonalMissionCardMission[] = [];
  for (const { id } of ids) {
    const row = (await getMissionRow(q, id))!;
    const mission: TPersonalMissionCardMission = { ...(projectMissionCard(row, secret, names).payload as TMissionCardPayload), version: row.version, changedFields: [],
      selfEditedFields: selfEdits.filter((edit) => edit.mission_id === id).map((edit) => edit.field) };
    if (candidate && data.review && !data.review.superseded_at) for (const item of data.feedback) {
      if (item.mission_id !== id || item.kind !== "suggestion" || !item.field || data.decisions.get(item.id) !== "accept" || !data.review.feedback_ids.includes(item.id)) continue;
      // 重开后正文可能变过；失效的旧建议不叠加，原文改回相同内容则仍可沿用。
      if (data.stale.has(item.id)) continue;
      if (item.field === "successEvidence" || item.field === "milestones") mission[item.field] = item.proposed!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      else mission[item.field] = item.proposed!;
      mission.changedFields.push(item.field);
    }
    result.push(mission);
  }
  return result;
}
/** 已确定的卡没有候选叠加：正文就是当前 Mission，更正与页面取同一份原文。 */
export function currentMissions(q: Query, cardId: string, people: MemoryPerson[], secret: string): Promise<TPersonalMissionCardMission[]> {
  return documentMissions(q, cardId, people, secret, { feedback: [], review: null, decisions: new Map(), stale: new Set() }, false);
}

export async function getPersonalMissionCard(q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, cardId: string, now: Date): Promise<TCard | null> {
  const visible = await visiblePersonalMissionCard(q, person, cardId);
  if (!visible) return null;
  const { card, round } = visible;
  const roundCard = await projectMissionRoundCard(q, people, secret, person, round, now);
  const summary = roundCard.payload as TMissionRoundSummary;
  // Draft readers can inspect the already signed basis; only the open action freezes it.
  if ((round.status === "draft" || round.status === "drafting") && !summary.goals) {
    const plan = (await q("SELECT status,battlefields,confirmed_at FROM monthly_plans WHERE id=$1", [round.monthly_plan_id])).rows[0] as { status: string; battlefields: { battlefieldId: string; outcome: string }[]; confirmed_at: Date | null } | undefined;
    const goal = plan?.battlefields.find((item) => item.battlefieldId === round.battlefield_id);
    if (plan?.status === "confirmed" && plan.confirmed_at && goal) summary.goals = {
      sixMonthOutcome: round.six_month_outcome, monthOutcome: goal.outcome, signedAt: plan.confirmed_at.toISOString(),
    };
  }
  const data = await discussion(q, round, cardId);
  const shown = summary.phase === "confirmed" ? "confirmed" : ["closed", "reviewing"].includes(summary.phase) ? "candidate" : "draft";
  const missions = await documentMissions(q, cardId, people, secret, data, shown === "candidate");
  const changed = missions.reduce((count, mission) => count + mission.changedFields.length, 0);
  const corrections = (await q("SELECT * FROM mission_card_corrections WHERE card_id=$1 ORDER BY created_at DESC,id DESC", [cardId])).rows as CorrectionRow[];
  const corrected = corrections.filter((item) => item.status === "applied").length;
  const byName = people.find((p) => p.personId === round.confirmed_by)?.displayName ?? round.confirmed_by;
  const pendingAnnotations = await pendingMissionCardAnnotations(q, round.id, cardId);
  const writeProblem = missionCardWriteProblem(round, card, now);
  const canEdit = !writeProblem && (person.personId === card.owner_id || summary.approver);
  const draftFailure = summary.draftFailures.find((item) => item.ownerId === card.owner_id)?.message ?? null;
  const confirmProblem = person.personId !== card.owner_id ? "请由任务卡本人完成审核" : writeProblem?.message
    ?? (draftFailure || !missions.length ? "草稿尚未完成，请先完成起草" : pendingAnnotations ? "还有待处理的修改批注，请先处理或明确保留备注" : null);
  const status = round.status === "drafting" ? "Co-Agent 正在起草"
    : shown === "confirmed" ? `已确定 · ${byName} ${localTime(round.confirmed_at!)}${corrected ? ` · 更正 ${corrected} 处` : ""}`
    : shown === "candidate" ? `候选版本 · 相比草稿 ${changed} 处改动 · 等${summary.deciderName}拍板`
    : summary.phase === "open" ? card.owner_confirmed_at ? "已完成审核" : "审核中" : `草稿${card.role_label ? ` · ${card.role_label}` : ""}`;
  const closedReason = round.status === "drafting" ? "Co-Agent 正在起草，完成后可讨论修改"
    : round.status !== "confirmed" ? "还没确定：讨论中请用修改建议"
    : correctionPeriodClosed(round, now) ? "月份已过，这张卡只读" : null;
  const payload: TPersonalMissionCardPayload = {
    round: summary,
    draftFailure,
    selfReview: { canConfirm: !confirmProblem, canCancel: person.personId === card.owner_id && round.status === "open" && !!card.owner_confirmed_at
      && (!round.closes_at || round.closes_at > now) && !correctionPeriodClosed(round, now),
      canEdit, blockedReason: confirmProblem, pendingAnnotations },
    annotationAccess: { canCreate: !writeProblem, canApply: canEdit, closedReason: writeProblem?.message ?? null },
    card: { cardId, ownerId: card.owner_id, ownerName: people.find((p) => p.personId === card.owner_id)?.displayName ?? card.owner_id,
      ownerConfirmedAt: card.owner_confirmed_at?.toISOString() ?? null, roleLabel: card.role_label, members: members(card, people), status, shown, missions },
    feedback: data.feedback.map((item) => projectFeedback(item, data, round, people, person, secret)),
    confirmation: round.confirmed_at && round.confirmed_by ? { by: round.confirmed_by,
      byName: people.find((p) => p.personId === round.confirmed_by)?.displayName ?? round.confirmed_by,
      at: round.confirmed_at.toISOString(), note: data.review?.note ?? "" } : null,
    corrections: corrections.map((item) => projectCorrection(item, missions, people)),
    correctionAccess: { canRequest: !closedReason && !summary.approver, canApply: !closedReason && summary.approver, closedReason },
  };
  return { schemaVersion: 1, id: `personal-mission-card:${cardId}`, kind: "personal-mission-card", version: round.version,
    objectRef: { type: "personal-mission-card", id: cardId, version: round.version }, title: `${payload.card.ownerName}的 ${Number(round.period.slice(5))} 月 Mission Card`,
    badge: "Mission Card", payload, conversation: { scope: `mission-card:${cardId}` }, actions: roundCard.actions };
}

/** 本人确认与最后一人触发的汇总共享一把阶段锁，不会认可未读版本或抢在批注写回前冻结。 */
export async function setMissionCardOwnerConfirmation(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson,
  cardId: string, input: TSetMissionCardOwnerConfirmationRequest, now: () => Date): Promise<{ card: TCard } | Failure> {
  const client = await pool.connect(); const q: Query = (sql, params) => client.query(sql, params);
  try {
    await q("BEGIN");
    let visible = await visiblePersonalMissionCard(q, person, cardId);
    const finish = async (problem?: Failure) => {
      await q("COMMIT");
      if (problem) return problem;
      const card = await getPersonalMissionCard(q, people, secret, person, cardId, now());
      return card ? { card } : fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
    };
    if (!visible) return await finish(fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见"));
    await q("SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE", [visible.round.id]);
    visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) return await finish(fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见"));
    const { card, round } = visible;
    if (card.owner_id !== person.personId) return await finish(fail(403, "OWNER_CONFIRMATION_FORBIDDEN", "请由任务卡本人完成审核"));
    if (round.window_seq !== input.round) return await finish(fail(409, "ROUND_CHANGED", "审核已重新开放，请刷新后再完成审核"));
    // 保存成功后网络重试只返回既有状态，即使最后一人已触发汇总也不会再写一遍。
    if (input.confirmed && card.owner_confirmed_at) return await finish();
    if (round.status !== "open" || round.closes_at && round.closes_at <= now())
      return await finish(fail(409, "ROUND_NOT_OPEN", "审核已结束；如需修改，请重新开放审核"));
    if (correctionPeriodClosed(round, now())) return await finish(fail(409, "MISSION_CARD_PERIOD_CLOSED", "月份已过，这张卡只读"));
    if (!input.confirmed && !card.owner_confirmed_at) return await finish();
    if (input.confirmed) {
      const missions = (await q("SELECT id,version FROM missions WHERE personal_mission_card_id=$1 ORDER BY id", [cardId])).rows as { id: string; version: number }[];
      const draft = round.draft_source as { failedOwners?: { ownerId: string }[] } | null;
      if (!missions.length || draft?.failedOwners?.some((owner) => owner.ownerId === card.owner_id))
        return await finish(fail(409, "MISSION_CARD_NOT_READY", "草稿尚未完成，请先完成起草"));
      if (missions.length !== Object.keys(input.missionVersions).length || missions.some((mission) => input.missionVersions[mission.id] !== mission.version))
        return await finish(fail(409, "SOURCE_VERSION_CONFLICT", "正文已变化，请阅读最新版本后再完成审核"));
      if (await pendingMissionCardAnnotations(q, round.id, cardId)) return await finish(fail(409, "ANNOTATIONS_PENDING", "还有待处理的修改批注，请先回答、重试或明确保留备注"));
    }
    const at = now();
    await q("UPDATE personal_mission_cards SET owner_confirmed_at=$2 WHERE id=$1", [cardId, input.confirmed ? at : null]);
    if (input.confirmed) {
      const remaining = (await q("SELECT count(*) AS n FROM personal_mission_cards WHERE round_id=$1 AND owner_confirmed_at IS NULL", [round.id])).rows[0];
      if (!Number(remaining.n)) {
        if (await pendingMissionCardAnnotations(q, round.id)) {
          await q("ROLLBACK");
          return fail(409, "ANNOTATIONS_PENDING", "还有待处理的修改批注，请先处理后再完成审核");
        }
        const updated = (await q("UPDATE mission_rounds SET closes_at=$2 WHERE id=$1 RETURNING *", [round.id, at])).rows[0] as MissionRoundRow;
        await closeIfDue(client, updated, at, true);
      }
    }
    return await finish();
  } catch (error) { await q("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** 修改建议与确认后的更正共用：列表字段逐行 trim、去空行，其余字段整体 trim。 */
export function normalizedProposal(field: TMissionCardField | undefined, proposed: string): string {
  return ["successEvidence", "milestones"].includes(field ?? "") ? proposed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n") : proposed.trim();
}
/** 规范化之后的长度规则：名称最多 200 字；列表最多 30 行，每行不超过 500 字。 */
export function proposalProblem(field: TMissionCardField, proposed: string): string | null {
  if (field === "title" && proposed.length > 200) return "名称最多 200 字";
  if (["successEvidence", "milestones"].includes(field)) {
    const lines = proposed.split("\n");
    if (lines.length > 30 || lines.some((line) => line.length > 500)) return "列表最多 30 行，每行不超过 500 字";
  }
  return null;
}
function normalizedInput(input: TCreateMissionCardFeedbackRequest): TCreateMissionCardFeedbackRequest {
  return { ...input, body: input.body.trim(), ...(input.proposed !== undefined ? { proposed: normalizedProposal(input.field, input.proposed) } : {}) };
}
function inputProblem(input: TCreateMissionCardFeedbackRequest): string | null {
  if (!input.body) return "请填写意见正文";
  if (input.kind === "comment") return input.missionId || input.field || input.quote !== undefined || input.proposed !== undefined || input.sourceVersion !== undefined ? "评论不带字段、引用或修改建议" : null;
  if (!input.missionId || !input.field || input.sourceVersion === undefined) return "引用和建议必须指明个人任务、字段与源版本";
  if (input.kind === "quote") return !input.quote?.trim() || input.proposed !== undefined ? "引用必须包含原文，不能包含修改建议" : null;
  if (!input.proposed || input.quote !== undefined) return "请填写修改建议，不能同时提交引用";
  return proposalProblem(input.field, input.proposed);
}
function sameInput(row: FeedbackRow, cardId: string, input: TCreateMissionCardFeedbackRequest): boolean {
  return row.card_id === cardId && row.kind === input.kind && row.window_seq === input.round && row.body === input.body
    && row.mission_id === (input.missionId ?? null) && row.field === (input.field ?? null) && row.quote === (input.quote ?? null)
    && row.proposed === (input.proposed ?? null) && row.source_version === (input.sourceVersion ?? null);
}

export async function createPersonalMissionCardFeedback(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, cardId: string, request: TCreateMissionCardFeedbackRequest, now: () => Date): Promise<{ feedback: TMissionCardFeedbackView } | Failure> {
  const client = await pool.connect(); const q: Query = (sql, params) => client.query(sql, params);
  const input = normalizedInput(request);
  try {
    await client.query("BEGIN");
    // Serializes retries across cards as well as within one card, matching the global author/client key.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mission-feedback:${person.personId}:${input.clientId}`]);
    let visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) { await client.query("ROLLBACK"); return fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见"); }
    await client.query("SELECT id FROM mission_rounds WHERE id=$1 FOR SHARE", [visible.round.id]);
    visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) { await client.query("ROLLBACK"); return fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见"); }
    let at = now();
    if (visible.round.status === "open" && visible.round.closes_at && visible.round.closes_at <= at) {
      // Release SHARE before taking UPDATE: simultaneous due writers cannot deadlock on lock upgrades.
      await client.query("COMMIT"); await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mission-feedback:${person.personId}:${input.clientId}`]);
      await client.query("SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE", [visible.round.id]);
      visible = await visiblePersonalMissionCard(q, person, cardId);
      if (!visible) { await client.query("ROLLBACK"); return fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见"); }
      at = now(); visible.round = await closeIfDue(client, visible.round, at);
    }
    const { round } = visible;
    const finish = async <T,>(result: T) => { await client.query("COMMIT"); return result; };
    const problem = inputProblem(input);
    if (problem) return await finish(fail(400, "INVALID_FEEDBACK", problem));
    const prior = (await q("SELECT * FROM mission_card_feedback WHERE author_id=$1 AND client_id=$2", [person.personId, input.clientId])).rows[0] as FeedbackRow | undefined;
    if (prior) {
      if (!sameInput(prior, cardId, input)) return await finish(fail(409, "CLIENT_ID_CONFLICT", "同一个 client_id 已提交不同的意见"));
      return await finish({ feedback: projectFeedback(prior, await discussion(q, round, cardId), round, people, person, secret) });
    }
    if (round.status === "draft" || round.status === "drafting") return await finish(fail(409, "ROUND_NOT_OPEN", "讨论还没开放"));
    if (round.status === "confirmed") return await finish(fail(409, "ROUND_CONFIRMED", "本月 Mission Card 已确定，不再收留言"));
    if (round.window_seq !== input.round) return await finish(fail(409, "ROUND_CHANGED", "讨论轮次已变化，请刷新后重新提交"));
    const late = round.status === "reviewing";
    if (late && input.kind === "suggestion") return await finish(fail(409, "ROUND_CLOSED", "截止后不能再提修改建议；需要改动，请由拍板人重新开启讨论"));
    const data = await discussion(q, round, cardId);
    let original: string | null = null;
    if (input.missionId) {
      const mission = (await documentMissions(q, cardId, people, secret, data, late)).find((m) => m.missionId === input.missionId);
      if (!mission) return await finish(fail(404, "MISSION_NOT_FOUND", "个人任务不存在或不属于这张卡"));
      if (mission.version !== input.sourceVersion) return await finish(fail(409, "SOURCE_VERSION_CONFLICT", "页面版本已变化，请刷新后重新提交"));
      original = fieldText(mission, input.field!);
      if (input.kind === "quote" && !compact(original).includes(compact(input.quote!))) return await finish(fail(409, "QUOTE_CHANGED", "引用内容已经变化，请重新划选"));
    }
    const inserted = (await q(`INSERT INTO mission_card_feedback
      (id,round_id,card_id,mission_id,field,kind,author_id,client_id,body,quote,proposed,original,source_version,basis,window_seq,late,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [randomUUID(), round.id, cardId, input.missionId ?? null, input.field ?? null, input.kind, person.personId, input.clientId, input.body,
      input.quote ?? null, input.proposed ?? null, original, input.sourceVersion ?? null, late ? "candidate" : "draft", round.window_seq, late, at])).rows[0] as FeedbackRow;
    return await finish({ feedback: projectFeedback(inserted, data, round, people, person, secret) });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function readState(q: Query, cardId: string, personId: string) {
  const result = (await q(`SELECT COALESCE((SELECT last_read_seq FROM mission_card_reads WHERE card_id=$1 AND person_id=$2),0) AS last_read_seq,
    (SELECT count(*) FROM mission_card_feedback WHERE card_id=$1 AND author_id<>$2
      AND seq>COALESCE((SELECT last_read_seq FROM mission_card_reads WHERE card_id=$1 AND person_id=$2),0)) AS unread`, [cardId, personId])).rows[0];
  return { lastReadSeq: Number(result.last_read_seq), unread: Number(result.unread) };
}
const localTime = (date: Date) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
export async function getPersonalMissionCardGroup(q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, cardId: string, now: Date, after = 0): Promise<TMissionCardGroupView | null> {
  const visible = await visiblePersonalMissionCard(q, person, cardId);
  if (!visible) return null;
  const { card, round } = visible; const data = await discussion(q, round, cardId);
  const entries: TMissionCardGroupView["entries"] = [];
  const names = new Map(people.map((p) => [p.personId, p.displayName]));
  if (round.first_opened_at) {
    const at = round.first_opened_at.toISOString();
    entries.push({ type: "divider", at, text: `${localTime(round.first_opened_at)} · 全战场下发审核` });
    const countRow = (await q("SELECT count(*) AS n,bool_or(placeholder) AS placeholder FROM missions WHERE personal_mission_card_id=$1", [cardId])).rows[0];
    const count = Number(countRow.n);
    const deciderId = round.battlefield_owner_id || people.find((p) => p.roles.includes("ceo"))?.personId || "CEO";
    const previous = Number(round.period.slice(5)) === 1 ? 12 : Number(round.period.slice(5)) - 1;
    const origin = round.draft_origin === "agent" ? "Co-Agent 起草 · 待大家讨论修改。"
      : `占位 · 沿用 ${previous} 月任务卡；仍需讨论修改。`;
    entries.push({ type: "opening", at, text: `审核${names.get(card.owner_id) ?? card.owner_id}的 ${Number(round.period.slice(5))} 月任务（${count} 项）：可以在正文上批注、划词引用并与 Co-Agent 沟通，处理待改批注后完成本人审核。全员完成审核后自动开始汇总，拍板人也可提前开始汇总，最后交${names.get(deciderId) ?? deciderId}拍板。${origin}${round.draft_origin === "agent" && countRow.placeholder ? "这张卡是占位，需重点核对。" : ""}` });
  }
  round.reopens.forEach((reopen) => {
    entries.push({ type: "divider", at: reopen.closedAt, text: `${localTime(new Date(reopen.closedAt))} · 开始汇总` });
    entries.push({ type: "divider", at: reopen.at, text: `${names.get(reopen.by) ?? reopen.by}重新开放审核` });
  });
  if (round.closes_at && round.closes_at <= now) entries.push({ type: "divider", at: round.closes_at.toISOString(), text: `${localTime(round.closes_at)} · 讨论已结束 · 之后的留言待后续审核` });
  if (round.confirmed_at) entries.push({ type: "divider", at: round.confirmed_at.toISOString(), text: `${names.get(round.confirmed_by!) ?? round.confirmed_by}确认了本月 Mission Card` });
  for (const item of data.feedback) if (Number(item.seq) > after) entries.push({ type: "message", feedback: projectFeedback(item, data, round, people, person, secret) });
  const at = (entry: TMissionCardGroupView["entries"][number]) => entry.type === "message" ? entry.feedback.createdAt : entry.at;
  const rank = { divider: 0, opening: 1, message: 2 };
  entries.sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)) || rank[a.type] - rank[b.type]
    || (a.type === "message" && b.type === "message" ? a.feedback.seq - b.feedback.seq : 0));
  return { roundVersion: round.version, members: members(card, people), ...await readState(q, cardId, person.personId), entries };
}
export async function markPersonalMissionCardRead(q: Query, person: MissionRoundPerson, cardId: string, requested: number, now: Date): Promise<{ lastReadSeq: number; unread: number } | null> {
  if (!await visiblePersonalMissionCard(q, person, cardId)) return null;
  await q(`INSERT INTO mission_card_reads (card_id,person_id,last_read_seq,updated_at)
    VALUES ($1,$2,LEAST($3,(SELECT COALESCE(MAX(seq),0) FROM mission_card_feedback WHERE card_id=$1)),$4)
    ON CONFLICT (card_id,person_id) DO UPDATE SET last_read_seq=GREATEST(mission_card_reads.last_read_seq,EXCLUDED.last_read_seq),updated_at=EXCLUDED.updated_at`, [cardId, person.personId, requested, now]);
  return readState(q, cardId, person.personId);
}
