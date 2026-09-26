import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import { CreateMissionRequest, type TCard, type TMissionCardField, type TMissionRoundConfirmInput, type TMissionRoundDecideInput, type TMissionRoundDraftPayload, type TMissionRoundPhase, type TMissionRoundSummary } from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { MemoryPerson } from "./companyMemory.js";
import type { MeetingActionOutcome, Query } from "./meetingStore.js";

export type MissionRoundPerson = { personId: string; role: "ceo" | "member" };
type GoalSnapshot = {
  sixMonthOutcome: string; monthOutcome: string; signedAt: string;
  battlefieldId: string; battlefieldVersion: number; monthlyPlanId: string; monthlyPlanVersion: number;
};
export type MissionRoundRow = {
  id: string; version: number; battlefield_id: string; period: string; monthly_plan_id: string;
  status: "draft" | "open" | "reviewing" | "confirmed";
  draft_origin: "placeholder" | "agent"; draft_source: Record<string, unknown>; goal_snapshot: GoalSnapshot | null;
  window_seq: number; first_opened_at: Date | null; opened_at: Date | null; closes_at: Date | null;
  reopens: { by: string; at: string; closedAt: string }[];
  confirmed_by: string | null; confirmed_at: Date | null; action_fingerprints: string[];
  created_at: Date; updated_at: Date;
  battlefield_owner_id: string; battlefield_name: string; battlefield_version: number; six_month_outcome: string;
};
type PersonalCardRow = {
  id: string; owner_id: string; sort_order: number; role_label: string | null; member_ids: string[];
};
type FeedbackRow = {
  id: string; card_id: string; mission_id: string | null; field: TMissionCardField | null;
  kind: "comment" | "quote" | "suggestion"; proposed: string | null; late: boolean; created_at: Date;
};
type ReviewRow = { id: string; feedback_ids: string[]; taken_at: Date; mission_versions: Record<string, number> };
const HOURS_48 = 48 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUND_SELECT = `SELECT r.*, b.owner_id AS battlefield_owner_id, b.name AS battlefield_name,
  b.version AS battlefield_version, b.six_month_outcome
  FROM mission_rounds r JOIN battlefield_config b ON b.id=r.battlefield_id`;

/** 拍板权每次取当前身份和战场负责人；卡成员则保留建卡时的名单。 */
export function canApprove(person: MissionRoundPerson, round: Pick<MissionRoundRow, "battlefield_owner_id">): boolean {
  return person.role === "ceo" || person.personId === round.battlefield_owner_id;
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
  return (await q("SELECT id,owner_id,sort_order,role_label,member_ids FROM personal_mission_cards WHERE round_id=$1 ORDER BY sort_order,owner_id,id", [roundId])).rows as PersonalCardRow[];
}
async function canRead(q: Query, person: MissionRoundPerson, row: MissionRoundRow): Promise<boolean> {
  if (canApprove(person, row)) return true;
  const found = await q("SELECT 1 FROM personal_mission_cards WHERE round_id=$1 AND member_ids @> $2::jsonb LIMIT 1", [row.id, JSON.stringify([person.personId])]);
  return !!found.rowCount;
}
function roundPhase(row: MissionRoundRow, now: Date): TMissionRoundPhase {
  return row.status === "open" && row.closes_at! <= now ? "closed" : row.status;
}
function cardLine(phase: TMissionRoundPhase, feedback: number, inReview: number, pending: number, approver: boolean): string {
  if (phase === "draft") return "未开放";
  if (phase === "open") return feedback ? `${feedback} 条意见` : "无意见";
  if (phase === "closed") return "汇总中";
  if (phase === "confirmed") return "已确定";
  if (!inReview) return approver ? "无意见" : "等拍板";
  return approver ? (pending ? `待处理 ${pending}` : "已处理") : `已处理 ${inReview - pending}/${inReview}`;
}

/** 同一轮的事实、计数与服务端状态文案；仅可见卡行和动作随看的人变化。 */
export async function projectMissionRoundCard(
  q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, row: MissionRoundRow, now: Date,
): Promise<TCard> {
  const cards = await personalCards(q, row.id);
  const feedback = (await q("SELECT id,card_id,mission_id,field,kind,proposed,late,created_at FROM mission_card_feedback WHERE round_id=$1 ORDER BY seq", [row.id])).rows as FeedbackRow[];
  const missions = (await q(`SELECT m.id,m.personal_mission_card_id,m.dependencies FROM missions m
    JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id WHERE c.round_id=$1`, [row.id])).rows as { id: string; personal_mission_card_id: string; dependencies: string }[];
  const review = (await q("SELECT id,feedback_ids,taken_at FROM mission_round_reviews WHERE round_id=$1 AND window_seq=$2 AND superseded_at IS NULL", [row.id, row.window_seq])).rows[0] as ReviewRow | undefined;
  const decisions = review ? (await q("SELECT feedback_id,decision FROM mission_review_decisions WHERE review_id=$1", [review.id])).rows as { feedback_id: string; decision: string }[] : [];
  const decisionMap = new Map(decisions.map((item) => [item.feedback_id, item.decision]));
  const snapshotIds = new Set(review?.feedback_ids ?? []);
  const inReview = feedback.filter((item) => snapshotIds.has(item.id));
  const pending = inReview.filter((item) => !decisionMap.has(item.id)).length;
  const suggestions = new Map<string, number>();
  const acceptedDependencies = new Map<string, string>();
  for (const item of inReview) {
    if (item.kind !== "suggestion") continue;
    const key = `${item.mission_id}:${item.field}`;
    suggestions.set(key, (suggestions.get(key) ?? 0) + 1);
    if (item.field === "dependencies" && decisionMap.get(item.id) === "accept") acceptedDependencies.set(item.mission_id!, item.proposed!);
  }
  const approver = canApprove(person, row);
  const phase = roundPhase(row, now);
  const names = new Map(people.map((item) => [item.personId, item.displayName]));
  const deciderId = row.battlefield_owner_id || people.find((item) => item.roles.includes("ceo"))?.personId;
  const visible = cards.filter((item) => approver || item.member_ids.includes(person.personId));
  const payload: TMissionRoundSummary = {
    roundId: row.id, period: row.period, battlefieldId: row.battlefield_id, battlefieldName: row.battlefield_name,
    version: row.version, phase, round: Math.max(1, row.window_seq), openedAt: row.opened_at?.toISOString() ?? null,
    closesAt: row.closes_at?.toISOString() ?? null, reviewAt: review?.taken_at.toISOString() ?? null,
    serverNow: now.toISOString(), approver, deciderName: (deciderId && names.get(deciderId)) || deciderId || "CEO",
    todo: !approver ? null : phase === "draft" ? "个人卡草稿已就绪，可以统一开放讨论"
      : phase === "reviewing" && pending === 0 ? "意见已全部处理，待你确认" : null,
    placeholder: row.draft_origin === "placeholder",
    goals: row.goal_snapshot ? { sixMonthOutcome: row.goal_snapshot.sixMonthOutcome, monthOutcome: row.goal_snapshot.monthOutcome, signedAt: row.goal_snapshot.signedAt } : null,
    counts: {
      cards: cards.length, feedback: review ? inReview.length : feedback.length, pending,
      conflicts: [...suggestions.values()].filter((count) => count > 1).length,
      dependencies: missions.reduce((total, mission) => total + (acceptedDependencies.get(mission.id) ?? mission.dependencies).split(/\r?\n/).filter((line) => line.trim()).length, 0),
      late: feedback.filter((item) => item.late && row.closes_at && item.created_at >= row.closes_at).length,
    },
    cards: visible.map((item) => {
      const all = feedback.filter((entry) => entry.card_id === item.id);
      const reviewed = all.filter((entry) => snapshotIds.has(entry.id));
      const outstanding = reviewed.filter((entry) => !decisionMap.has(entry.id)).length;
      return { cardId: item.id, ownerId: item.owner_id, ownerName: names.get(item.owner_id) ?? item.owner_id,
        roleLabel: item.role_label, missionCount: missions.filter((mission) => mission.personal_mission_card_id === item.id).length,
        line: cardLine(phase, all.length, reviewed.length, outstanding, approver), pending: outstanding,
        firstPendingFeedbackId: reviewed.find((entry) => !decisionMap.has(entry.id))?.id ?? null, mine: item.owner_id === person.personId };
    }),
  };
  const actions: TCard["actions"] = [];
  const actionType = approver ? (phase === "draft" ? "mission-round.open" : phase === "reviewing" ? "mission-round.reopen" : null) : null;
  if (actionType) actions.push({ actionType, label: phase === "draft" ? "统一开放 48 小时讨论" : "重新开启 48 小时讨论",
    actionId: signActionId(secret, { actionType, objectType: "mission-round", objectId: row.id, objectVersion: row.version }) });
  if (approver && phase === "reviewing" && review && pending === 0) actions.push({ actionType: "mission-round.confirm", label: "确认前核对",
    actionId: signActionId(secret, { actionType: "mission-round.confirm", objectType: "mission-round", objectId: row.id, objectVersion: row.version }) });
  return { schemaVersion: 1, id: `mission-round:${row.id}`, kind: "mission-round", version: row.version,
    objectRef: { type: "mission-round", id: row.id, version: row.version },
    title: `${Number(row.period.slice(5))} 月 Mission Card · ${row.battlefield_name}`, badge: "Mission Card", urgency: "normal", payload,
    navigation: visible[0] ? [{ href: `${person.role === "ceo" ? "" : "/me"}/mission-cards/${visible[0].id}`, label: "个人 Mission Card" }] : [], actions };
}

export async function getMissionRoundCard(
  q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, roundId: string, now: Date,
): Promise<TCard | null> {
  const row = await getMissionRoundRow(q, roundId);
  return row && await canRead(q, person, row) ? projectMissionRoundCard(q, people, secret, person, row, now) : null;
}
export async function listMissionRoundCards(
  q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, period: string, now: Date,
): Promise<TCard[]> {
  const rows = (await q(`${ROUND_SELECT} WHERE r.period=$1 AND r.status<>'confirmed' ORDER BY b.sort_order,b.code,r.id`, [period])).rows as MissionRoundRow[];
  const cards: TCard[] = [];
  for (const row of rows) if (await canRead(q, person, row)) cards.push(await projectMissionRoundCard(q, people, secret, person, row, now));
  return cards;
}

/** 调用者须已持轮次 FOR UPDATE。截止按窗口时刻收意见，不按调度实际运行时刻。 */
export async function closeIfDue(client: PoolClient, row: MissionRoundRow, now: Date): Promise<MissionRoundRow> {
  if (row.status !== "open" || row.closes_at! > now) return row;
  const feedback = await client.query<{ id: string }>("SELECT id FROM mission_card_feedback WHERE round_id=$1 AND created_at<$2 ORDER BY seq", [row.id, row.closes_at]);
  const missions = await client.query<{ id: string; version: number }>(`SELECT m.id,m.version FROM missions m
    JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id WHERE c.round_id=$1 ORDER BY m.id`, [row.id]);
  const previous = await client.query<{ id: string }>("SELECT id FROM mission_round_reviews WHERE round_id=$1 AND superseded_at IS NOT NULL ORDER BY window_seq DESC LIMIT 1", [row.id]);
  const reviewId = randomUUID();
  const feedbackIds = feedback.rows.map((item) => item.id);
  await client.query(`INSERT INTO mission_round_reviews (id,round_id,window_seq,snapshot_at,taken_at,feedback_ids,mission_versions)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
  [reviewId, row.id, row.window_seq, row.closes_at, now, JSON.stringify(feedbackIds), JSON.stringify(Object.fromEntries(missions.rows.map((item) => [item.id, item.version])))]);
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

function failure(status: number, code: string, message: string): MeetingActionOutcome {
  return { error: { status, code, message } };
}
function appendFingerprint(existing: string[], fingerprint: string): string[] {
  return [...existing.filter((value) => value !== fingerprint), fingerprint].slice(-100);
}
async function executeRoundAction(
  operation: "open" | "reopen" | "decide" | "confirm", pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson,
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
      await client.query("ROLLBACK"); return failure(403, "ROUND_FORBIDDEN", "仅 CEO 或该战场 DRI 可以拍板");
    }
    const at = now();
    let row = await closeIfDue(client, current, at);
    const finish = async (outcome: MeetingActionOutcome) => { await client.query("COMMIT"); return outcome; };
    const project = () => projectMissionRoundCard(q, people, secret, person, row, at);
    if (row.action_fingerprints.includes(fingerprint)) return await finish({ card: await project(), replayed: true });
    if (row.version !== scope.objectVersion) return await finish({ conflict: true, latestCard: await project() });
    if (row.status === "confirmed") return await finish(failure(409, "ROUND_CONFIRMED", "本月 Mission Card 已确定，修改规则待定（GAP-04）"));
    if (operation === "open") {
      if (row.status !== "draft") return await finish(failure(409, "ROUND_ALREADY_OPEN", "本轮已经开放，倒计时不会重置"));
      const plan = (await client.query<{ id: string; version: number; status: string; confirmed_at: Date | null; battlefields: { battlefieldId: string; outcome: string }[] }>(
        "SELECT id,version,status,confirmed_at,battlefields FROM monthly_plans WHERE id=$1 AND period=$2 FOR SHARE", [row.monthly_plan_id, row.period])).rows[0];
      if (!plan || plan.status !== "confirmed" || !plan.confirmed_at) return await finish(failure(409, "MONTHLY_PLAN_NOT_CONFIRMED", `${Number(row.period.slice(5))} 月月度计划还没签发：先签发再开放讨论`));
      const monthOutcome = plan.battlefields.find((item) => item.battlefieldId === row.battlefield_id)?.outcome;
      if (!monthOutcome?.trim() || !row.six_month_outcome.trim()) return await finish(failure(409, "ROUND_GOALS_MISSING", "缺少本战场的六个月目标或已签发本月目标，暂不能开放讨论"));
      const cards = await client.query<{ count: number }>(`SELECT count(m.id)::int AS count FROM personal_mission_cards c
        LEFT JOIN missions m ON m.personal_mission_card_id=c.id WHERE c.round_id=$1 GROUP BY c.id`, [row.id]);
      if (!cards.rows.length || cards.rows.some((item) => item.count === 0)) return await finish(failure(409, "ROUND_EMPTY_CARD", "每张个人卡至少需要一项个人任务，暂不能开放讨论"));
      const goal: GoalSnapshot = { sixMonthOutcome: row.six_month_outcome, monthOutcome, signedAt: plan.confirmed_at.toISOString(),
        battlefieldId: row.battlefield_id, battlefieldVersion: row.battlefield_version, monthlyPlanId: plan.id, monthlyPlanVersion: plan.version };
      const updated = await client.query(`UPDATE mission_rounds SET status='open',window_seq=1,opened_at=$2,first_opened_at=$2,
        closes_at=$3,goal_snapshot=$4::jsonb,version=version+1,action_fingerprints=$5::jsonb,updated_at=$2 WHERE id=$1 RETURNING *`,
      [row.id, at, new Date(at.getTime() + HOURS_48), JSON.stringify(goal), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))]);
      row = { ...row, ...updated.rows[0] };
    } else if (operation === "reopen") {
      if (row.status !== "reviewing") return await finish(failure(409, "ROUND_NOT_CLOSED", "讨论还没截止，倒计时不会重置"));
      await client.query("UPDATE mission_round_reviews SET superseded_at=$3 WHERE round_id=$1 AND window_seq=$2 AND superseded_at IS NULL", [row.id, row.window_seq, at]);
      const reopens = [...row.reopens, { by: person.personId, at: at.toISOString(), closedAt: row.closes_at!.toISOString() }];
      const updated = await client.query(`UPDATE mission_rounds SET status='open',window_seq=window_seq+1,opened_at=$2,closes_at=$3,
        reopens=$4::jsonb,version=version+1,action_fingerprints=$5::jsonb,updated_at=$2 WHERE id=$1 RETURNING *`,
      [row.id, at, new Date(at.getTime() + HOURS_48), JSON.stringify(reopens), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))]);
      row = { ...row, ...updated.rows[0] };
    } else {
      if (row.status !== "reviewing") return await finish(failure(409, "ROUND_NOT_REVIEWING", "请先等待讨论截止并完成规则汇总"));
      const review = (await client.query<ReviewRow>("SELECT id,feedback_ids,taken_at,mission_versions FROM mission_round_reviews WHERE round_id=$1 AND window_seq=$2 AND superseded_at IS NULL", [row.id, row.window_seq])).rows[0];
      if (!review) return await finish(failure(409, "ROUND_NOT_REVIEWING", "本轮尚未完成规则汇总"));
      const snapshot = (await client.query<FeedbackRow & { decision: "accept" | "decline" | null }>(`SELECT f.*,d.decision FROM mission_card_feedback f
        LEFT JOIN mission_review_decisions d ON d.feedback_id=f.id AND d.review_id=$1
        WHERE f.round_id=$2 AND f.id=ANY($3::uuid[]) ORDER BY f.seq`, [review.id, row.id, review.feedback_ids])).rows;
      if (operation === "decide") {
        if (!scope.itemId || !UUID.test(scope.itemId) || !input.decision) return await finish(failure(400, "INVALID_REVIEW_DECISION", "请指定要处理的意见与结论"));
        const item = snapshot.find((item) => item.id === scope.itemId);
        if (!item) return await finish(failure(409, "FEEDBACK_NOT_IN_REVIEW", "意见不属于本轮 Review，不能处理"));
        if (input.decision === "accept" && item.kind === "suggestion" && snapshot.some((other) => other.id !== item.id && other.kind === "suggestion"
          && other.mission_id === item.mission_id && other.field === item.field && other.decision === "accept")) {
          return await finish(failure(409, "CONFLICTING_SUGGESTION", "同一字段已采纳另一条"));
        }
        await client.query(`INSERT INTO mission_review_decisions (review_id,feedback_id,decision,decided_by,decided_at,carried)
          VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT (review_id,feedback_id)
          DO UPDATE SET decision=EXCLUDED.decision,decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at,carried=false`,
        [review.id, item.id, input.decision, person.personId, at]);
      } else {
        const note = input.note?.trim() ?? "";
        if (!note || note.length > 2000) return await finish(failure(400, "INVALID_REVIEW_NOTE", "请填写 1–2000 字的跨人员依赖、冲突与协作核对结论"));
        if (snapshot.length !== review.feedback_ids.length || snapshot.some((item) => !item.decision)) return await finish(failure(409, "REVIEW_INCOMPLETE", "请逐条处理本轮全部公开意见后再确认"));
        const accepted = snapshot.filter((item) => item.kind === "suggestion" && item.decision === "accept");
        const keys = accepted.map((item) => `${item.mission_id}:${item.field}`);
        if (new Set(keys).size !== keys.length) return await finish(failure(409, "CONFLICTING_SUGGESTION", "同一字段已采纳另一条"));
        // Lock the complete snapshot before any write, including missions with no accepted change.
        const missions = (await client.query<{ id: string; version: number }>(`SELECT m.id,m.version FROM missions m
          JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id WHERE c.round_id=$1 ORDER BY m.id FOR UPDATE OF m`, [row.id])).rows;
        if (missions.length !== Object.keys(review.mission_versions).length || missions.some((mission) => review.mission_versions[mission.id] !== mission.version)) {
          return await finish(failure(409, "MISSION_CHANGED", "个人任务版本已变化，请重新审阅后再确认"));
        }
        const appliedVersions: Record<string, number> = {};
        for (const mission of missions) {
          const changes = accepted.filter((item) => item.mission_id === mission.id);
          if (!changes.length) continue;
          // Columns are selected only through the field allowlist, never through request text.
          const values: unknown[] = [mission.id, at];
          const sets = changes.map((item) => {
            const list = item.field === "successEvidence" || item.field === "milestones";
            values.push(list ? JSON.stringify(item.proposed!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) : item.proposed);
            return `${MISSION_FIELD_COLUMNS[item.field!]}=$${values.length}${list ? "::jsonb" : ""}`;
          });
          const updated = await client.query<{ version: number }>(`UPDATE missions SET ${sets.join(",")},version=version+1,updated_at=$2 WHERE id=$1 RETURNING version`, values);
          appliedVersions[mission.id] = updated.rows[0].version;
        }
        await client.query("UPDATE mission_round_reviews SET note=$2,applied_versions=$3::jsonb WHERE id=$1", [review.id, note, JSON.stringify(appliedVersions)]);
      }
      const updated = await client.query(`UPDATE mission_rounds SET version=version+1,updated_at=$2,action_fingerprints=$3::jsonb
        ${operation === "confirm" ? ",status='confirmed',confirmed_at=$2,confirmed_by=$4" : ""} WHERE id=$1 RETURNING *`,
      [row.id, at, JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint)), ...(operation === "confirm" ? [person.personId] : [])]);
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
export function executeReopenMissionRound(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date): Promise<MeetingActionOutcome> {
  return executeRoundAction("reopen", pool, people, secret, person, scope, fingerprint, now);
}
export function executeDecideMissionRound(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date, input: TMissionRoundDecideInput): Promise<MeetingActionOutcome> {
  return executeRoundAction("decide", pool, people, secret, person, scope, fingerprint, now, input);
}
export function executeConfirmMissionRound(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope, fingerprint: string, now: () => Date, input: TMissionRoundConfirmInput): Promise<MeetingActionOutcome> {
  return executeRoundAction("confirm", pool, people, secret, person, scope, fingerprint, now, input);
}

const MISSION_FIELD_COLUMNS: Record<TMissionCardField, string> = {
  title: "title", why: "why", outcome: "outcome", successEvidence: "success_evidence", boundaries: "boundaries", keyPath: "key_path",
  milestones: "milestones", resources: "resources", dependencies: "dependencies", humanAgentSplit: "human_agent_split", risk: "risk", retrospect: "retrospect",
};

const DraftText = Type.String({ maxLength: 4000 });
const DraftLines = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 30 });
const DraftMission = Type.Object({
  code: CreateMissionRequest.properties.code,
  carriedFrom: Type.Object({ ssotTaskId: Type.String({ minLength: 1 }), septemberMissionCode: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }, { additionalProperties: false }),
  capabilityCode: Type.String({ minLength: 1 }), title: CreateMissionRequest.properties.title,
  why: DraftText, outcome: CreateMissionRequest.properties.outcome, successEvidence: DraftLines,
  boundaries: DraftText, keyPath: DraftText, milestones: DraftLines, resources: DraftText,
  dependencies: DraftText, humanAgentSplit: DraftText, risk: DraftText, retrospect: DraftText,
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
export const DEFAULT_MISSION_CARD_DRAFTS_DIR = fileURLToPath(new URL("../../../seed/placeholders", import.meta.url));

function draftPath(directory: string | undefined, period: string, battlefieldCode: string): string {
  if (/[/\\]/.test(battlefieldCode)) throw new MissionDraftImportError(400, "INVALID_BATTLEFIELD", "战场编号不能用于草稿文件名");
  return join(directory ? resolve(directory) : DEFAULT_MISSION_CARD_DRAFTS_DIR, `${period}-mission-cards.battlefield-${battlefieldCode}.json`);
}
async function isDraftFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
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

/** CLI 与整理草稿动作共用：先校验完整候选，锁定战场 slot 后在同一事务建轮次、卡、个人任务。 */
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
      if (!canApprove(action.person, { battlefield_owner_id: battlefield.owner_id })) throw new MissionDraftImportError(403, "ROUND_FORBIDDEN", "仅 CEO 或该战场 DRI 可以整理个人卡草稿");
    }
    const existing = (await client.query<{ id: string; draft_source: { sha256?: string } }>("SELECT id,draft_source FROM mission_rounds WHERE battlefield_id=$1 AND period=$2 FOR UPDATE", [battlefield.id, value.period])).rows[0];
    if (existing) {
      if (existing.draft_source.sha256 !== sha256) throw new MissionDraftImportError(409, "MISSION_DRAFT_SOURCE_CHANGED", "本轮已存在且候选文件已改变，不能覆盖已经整理或讨论的内容");
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
      if (!knownPeople.has(card.ownerId)) throw new MissionDraftImportError(400, "INVALID_OWNER", `个人卡 Owner 未登记：${card.ownerId}`);
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
    for (const card of value.cards) {
      const cardId = randomUUID();
      await client.query(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,role_label,member_ids,created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [cardId, roundId, card.ownerId, card.sortOrder, card.roleLabel ?? null, JSON.stringify(missionCardMembers(card.ownerId, battlefield.owner_id, people)), at]);
      for (const mission of card.missions) await client.query(`INSERT INTO missions
        (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,boundaries,key_path,
         milestones,resources,dependencies,human_agent_split,risk,retrospect,source_ref,source_document_id,source_revision,
         source_title,placeholder,personal_mission_card_id,created_at,updated_at)
        VALUES ($1,1,$1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,true,$22,$23,$23)`,
      [mission.code, value.period, mission.title, card.ownerId, capabilities.get(mission.capabilityCode)!, JSON.stringify([battlefield.id]),
        mission.outcome, mission.why, JSON.stringify(mission.successEvidence), mission.boundaries, mission.keyPath,
        JSON.stringify(mission.milestones), mission.resources, mission.dependencies, mission.humanAgentSplit, mission.risk,
        mission.retrospect, mission.source.url, mission.source.documentId, mission.source.revision, value.placeholderNote, cardId, at]);
    }
    const cards = await importedCards(q, roundId);
    await client.query("COMMIT"); return { roundId, imported: true, cards };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") throw new MissionDraftImportError(409, "MISSION_CODE_CONFLICT", "个人任务编号已存在，未导入任何草稿");
    throw error;
  } finally { client.release(); }
}

export async function executeDraftMissionRound(
  pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, scope: ActionScope,
  fingerprint: string, now: () => Date, directory?: string,
): Promise<MeetingActionOutcome> {
  const match = /^(.*):(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(scope.objectId);
  if (!match || scope.objectVersion !== 1) return failure(404, "UNKNOWN_ACTION", "无效的整理草稿入口");
  const q: Query = (sql, params) => pool.query(sql, params);
  const battlefield = (await q("SELECT id,code,owner_id FROM battlefield_config WHERE id=$1", [match[1]])).rows[0] as { id: string; code: string; owner_id: string } | undefined;
  if (!battlefield) return failure(404, "ROUND_NOT_FOUND", "战场不存在");
  if (!canApprove(person, { battlefield_owner_id: battlefield.owner_id })) return failure(403, "ROUND_FORBIDDEN", "仅 CEO 或该战场 DRI 可以整理个人卡草稿");
  try {
    const imported = await importMissionCardDrafts(pool, people, draftPath(directory, match[2], battlefield.code), now, { person, scope, fingerprint });
    const card = await getMissionRoundCard(q, people, secret, person, imported.roundId, now());
    return card ? { card, ...(imported.imported ? {} : { replayed: true }) } : failure(404, "ROUND_NOT_FOUND", "Mission Card 轮次不存在");
  } catch (error) {
    if (error instanceof MissionDraftImportError) return failure(error.status, error.code, error.message);
    throw error;
  }
}

export async function listMissionRoundDraftCards(
  q: Query, _people: MemoryPerson[], secret: string, person: MissionRoundPerson, period: string, now: Date, directory?: string,
): Promise<TCard[]> {
  const plan = (await q("SELECT battlefields FROM monthly_plans WHERE period=$1 AND status='confirmed' AND confirmed_at IS NOT NULL", [period])).rows[0] as { battlefields: { battlefieldId: string; outcome: string }[] } | undefined;
  if (!plan) return [];
  const battlefields = (await q(`SELECT b.id,b.code,b.name,b.owner_id FROM battlefield_config b
    WHERE NOT EXISTS (SELECT 1 FROM mission_rounds r WHERE r.battlefield_id=b.id AND r.period=$1)
    ORDER BY b.sort_order,b.code,b.id`, [period])).rows as { id: string; code: string; name: string; owner_id: string }[];
  const cards: TCard[] = [];
  for (const battlefield of battlefields) {
    if (!canApprove(person, { battlefield_owner_id: battlefield.owner_id }) || !plan.battlefields.some((item) => item.battlefieldId === battlefield.id && item.outcome.trim())) continue;
    if (/[/\\]/.test(battlefield.code) || !await isDraftFile(draftPath(directory, period, battlefield.code))) continue;
    const slotId = `${battlefield.id}:${period}`;
    const payload: TMissionRoundDraftPayload = { period, battlefieldId: battlefield.id, battlefieldName: battlefield.name,
      placeholder: true, todo: "可以整理个人卡草稿", serverNow: now.toISOString() };
    const scope: ActionScope = { actionType: "mission-round.draft", objectType: "mission-round-slot", objectId: slotId, objectVersion: 1 };
    cards.push({ schemaVersion: 1, id: `mission-round-slot:${slotId}`, kind: "mission-round", version: 1,
      objectRef: { type: "mission-round-slot", id: slotId, version: 1 },
      title: `${Number(period.slice(5))} 月 Mission Card · ${battlefield.name}`, badge: "Mission Card", urgency: "normal", payload,
      actions: [{ actionId: signActionId(secret, scope), actionType: scope.actionType, label: "整理个人卡草稿" }] });
  }
  return cards;
}
