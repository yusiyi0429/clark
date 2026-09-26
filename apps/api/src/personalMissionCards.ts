import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TCard, TCreateMissionCardFeedbackRequest, TMissionCardFeedbackView, TMissionCardField, TMissionCardGroupView, TMissionCardPayload, TMissionRoundSummary, TPersonalMissionCardMission, TPersonalMissionCardPayload, TThreadMember } from "@warmap/contracts";
import type { MemoryPerson } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { canApprove, closeIfDue, getMissionRoundRow, projectMissionRoundCard, type MissionRoundPerson, type MissionRoundRow } from "./missionRounds.js";
import { getMissionRow, projectMissionCard } from "./missions.js";

type PersonalRow = { id: string; round_id: string; owner_id: string; role_label: string | null; member_ids: string[] };
type FeedbackRow = {
  id: string; seq: string | number; card_id: string; mission_id: string | null; field: TMissionCardField | null;
  kind: "comment" | "quote" | "suggestion"; author_id: string; client_id: string; body: string;
  quote: string | null; proposed: string | null; original: string | null; source_version: number | null;
  basis: "draft" | "candidate"; late: boolean; window_seq: number; created_at: Date;
};
type Review = { id: string; feedback_ids: string[]; superseded_at: Date | null; note: string | null };
type Discussion = { feedback: FeedbackRow[]; review: Review | null; decisions: Map<string, "accept" | "decline"> };
type Failure = { error: { status: number; code: string; message: string } };
const fail = (status: number, code: string, message: string): Failure => ({ error: { status, code, message } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fieldText = (mission: TPersonalMissionCardMission, field: TMissionCardField) => Array.isArray(mission[field]) ? mission[field].join("\n") : mission[field] as string;
const compact = (text: string) => text.replace(/\s+/g, " ").trim();

/** Stored membership and current approval authority are both checked on every access. */
export async function visiblePersonalMissionCard(q: Query, person: MissionRoundPerson, cardId: string): Promise<{ card: PersonalRow; round: MissionRoundRow } | null> {
  if (!UUID.test(cardId)) return null;
  const card = (await q("SELECT id,round_id,owner_id,role_label,member_ids FROM personal_mission_cards WHERE id=$1", [cardId])).rows[0] as PersonalRow | undefined;
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
  return { feedback, review: review ?? null, decisions: new Map(decisions.map((r) => [r.feedback_id, r.decision])) };
}
function projectFeedback(item: FeedbackRow, data: Discussion, round: MissionRoundRow, people: MemoryPerson[]): TMissionCardFeedbackView {
  const decision = data.decisions.get(item.id) ?? null;
  const included = data.review?.feedback_ids.includes(item.id) ?? false;
  let verdict: TMissionCardFeedbackView["verdict"];
  if (round.status === "open" && data.review?.superseded_at && included && decision) {
    verdict = { text: `上一轮${decision === "decline" ? "未采纳" : item.kind === "suggestion" ? "已采纳" : "已纳入核对"} · 下次截止沿用`, tone: decision === "decline" ? "decline" : "accept" };
  } else if (item.late && !included) verdict = { text: "截止后留言 · 不在这一轮", tone: "late" };
  else if (decision === "decline") verdict = { text: "未采纳", tone: "decline" };
  else if (decision === "accept") verdict = { text: item.kind !== "suggestion" ? "已纳入核对" : round.status === "confirmed" ? "已采纳" : "已采纳 · 拍板前可能变化", tone: "accept" };
  else if (item.late && included) verdict = { text: "截止后留言 · 已并入这一轮", tone: "wait" };
  else verdict = { text: round.status === "open" ? "讨论中" : "待拍板人处理", tone: round.status === "open" ? "open" : "wait" };
  return { id: item.id, seq: Number(item.seq), missionId: item.mission_id, field: item.field, kind: item.kind,
    authorId: item.author_id, authorName: people.find((p) => p.personId === item.author_id)?.displayName ?? item.author_id,
    body: item.body, quote: item.quote, proposed: item.proposed, original: item.original, sourceVersion: item.source_version,
    basis: item.basis, late: item.late, round: item.window_seq, createdAt: item.created_at.toISOString(), verdict, decision, actions: [] };
}
async function documentMissions(q: Query, cardId: string, people: MemoryPerson[], secret: string, data: Discussion, candidate: boolean): Promise<TPersonalMissionCardMission[]> {
  const ids = (await q("SELECT id FROM missions WHERE personal_mission_card_id=$1 ORDER BY code,id", [cardId])).rows as { id: string }[];
  const names = new Map(people.map((p) => [p.personId, p.displayName]));
  const result: TPersonalMissionCardMission[] = [];
  for (const { id } of ids) {
    const row = (await getMissionRow(q, id))!;
    const mission: TPersonalMissionCardMission = { ...(projectMissionCard(row, secret, names).payload as TMissionCardPayload), version: row.version, changedFields: [] };
    if (candidate && data.review && !data.review.superseded_at) for (const item of data.feedback) {
      if (item.mission_id !== id || item.kind !== "suggestion" || !item.field || data.decisions.get(item.id) !== "accept" || !data.review.feedback_ids.includes(item.id)) continue;
      if (item.field === "successEvidence" || item.field === "milestones") mission[item.field] = item.proposed!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      else mission[item.field] = item.proposed!;
      mission.changedFields.push(item.field);
    }
    result.push(mission);
  }
  return result;
}

export async function getPersonalMissionCard(q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, cardId: string, now: Date): Promise<TCard | null> {
  const visible = await visiblePersonalMissionCard(q, person, cardId);
  if (!visible) return null;
  const { card, round } = visible;
  const roundCard = await projectMissionRoundCard(q, people, secret, person, round, now);
  const summary = roundCard.payload as TMissionRoundSummary;
  // Draft readers can inspect the already signed basis; only the open action freezes it.
  if (round.status === "draft" && !summary.goals) {
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
  const byName = people.find((p) => p.personId === round.confirmed_by)?.displayName ?? round.confirmed_by;
  const status = shown === "confirmed" ? `已确定 · ${byName} ${localTime(round.confirmed_at!)}`
    : shown === "candidate" ? `候选版本 · 相比草稿 ${changed} 处改动 · 等${summary.deciderName}拍板`
    : `草稿${summary.phase === "open" ? " · 讨论中" : ""}${card.role_label ? ` · ${card.role_label}` : ""}`;
  const payload: TPersonalMissionCardPayload = {
    round: summary,
    card: { cardId, ownerId: card.owner_id, ownerName: people.find((p) => p.personId === card.owner_id)?.displayName ?? card.owner_id,
      roleLabel: card.role_label, members: members(card, people), status, shown, missions },
    feedback: data.feedback.map((item) => projectFeedback(item, data, round, people)),
    confirmation: round.confirmed_at && round.confirmed_by ? { by: round.confirmed_by,
      byName: people.find((p) => p.personId === round.confirmed_by)?.displayName ?? round.confirmed_by,
      at: round.confirmed_at.toISOString(), note: data.review?.note ?? "" } : null,
  };
  return { schemaVersion: 1, id: `personal-mission-card:${cardId}`, kind: "personal-mission-card", version: round.version,
    objectRef: { type: "personal-mission-card", id: cardId, version: round.version }, title: `${payload.card.ownerName}的 ${Number(round.period.slice(5))} 月 Mission Card`,
    badge: "Mission Card", payload, conversation: { scope: `mission-card:${cardId}` }, actions: roundCard.actions };
}

function normalizedInput(input: TCreateMissionCardFeedbackRequest): TCreateMissionCardFeedbackRequest {
  return { ...input, body: input.body.trim(), ...(input.proposed !== undefined ? { proposed: ["successEvidence", "milestones"].includes(input.field ?? "")
    ? input.proposed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n") : input.proposed.trim() } : {}) };
}
function inputProblem(input: TCreateMissionCardFeedbackRequest): string | null {
  if (!input.body) return "请填写意见正文";
  if (input.kind === "comment") return input.missionId || input.field || input.quote !== undefined || input.proposed !== undefined || input.sourceVersion !== undefined ? "评论不带字段、引用或修改建议" : null;
  if (!input.missionId || !input.field || input.sourceVersion === undefined) return "引用和建议必须指明个人任务、字段与源版本";
  if (input.kind === "quote") return !input.quote?.trim() || input.proposed !== undefined ? "引用必须包含原文，不能包含修改建议" : null;
  if (!input.proposed || input.quote !== undefined) return "请填写修改建议，不能同时提交引用";
  if (input.field === "title" && input.proposed.length > 200) return "名称最多 200 字";
  if (["successEvidence", "milestones"].includes(input.field)) {
    const lines = input.proposed.split("\n");
    if (lines.length > 30 || lines.some((line) => line.length > 500)) return "列表最多 30 行，每行不超过 500 字";
  }
  return null;
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
    if (!visible) { await client.query("ROLLBACK"); return fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "个人卡不存在或不可见"); }
    await client.query("SELECT id FROM mission_rounds WHERE id=$1 FOR SHARE", [visible.round.id]);
    visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) { await client.query("ROLLBACK"); return fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "个人卡不存在或不可见"); }
    let at = now();
    if (visible.round.status === "open" && visible.round.closes_at! <= at) {
      // Release SHARE before taking UPDATE: simultaneous due writers cannot deadlock on lock upgrades.
      await client.query("COMMIT"); await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mission-feedback:${person.personId}:${input.clientId}`]);
      await client.query("SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE", [visible.round.id]);
      visible = await visiblePersonalMissionCard(q, person, cardId);
      if (!visible) { await client.query("ROLLBACK"); return fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "个人卡不存在或不可见"); }
      at = now(); visible.round = await closeIfDue(client, visible.round, at);
    }
    const { round } = visible;
    const finish = async <T,>(result: T) => { await client.query("COMMIT"); return result; };
    const problem = inputProblem(input);
    if (problem) return await finish(fail(400, "INVALID_FEEDBACK", problem));
    const prior = (await q("SELECT * FROM mission_card_feedback WHERE author_id=$1 AND client_id=$2", [person.personId, input.clientId])).rows[0] as FeedbackRow | undefined;
    if (prior) {
      if (!sameInput(prior, cardId, input)) return await finish(fail(409, "CLIENT_ID_CONFLICT", "同一个 client_id 已提交不同的意见"));
      return await finish({ feedback: projectFeedback(prior, await discussion(q, round, cardId), round, people) });
    }
    if (round.status === "draft") return await finish(fail(409, "ROUND_NOT_OPEN", "讨论还没开放"));
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
    return await finish({ feedback: projectFeedback(inserted, data, round, people) });
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
    entries.push({ type: "divider", at, text: `${localTime(round.first_opened_at)} · 全战场统一开放 48 小时讨论` });
    const count = Number((await q("SELECT count(*) AS n FROM missions WHERE personal_mission_card_id=$1", [cardId])).rows[0].n);
    const deciderId = round.battlefield_owner_id || people.find((p) => p.roles.includes("ceo"))?.personId || "CEO";
    entries.push({ type: "opening", at, text: `这个群讨论${names.get(card.owner_id) ?? card.owner_id}的 ${Number(round.period.slice(5))} 月 Mission Card（${count} 项个人任务），开放到 ${localTime(new Date(round.first_opened_at.getTime() + 48 * 3600000))}：可以在字段上评论、划词引用、提修改建议。截止后 Co-Agent 汇总大家的意见，交${names.get(deciderId) ?? deciderId}拍板。${round.draft_origin === "placeholder" ? "本月草稿是占位（Co-Agent 起草未接入，沿用 9 月个人卡）。" : ""}` });
  }
  round.reopens.forEach((reopen, i) => {
    entries.push({ type: "divider", at: reopen.closedAt, text: `${localTime(new Date(reopen.closedAt))} · 讨论截止` });
    entries.push({ type: "divider", at: reopen.at, text: `${names.get(reopen.by) ?? reopen.by}重新开启 48 小时讨论（第 ${i + 2} 轮）` });
  });
  if (round.closes_at && round.closes_at <= now) entries.push({ type: "divider", at: round.closes_at.toISOString(), text: `${localTime(round.closes_at)} · 讨论截止 · 之后的留言不进这一轮` });
  if (round.confirmed_at) entries.push({ type: "divider", at: round.confirmed_at.toISOString(), text: `${names.get(round.confirmed_by!) ?? round.confirmed_by}确认了本月 Mission Card` });
  for (const item of data.feedback) if (Number(item.seq) > after) entries.push({ type: "message", feedback: projectFeedback(item, data, round, people) });
  const at = (entry: TMissionCardGroupView["entries"][number]) => entry.type === "message" ? entry.feedback.createdAt : entry.at;
  const rank = { divider: 0, opening: 1, message: 2 };
  entries.sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)) || rank[a.type] - rank[b.type]
    || (a.type === "message" && b.type === "message" ? a.feedback.seq - b.feedback.seq : 0));
  return { members: members(card, people), ...await readState(q, cardId, person.personId), entries };
}
export async function markPersonalMissionCardRead(q: Query, person: MissionRoundPerson, cardId: string, requested: number, now: Date): Promise<{ lastReadSeq: number; unread: number } | null> {
  if (!await visiblePersonalMissionCard(q, person, cardId)) return null;
  await q(`INSERT INTO mission_card_reads (card_id,person_id,last_read_seq,updated_at)
    VALUES ($1,$2,LEAST($3,(SELECT COALESCE(MAX(seq),0) FROM mission_card_feedback WHERE card_id=$1)),$4)
    ON CONFLICT (card_id,person_id) DO UPDATE SET last_read_seq=GREATEST(mission_card_reads.last_read_seq,EXCLUDED.last_read_seq),updated_at=EXCLUDED.updated_at`, [cardId, person.personId, requested, now]);
  return readState(q, cardId, person.personId);
}
