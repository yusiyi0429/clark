import { readCompanyContext } from "./companyContext.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import { CreateMissionRequest, type TCard, type TMissionCardField, type TMissionRoundConfirmInput, type TMissionRoundDecideInput, type TMissionRoundPhase, type TMissionRoundSummary } from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
import type { CompanyContext } from "./companyContext.js";
import { MissionCardDraftCandidate, type MissionCardDraftAgent, type MissionCardDraftCandidateValue, type MissionCardDraftInput } from "./missionCardDraftAgent.js";
import type { MeetingActionOutcome, Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { fieldText, getMissionRow, projectMissionCard } from "./missions.js";
import type { TMissionCardPayload } from "@warmap/contracts";
import { buildMissionCardReviewInput } from "./missionCardReview.js";

export type MissionRoundPerson = { personId: string; role: "ceo" | "member" };
type GoalSnapshot = {
  sixMonthOutcome: string; monthOutcome: string; signedAt: string;
  battlefieldId: string; battlefieldVersion: number; monthlyPlanId: string; monthlyPlanVersion: number;
};
export type MissionRoundRow = {
  id: string; version: number; battlefield_id: string; period: string; monthly_plan_id: string;
  status: "drafting" | "draft" | "open" | "reviewing" | "confirmed";
  draft_origin: "placeholder" | "agent" | null; draft_source: Record<string, unknown>; goal_snapshot: GoalSnapshot | null;
  window_seq: number; first_opened_at: Date | null; opened_at: Date | null; closes_at: Date | null;
  reopens: { by: string; at: string; closedAt: string; priorConfirmation?: { by: string; at: string; note: string; reviewId: string | null } }[];
  confirmed_by: string | null; confirmed_at: Date | null; action_fingerprints: string[];
  created_at: Date; updated_at: Date;
  battlefield_owner_id: string; battlefield_name: string; battlefield_version: number; six_month_outcome: string;
};
type PersonalCardRow = {
  id: string; owner_id: string; sort_order: number; role_label: string | null; member_ids: string[]; placeholder: boolean; owner_confirmed_at: Date | null;
};
type FeedbackRow = {
  id: string; card_id: string; mission_id: string | null; field: TMissionCardField | null;
  kind: "comment" | "quote" | "suggestion"; proposed: string | null; original: string | null; source_version: number | null; late: boolean; created_at: Date;
};
type ReviewRow = { id: string; feedback_ids: string[]; taken_at: Date; mission_versions: Record<string, number>;
  agent_status: "queued" | "running" | "completed" | "failed"; agent_report: import("@warmap/contracts").TMissionCardReviewReport | null;
  agent_error: string | null; agent_completed_at: Date | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUND_SELECT = `SELECT r.*, b.owner_id AS battlefield_owner_id, b.name AS battlefield_name,
  b.version AS battlefield_version, b.six_month_outcome
  FROM mission_rounds r JOIN battlefield_config b ON b.id=r.battlefield_id`;

type DraftFailure = { ownerId: string; message: string; reviewRunIds?: string[]; draftRunIds?: string[]; basisSource?: string };
function draftFailures(row: Pick<MissionRoundRow, "draft_source">): DraftFailure[] {
  const values = row.draft_source.failedOwners;
  return Array.isArray(values) ? values.filter((item): item is DraftFailure => item !== null && typeof item === "object"
    && typeof item.ownerId === "string" && typeof item.message === "string") : [];
}
/** 系统代做的动作留痕（签发后起草、起草完成后交给本人）；操作人记为 system，不记成任何人。 */
export type DraftTrailEntry = { at: string; by: "system"; text: string };
export function draftTrail(row: Pick<MissionRoundRow, "draft_source">): DraftTrailEntry[] {
  return Array.isArray(row.draft_source.trail) ? row.draft_source.trail as DraftTrailEntry[] : [];
}
/** 起草全部成功、但自动交给本人没通过检查时的原因；补齐后由战场 DRI 交给本人。 */
function openProblem(row: Pick<MissionRoundRow, "draft_source">): string | null {
  return typeof row.draft_source.openProblem === "string" ? row.draft_source.openProblem : null;
}

/** 拍板权每次取当前身份和战场负责人；卡成员则保留建卡时的名单。 */
export function canApprove(person: MissionRoundPerson, round: Pick<MissionRoundRow, "battlefield_owner_id">): boolean {
  return person.personId === round.battlefield_owner_id;
}
export function missionCardMembers(ownerId: string, battlefieldOwnerId: string | null, people: MemoryPerson[]): string[] {
  return [...new Set([ownerId, ...(battlefieldOwnerId ? [battlefieldOwnerId] : []),
    ...people.filter((person) => person.roles.includes("ceo")).map((person) => person.personId)])];
}

export async function getMissionRoundRow(q: Query, roundId: string): Promise<MissionRoundRow | null> {
  if (!UUID.test(roundId)) return null;
  return (await q(`${ROUND_SELECT} WHERE r.id=$1`, [roundId])).rows[0] as MissionRoundRow | undefined ?? null;
}
async function personalCards(q: Query, roundId: string): Promise<PersonalCardRow[]> {
  return (await q(`SELECT c.id,c.owner_id,c.sort_order,c.role_label,c.member_ids,c.owner_confirmed_at,
    EXISTS (SELECT 1 FROM missions m WHERE m.personal_mission_card_id=c.id AND m.placeholder) AS placeholder
    FROM personal_mission_cards c WHERE c.round_id=$1 ORDER BY c.sort_order,c.owner_id,c.id`, [roundId])).rows as PersonalCardRow[];
}
async function canRead(q: Query, person: MissionRoundPerson, row: MissionRoundRow): Promise<boolean> {
  if (canApprove(person, row) || person.role === "ceo") return true;
  const found = await q("SELECT 1 FROM personal_mission_cards WHERE round_id=$1 AND owner_id=$2 LIMIT 1", [row.id, person.personId]);
  return !!found.rowCount;
}
function roundPhase(row: MissionRoundRow, now: Date): TMissionRoundPhase {
  return row.status === "open" && row.closes_at !== null && row.closes_at <= now ? "closed" : row.status;
}
/** 已确定的卡只在轮次月份未过时可更正（GAP-04）；YYYY-MM 直接比较，月底提前确定的下月卡也算未过。 */
export function correctionPeriodClosed(row: Pick<MissionRoundRow, "period">, now: Date): boolean {
  return row.period < companyPeriod(now);
}
/** 私聊、批注、队列统一的正文冻结规则；实质更正先退回本人。 */
export function missionCardWriteProblem(round: Pick<MissionRoundRow, "period" | "status" | "closes_at">,
  card: { owner_confirmed_at: Date | null }, now: Date): { status: number; code: string; message: string } | null {
  if (correctionPeriodClosed(round, now)) return { status: 409, code: "MISSION_CARD_PERIOD_CLOSED", message: "月份已过，正文只读" };
  if (round.status === "drafting") return { status: 409, code: "MISSION_CARD_DRAFTING", message: "Co-Agent 正在起草，完成后自动交给本人确认" };
  if (round.status !== "open" || round.closes_at && round.closes_at <= now)
    return { status: 409, code: "ROUND_NOT_OPEN", message: round.status === "draft" ? "任务卡尚未交给本人确认"
      : round.status === "open" ? "本人准备时间已到，请由战场 DRI 延长本人确认后继续"
        : "本人准备已结束；如需修改，请由战场 DRI 退回受影响的本人重新确认" };
  if (card.owner_confirmed_at) return { status: 409, code: "OWNER_CONFIRMED", message: "本人已确认，请先取消确认再修改" };
  return null;
}
export async function pendingMissionCardAnnotations(q: Query, roundId: string, cardId?: string): Promise<number> {
  return Number((await q(`SELECT count(*)::int AS count FROM mission_card_annotations a JOIN personal_mission_cards c ON c.id=a.card_id
    WHERE c.round_id=$1 AND a.author_id=c.owner_id AND a.intent='edit' AND a.status IN ('queued','applying','needs_clarification','failed')${cardId ? " AND c.id=$2" : ""}`,
    cardId ? [roundId, cardId] : [roundId])).rows[0].count);
}
export function missionCardLine(phase: TMissionRoundPhase, ownerConfirmedAt: Date | null, inReview: number, pending: number, approver: boolean, corrections = 0): string {
  if (phase === "drafting") return "Co-Agent 正在起草";
  if (phase === "draft") return "未开放";
  if (phase === "open") return ownerConfirmedAt ? "本人已确认" : "待本人确认";
  if (phase === "closed") return ownerConfirmedAt ? "本人已确认" : "待本人确认";
  if (phase === "confirmed") return approver && corrections ? `${corrections} 条更正申请` : "已确定";
  return ownerConfirmedAt ? "本人已确认" : "待本人确认";
}

/** 同一轮的事实、计数与服务端状态文案；仅可见卡行和动作随看的人变化。 */
export async function projectMissionRoundCard(
  q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, row: MissionRoundRow, now: Date,
): Promise<TCard> {
  const cards = await personalCards(q, row.id);
  const missions = (await q(`SELECT m.id,m.personal_mission_card_id,m.dependencies FROM missions m
    JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id WHERE c.round_id=$1`, [row.id])).rows as { id: string; personal_mission_card_id: string; dependencies: string }[];
  const review = (await q("SELECT * FROM mission_round_reviews WHERE round_id=$1 AND window_seq=$2 AND superseded_at IS NULL", [row.id, row.window_seq])).rows[0] as ReviewRow | undefined;
  // 确认后的更正申请（GAP-04）：最早的在前，行上的「第一条」据此定位。
  const corrections = (await q("SELECT id,card_id FROM mission_card_corrections WHERE round_id=$1 AND status='pending' ORDER BY created_at,id", [row.id])).rows as { id: string; card_id: string }[];
  const annotationCounts = (await q(`SELECT a.card_id,count(*)::int AS total,
    count(*) FILTER (WHERE a.status IN ('queued','applying','needs_clarification','failed'))::int AS pending
    FROM mission_card_annotations a JOIN personal_mission_cards c ON c.id=a.card_id WHERE c.round_id=$1 AND a.author_id=c.owner_id GROUP BY a.card_id`, [row.id])).rows as { card_id: string; total: number; pending: number }[];
  const approver = canApprove(person, row);
  const supervisor = approver || person.role === "ceo";
  const phase = roundPhase(row, now);
  // 月份过了没法再处理更正，行文案回到「已确定」；待处理数照实保留。
  const correctable = !correctionPeriodClosed(row, now);
  const names = new Map(people.map((item) => [item.personId, item.displayName]));
  const deciderId = row.battlefield_owner_id;
  const deciderName = (deciderId && names.get(deciderId)) || deciderId || "CEO";
  // 只有战场 DRI 能重试起草；其他人（含 CEO）看到等谁重试。
  const retryHint = approver ? "，可重试" : ` · 等${deciderName}重试`;
  const visible =cards.filter((item) => approver || person.role === "ceo" || item.owner_id === person.personId);
  const failures = draftFailures(row);
  const visibleFailures = failures.filter((failure) => visible.some((card) => card.owner_id === failure.ownerId));
  const retryDraftAction = approver && phase === "draft" && failures.length ? {
    actionType: "mission-round.draft", label: "重试未完成的起草",
    actionId: signActionId(secret, { actionType: "mission-round.draft", objectType: "mission-round-slot",
      objectId: `${row.battlefield_id}:${row.period}`, objectVersion: 1, itemId: `${row.id}:${row.version}` }),
  } : null;
  const payload: TMissionRoundSummary = {
    roundId: row.id, period: row.period, battlefieldId: row.battlefield_id, battlefieldName: row.battlefield_name,
    version: row.version, phase, round: Math.max(1, row.window_seq), openedAt: row.opened_at?.toISOString() ?? null,
    closesAt: row.closes_at?.toISOString() ?? null, reviewAt: review?.taken_at.toISOString() ?? null,
    serverNow: now.toISOString(), approver, deciderName,
    todo: !supervisor ? null : phase === "drafting" ? "Co-Agent 正在起草" : phase === "draft" ? failures.length
      ? `${failures.length} 张任务卡起草未完成${retryHint}` : openProblem(row) ?? "任务卡草稿已就绪，可以交给本人确认"
      : ["open", "closed"].includes(phase) ? `${cards.filter((card) => !!card.owner_confirmed_at).length}/${cards.length} 人已确认${phase === "closed" ? " · 本人确认时间已到，请 DRI 延长" : ""}；待确认：${cards.filter((card) => !card.owner_confirmed_at).map((card) => names.get(card.owner_id) ?? card.owner_id).join("、") || "无"}`
      : phase === "reviewing" ? review?.agent_status === "completed" ? "Co-Agent Review 已完成，待战场 DRI 确认组合" : review?.agent_status === "failed" ? "Co-Agent Review 未完成，可重试" : "Co-Agent 正在审阅任务组合"
      : phase === "confirmed" && corrections.length > 0 && correctable ? `${corrections.length} 条更正申请待你处理` : null,
    placeholder: row.draft_origin === "placeholder",
    draftOrigin: row.draft_origin,
    draftFailures: visibleFailures.map((failure) => ({ ownerId: failure.ownerId, ownerName: names.get(failure.ownerId) ?? failure.ownerId, message: failure.message })),
    retryDraftAction,
    coAgentReview: review && (row.status !== "confirmed" || review.agent_report !== null) ? { status: review.agent_status, summary: supervisor ? review.agent_report?.summary ?? "" : "",
      findings: supervisor ? review.agent_report?.findings ?? [] : [], error: review.agent_error,
      completedAt: review.agent_completed_at?.toISOString() ?? null, retryAction: approver && review.agent_status === "failed" ? {
        actionType: "mission-round.review-retry", label: "重试 Co-Agent Review", actionId: signActionId(secret, {
          actionType: "mission-round.review-retry", objectType: "mission-round", objectId: row.id, objectVersion: row.version }),
      } : null } : null,
    goals: row.goal_snapshot ? { sixMonthOutcome: row.goal_snapshot.sixMonthOutcome, monthOutcome: row.goal_snapshot.monthOutcome, signedAt: row.goal_snapshot.signedAt } : null,
    counts: {
      cards: cards.length, feedback: annotationCounts.reduce((n,item)=>n+item.total,0), pending: annotationCounts.reduce((n,item)=>n+item.pending,0),
      conflicts: review?.agent_report?.findings.filter((item)=>item.kind === "risk").length ?? 0,
      dependencies: missions.reduce((total, mission) => total + mission.dependencies.split(/\r?\n/).filter((line) => line.trim()).length, 0),
      late: 0,
      corrections: corrections.length,
      unreviewed: cards.filter((card) => !card.owner_confirmed_at).length,
    },
    cards: visible.map((item) => {
      const waiting = corrections.filter((entry) => entry.card_id === item.id);
      return { cardId: item.id, ownerId: item.owner_id, ownerName: names.get(item.owner_id) ?? item.owner_id,
        roleLabel: item.role_label, missionCount: missions.filter((mission) => mission.personal_mission_card_id === item.id).length,
        ownerConfirmedAt: item.owner_confirmed_at?.toISOString() ?? null,
        contentVisible: item.owner_id === person.personId || (phase === "confirmed" || !!item.owner_confirmed_at) && (approver || person.role === "ceo"),
        line: failures.some((failure) => failure.ownerId === item.owner_id) && phase === "draft" ? `起草未完成${retryHint}`
          : missionCardLine(phase, item.owner_confirmed_at, 0, 0, approver, correctable ? waiting.length : 0), pending: annotationCounts.find((entry)=>entry.card_id===item.id)?.pending ?? 0,
        firstPendingFeedbackId: null,
        pendingCorrections: waiting.length, firstPendingCorrectionId: waiting[0]?.id ?? null, mine: item.owner_id === person.personId,
        placeholder: item.placeholder };
    }),
  };
  const actions: TCard["actions"] = [];
  if (retryDraftAction) actions.push(retryDraftAction);
  const actionType = approver ? (phase === "draft" && !failures.length ? "mission-round.open" : phase === "closed" ? "mission-round.reopen" : null) : null;
  if (actionType) actions.push({ actionType, label: phase === "draft" ? "交给本人确认" : "延长本人确认",
    actionId: signActionId(secret, { actionType, objectType: "mission-round", objectId: row.id, objectVersion: row.version }) });
  if (payload.coAgentReview?.retryAction) actions.push(payload.coAgentReview.retryAction);
  if (approver && phase === "reviewing" && review?.agent_status === "completed") actions.push({ actionType: "mission-round.confirm", label: "确认任务组合",
    actionId: signActionId(secret, { actionType: "mission-round.confirm", objectType: "mission-round", objectId: row.id, objectVersion: row.version }) });
  return { schemaVersion: 1, id: `mission-round:${row.id}`, kind: "mission-round", version: row.version,
    objectRef: { type: "mission-round", id: row.id, version: row.version },
    title: `${Number(row.period.slice(5))} 月 Mission Card · ${row.battlefield_name}`, badge: "Mission Card", urgency: "normal", payload,
    navigation: visible.find((card) => card.owner_id === person.personId || row.status === "confirmed" || !!card.owner_confirmed_at) ? [{ href: `${person.role === "ceo" ? "" : "/me"}/mission-cards/${visible.find((card) => card.owner_id === person.personId || row.status === "confirmed" || !!card.owner_confirmed_at)!.id}`, label: "个人 Mission Card" }] : [], actions };
}

export async function getMissionRoundCard(
  q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, roundId: string, now: Date,
): Promise<TCard | null> {
  const row = await getMissionRoundRow(q, roundId);
  return row && await canRead(q, person, row) ? projectMissionRoundCard(q, people, secret, person, row, now) : null;
}
export async function listMissionRoundCards(
  q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, period: string | undefined, now: Date,
): Promise<TCard[]> {
  // 通知只在确认后退出；引导可显式限定本月，跨月不能让尚未拍板的通知消失。
  // 已确定、月份未过且仍有待处理更正申请的轮次，只对当前拍板人重新出现（GAP-04）。
  const rows = (await q(`${ROUND_SELECT} WHERE (r.status<>'confirmed'
    OR EXISTS (SELECT 1 FROM mission_card_corrections k WHERE k.round_id=r.id AND k.status='pending'))${period ? " AND r.period=$1" : ""}
    ORDER BY r.period DESC,b.sort_order,b.code,r.id`, period ? [period] : [])).rows as MissionRoundRow[];
  const cards: TCard[] = [];
  for (const row of rows) {
    const notice = row.status === "confirmed" ? canApprove(person, row) && !correctionPeriodClosed(row, now) : await canRead(q, person, row);
    if (notice) cards.push(await projectMissionRoundCard(q, people, secret, person, row, now));
  }
  return cards;
}

/** 调用者须已持轮次 FOR UPDATE。截止按窗口时刻收意见，不按调度实际运行时刻。 */
export async function closeIfDue(client: PoolClient, row: MissionRoundRow, now: Date, explicitClose = false): Promise<MissionRoundRow> {
  if (row.status !== "open" || !row.closes_at || row.closes_at > now) return row;
  if (await pendingMissionCardAnnotations((sql, params) => client.query(sql, params), row.id)) return row;
  if ((await client.query("SELECT 1 FROM personal_mission_cards WHERE round_id=$1 AND owner_confirmed_at IS NULL LIMIT 1", [row.id])).rowCount) return row;
  // 人工/最后本人确认已经持阶段锁，之前同毫秒提交的意见也须收下；自然截止仍沿用严格截止边界。
  const feedback = await client.query<{ id: string }>(`SELECT id FROM mission_card_feedback WHERE round_id=$1
    AND (created_at<$2${explicitClose ? " OR (created_at=$2 AND NOT late)" : ""}) ORDER BY seq`, [row.id, row.closes_at]);
  const missions = await client.query<{ id: string; version: number }>(`SELECT m.id,m.version FROM missions m
    JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id WHERE c.round_id=$1 ORDER BY m.id`, [row.id]);
  const previous = await client.query<{ id: string }>("SELECT id FROM mission_round_reviews WHERE round_id=$1 AND superseded_at IS NOT NULL ORDER BY window_seq DESC LIMIT 1", [row.id]);
  const reviewId = randomUUID();
  const feedbackIds = feedback.rows.map((item) => item.id);
  const input = await buildMissionCardReviewInput((sql, params) => client.query(sql, params), row);
  await client.query(`INSERT INTO mission_round_reviews (id,round_id,window_seq,snapshot_at,taken_at,feedback_ids,mission_versions,agent_input)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
  [reviewId, row.id, row.window_seq, row.closes_at, now, JSON.stringify(feedbackIds), JSON.stringify(Object.fromEntries(missions.rows.map((item) => [item.id, item.version]))), JSON.stringify(input)]);
  if (previous.rows[0]) await client.query(`INSERT INTO mission_review_decisions (review_id,feedback_id,decision,decided_by,decided_at,carried)
    SELECT $1,feedback_id,decision,decided_by,decided_at,true FROM mission_review_decisions
    WHERE review_id=$2 AND feedback_id=ANY($3::uuid[])`, [reviewId, previous.rows[0].id, feedbackIds]);
  const updated = await client.query("UPDATE mission_rounds SET status='reviewing',version=version+1,updated_at=$2 WHERE id=$1 RETURNING *", [row.id, now]);
  return { ...row, ...updated.rows[0] };
}

/** 各战场分别取锁、分别提交；重复/并行 tick 在锁后重新判断，不重复写快照。 */
export async function closeDueRounds(pool: Pool, now: Date | (() => Date)): Promise<number> {
  const clock = typeof now === "function" ? now : () => now;
  const due = await pool.query<{ id: string }>("SELECT id FROM mission_rounds WHERE status='open' AND closes_at<=$1 ORDER BY closes_at,id", [clock()]);
  let closed = 0;
  for (const candidate of due.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<MissionRoundRow>(`${ROUND_SELECT} WHERE r.id=$1 FOR UPDATE OF r`, [candidate.id]);
      const row = result.rows[0];
      if (row && (await closeIfDue(client, row, clock())).version !== row.version) closed++;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined); throw error;
    } finally { client.release(); }
  }
  return closed;
}

type RoundRefusal = Extract<MeetingActionOutcome, { error: unknown }>;
function failure(status: number, code: string, message: string): RoundRefusal {
  return { error: { status, code, message } };
}
function appendFingerprint(existing: string[], fingerprint: string): string[] {
  return [...existing.filter((value) => value !== fingerprint), fingerprint].slice(-100);
}
/**
 * 交给本人确认：目标已签发、每张卡至少一项任务，冻结目标快照。DRI 手动交付与起草完成后的系统交付共用；
 * 调用者须已持轮次锁，record 写入各自的留痕（动作指纹或系统留痕）。
 */
async function openForOwners(client: PoolClient, row: MissionRoundRow, at: Date,
  record: { action_fingerprints?: string[]; draft_source?: Record<string, unknown> }): Promise<{ row: MissionRoundRow } | RoundRefusal> {
  const plan = (await client.query<{ id: string; version: number; status: string; confirmed_at: Date | null; battlefields: { battlefieldId: string; outcome: string }[] }>(
    "SELECT id,version,status,confirmed_at,battlefields FROM monthly_plans WHERE id=$1 AND period=$2 FOR SHARE", [row.monthly_plan_id, row.period])).rows[0];
  if (!plan || plan.status !== "confirmed" || !plan.confirmed_at) return failure(409, "MONTHLY_PLAN_NOT_CONFIRMED", `${Number(row.period.slice(5))} 月月度计划还没签发：先签发目标，再交给本人确认`);
  const monthOutcome = plan.battlefields.find((item) => item.battlefieldId === row.battlefield_id)?.outcome;
  if (!monthOutcome?.trim() || !row.six_month_outcome.trim()) return failure(409, "ROUND_GOALS_MISSING", "缺少本战场的六个月目标或已签发本月目标，暂不能交给本人确认");
  const cards = await client.query<{ count: number }>(`SELECT count(m.id)::int AS count FROM personal_mission_cards c
    LEFT JOIN missions m ON m.personal_mission_card_id=c.id WHERE c.round_id=$1 GROUP BY c.id`, [row.id]);
  if (!cards.rows.length || cards.rows.some((item) => item.count === 0)) return failure(409, "ROUND_EMPTY_CARD", "每张任务卡至少需要一项个人任务，暂不能交给本人确认");
  const goal: GoalSnapshot = { sixMonthOutcome: row.six_month_outcome, monthOutcome, signedAt: plan.confirmed_at.toISOString(),
    battlefieldId: row.battlefield_id, battlefieldVersion: row.battlefield_version, monthlyPlanId: plan.id, monthlyPlanVersion: plan.version };
  const updated = await client.query(`UPDATE mission_rounds SET status='open',window_seq=1,opened_at=$2,first_opened_at=$2,
    closes_at=NULL,goal_snapshot=$3::jsonb,version=version+1,action_fingerprints=$4::jsonb,draft_source=$5::jsonb,updated_at=$2 WHERE id=$1 RETURNING *`,
  [row.id, at, JSON.stringify(goal), JSON.stringify(record.action_fingerprints ?? row.action_fingerprints), JSON.stringify(record.draft_source ?? row.draft_source)]);
  return { row: { ...row, ...updated.rows[0] } };
}
async function executeRoundAction(
  operation: "open" | "close" | "reopen" | "decide" | "confirm" | "review-retry", pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson,
  scope: ActionScope, fingerprint: string, now: () => Date, input: { decision?: "accept" | "decline"; note?: string } = {},
): Promise<MeetingActionOutcome> {
  if (!UUID.test(scope.objectId)) return failure(404, "ROUND_NOT_FOUND", "Mission Card 轮次不存在");
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    const selected = await client.query<MissionRoundRow>(`${ROUND_SELECT} WHERE r.id=$1 FOR UPDATE OF r`, [scope.objectId]);
    // JOIN 的负责人快照可能早于等待行锁期间的配置修改；拿到锁后用新语句读取当前关系。
    const current = selected.rows[0] ? await getMissionRoundRow(q, scope.objectId) : null;
    if (!current || !await canRead(q, person, current)) {
      await client.query("ROLLBACK"); return failure(404, "ROUND_NOT_FOUND", "Mission Card 轮次不存在");
    }
    // 拍板权在重放与 latestCard 之前复查，旧令牌不保留旧权限。
    if (!canApprove(person, current)) {
      await client.query("ROLLBACK"); return failure(403, "ROUND_FORBIDDEN", "仅该战场 DRI 可以确认任务组合");
    }
    const at = now();
    // 显式开始汇总先检查令牌与待改批注；遗留截止仍使用原截止时间取快照。
    let row = operation === "close" ? current : await closeIfDue(client, current, at);
    const finish = async (outcome: MeetingActionOutcome) => { await client.query("COMMIT"); return outcome; };
    const project = () => projectMissionRoundCard(q, people, secret, person, row, at);
    if (row.action_fingerprints.includes(fingerprint)) return await finish({ card: await project(), replayed: true });
    if (row.version !== scope.objectVersion) return await finish({ conflict: true, latestCard: await project() });
    if (row.status === "confirmed") return await finish(failure(409, "ROUND_CONFIRMED", "本月 Mission Card 已确定；要改字段，请在任务卡上更正"));
    if (operation === "open") {
      if (row.status !== "draft") return await finish(failure(409, "ROUND_ALREADY_OPEN", "本轮已经开放，倒计时不会重置"));
      if (draftFailures(row).length) return await finish(failure(409, "ROUND_DRAFT_INCOMPLETE", "有任务卡起草未完成，请先重试，再交给本人确认"));
      const opened = await openForOwners(client, row, at, { action_fingerprints: appendFingerprint(row.action_fingerprints, fingerprint) });
      if ("error" in opened) return await finish(opened);
      row = opened.row;
    } else if (operation === "close") {
      if (row.status !== "open") return await finish(failure(409, "ROUND_NOT_OPEN", "本人准备尚未开放或已经结束"));
      if ((await q("SELECT 1 FROM personal_mission_cards WHERE round_id=$1 AND owner_confirmed_at IS NULL LIMIT 1", [row.id])).rowCount) return await finish(failure(409, "OWNERS_NOT_CONFIRMED", "仍有本人未确认任务，不能提前汇总或替人确认"));
      if (await pendingMissionCardAnnotations(q, row.id)) return await finish(failure(409, "ANNOTATIONS_PENDING", "还有待处理的修改批注，请先回答、重试或明确保留备注再开始汇总"));
      const alreadyDue = row.closes_at !== null && row.closes_at <= at;
      const updated = await client.query(`UPDATE mission_rounds SET closes_at=$2,action_fingerprints=$3::jsonb WHERE id=$1 RETURNING *`,
        [row.id, alreadyDue ? row.closes_at : at, JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))]);
      row = await closeIfDue(client, { ...row, ...updated.rows[0] }, at, !alreadyDue);
    } else if (operation === "reopen") {
      if (row.status === "open" && row.closes_at && row.closes_at <= at) {
        const updated = await client.query(`UPDATE mission_rounds SET closes_at=NULL,window_seq=window_seq+1,version=version+1,
          action_fingerprints=$2::jsonb,updated_at=$3 WHERE id=$1 RETURNING *`, [row.id, JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint)), at]);
        row = { ...row, ...updated.rows[0] };
        return await finish({ card: await project() });
      }
      return await finish(failure(409, "SELECT_AFFECTED_CARDS", "请指定受影响的任务卡并说明退回原因；其他人的确认保持有效"));
    } else if (operation === "review-retry") {
      if (row.status !== "reviewing") return await finish(failure(409, "ROUND_NOT_REVIEWING", "当前不在组合 Review 阶段"));
      const updatedReview = await client.query("UPDATE mission_round_reviews SET agent_status='queued',agent_error=NULL,agent_run_id=NULL WHERE round_id=$1 AND window_seq=$2 AND superseded_at IS NULL AND agent_status='failed' RETURNING id", [row.id, row.window_seq]);
      if (!updatedReview.rowCount) return await finish(failure(409, "REVIEW_NOT_FAILED", "当前 Review 无需重试"));
      const updated = await client.query("UPDATE mission_rounds SET version=version+1,updated_at=$2,action_fingerprints=$3::jsonb WHERE id=$1 RETURNING *", [row.id, at, JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))]);
      row = { ...row, ...updated.rows[0] };
    } else {
      if (operation === "decide") return await finish(failure(409, "OWNER_RECONFIRMATION_REQUIRED", "修改建议需退回受影响的本人，不能在组合 Review 中改写已确认正文"));
      if (row.status !== "reviewing") return await finish(failure(409, "ROUND_NOT_REVIEWING", "请先等待全员本人确认与 Co-Agent Review"));
      const review = (await client.query<ReviewRow>("SELECT * FROM mission_round_reviews WHERE round_id=$1 AND window_seq=$2 AND superseded_at IS NULL", [row.id, row.window_seq])).rows[0];
      if (!review || review.agent_status !== "completed") return await finish(failure(409, "CO_AGENT_REVIEW_INCOMPLETE", "请先完成 Co-Agent Review，再由战场 DRI 确认任务组合"));
      if ((await q("SELECT 1 FROM personal_mission_cards WHERE round_id=$1 AND owner_confirmed_at IS NULL LIMIT 1", [row.id])).rowCount)
        return await finish(failure(409, "OWNERS_NOT_CONFIRMED", "仍有本人未确认任务"));
      const missions = (await q(`SELECT m.id,m.version FROM missions m JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id WHERE c.round_id=$1 ORDER BY m.id FOR SHARE OF m`, [row.id])).rows;
      if (missions.length !== Object.keys(review.mission_versions).length || missions.some((mission) => review.mission_versions[mission.id] !== mission.version))
        return await finish(failure(409, "MISSION_CHANGED", "任务版本已变化，请退回受影响的本人重新确认"));
      const note = input.note?.trim() ?? "";
      if (!note || note.length > 2000) return await finish(failure(400, "INVALID_REVIEW_NOTE", "请填写任务组合确认说明"));
      await q("UPDATE mission_round_reviews SET note=$2 WHERE id=$1", [review.id, note]);
      const updated = await q("UPDATE mission_rounds SET status='confirmed',confirmed_at=$2,confirmed_by=$3,version=version+1,updated_at=$2,action_fingerprints=$4::jsonb WHERE id=$1 RETURNING *", [row.id, at, person.personId, JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))]);
      row = { ...row, ...updated.rows[0] };
    }
    return await finish({ card: await project() });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined); throw error;
  } finally { client.release(); }
}
export function executeOpenMissionRound(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date): Promise<MeetingActionOutcome> {
  return executeRoundAction("open", pool, people, secret, person, scope, fingerprint, now);
}
export function executeRetryMissionRoundReview(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date): Promise<MeetingActionOutcome> {
  return executeRoundAction("review-retry", pool, people, secret, person, scope, fingerprint, now);
}
export function executeReopenMissionRound(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date): Promise<MeetingActionOutcome> {
  return executeRoundAction("reopen", pool, people, secret, person, scope, fingerprint, now);
}
export function executeCloseMissionRound(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date): Promise<MeetingActionOutcome> {
  return executeRoundAction("close", pool, people, secret, person, scope, fingerprint, now);
}
export function executeDecideMissionRound(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date, input: TMissionRoundDecideInput): Promise<MeetingActionOutcome> {
  return executeRoundAction("decide", pool, people, secret, person, scope, fingerprint, now, input);
}
export function executeConfirmMissionRound(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date, input: TMissionRoundConfirmInput): Promise<MeetingActionOutcome> {
  return executeRoundAction("confirm", pool, people, secret, person, scope, fingerprint, now, input);
}

/** 组合 Review 只退回具体受影响的卡，不使其他人的已确认承诺失效。 */
export async function returnMissionCards(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson,
  roundId: string, input: import("@warmap/contracts").TReturnMissionCardsRequest, now: () => Date): Promise<MeetingActionOutcome> {
  if (!UUID.test(roundId)) return failure(404, "ROUND_NOT_FOUND", "任务组合不存在");
  const client = await pool.connect(); const q: Query = (sql, params) => client.query(sql, params);
  try {
    await q("BEGIN");
    await q("SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE", [roundId]);
    const row = await getMissionRoundRow(q, roundId);
    if (!row || !await canRead(q, person, row)) { await q("ROLLBACK"); return failure(404, "ROUND_NOT_FOUND", "任务组合不存在"); }
    if (!canApprove(person, row)) { await q("ROLLBACK"); return failure(403, "ROUND_FORBIDDEN", "仅战场 DRI 可以退回任务卡"); }
    const finish = async (result: MeetingActionOutcome) => { await q("COMMIT"); return result; };
    if (row.version !== input.version) return await finish({ conflict: true, latestCard: await projectMissionRoundCard(q, people, secret, person, row, now()) });
    if (!["reviewing", "confirmed"].includes(row.status)) return await finish(failure(409, "ROUND_NOT_REVIEWING", "全员本人确认后，才能退回受影响的任务卡"));
    if (correctionPeriodClosed(row, now())) return await finish(failure(409, "MISSION_CARD_PERIOD_CLOSED", "月份已过，任务卡只读"));
    if (row.status === "confirmed" && (await q("SELECT 1 FROM personal_mission_cards WHERE round_id=$1 AND owner_confirmed_at IS NULL LIMIT 1", [roundId])).rowCount)
      return await finish(failure(409, "LEGACY_CONFIRMATION_REQUIRES_NEW_DRAFT", "这份历史组合没有本人确认记录，请单独重新起草；原正式确认与更正历史保持只读"));
    const cards = (await q("SELECT id FROM personal_mission_cards WHERE round_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE", [roundId, input.cardIds])).rows;
    if (cards.length !== input.cardIds.length) return await finish(failure(400, "INVALID_RETURN_CARDS", "请选择当前战场里的任务卡"));
    const reason = input.reason.trim(), at = now();
    if (!reason || reason.includes("\u0000")) return await finish(failure(400, "INVALID_RETURN_REASON", "请说明需要本人处理的具体问题"));
    await q("UPDATE personal_mission_cards SET owner_confirmed_at=NULL,return_reason=$3 WHERE round_id=$1 AND id=ANY($2::uuid[])", [roundId, input.cardIds, reason]);
    await q("UPDATE mission_round_reviews SET superseded_at=$2 WHERE round_id=$1 AND superseded_at IS NULL", [roundId, at]);
    const priorReview = (await q("SELECT id,note FROM mission_round_reviews WHERE round_id=$1 AND window_seq=$2 ORDER BY taken_at DESC LIMIT 1", [row.id, row.window_seq])).rows[0];
    const priorConfirmation = row.confirmed_at && row.confirmed_by ? { by: row.confirmed_by, at: row.confirmed_at.toISOString(), note: priorReview?.note ?? "", reviewId: priorReview?.id ?? null } : undefined;
    const reopens = [...row.reopens, { by: person.personId, at: at.toISOString(), closedAt: row.closes_at?.toISOString() ?? at.toISOString(), cardIds: input.cardIds, reason, priorConfirmation }];
    await q(`UPDATE mission_rounds SET status='open',window_seq=window_seq+1,opened_at=$2,closes_at=NULL,
      confirmed_at=NULL,confirmed_by=NULL,reopens=$3::jsonb,version=version+1,updated_at=$2 WHERE id=$1`, [roundId, at, JSON.stringify(reopens)]);
    const updated = (await getMissionRoundRow(q, roundId))!;
    return await finish({ card: await projectMissionRoundCard(q, people, secret, person, updated, at) });
  } catch (cause) { await q("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

const MISSION_FIELD_COLUMNS: Record<TMissionCardField, string> = {
  title: "title", why: "why", outcome: "outcome", successEvidence: "success_evidence", boundaries: "boundaries", keyPath: "key_path",
  timeBoundary: "time_boundary", tradeoffs: "tradeoffs",
  milestones: "milestones", resources: "resources", dependencies: "dependencies", humanAgentSplit: "human_agent_split", risk: "risk", retrospect: "retrospect",
};
/**
 * 整轮确认与确认后更正共用的写回：successEvidence／milestones 按行拆成 JSON 数组，一次调用只升一次版本。
 * 调用者须在同一事务里已持该 Mission 行锁；返回写回后的版本。
 */
export async function writeMissionFields(client: PoolClient, missionId: string, changes: { field: TMissionCardField; proposed: string }[], at: Date): Promise<number> {
  // Columns are selected only through the field allowlist, never through request text.
  const values: unknown[] = [missionId, at];
  const sets = changes.map(({ field, proposed }) => {
    const list = field === "successEvidence" || field === "milestones";
    values.push(list ? JSON.stringify(proposed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) : proposed);
    return `${MISSION_FIELD_COLUMNS[field]}=$${values.length}${list ? "::jsonb" : ""}`;
  });
  const updated = await client.query<{ version: number }>(`UPDATE missions SET ${sets.join(",")},version=version+1,updated_at=$2 WHERE id=$1 RETURNING version`, values);
  return updated.rows[0].version;
}

const DraftText = Type.String({ maxLength: 4000 });
const DraftLines = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 30 });
const DraftMission = Type.Object({
  code: CreateMissionRequest.properties.code,
  carriedFrom: Type.Object({ ssotTaskId: Type.String({ minLength: 1 }), septemberMissionCode: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }, { additionalProperties: false }),
  capabilityCode: Type.String({ minLength: 1 }), title: CreateMissionRequest.properties.title,
  why: DraftText, outcome: CreateMissionRequest.properties.outcome, successEvidence: DraftLines,
  boundaries: DraftText, keyPath: DraftText, milestones: DraftLines, resources: DraftText,
  dependencies: DraftText, humanAgentSplit: DraftText, risk: DraftText, retrospect: DraftText,
  timeBoundary: Type.Optional(DraftText), tradeoffs: Type.Optional(DraftText),
  source: Type.Object({ url: Type.String({ minLength: 1, maxLength: 500 }), documentId: Type.String({ minLength: 1, maxLength: 200 }),
    revision: Type.Integer({ minimum: 1 }), fetchedOn: Type.Optional(Type.String()) }, { additionalProperties: false }),
}, { additionalProperties: false });
const DraftFile = Type.Object({
  schema: Type.Literal("mission-card-drafts.v1"), period: CreateMissionRequest.properties.period,
  battlefieldCode: Type.String({ minLength: 1 }), origin: Type.Literal("placeholder"),
  placeholderNote: Type.String({ minLength: 1, maxLength: 300 }),
  generatedBy: Type.Optional(Type.String()), rules: Type.Optional(Type.Array(Type.String())),
  source: Type.Object({ file: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }),
    sha256: Type.String({ pattern: "^[a-fA-F0-9]{64}$" }), period: CreateMissionRequest.properties.period }, { additionalProperties: false }),
  cards: Type.Array(Type.Object({ ownerId: Type.String({ minLength: 1 }), sortOrder: Type.Integer(),
    roleLabel: Type.Optional(Type.String()), sourceCardId: Type.String({ minLength: 1 }),
    missions: Type.Array(DraftMission, { minItems: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });
type DraftFileValue = Static<typeof DraftFile>;
export class MissionDraftImportError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "MissionDraftImportError"; }
}
export type MissionDraftImportResult = { roundId: string; imported: boolean; cards: { ownerId: string; missionCount: number }[] };
type DraftActionContext = { person: MissionRoundPerson; scope: ActionScope; fingerprint: string };
async function readDraft(file: string): Promise<{ value: DraftFileValue; sha256: string }> {
  let bytes: Buffer;
  try { bytes = await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissionDraftImportError(404, "MISSION_DRAFTS_NOT_FOUND", `找不到讨论候选文件：${basename(file)}`);
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new MissionDraftImportError(400, "INVALID_DRAFT_SCHEMA", "讨论候选文件不是合法 JSON"); }
  if (!Value.Check(DraftFile, value)) {
    const first = Value.Errors(DraftFile, value).First();
    throw new MissionDraftImportError(400, "INVALID_DRAFT_SCHEMA", `讨论候选不符合 mission-card-drafts.v1：${first?.path || "/"} ${first?.message ?? ""}`);
  }
  const owners = new Set<string>(); const codes = new Set<string>();
  for (const card of value.cards) {
    if (owners.has(card.ownerId)) throw new MissionDraftImportError(400, "INVALID_DRAFT_SCHEMA", `Owner 重复：${card.ownerId}`);
    owners.add(card.ownerId);
    for (const mission of card.missions) {
      if (codes.has(mission.code)) throw new MissionDraftImportError(400, "INVALID_DRAFT_SCHEMA", `个人任务编号重复：${mission.code}`);
      codes.add(mission.code);
    }
  }
  return { value, sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function importedCards(q: Query, roundId: string): Promise<MissionDraftImportResult["cards"]> {
  return (await q(`SELECT c.owner_id AS "ownerId",count(m.id)::int AS "missionCount" FROM personal_mission_cards c
    LEFT JOIN missions m ON m.personal_mission_card_id=c.id WHERE c.round_id=$1 GROUP BY c.id ORDER BY c.sort_order,c.owner_id,c.id`, [roundId])).rows as MissionDraftImportResult["cards"];
}

async function insertPlaceholderCards(
  client: PoolClient, value: DraftFileValue, roundId: string, battlefieldId: string, battlefieldOwnerId: string,
  capabilities: Map<string, string>, people: MemoryPerson[], at: Date, existingCards: Map<string, string> = new Map(),
): Promise<void> {
  for (const card of value.cards) {
    // 起草中已经为这个人建过卡时沿用那张卡的编号，已经打开的链接不失效。
    const existing = existingCards.get(card.ownerId);
    const cardId = existing ?? randomUUID();
    if (existing) await client.query("UPDATE personal_mission_cards SET sort_order=$2,role_label=$3,member_ids=$4::jsonb WHERE id=$1",
      [cardId, card.sortOrder, card.roleLabel ?? null, JSON.stringify(missionCardMembers(card.ownerId, battlefieldOwnerId, people))]);
    else await client.query(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,role_label,member_ids,created_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [cardId, roundId, card.ownerId, card.sortOrder, card.roleLabel ?? null, JSON.stringify(missionCardMembers(card.ownerId, battlefieldOwnerId, people)), at]);
    for (const mission of card.missions) await client.query(`INSERT INTO missions
      (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,boundaries,key_path,
       milestones,resources,dependencies,human_agent_split,risk,retrospect,source_ref,source_document_id,source_revision,
       source_title,placeholder,personal_mission_card_id,created_at,updated_at,time_boundary,tradeoffs)
      VALUES ($1,1,$1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,true,$22,$23,$23,$24,$25)`,
    [mission.code, value.period, mission.title, card.ownerId, capabilities.get(mission.capabilityCode)!, JSON.stringify([battlefieldId]),
      mission.outcome, mission.why, JSON.stringify(mission.successEvidence), mission.boundaries, mission.keyPath,
      JSON.stringify(mission.milestones), mission.resources, mission.dependencies, mission.humanAgentSplit, mission.risk,
      mission.retrospect, mission.source.url, mission.source.documentId, mission.source.revision, value.placeholderNote, cardId, at,
      mission.timeBoundary ?? "", mission.tradeoffs ?? ""]);
  }
}

/** 显式人工文件导入：先校验完整候选，再在同一事务建轮次、卡与任务；自动起草不调用这里。 */
export async function importMissionCardDrafts(
  pool: Pool, people: MemoryPerson[], file: string, now: Date | (() => Date), action?: DraftActionContext,
): Promise<MissionDraftImportResult> {
  const { value, sha256 } = await readDraft(file);
  const clock = typeof now === "function" ? now : () => now;
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    // 空 slot 尚无轮次行；稳定战场行锁使并发整理在唯一性判断之前串行。
    const battlefield = (await client.query<{ id: string; owner_id: string }>("SELECT id,owner_id FROM battlefield_config WHERE code=$1 FOR UPDATE", [value.battlefieldCode])).rows[0];
    if (!battlefield) throw new MissionDraftImportError(400, "INVALID_BATTLEFIELD", `战场 code ${value.battlefieldCode} 未登记`);
    if (action) {
      if (action.scope.objectId !== `${battlefield.id}:${value.period}`) throw new MissionDraftImportError(400, "INVALID_DRAFT_SCHEMA", "候选文件的战场或月份与整理草稿入口不一致");
      if (!canApprove(action.person, { battlefield_owner_id: battlefield.owner_id })) throw new MissionDraftImportError(403, "ROUND_FORBIDDEN", "仅该战场 DRI 可以整理任务卡草稿");
    }
    const existing = (await client.query<{ id: string; draft_source: { sha256?: string } }>("SELECT id,draft_source FROM mission_rounds WHERE battlefield_id=$1 AND period=$2 FOR UPDATE", [battlefield.id, value.period])).rows[0];
    if (existing) {
      if (existing.draft_source.sha256 !== sha256) throw new MissionDraftImportError(409, "MISSION_DRAFT_SOURCE_CHANGED", "本月任务卡已存在且候选文件已改变，不能覆盖已有任务内容");
      if (action) await closeIfDue(client, (await getMissionRoundRow(q, existing.id))!, clock());
      const cards = await importedCards(q, existing.id);
      await client.query("COMMIT"); return { roundId: existing.id, imported: false, cards };
    }
    const plan = (await client.query<{ id: string; status: string; confirmed_at: Date | null; battlefields: { battlefieldId: string; outcome: string }[] }>(
      "SELECT id,status,confirmed_at,battlefields FROM monthly_plans WHERE period=$1 FOR SHARE", [value.period])).rows[0];
    if (!plan || plan.status !== "confirmed" || !plan.confirmed_at) throw new MissionDraftImportError(409, "MONTHLY_PLAN_NOT_CONFIRMED", `${Number(value.period.slice(5))} 月月度计划还没签发：先签发再整理草稿`);
    if (!plan.battlefields.some((item) => item.battlefieldId === battlefield.id && item.outcome.trim())) throw new MissionDraftImportError(409, "ROUND_GOALS_MISSING", "已签发月度计划里没有本战场的本月结果，暂不能整理草稿");
    const knownPeople = new Set(people.map((person) => person.personId));
    const capabilities = new Map((await client.query<{ id: string; code: string }>("SELECT id,code FROM capability_config")).rows.map((item) => [item.code, item.id]));
    for (const card of value.cards) {
      if (!knownPeople.has(card.ownerId)) throw new MissionDraftImportError(400, "INVALID_OWNER", `任务卡 Owner 未登记：${card.ownerId}`);
      for (const mission of card.missions) if (!capabilities.has(mission.capabilityCode)) throw new MissionDraftImportError(400, "INVALID_CAPABILITY", `个人任务 ${mission.code} 的能力域 code ${mission.capabilityCode} 未登记`);
    }
    const codes = value.cards.flatMap((card) => card.missions.map((mission) => mission.code));
    const collision = await client.query<{ code: string }>("SELECT code FROM missions WHERE id=ANY($1::text[]) OR code=ANY($1::text[]) LIMIT 1", [codes]);
    if (collision.rows[0]) throw new MissionDraftImportError(409, "MISSION_CODE_CONFLICT", `个人任务编号已存在：${collision.rows[0].code}`);
    const at = clock(); const roundId = randomUUID();
    const source = { file: basename(file), sha256, schema: value.schema, importedAt: at.toISOString(), source: value.source };
    await client.query(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,action_fingerprints,created_at,updated_at)
      VALUES ($1,1,$2,$3,$4,'draft','placeholder',$5::jsonb,$6::jsonb,$7,$7)`,
    [roundId, battlefield.id, value.period, plan.id, JSON.stringify(source), JSON.stringify(action ? [action.fingerprint] : []), at]);
    await insertPlaceholderCards(client, value, roundId, battlefield.id, battlefield.owner_id, capabilities, people, at);
    const cards = await importedCards(q, roundId);
    await client.query("COMMIT"); return { roundId, imported: true, cards };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") throw new MissionDraftImportError(409, "MISSION_CODE_CONFLICT", "个人任务编号已存在，未导入任何草稿");
    throw error;
  } finally { client.release(); }
}

function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4)); const month = Number(period.slice(5));
  return `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, "0")}`;
}

type PreviousMission = {
  title: string; why: string; outcome: string; success_evidence: string[]; boundaries: string; key_path: string;
  milestones: string[]; resources: string; dependencies: string; human_agent_split: string; risk: string; retrospect: string;
  capability_code: string; source_ref: string; source_document_id: string; source_revision: number;
  time_boundary: string; tradeoffs: string;
};
/**
 * 起草名单 = 战场参与者，去掉 CEO 和人员目录外的人。参与者从未保存过（NULL）时，
 * 按上月在本战场有任务卡或 Mission 的人推算（含本月已登记 Mission 的人）。
 */
export async function missionCardParticipants(q: Query, people: MemoryPerson[], battlefieldId: string, period: string): Promise<{ personIds: string[]; derived: boolean }> {
  const saved = ((await q("SELECT participant_ids FROM battlefield_config WHERE id=$1", [battlefieldId])).rows[0]?.participant_ids ?? null) as string[] | null;
  const ids = saved ?? ((await q(`SELECT owner_id FROM (
    SELECT c.owner_id FROM personal_mission_cards c JOIN mission_rounds r ON r.id=c.round_id
      WHERE r.battlefield_id=$1 AND r.period=$2
    UNION SELECT m.owner_id FROM missions m WHERE m.period IN ($2,$3) AND m.battlefield_ids @> $4::jsonb
  ) owners ORDER BY owner_id`, [battlefieldId, previousPeriod(period), period, JSON.stringify([battlefieldId])])).rows as { owner_id: string }[]).map((row) => row.owner_id);
  const eligible = new Set(people.filter((person) => !person.roles.includes("ceo")).map((person) => person.personId));
  return { personIds: ids.filter((id) => eligible.has(id)), derived: saved === null };
}

/** 起草中断时保留个人卡与真实成功结果，标记未完成的人；晚到的旧结果不能覆盖重试。 */
export async function recoverStaleMissionDrafts(pool: Pool, now: Date): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stale = await client.query<{ id: string; draft_source: Record<string, unknown> }>(
      "SELECT id,draft_source FROM mission_rounds WHERE status='drafting' AND updated_at < $1 FOR UPDATE",
      [new Date(now.getTime() - 10 * 60_000)]);
    for (const row of stale.rows) await markDraftInterrupted(client, row, "Co-Agent 起草中断，可重试", now);
    await client.query("COMMIT");
    return stale.rowCount ?? 0;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function markDraftInterrupted(client: PoolClient, row: { id: string; draft_source: Record<string, unknown> }, message: string, at: Date) {
  const owners = (await client.query<{ owner_id: string }>(`SELECT c.owner_id FROM personal_mission_cards c
    WHERE c.round_id=$1 AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.personal_mission_card_id=c.id)`, [row.id])).rows;
  const pending = Array.isArray(row.draft_source.pendingOwners) ? row.draft_source.pendingOwners as string[] : owners.map((owner) => owner.owner_id);
  const interrupted = owners.filter((owner) => pending.includes(owner.owner_id));
  const failedOwners = [...draftFailures(row).filter((failure) => !pending.includes(failure.ownerId)),
    ...interrupted.map((owner) => ({ ownerId: owner.owner_id, message }))];
  const previousResults = Array.isArray(row.draft_source.ownerResults) ? row.draft_source.ownerResults : [];
  const ownerResults = [...previousResults, ...interrupted.map((owner) => ({ ownerId: owner.owner_id,
    attemptId: row.draft_source.attemptId, at: at.toISOString(), error: message, interrupted: true }))];
  await client.query("UPDATE mission_rounds SET status='draft',draft_origin='agent',draft_source=$2::jsonb,version=version+1,updated_at=$3 WHERE id=$1",
    [row.id, JSON.stringify({ ...row.draft_source, pendingOwners: [], failedOwners, ownerResults }), at]);
}

const KnownMissionsFile = Type.Object({
  period: CreateMissionRequest.properties.period,
  items: Type.Array(Type.Object({ personId: Type.String({ minLength: 1 }), kind: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String()), sourceRef: Type.Optional(Type.String()), markdown: Type.Union([Type.String(), Type.Null()]) })),
});
/** 本人这个月已写好的任务（飞书任务卡、本体已建 Mission 的导出）；文件未配置、缺失或格式不对时不影响起草。 */
async function readKnownMissions(file: string | undefined, period: string): Promise<(Static<typeof KnownMissionsFile>["items"][number] & { markdown: string })[]> {
  if (!file) return [];
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Value.Check(KnownMissionsFile, value)) throw new Error(`${Value.Errors(KnownMissionsFile, value).First()?.path || "/"} 格式不对`);
    return value.period === period ? value.items.filter((item): item is typeof item & { markdown: string } => !!item.markdown?.trim()) : [];
  } catch (error) {
    console.warn(`known missions ignored (${basename(file)}): ${(error as Error).message || String(error)}`);
    return [];
  }
}

/** 真实历史只用于模型依据；失败保留原始错误与空卡，绝不填入旧月正文或演示文件。全部成功后由系统交给本人。 */
export async function completeMissionRoundDraft(
  pool: Pool, people: MemoryPerson[], roundId: string, agent: MissionCardDraftAgent,
  memory: CompanyContext | undefined, now: () => Date, knownMissionsFile?: string,
): Promise<void> {
  const q: Query = (sql, params) => pool.query(sql, params);
  const row = await getMissionRoundRow(q, roundId);
  if (!row || row.status !== "drafting") return;
  const attemptId = row.draft_source.attemptId;
  const plan = (await q("SELECT company_outcome,battlefields,confirmed_at FROM monthly_plans WHERE id=$1", [row.monthly_plan_id])).rows[0] as { company_outcome: string; battlefields: { battlefieldId: string; outcome: string }[]; confirmed_at: Date };
  const battlefield = (await q("SELECT code,name,six_month_outcome,mission_anchors FROM battlefield_config WHERE id=$1", [row.battlefield_id])).rows[0] as { code: string; name: string; six_month_outcome: string; mission_anchors: unknown };
  const capabilities = (await q("SELECT code,name FROM capability_config ORDER BY sort_order,code")).rows as { code: string; name: string }[];
  const pending = Array.isArray(row.draft_source.pendingOwners) ? row.draft_source.pendingOwners as string[] : null;
  const owners = (await personalCards(q, roundId)).filter((owner) => !pending || pending.includes(owner.owner_id));
  const names = new Map(people.map((item) => [item.personId, item.displayName]));
  const known = await readKnownMissions(knownMissionsFile, row.period);
  const results = await Promise.all(owners.map(async (owner) => {
    try {
      const previous = (await q(`SELECT m.title,m.why,m.outcome,m.success_evidence,m.boundaries,m.key_path,m.milestones,m.resources,
        m.dependencies,m.human_agent_split,m.risk,m.retrospect,m.time_boundary,m.tradeoffs,cap.code AS capability_code,
        m.source_ref,m.source_document_id,m.source_revision
        FROM missions m JOIN capability_config cap ON cap.id=m.capability_id
        WHERE m.period=$2 AND m.owner_id=$3
          AND (m.personal_mission_card_id IN (SELECT c.id FROM personal_mission_cards c JOIN mission_rounds r ON r.id=c.round_id WHERE r.battlefield_id=$1 AND r.period=$2 AND c.owner_id=$3)
            OR (m.personal_mission_card_id IS NULL AND m.battlefield_ids @> jsonb_build_array($1::text) AND NOT EXISTS (SELECT 1 FROM personal_mission_cards c JOIN mission_rounds r ON r.id=c.round_id WHERE r.battlefield_id=$1 AND r.period=$2 AND c.owner_id=$3)))
        ORDER BY m.code`,
      [row.battlefield_id, previousPeriod(row.period), owner.owner_id])).rows as PreviousMission[];
      const company = memory ? await readCompanyContext(memory, `${battlefield.name} ${names.get(owner.owner_id) ?? owner.owner_id}`) : undefined;
      const matches = company?.entries ?? [];
      const input: MissionCardDraftInput = {
        period: row.period,
        battlefield: { id: row.battlefield_id, code: battlefield.code, name: battlefield.name, sixMonthOutcome: battlefield.six_month_outcome, missionAnchors: battlefield.mission_anchors },
        plan: { companyOutcome: plan.company_outcome, monthOutcome: plan.battlefields.find((item) => item.battlefieldId === row.battlefield_id)?.outcome ?? "", signedAt: plan.confirmed_at.toISOString() },
        owner: { personId: owner.owner_id, displayName: names.get(owner.owner_id) ?? owner.owner_id },
        previousCard: previous.length ? { missions: previous } : null,
        previousReview: (await q("SELECT self_review FROM personal_reviews WHERE person_id=$1 AND period=$2 AND status='submitted' ORDER BY submitted_at DESC LIMIT 1",
          [owner.owner_id, previousPeriod(row.period)])).rows[0]?.self_review ?? null, capabilities,
        companyMemory: matches.slice(0, 3).map(({ title, text }) => ({ title, text })),
        companyStatus: company?.nextCursor ? "partial" : company?.status ?? "not_configured",
        knownMissions: known.filter((item) => item.personId === owner.owner_id)
          .map((item) => ({ kind: item.kind, title: item.title ?? null, sourceRef: item.sourceRef ?? null, markdown: item.markdown })),
      };
      const generated = await agent.generate(input, AbortSignal.timeout(240_000));
      const { candidate, runId } = generated;
      const metadata = generated as { reviewRunIds?: string[]; draftRunIds?: string[]; basisSource?: string };
      if (!Value.Check(MissionCardDraftCandidate, candidate)) throw Object.assign(new Error("Mission Card candidate schema invalid"), metadata);
      if (candidate.missions.some((mission) => !capabilities.some((capability) => capability.code === mission.capabilityCode))) throw Object.assign(new Error("Mission Card capability unknown"), metadata);
      return { owner, missions: candidate.missions as MissionCardDraftCandidateValue["missions"], runId,
        reviewRunIds: metadata.reviewRunIds ?? [], draftRunIds: metadata.draftRunIds ?? [], basisSource: metadata.basisSource, error: null };
    } catch (error) {
      const metadata = error as { reviewRunIds?: string[]; draftRunIds?: string[]; basisSource?: string };
      const message = (error as Error).message || String(error);
      console.warn(`mission card draft failed for ${owner.owner_id}: ${message}`);
      return { owner, missions: null, runId: undefined, reviewRunIds: metadata.reviewRunIds ?? [],
        draftRunIds: metadata.draftRunIds ?? [], basisSource: metadata.basisSource, error: message };
    }
  }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query<{ status: string; draft_source: Record<string, unknown> }>(
      "SELECT status,draft_source FROM mission_rounds WHERE id=$1 FOR UPDATE", [roundId])).rows[0];
    if (current?.status !== "drafting" || current.draft_source.attemptId !== attemptId) { await client.query("ROLLBACK"); return; }
    const capabilityIds = new Map((await client.query<{ id: string; code: string }>("SELECT id,code FROM capability_config")).rows.map((item) => [item.code, item.id]));
    const at = now();
    for (const result of results) {
      if (!result.missions) continue;
      // Retried owners retain their card identity. Successful owners are never rewritten by a retry.
      const existing = await client.query("SELECT 1 FROM missions WHERE personal_mission_card_id=$1 LIMIT 1", [result.owner.id]);
      if (existing.rowCount) continue;
      for (const [index, mission] of result.missions.entries()) {
        const id = randomUUID();
        const code = `${row.period}-${battlefield.code}-${String(result.owner.sort_order + 1).padStart(2, "0")}-${index + 1}`;
        await client.query(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,boundaries,key_path,
          milestones,resources,dependencies,human_agent_split,risk,retrospect,source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id,created_at,updated_at,time_boundary,tradeoffs)
          VALUES ($1,1,$25,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,1,$20,false,$21,$22,$22,$23,$24)`,
        [id, row.period, mission.title, result.owner.owner_id, capabilityIds.get(mission.capabilityCode), JSON.stringify([row.battlefield_id]),
          mission.outcome, mission.why, JSON.stringify(mission.successEvidence), mission.boundaries, mission.keyPath, JSON.stringify(mission.milestones),
          mission.resources, mission.dependencies, mission.humanAgentSplit, mission.risk, mission.retrospect,
          `mission-card-agent://${roundId}/${result.owner.owner_id}`, `mission-card-agent:${roundId}`, `起草依据：${mission.basis}`,
          result.owner.id, at, mission.timeBoundary, mission.tradeoffs, code]);
      }
    }
    const retried = new Set(results.map((result) => result.owner.owner_id));
    const failedOwners = [...draftFailures(current).filter((failure) => !retried.has(failure.ownerId)),
      ...results.filter((result) => result.error !== null).map((result) => ({ ownerId: result.owner.owner_id, message: result.error!,
        reviewRunIds: result.reviewRunIds, draftRunIds: result.draftRunIds, basisSource: result.basisSource }))];
    const previousResults = Array.isArray(current.draft_source.ownerResults) ? current.draft_source.ownerResults : [];
    const source = { ...current.draft_source, pendingOwners: [], failedOwners,
      ownerResults: [...previousResults, ...results.map((result) => ({ ownerId: result.owner.owner_id, attemptId, at: at.toISOString(),
        runId: result.runId, reviewRunIds: result.reviewRunIds, draftRunIds: result.draftRunIds, basisSource: result.basisSource, error: result.error }))] };
    await client.query("UPDATE mission_rounds SET status='draft',draft_origin='agent',draft_source=$2::jsonb,version=version+1,updated_at=$3 WHERE id=$1",
      [roundId, JSON.stringify(source), at]);
    // 整个战场都起草成功才一起交给本人；检查不过（如缺六个月目标）停在草稿，原因给 CEO 与战场 DRI 看。
    if (!failedOwners.length) {
      const drafted = (await getMissionRoundRow((sql, params) => client.query(sql, params), roundId))!;
      const opened = await openForOwners(client, drafted, at, { draft_source: { ...source,
        trail: [...draftTrail(drafted), { at: at.toISOString(), by: "system", text: "起草完成后自动交给本人" }] } });
      if ("error" in opened) await client.query("UPDATE mission_rounds SET draft_source=$2::jsonb WHERE id=$1",
        [roundId, JSON.stringify({ ...source, openProblem: opened.error.message })]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function recoverDraftRound(pool: Pool, roundId: string, message: string, now: Date, attemptId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query<{ id: string; status: string; draft_source: Record<string, unknown> }>(
      "SELECT id,status,draft_source FROM mission_rounds WHERE id=$1 FOR UPDATE", [roundId])).rows[0];
    if (current?.status === "drafting" && current.draft_source.attemptId === attemptId)
      await markDraftInterrupted(client, current, message, now);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** 新建起草中的轮次，参与者每人一张空卡；不判断操作人身份。调用者须已持战场行锁，并确认本月还没有轮次。 */
async function insertDraftingRound(client: PoolClient, people: MemoryPerson[], battlefield: { id: string; owner_id: string }, period: string,
  at: Date, record: { action_fingerprints: string[]; trail?: DraftTrailEntry[] }): Promise<{ roundId: string; attemptId: string } | RoundRefusal> {
  const plan = (await client.query<{ id: string; status: string; confirmed_at: Date | null; battlefields: { battlefieldId: string; outcome: string }[] }>(
    "SELECT id,status,confirmed_at,battlefields FROM monthly_plans WHERE period=$1 FOR SHARE", [period])).rows[0];
  if (!plan || plan.status !== "confirmed" || !plan.confirmed_at) return failure(409, "MONTHLY_PLAN_NOT_CONFIRMED", "月度计划还没签发：先签发再整理草稿");
  if (!plan.battlefields.some((item) => item.battlefieldId === battlefield.id && item.outcome.trim())) return failure(409, "ROUND_GOALS_MISSING", "已签发月度计划里没有本战场的本月结果");
  const { personIds } = await missionCardParticipants((sql, params) => client.query(sql, params), people, battlefield.id, period);
  if (!personIds.length) return failure(409, "NO_DRAFT_OWNERS", "战场参与者名单为空，请先在战场配置里设置参与者");
  const roundId = randomUUID(), attemptId = randomUUID();
  await client.query(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,action_fingerprints,created_at,updated_at)
    VALUES ($1,1,$2,$3,$4,'drafting','agent',$5::jsonb,$6::jsonb,$7,$7)`,
  [roundId, battlefield.id, period, plan.id, JSON.stringify({ attemptId, pendingOwners: personIds, failedOwners: [], ...(record.trail ? { trail: record.trail } : {}) }),
    JSON.stringify(record.action_fingerprints), at]);
  for (const [index, ownerId] of personIds.entries()) await client.query(`INSERT INTO personal_mission_cards
    (id,round_id,owner_id,sort_order,role_label,member_ids,created_at) VALUES ($1,$2,$3,$4,NULL,$5::jsonb,$6)`,
  [randomUUID(), roundId, ownerId, index, JSON.stringify(missionCardMembers(ownerId, battlefield.owner_id, people)), at]);
  return { roundId, attemptId };
}

/** 后台逐人起草；中途异常时保留卡并标出未完成的人，由战场 DRI 重试。 */
function draftInBackground(pool: Pool, people: MemoryPerson[], roundId: string, attemptId: string, now: () => Date,
  agent: MissionCardDraftAgent, memory?: CompanyContext, knownMissionsFile?: string): void {
  void completeMissionRoundDraft(pool, people, roundId, agent, memory, now, knownMissionsFile).catch(async (error) => {
    await recoverDraftRound(pool, roundId, (error as Error).message || String(error), now(), attemptId).catch((recovery) =>
      console.error(`mission card draft recovery ${roundId} failed: ${String(recovery)}`));
    console.error(`mission card draft ${roundId} failed: ${(error as Error).message || String(error)}`);
  });
}

/**
 * CEO 签发后，系统为计划里有本月结果的每个战场起草任务卡（不记成任何人的操作）。
 * 已有轮次或参与者为空的战场跳过；各战场分别提交，起草在后台进行，起草完成后自动交给本人。
 */
export async function startSignedMissionDrafts(pool: Pool, people: MemoryPerson[], period: string, now: () => Date,
  agent: MissionCardDraftAgent, memory?: CompanyContext, knownMissionsFile?: string): Promise<void> {
  const plan = (await pool.query<{ battlefields: { battlefieldId: string; outcome: string }[] }>(
    "SELECT battlefields FROM monthly_plans WHERE period=$1 AND status='confirmed'", [period])).rows[0];
  for (const { battlefieldId } of (plan?.battlefields ?? []).filter((item) => item.outcome.trim())) {
    const client = await pool.connect();
    let started: { roundId: string; attemptId: string } | null = null;
    try {
      await client.query("BEGIN");
      const battlefield = (await client.query<{ id: string; owner_id: string }>("SELECT id,owner_id FROM battlefield_config WHERE id=$1 FOR UPDATE", [battlefieldId])).rows[0];
      const existing = (await client.query("SELECT 1 FROM mission_rounds WHERE battlefield_id=$1 AND period=$2", [battlefieldId, period])).rowCount;
      const at = now();
      const result = battlefield && !existing ? await insertDraftingRound(client, people, battlefield, period, at,
        { action_fingerprints: [], trail: [{ at: at.toISOString(), by: "system", text: "CEO 签发后系统起草" }] }) : null;
      if (result && !("error" in result)) started = result;
      await client.query(started ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error(`mission card draft for ${battlefieldId} ${period} did not start: ${(error as Error).message || String(error)}`);
    } finally { client.release(); }
    if (started) draftInBackground(pool, people, started.roundId, started.attemptId, now, agent, memory, knownMissionsFile);
  }
}

/** 战场 DRI 的起草动作：重试起草失败的人；本月还没有轮次时也从这里起草。签发后的系统起草见 startSignedMissionDrafts。 */
export async function executeDraftMissionRound(
  pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope,
  fingerprint: string, now: () => Date, knownMissionsFile?: string, agent?: MissionCardDraftAgent, memory?: CompanyContext,
): Promise<MeetingActionOutcome> {
  const match = /^(.*):(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(scope.objectId);
  if (!match || scope.objectVersion !== 1) return failure(404, "UNKNOWN_ACTION", "无效的整理草稿入口");
  const retry = scope.itemId ? /^([0-9a-f-]{36}):([1-9]\d*)$/i.exec(scope.itemId) : null;
  if (scope.itemId && !retry) return failure(404, "UNKNOWN_ACTION", "无效的起草重试入口");
  const q: Query = (sql, params) => pool.query(sql, params);
  const battlefield = (await q("SELECT id,code,owner_id FROM battlefield_config WHERE id=$1", [match[1]])).rows[0] as { id: string; code: string; owner_id: string } | undefined;
  if (!battlefield) return failure(404, "ROUND_NOT_FOUND", "战场不存在");
  if (!canApprove(person, { battlefield_owner_id: battlefield.owner_id })) return failure(403, "ROUND_FORBIDDEN", "仅该战场 DRI 可以整理任务卡草稿");
  if (!agent) return failure(503, "MISSION_DRAFT_AGENT_UNAVAILABLE", "Co-Agent 起草服务未配置，请配置后重试");
  const client = await pool.connect();
  let roundId: string | undefined;
  let attemptId: string | undefined;
  let replayed = false;
  try {
    await client.query("BEGIN");
    const locked = (await client.query<{ id: string; owner_id: string }>("SELECT id,owner_id FROM battlefield_config WHERE id=$1 FOR UPDATE", [battlefield.id])).rows[0];
    if (!locked || !canApprove(person, { battlefield_owner_id: locked.owner_id })) {
      await client.query("ROLLBACK"); return failure(403, "ROUND_FORBIDDEN", "仅该战场 DRI 可以整理任务卡草稿");
    }
    const existing = (await client.query<{ id: string; version: number; status: string; draft_source: Record<string, unknown>; action_fingerprints: string[] }>(
      "SELECT id,version,status,draft_source,action_fingerprints FROM mission_rounds WHERE battlefield_id=$1 AND period=$2 FOR UPDATE", [battlefield.id, match[2]])).rows[0];
    if (existing) {
      if (retry && retry[1] !== existing.id) {
        await client.query("ROLLBACK"); return failure(404, "ROUND_NOT_FOUND", "起草重试不属于当前任务卡");
      }
      roundId = existing.id;
      if (existing.action_fingerprints.includes(fingerprint)) replayed = true;
      else if (retry && Number(retry[2]) !== existing.version) {
        await client.query("ROLLBACK"); return failure(409, "ROUND_DRAFT_RETRY_STALE", "起草状态已变化，请刷新后重试");
      } else if (existing.status === "drafting") {
        await client.query("ROLLBACK"); return failure(409, "ROUND_DRAFTING", "Co-Agent 正在起草，稍后刷新即可查看");
      } else if (retry && existing.status === "draft" && draftFailures(existing).length) {
        const failed = draftFailures(existing).map((failure) => failure.ownerId);
        const unfinished = (await client.query<{ owner_id: string }>(`SELECT c.owner_id FROM personal_mission_cards c
          WHERE c.round_id=$1 AND c.owner_id=ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.personal_mission_card_id=c.id)`,
          [existing.id, failed])).rows.map((owner) => owner.owner_id);
        if (!unfinished.length) {
          await client.query("ROLLBACK"); return failure(409, "ROUND_DRAFT_NOT_RETRYABLE", "没有可重试的起草任务");
        }
        attemptId = randomUUID();
        await client.query("UPDATE mission_rounds SET status='drafting',draft_source=$2::jsonb,version=version+1,action_fingerprints=$3::jsonb,updated_at=$4 WHERE id=$1",
          [existing.id, JSON.stringify({ ...existing.draft_source, attemptId, pendingOwners: unfinished }),
            JSON.stringify(appendFingerprint(existing.action_fingerprints, fingerprint)), now()]);
      } else replayed = true;
    } else {
      if (retry) { await client.query("ROLLBACK"); return failure(404, "ROUND_NOT_FOUND", "起草重试的任务卡不存在"); }
      const started = await insertDraftingRound(client, people, locked, match[2], now(), { action_fingerprints: [fingerprint] });
      if ("error" in started) { await client.query("ROLLBACK"); return started; }
      ({ roundId, attemptId } = started);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
  if (!replayed && attemptId) draftInBackground(pool, people, roundId!, attemptId, now, agent, memory, knownMissionsFile);
  const card = await getMissionRoundCard(q, people, secret, person, roundId!, now());
  return card ? { card, ...(replayed ? { replayed: true } : {}) } : failure(404, "ROUND_NOT_FOUND", "任务卡不存在");
}
