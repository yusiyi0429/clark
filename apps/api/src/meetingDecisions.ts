import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TImpactAskWho, TImpactSource, TImpactTarget, TMeetingDecisionView, TMeetingOutcomeItem, TMeetingWorldView, TMyMeetingDecisionGroup, TWorldAnchor } from "@warmap/contracts";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { feishuNotifier, type FeishuNotify } from "./feishu/notify.js";
import type { ImpactAgent, TImpactAnalysisCandidate } from "./impactAgent.js";
import { insertImpactCards, type ImpactCardRow, type NewImpactCard } from "./impactCards.js";
import { enqueueJob, type JobHandler, type RecurringJob } from "./jobs.js";
import { impactCandidates, type ImpactCandidate, type InterpretationContext } from "./meetingContext.js";
import { transcriptLines, type DecisionLayeringAgent } from "./meetingDecisionAgent.js";
import { decisionEffective, decisionStatement, decisionWorldContext, meetingWorldView, projectMeetingDecision, type MeetingDecisionRow } from "./meetingDecisionView.js";
import { getMeetingRow, meetingColumns, UUID_PATTERN, type MeetingRow, type Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { personDisplayNames } from "./people.js";
import { addWorkday, nextWorkdayAt, shanghaiDate, shanghaiLabel } from "./workdays.js";
import type { DecisionWorldSync } from "./worldDecisionEvents.js";
import { meetingEventDigest, meetingEventText, transcriptDigest, type MeetingEventWorld, type ResolvedAnchors } from "./worldMeetingEvent.js";

/**
 * 会后分层确认（议题 3）：
 * - 纪要整理好后，战略项（会后抽取标成 strategic 的）推给 CEO，状态跟着 CEO 在会议条目上的「确认 / 不同意」走，不代判；
 * - 其余由分层 Agent 挑出最多 5 条「会上定了 X」给主持人，三选一：对 / 改一下 / 其实没定；
 * - 提醒：出来之后提醒一次（散会当天），下一个工作日 9:30 再提醒一次，天枢通知栏置顶 + 飞书通知；
 * - 满一个工作日主持人没确认，按 Agent 的推荐判断生效（agent_judged），往下推的卡标「Agent 代判，Host 尚未确认」；
 * - 生效的决定做影响分析，给受影响的人推影响卡，并按方案 A 记一条本体事件；主持人之后改判，revision 加一，给收过卡的人出更正卡、本体记 correction。
 * - 会议入本体（回流设计稿 3.1、3.2）：主持人的条目都办完（或代判）、影响卡推完之后，先记一条会议事件（摘要 + 会上定了 + 挂点），
 *   再记各条决定事件并指回它；对不上受影响对象的决定挂到会议的挂点上。主持人或 CEO 可改挂点、标不写进本体（已写的记撤回更正）。
 * 耗时的事（分层、影响分析、写本体）都走 jobs，失败按 jobs 退避重试。
 */
export const MEETING_DECISIONS_SYNC_KIND = "meeting.decisions_sync";
export const MEETING_DECISIONS_TICK_KIND = "meeting.decisions_tick";
export const MEETING_DECISION_PROPAGATE_KIND = "meeting.decision_propagate";
export const MEETING_WORLD_SYNC_KIND = "meeting.world_sync";
const TICK_EVERY_MS = 10 * 60_000;
const MAX_HOST_DECISIONS = 5;
const PICKABLE_KINDS = new Set(["decision", "todo", "ceoJudgment", "reopenWhen"]);

export type MeetingDecisionDeps = {
  pool: Pool;
  peopleDirectory: PeopleDirectory;
  layering: DecisionLayeringAgent;
  impact: ImpactAgent;
  /** 解读与影响分析用的公司地图。 */
  context: () => Promise<InterpretationContext>;
  /** 飞书配了才有。 */
  notify?: FeishuNotify;
  /** 本体可写时才有。 */
  world?: DecisionWorldSync;
  /** 会议事件（和 world 一起装配）；没有时只写决定事件。 */
  meetingWorld?: MeetingEventWorld;
  /** live：影响卡推送；shadow：只在后台记录。缺省 live（低置信度的卡一律影子）。 */
  impactMode?: "live" | "shadow";
  now?: () => Date;
};

export type ReviewInput = { verdict: "confirmed" | "edited" | "not_decided"; statement?: string };
export type ReviewResult = { decision: TMeetingDecisionView } | { error: { status: number; code: string; message: string } };
export type WorldResult = { world: TMeetingWorldView } | { error: { status: number; code: string; message: string } };
const NOT_FOUND = { error: { status: 404, code: "MEETING_NOT_FOUND", message: "会议不存在" } } as const;

/** 分层 Agent 的候选 → 主持人要确认的几行：只认这场会里可挑的条目，同一条目不进两行，最多 5 行（评测脚本也用它）。 */
export function selectHostDecisions(items: TMeetingOutcomeItem[], candidate: Awaited<ReturnType<DecisionLayeringAgent["layer"]>>) {
  const pickable = new Map(items.filter((item) => PICKABLE_KINDS.has(item.kind)).map((item) => [item.id, item]));
  const used = new Set<string>();
  const rows: { statement: string; itemIds: string[]; primary: TMeetingOutcomeItem; recommendation: "confirmed" | "not_decided"; why: string }[] = [];
  for (const decision of candidate.decisions) {
    const ids = [...new Set(decision.itemIds)].filter((id) => pickable.has(id) && !used.has(id));
    if (!ids.length || !decision.statement.trim()) continue;
    ids.forEach((id) => used.add(id));
    const primary = ids.map((id) => pickable.get(id)!).find((item) => item.kind === "decision") ?? pickable.get(ids[0])!;
    rows.push({ statement: decision.statement.trim(), itemIds: ids, primary, recommendation: decision.recommendation, why: decision.recommendationReason.trim() });
    if (rows.length >= MAX_HOST_DECISIONS) break;
  }
  return rows;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const realDate = (value: string | null) => {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
};

export function createMeetingDecisionService(deps: MeetingDecisionDeps) {
  const { pool, peopleDirectory, layering, impact } = deps;
  const q: Query = pool.query.bind(pool);
  const now = deps.now ?? (() => new Date());
  const names = () => personDisplayNames(peopleDirectory);
  const isCeo = (personId: string) => peopleDirectory.searchPeople(undefined).find((person) => person.personId === personId)?.roles.includes("ceo") ?? false;
  const pathFor = (personId: string, kind: "request" | "meeting", id: string) =>
    `${isCeo(personId) ? "" : "/me"}/${kind === "request" ? "requests" : "meetings"}/${id}`;
  const enqueue = (client: Query, kind: string, key: string, payload: unknown) => enqueueJob(client, { kind, dedupeKey: `${kind}:${key}`, payload });
  /** 排一次本体同步（只在本体可写时）；按会议串行由 jobs worker 逐条执行保证。 */
  const queueWorldSync = async (client: Query, meetingId: string) => {
    if (deps.world) await enqueue(client, MEETING_WORLD_SYNC_KIND, `${meetingId}:${randomUUID()}`, { meetingId });
  };
  /** 主持人和 CEO 看得到写入状态，能改挂点、标不写进本体。 */
  const canManageWorld = (meeting: Pick<MeetingRow, "lead_dri_id">, viewerId: string) => meeting.lead_dri_id === viewerId || isCeo(viewerId);

  const rowsOf = async (client: Query, meetingId: string) =>
    (await client("SELECT * FROM meeting_decisions WHERE meeting_id = $1 ORDER BY tier DESC, ordinal", [meetingId])).rows as MeetingDecisionRow[];

  /** 战略项：一条会议条目一行，状态跟着 CEO 在条目上的处理走。 */
  async function syncStrategic(client: PoolClient, meeting: MeetingRow, items: TMeetingOutcomeItem[], existing: MeetingDecisionRow[]): Promise<void> {
    const strategic = items.filter((item) => item.kind === "strategic");
    for (const [index, item] of strategic.entries()) {
      const status = item.review?.status === "confirmed" ? "confirmed" : item.review?.status === "dismissed" ? "rejected" : "pending";
      const row = existing.find((decision) => decision.tier === "strategic" && decision.item_ids[0] === item.id);
      if (!row) {
        const used = new Set(existing.filter((decision) => decision.tier === "strategic").map((decision) => decision.ordinal));
        let ordinal = index + 1;
        while (used.has(ordinal)) ordinal += 1;
        const id = randomUUID();
        await client.query(
          `INSERT INTO meeting_decisions (id, meeting_id, tier, ordinal, statement, item_ids, turn_id, quote, speaker_id, why, status, reviewer_id, reviewed_at,
             next_remind_at, impact_status)
           VALUES ($1, $2, 'strategic', $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [id, meeting.id, ordinal, (item.title ?? item.text).slice(0, 300), JSON.stringify([item.id]), item.turnId, item.quote, item.speakerId, item.brief ?? null,
            status, status === "pending" ? null : meeting.ceo_participant_id, status === "pending" ? null : now(),
            status === "pending" ? now() : null, status === "confirmed" ? "pending" : "none"],
        );
        if (status === "confirmed") await enqueue(client.query.bind(client), MEETING_DECISION_PROPAGATE_KIND, `${id}:0`, { decisionId: id, revision: 0 });
        continue;
      }
      if (row.status !== "pending" || status === "pending") continue;
      await client.query(
        `UPDATE meeting_decisions SET status = $2, reviewer_id = $3, reviewed_at = now(), next_remind_at = NULL,
           impact_status = CASE WHEN $2 = 'confirmed' THEN 'pending' ELSE impact_status END, updated_at = now() WHERE id = $1`,
        [row.id, status, meeting.ceo_participant_id],
      );
      if (status === "confirmed") await enqueue(client.query.bind(client), MEETING_DECISION_PROPAGATE_KIND, `${row.id}:${row.revision}`, { decisionId: row.id, revision: row.revision });
    }
  }

  /**
   * 纪要整理好或会议条目有人处理过之后调用（幂等）：同步战略项；这一次纪要还没分过层的，调分层 Agent 挑主持人要确认的几条。
   * 纪要重新整理过（换了逐字稿）且上一版主持人条目都还没动过，换成新的一版。
   */
  async function sync(meetingId: string): Promise<void> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || meeting.outcome?.status !== "ready") return;
    const runId = meeting.outcome.runId;
    const items = meeting.outcome.items;
    const layeredRun = (await q("SELECT decisions_run_id FROM meetings WHERE id = $1", [meetingId])).rows[0]?.decisions_run_id as string | null;
    const needsLayering = Boolean(runId) && layeredRun !== runId;
    let candidate: Awaited<ReturnType<DecisionLayeringAgent["layer"]>> | null = null;
    // 纪要里没有可挑的条目（决定、待办等）就不用调模型：这一版记为分过层、主持人没有要确认的。
    if (needsLayering && !items.some((item) => PICKABLE_KINDS.has(item.kind))) candidate = { decisions: [] };
    else if (needsLayering) {
      const nameMap = new Map(meeting.participants.map((person) => [person.personId, person.displayName]));
      const lookup = (id: string | null) => (id ? nameMap.get(id) ?? names().get(id) ?? id : null);
      const attendees = meeting.attendees_actual ?? meeting.participants.map((person) => person.personId);
      candidate = await layering.layer({
        meeting: { id: meeting.id, title: meeting.title, date: shanghaiDate(meeting.scheduled_at),
          host: { personId: meeting.lead_dri_id, name: lookup(meeting.lead_dri_id)! }, ceo: { personId: meeting.ceo_participant_id, name: lookup(meeting.ceo_participant_id)! },
          attendees: attendees.map((personId) => ({ personId, name: lookup(personId)! })) },
        summary: meeting.outcome.summary,
        items: items.filter((item) => item.kind !== "strategic").map((item) => ({ id: item.id, kind: item.kind, text: item.text, quote: item.quote, turnId: item.turnId,
          speaker: lookup(item.speakerId) ?? item.speakerId, owner: lookup(item.ownerPersonId), dueDate: item.dueDate ?? null, parentItemId: item.parentItemId })),
        strategic: items.filter((item) => item.kind === "strategic").map((item) => ({ id: item.id, title: item.title ?? item.text, brief: item.brief ?? "" })),
        transcript: transcriptLines(meeting.transcript?.turns ?? [], nameMap),
        context: await deps.context().catch(() => null),
      }, AbortSignal.timeout(240_000));
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = (await client.query(`SELECT ${meetingColumns()}, decisions_run_id FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId])).rows[0] as MeetingRow & { decisions_run_id: string | null };
      if (!locked || locked.outcome?.status !== "ready") { await client.query("ROLLBACK"); return; }
      const existing = await rowsOf(client.query.bind(client), meetingId);
      await syncStrategic(client, locked, locked.outcome.items, existing);
      if (candidate && locked.outcome.runId === runId && locked.decisions_run_id !== runId) {
        const host = existing.filter((decision) => decision.tier === "host");
        const untouched = host.every((decision) => decision.status === "pending" && decision.impact_status === "none");
        if (untouched) {
          await client.query("DELETE FROM meeting_decisions WHERE meeting_id = $1 AND tier = 'host'", [meetingId]);
          const at = now();
          for (const [index, row] of selectHostDecisions(locked.outcome.items, candidate).entries()) {
            await client.query(
              `INSERT INTO meeting_decisions (id, meeting_id, tier, ordinal, statement, item_ids, turn_id, quote, speaker_id, recommendation, why, next_remind_at, due_at)
               VALUES ($1, $2, 'host', $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
              [randomUUID(), meetingId, index + 1, row.statement.slice(0, 300), JSON.stringify(row.itemIds), row.primary.turnId, row.primary.quote,
                row.primary.speakerId, row.recommendation, row.why.slice(0, 500) || null, at, addWorkday(at)],
            );
          }
        }
        await client.query("UPDATE meetings SET decisions_run_id = $2 WHERE id = $1", [meetingId, runId]);
      }
      // 一条主持人条目都没有、或纪要换过：会议事件可能要写或要更正。
      await queueWorldSync(client.query.bind(client), meetingId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function view(decisionId: string, viewerId: string): Promise<TMeetingDecisionView | null> {
    const meetingId = (await q("SELECT meeting_id FROM meeting_decisions WHERE id = $1", [decisionId])).rows[0]?.meeting_id as string | undefined;
    const meeting = meetingId ? await getMeetingRow(q, meetingId) : null;
    const row = meeting?.decisions?.find((decision) => decision.id === decisionId);
    if (!meeting || !row) return null;
    return projectMeetingDecision(row, meeting.participants, row.tier === "host" && meeting.lead_dri_id === viewerId,
      decisionWorldContext(meeting, canManageWorld(meeting, viewerId)));
  }

  /**
   * 主持人确认一条：对 / 改一下 / 其实没定。主持人的判断总是生效（包括 Agent 已经代判过的）。
   * 已经往下推过、而生效与否或说法变了的，revision 加一，给收过卡的人出更正卡；还没推过、现在生效的，照常往下推。
   */
  async function review(meetingId: string, decisionId: string, viewerId: string, input: ReviewInput): Promise<ReviewResult> {
    if (!UUID_PATTERN.test(meetingId) || !UUID_PATTERN.test(decisionId)) return { error: { status: 404, code: "DECISION_NOT_FOUND", message: "这条决定不存在" } };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = (await client.query(
        `SELECT d.*, m.lead_dri_id FROM meeting_decisions d JOIN meetings m ON m.id = d.meeting_id WHERE d.id = $1 AND d.meeting_id = $2 FOR UPDATE OF d`,
        [decisionId, meetingId],
      )).rows[0] as (MeetingDecisionRow & { lead_dri_id: string }) | undefined;
      if (!found || found.lead_dri_id !== viewerId) { await client.query("ROLLBACK"); return { error: { status: 404, code: "DECISION_NOT_FOUND", message: "这条决定不存在" } }; }
      if (found.tier !== "host") { await client.query("ROLLBACK"); return { error: { status: 409, code: "STRATEGIC_BY_CEO", message: "战略项由 CEO 确认" } }; }
      const edited = input.verdict === "edited" ? input.statement?.trim() : undefined;
      if (input.verdict === "edited" && !edited) { await client.query("ROLLBACK"); return { error: { status: 400, code: "STATEMENT_REQUIRED", message: "改一下要写改后的说法" } }; }
      // 改成和原说法一样就是「对」。
      const verdict = edited && edited === found.statement ? "confirmed" : input.verdict;
      const finalStatement = verdict === "edited" ? edited! : null;
      const next = { status: verdict, recommendation: found.recommendation } as const;
      const wasEffective = decisionEffective(found);
      const nowEffective = decisionEffective(next);
      const pushed = found.impact_status !== "none";
      const changed = wasEffective !== nowEffective || decisionStatement(found) !== (finalStatement ?? found.statement);
      const bump = pushed && changed;
      const revision = found.revision + (bump ? 1 : 0);
      const propagate = bump || (!pushed && nowEffective);
      await client.query(
        `UPDATE meeting_decisions SET status = $2, final_statement = $3, reviewer_id = $4, reviewed_at = now(), next_remind_at = NULL, revision = $5,
           impact_status = CASE WHEN $6 THEN 'pending' ELSE impact_status END,
           world_status = CASE WHEN $7 THEN 'pending' ELSE world_status END, updated_at = now()
         WHERE id = $1`,
        [decisionId, verdict, finalStatement, viewerId, revision, propagate, bump],
      );
      if (propagate) await enqueue(client.query.bind(client), MEETING_DECISION_PROPAGATE_KIND, `${decisionId}:${revision}`, { decisionId, revision });
      // 不往下推的（其实没定）也可能让这场会办完：会议事件该写了。
      else await queueWorldSync(client.query.bind(client), meetingId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { decision: (await view(decisionId, viewerId))! };
  }

  /** 提醒（散会当天一次、下一个工作日 9:30 一次）与到点代判。 */
  async function tick(): Promise<void> {
    const at = now();
    const due = (await q(
      `SELECT d.*, m.title AS meeting_title, m.lead_dri_id, m.ceo_participant_id FROM meeting_decisions d JOIN meetings m ON m.id = d.meeting_id
        WHERE d.status = 'pending' AND d.next_remind_at IS NOT NULL AND d.next_remind_at <= $1 ORDER BY d.meeting_id, d.tier, d.ordinal`,
      [at],
    )).rows as (MeetingDecisionRow & { meeting_title: string; lead_dri_id: string; ceo_participant_id: string })[];
    const groups = new Map<string, typeof due>();
    for (const row of due) groups.set(`${row.meeting_id}:${row.tier}`, [...(groups.get(`${row.meeting_id}:${row.tier}`) ?? []), row]);
    for (const rows of groups.values()) {
      const first = rows[0];
      const recipient = first.tier === "host" ? first.lead_dri_id : first.ceo_participant_id;
      const round = Math.max(...rows.map((row) => row.remind_count)) + 1;
      const deadline = first.tier === "host" && first.due_at ? `\n\n${shanghaiLabel(new Date(first.due_at))} 前没确认，按 Agent 的判断生效。` : "";
      await deps.notify?.({
        personId: recipient,
        title: first.tier === "host" ? `「${first.meeting_title}」会后待你确认 ${rows.length} 条` : `「${first.meeting_title}」有 ${rows.length} 条战略项待你确认`,
        body: `${rows.map((row, index) => `${index + 1}. ${decisionStatement(row)}`).join("\n")}${deadline}`,
        links: [{ label: "去确认", path: pathFor(recipient, "meeting", first.meeting_id) }],
      }, `meeting-decisions:${first.meeting_id}:${first.tier}:${round}`);
      await q(
        `UPDATE meeting_decisions SET remind_count = remind_count + 1, next_remind_at = CASE WHEN remind_count + 1 >= 2 THEN NULL ELSE $2::timestamptz END, updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [rows.map((row) => row.id), nextWorkdayAt(at, 9, 30)],
      );
    }
    const judged = (await q(
      `UPDATE meeting_decisions SET status = 'agent_judged', judged_at = $1, next_remind_at = NULL,
         impact_status = CASE WHEN recommendation = 'confirmed' THEN 'pending' ELSE impact_status END, updated_at = now()
        WHERE tier = 'host' AND status = 'pending' AND due_at <= $1 RETURNING id, meeting_id, revision, recommendation`,
      [at],
    )).rows as { id: string; meeting_id: string; revision: number; recommendation: string }[];
    for (const row of judged) {
      logEvent({ event: "meeting.decision", objectRef: `meeting_decision:${row.id}`, status: "agent_judged" });
      if (row.recommendation === "confirmed") await enqueue(q, MEETING_DECISION_PROPAGATE_KIND, `${row.id}:${row.revision}`, { decisionId: row.id, revision: row.revision });
    }
    for (const meetingId of new Set(judged.filter((row) => row.recommendation !== "confirmed").map((row) => row.meeting_id))) await queueWorldSync(q, meetingId);
  }

  /** 影响分析的候选 → 能落库的卡：人、Task、Mission、验收项都要在候选里对得上；每人一张。 */
  function cardsFrom(candidate: TImpactAnalysisCandidate, people: ImpactCandidate[], base: Pick<NewImpactCard, "sources" | "ask_who" | "agent_judged">): NewImpactCard[] {
    const byId = new Map(people.map((person) => [person.personId, person]));
    const cards: NewImpactCard[] = [];
    for (const card of candidate.cards) {
      const person = byId.get(card.personId);
      if (!person || cards.some((existing) => existing.person_id === person.personId)) continue;
      const targets: TImpactTarget[] = [];
      for (const target of card.targets) {
        let resolved: TImpactTarget | null = null;
        if (target.type === "mission") {
          const mission = person.missions.find((item) => item.id === target.id || item.code === target.id);
          if (mission) resolved = { type: "mission", id: mission.id, title: mission.title };
        } else {
          const task = person.tasks.find((item) => item.id === target.id);
          if (task && target.type === "acceptance" && target.index !== undefined && target.index < task.acceptance.length) {
            resolved = { type: "acceptance", id: task.id, index: target.index, title: `${task.title} · ${task.acceptance[target.index]}` };
          } else if (task) resolved = { type: "task", id: task.id, title: task.title };
        }
        if (resolved && !targets.some((item) => item.type === resolved!.type && item.id === resolved!.id && item.index === resolved!.index)) targets.push(resolved);
      }
      if (!targets.length) continue;
      cards.push({
        person_id: person.personId, title: card.title.trim(), impact: card.impact.trim(), targets, why: card.why.trim(), confidence: card.confidence,
        action: { kind: card.action.kind, text: card.action.kind === "know" && !card.action.text.trim() ? "知悉即可" : card.action.text.trim(), due: card.action.kind === "do" ? realDate(card.action.due) : null },
        correction_of: null, correction_note: null, ...base,
      });
    }
    return cards;
  }

  /** 往下推一版：影响分析 → 落库并推送（含更正卡）→ 写本体。重放安全：这一版分析过就只补本体。 */
  async function propagate(decisionId: string, revision: number): Promise<void> {
    let decision = (await q("SELECT * FROM meeting_decisions WHERE id = $1", [decisionId])).rows[0] as MeetingDecisionRow | undefined;
    if (!decision || decision.revision !== revision) return;
    const meeting = await getMeetingRow(q, decision.meeting_id);
    if (!meeting) return;
    const nameMap = names();
    const lookup = (id: string | null) => (id ? meeting.participants.find((person) => person.personId === id)?.displayName ?? nameMap.get(id) ?? id : null);
    const effective = decisionEffective(decision);
    const statement = decisionStatement(decision);
    const initiatorId = decision.tier === "strategic" ? meeting.ceo_participant_id : meeting.lead_dri_id;
    const decidedBy = decision.tier === "strategic" ? "ceo" as const : decision.status === "agent_judged" ? "agent" as const : "host" as const;

    if (decision.impact_status !== "done") {
      // 每人最近一张已推过的卡（更正卡对着它出）。
      const previous = (await q(
        `SELECT DISTINCT ON (c.person_id) c.*, r.prompt AS statement FROM impact_cards c LEFT JOIN requests r ON r.id = c.request_id
          WHERE c.trigger_id = $1 AND c.trigger_revision < $2 AND c.status IN ('delivered', 'irrelevant')
          ORDER BY c.person_id, c.trigger_revision DESC`,
        [decision.id, revision],
      )).rows as (ImpactCardRow & { statement: string | null })[];
      const turn = meeting.transcript?.turns.find((item) => item.id === decision!.turn_id);
      const sources: TImpactSource[] = decision.quote ? [{ meetingId: meeting.id, meetingTitle: meeting.title, turnId: decision.turn_id,
        speakerName: lookup(decision.speaker_id), quote: decision.quote, at: turn?.startedAt ?? null }] : [];
      const askWho: TImpactAskWho[] = [{ personId: initiatorId, displayName: lookup(initiatorId)!, role: decision.tier === "strategic" ? "ceo" : "host" }];
      let cards: NewImpactCard[] = [];
      if (effective) {
        const context = await deps.context();
        const people = await impactCandidates(q, context, nameMap);
        const items = meeting.outcome?.items.filter((item) => decision!.item_ids.includes(item.id)) ?? [];
        const previousStatement = previous.find((card) => card.statement)?.statement ?? null;
        const analysis = await impact.analyze({
          today: shanghaiDate(now()),
          // 战略项是提给 CEO 的问题，CEO 确认即同意：按「CEO 同意：…」交给影响分析。
          decision: { statement: decision.tier === "strategic" ? `CEO 同意：${statement}${decision.why ? `（${decision.why}）` : ""}` : statement,
            decidedBy, meeting: { title: meeting.title, date: shanghaiDate(meeting.scheduled_at), host: lookup(meeting.lead_dri_id)! },
            quote: decision.quote, speaker: lookup(decision.speaker_id), why: decision.why },
          ...(previousStatement && previousStatement !== statement ? { previous: { statement: previousStatement } } : {}),
          relatedItems: items.map((item) => ({ kind: item.kind, text: item.text, owner: lookup(item.ownerPersonId), dueDate: item.dueDate ?? null })),
          meetingSummary: meeting.outcome?.summary ?? "",
          company: { monthOutcome: context.company.monthOutcome, longTermOutcome: context.company.longTermOutcome },
          people,
        }, { decisionId: decision.id }, AbortSignal.timeout(240_000));
        cards = cardsFrom(analysis, people, { sources, ask_who: askWho, agent_judged: decision.status === "agent_judged" });
      }
      const host = lookup(initiatorId)!;
      for (const card of cards) {
        const prior = previous.find((item) => item.person_id === card.person_id);
        if (!prior) continue;
        card.correction_of = prior.id;
        card.correction_note = `${host}把「${prior.statement ?? decision.statement}」改为「${statement}」`;
      }
      for (const prior of previous) {
        if (cards.some((card) => card.person_id === prior.person_id)) continue;
        const was = prior.statement ?? decision.statement;
        cards.push({
          person_id: prior.person_id, title: `「${prior.title}」作废`.slice(0, 200),
          impact: effective
            ? `${host}把会上的说法改成了「${statement}」，改后不再影响你手上的事，之前那张卡作废。`
            : `${host}确认会上其实没定「${was}」，之前推给你的那张卡作废，你手上的事照原计划推进。`,
          action: { kind: "know", text: "知悉即可", due: null }, targets: prior.targets, why: prior.why, sources: prior.sources, ask_who: prior.ask_who,
          confidence: "high", agent_judged: false, correction_of: prior.id,
          correction_note: effective ? `${host}把「${was}」改为「${statement}」` : `${host}确认会上其实没定「${was}」`,
        });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = (await client.query("SELECT revision, impact_status FROM meeting_decisions WHERE id = $1 FOR UPDATE", [decision.id])).rows[0] as { revision: number; impact_status: string };
        if (current.revision !== revision) { await client.query("ROLLBACK"); return; }
        if (current.impact_status !== "done") {
          // 飞书通知与影响卡同一个事务入队：卡没落库就不发。
          await insertImpactCards(client, { decision, initiatorId, cards, mode: deps.impactMode ?? "live",
            notify: deps.notify ? feishuNotifier(client.query.bind(client)) : undefined, pathFor, meetingTitle: meeting.title });
          await client.query("UPDATE meeting_decisions SET impact_status = 'done', updated_at = now() WHERE id = $1", [decision.id]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      logEvent({ event: "meeting.decision", objectRef: `meeting_decision:${decision.id}`, status: "propagated" });
      decision = (await q("SELECT * FROM meeting_decisions WHERE id = $1", [decisionId])).rows[0] as MeetingDecisionRow;
    }

    if (!deps.world || decision.world_status === "committed" || decision.world_status === "skipped") return;
    // 没生效、也没记过事件的，不用写。
    if (!effective && !decision.world_event_id) {
      await q("UPDATE meeting_decisions SET world_status = 'skipped' WHERE id = $1 AND revision = $2", [decision.id, revision]);
      await syncWorld(meeting.id);
      return;
    }
    await q("UPDATE meeting_decisions SET world_status = 'pending', world_error = NULL WHERE id = $1 AND revision = $2", [decision.id, revision]);
    await syncWorld(meeting.id);
  }

  /** 一条决定写进本体（或撤回）；NETWORK_ERROR 抛出交给 jobs 重试，其他错误记 failed。 */
  async function writeDecision(row: MeetingDecisionRow, meeting: MeetingRow, link: { meetingEventId: string | null; fallback: ResolvedAnchors | null },
    withdrawnBy?: string): Promise<void> {
    const world = deps.world!;
    const nameMap = names();
    const lookup = (id: string | null) => (id ? meeting.participants.find((person) => person.personId === id)?.displayName ?? nameMap.get(id) ?? id : null);
    const targets = (await q("SELECT targets FROM impact_cards WHERE trigger_id = $1 AND trigger_revision = $2", [row.id, row.revision])).rows
      .flatMap((card) => card.targets as TImpactTarget[]).map((target) => ({ type: target.type, id: target.id }));
    // 同一版再写一次（撤回、撤回后恢复）：幂等键另起，不然会重放上一次的回执。
    const sameRevision = row.world_event_id !== null && row.world_event_revision === row.revision;
    try {
      const result = await world.record({
        decision: { id: row.id, revision: row.revision, statement: decisionStatement(row),
          decidedBy: row.tier === "strategic" ? "ceo" : row.status === "agent_judged" ? "agent" : "host", quote: row.quote, speaker: lookup(row.speaker_id) },
        meeting: { id: meeting.id, title: meeting.title, scheduledAt: meeting.scheduled_at, leadDriId: meeting.lead_dri_id },
        targets, supersedesEventId: row.world_event_id,
        correctionNote: row.revision > 0 && !withdrawnBy
          ? (await q("SELECT correction_note FROM impact_cards WHERE trigger_id = $1 AND trigger_revision = $2 AND correction_note IS NOT NULL LIMIT 1", [row.id, row.revision])).rows[0]?.correction_note ?? null
          : null,
        withdrawn: Boolean(withdrawnBy) || !decisionEffective(row),
        meetingEventId: link.meetingEventId,
        fallback: link.fallback ? { refs: link.fallback.refs, sceneId: link.fallback.sceneId } : null,
        ...(withdrawnBy ? { withdrawnBy } : {}),
        ...(sameRevision ? { variant: `:${row.world_event_id!.slice(-12)}` } : {}),
      });
      const eventId = result.status === "committed" ? result.eventId : null;
      await q(
        `UPDATE meeting_decisions SET world_status = $3, world_event_id = COALESCE($4, world_event_id),
           world_event_revision = CASE WHEN $4::text IS NULL THEN world_event_revision ELSE revision END, world_fallback = $5, world_error = NULL
         WHERE id = $1 AND revision = $2`,
        [row.id, row.revision, withdrawnBy || !eventId ? "skipped" : "committed", eventId, Boolean(eventId && !withdrawnBy && result.status === "committed" && result.fallback)],
      );
    } catch (error) {
      const code = world.errorCode(error);
      await q("UPDATE meeting_decisions SET world_status = $3, world_error = $4 WHERE id = $1 AND revision = $2",
        [row.id, row.revision, code === "NETWORK_ERROR" ? "pending" : "failed", code]);
      logEvent({ event: "meeting.decision", objectRef: `meeting_decision:${row.id}`, status: "world_failed", errorCode: code });
      if (code === "NETWORK_ERROR") throw error;
    }
  }

  /** 会议事件写入或撤回；返回成功后的事件 id。NETWORK_ERROR 抛出，其他错误记 failed（已写过的保持原状态）；错误码在 world_sync_ledger。 */
  async function writeMeetingEvent(meeting: MeetingRow, write: Parameters<MeetingEventWorld["write"]>[0], status: "committed" | "withdrawn"): Promise<string | null> {
    try {
      const eventId = await deps.meetingWorld!.write(write);
      await q(
        `UPDATE meetings SET world_event_status = $2, world_event_id = $3, world_event_digest = $4, world_event_anchors = $5::jsonb,
           world_event_at = $6 WHERE id = $1`,
        [meeting.id, status, eventId, write.digest, JSON.stringify(write.anchors.used), now()],
      );
      return eventId;
    } catch (error) {
      const code = deps.meetingWorld!.errorCode(error);
      logEvent({ event: "meeting.world_event", objectRef: `meeting:${meeting.id}`, status: "world_failed", errorCode: code });
      if (code === "NETWORK_ERROR") throw error;
      await q("UPDATE meetings SET world_event_status = CASE WHEN world_event_status = 'committed' THEN world_event_status ELSE 'failed' END WHERE id = $1", [meeting.id]);
      return null;
    }
  }

  /**
   * 这场会的本体同步（幂等；jobs worker 逐条执行，同一场会不会并发）：
   * - 标了不写进本体：已写的会议事件和决定事件各记一条撤回，还没写的记 skipped；
   * - 否则等主持人的条目都办完（或代判）、生效的决定影响卡都推完，先写（或更正）会议事件，再写等着的决定事件并指回会议事件。
   */
  async function syncWorld(meetingId: string): Promise<void> {
    if (!deps.world) return;
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting) return;
    const rows = await rowsOf(q, meetingId);
    const resolve = () => (deps.meetingWorld ? deps.meetingWorld.resolve(meeting.world_anchor_groups ?? []) : Promise.resolve(null));

    if (meeting.world_excluded) {
      const by = meeting.world_excluded_by ?? "主持人";
      const committed = rows.filter((row) => row.world_status === "committed" && decisionEffective(row));
      const anchors = meeting.world_event_status === "committed" || committed.length ? await resolve() : null;
      if (deps.meetingWorld && meeting.world_event_status === "committed" && anchors) {
        await writeMeetingEvent(meeting, {
          meeting, digest: "withdrawn", transcriptDigest: transcriptDigest(meeting), anchors, supersedesEventId: meeting.world_event_id,
          text: [`撤回：${by}标为不写进本体`, `会议：${meeting.title}（${shanghaiLabel(new Date(meeting.scheduled_at))}）`].join("\n"),
        }, "withdrawn");
      } else if (meeting.world_event_status === "none" || meeting.world_event_status === "failed") {
        await q("UPDATE meetings SET world_event_status = 'skipped' WHERE id = $1", [meetingId]);
      }
      for (const row of committed) await writeDecision(row, meeting, { meetingEventId: null, fallback: anchors }, by);
      await q("UPDATE meeting_decisions SET world_status = 'skipped' WHERE meeting_id = $1 AND world_status IN ('pending', 'failed')", [meetingId]);
      return;
    }

    const waiting = rows.some((row) => row.tier === "host" && row.status === "pending")
      || rows.some((row) => decisionEffective(row) && row.impact_status === "pending");
    if (waiting) return;
    let meetingEventId = meeting.world_event_status === "committed" ? meeting.world_event_id : null;
    const anchors = await resolve();
    if (deps.meetingWorld && !anchors && meeting.world_event_status !== "committed") {
      await q("UPDATE meetings SET world_event_status = 'skipped' WHERE id = $1", [meetingId]);
    } else if (deps.meetingWorld && anchors) {
      const digest = meetingEventDigest(meeting, rows, anchors);
      if (meeting.world_event_status !== "committed" || meeting.world_event_digest !== digest) {
        meetingEventId = await writeMeetingEvent(meeting, {
          meeting, digest, transcriptDigest: transcriptDigest(meeting), anchors, supersedesEventId: meeting.world_event_id,
          text: meetingEventText(meeting, rows, anchors.used, names()),
        }, "committed") ?? meetingEventId;
      }
    }
    for (const row of rows.filter((item) => item.world_status === "pending")) await writeDecision(row, meeting, { meetingEventId, fallback: anchors });
  }

  /** 这场会在本体里的视图（主持人和 CEO）。 */
  async function worldView(meetingId: string, viewerId: string): Promise<WorldResult> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !canManageWorld(meeting, viewerId)) return NOT_FOUND;
    return { world: meetingWorldView(meeting, { canEdit: true, showStatus: true }) };
  }

  /** 标不写进本体（或取消）。取消时之前跳过、撤回的重新排队写。 */
  async function setExcluded(meetingId: string, viewerId: string, excluded: boolean): Promise<WorldResult> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !canManageWorld(meeting, viewerId)) return NOT_FOUND;
    if (meeting.world_excluded !== excluded) {
      const by = meeting.participants.find((person) => person.personId === viewerId)?.displayName ?? names().get(viewerId) ?? null;
      await q(
        `UPDATE meetings SET world_excluded = $2, world_excluded_by = $3,
           world_event_status = CASE WHEN NOT $2 AND world_event_status = 'skipped' THEN 'none' ELSE world_event_status END WHERE id = $1`,
        [meetingId, excluded, excluded ? by : null],
      );
      if (!excluded) {
        await q(`UPDATE meeting_decisions SET world_status = 'pending' WHERE meeting_id = $1 AND world_status = 'skipped'
            AND (status IN ('confirmed', 'edited') OR (status = 'agent_judged' AND recommendation = 'confirmed'))`, [meetingId]);
      }
      await queueWorldSync(q, meetingId);
    }
    return worldView(meetingId, viewerId);
  }

  /** 改挂点时可选的对象：会议所在月的 Mission 和所有责任单元。 */
  async function anchorOptions(meeting: MeetingRow): Promise<TWorldAnchor[]> {
    const period = shanghaiDate(new Date(meeting.scheduled_at)).slice(0, 7);
    const missions = (await q("SELECT id, title FROM missions WHERE period = $1 AND NOT placeholder ORDER BY code", [period])).rows as { id: string; title: string }[];
    const units = (await q("SELECT id, name FROM capability_config ORDER BY sort_order, code")).rows as { id: string; name: string }[];
    return [
      ...missions.map((row) => ({ kind: "mission" as const, id: row.id, title: row.title })),
      ...units.map((row) => ({ kind: "unit" as const, id: row.id, title: row.name })),
    ];
  }

  /** 改挂点（null 回到自动）；已写入的在下一次同步时记 correction。 */
  async function setAnchors(meetingId: string, viewerId: string, anchors: { kind: "mission" | "unit"; id: string }[] | null): Promise<WorldResult> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !canManageWorld(meeting, viewerId)) return NOT_FOUND;
    let chosen = anchors;
    if (chosen) {
      chosen = chosen.filter((anchor, index) => chosen!.findIndex((other) => other.kind === anchor.kind && other.id === anchor.id) === index);
      const known = await anchorOptions(meeting);
      if (chosen.some((anchor) => !known.some((option) => option.kind === anchor.kind && option.id === anchor.id))) {
        return { error: { status: 400, code: "ANCHOR_NOT_FOUND", message: "挂点只能是本月的 Mission 或责任单元" } };
      }
    }
    await q("UPDATE meetings SET world_anchors = $2::jsonb WHERE id = $1", [meetingId, chosen ? JSON.stringify(chosen) : null]);
    await queueWorldSync(q, meetingId);
    return worldView(meetingId, viewerId);
  }

  async function listAnchorOptions(meetingId: string, viewerId: string): Promise<{ options: TWorldAnchor[] } | typeof NOT_FOUND> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !canManageWorld(meeting, viewerId)) return NOT_FOUND;
    return { options: await anchorOptions(meeting) };
  }

  /** 我主持的会里还没确认的主持人条目（通知栏置顶）：待确认的，和 Agent 代判了、我还没点过的。 */
  async function listMine(viewerId: string): Promise<TMyMeetingDecisionGroup[]> {
    const rows = (await q(
      `SELECT d.*, m.title AS meeting_title, m.scheduled_at AS meeting_at, m.participants, m.world_excluded FROM meeting_decisions d JOIN meetings m ON m.id = d.meeting_id
        WHERE d.tier = 'host' AND d.status IN ('pending', 'agent_judged') AND m.lead_dri_id = $1 ORDER BY m.scheduled_at, d.ordinal`,
      [viewerId],
    )).rows as (MeetingDecisionRow & { meeting_title: string; meeting_at: Date; participants: MeetingRow["participants"]; world_excluded: boolean })[];
    const groups = new Map<string, TMyMeetingDecisionGroup>();
    for (const row of rows) {
      const group = groups.get(row.meeting_id) ?? { meetingId: row.meeting_id, meetingTitle: row.meeting_title, scheduledAt: iso(row.meeting_at),
        dueAt: row.due_at ? iso(row.due_at) : null, decisions: [] };
      group.decisions.push(projectMeetingDecision(row, row.participants, true, { excluded: row.world_excluded, meetingAnchors: [], showStatus: true }));
      groups.set(row.meeting_id, group);
    }
    return [...groups.values()];
  }

  return { sync, review, tick, propagate, listMine, syncWorld, worldView, setExcluded, setAnchors, listAnchorOptions };
}

export type MeetingDecisionService = ReturnType<typeof createMeetingDecisionService>;

/** 纪要整理好、会议条目有人处理过：排一次同步（幂等，按会议串行由行锁保证）。 */
export async function enqueueDecisionSync(q: Query, meetingId: string): Promise<void> {
  await enqueueJob(q, { kind: MEETING_DECISIONS_SYNC_KIND, dedupeKey: `${MEETING_DECISIONS_SYNC_KIND}:${meetingId}:${randomUUID()}`, payload: { meetingId } });
}

export function meetingDecisionJobs(service: MeetingDecisionService): { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  return {
    handlers: {
      [MEETING_DECISIONS_SYNC_KIND]: (payload) => service.sync(String((payload as { meetingId?: unknown }).meetingId)),
      [MEETING_DECISIONS_TICK_KIND]: () => service.tick(),
      [MEETING_DECISION_PROPAGATE_KIND]: (payload) => {
        const { decisionId, revision } = payload as { decisionId: string; revision: number };
        return service.propagate(decisionId, Number(revision));
      },
      [MEETING_WORLD_SYNC_KIND]: (payload) => service.syncWorld(String((payload as { meetingId?: unknown }).meetingId)),
    },
    recurring: [{ kind: MEETING_DECISIONS_TICK_KIND, everyMs: TICK_EVERY_MS }],
  };
}
