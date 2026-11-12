import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  TAddReviewLinkRequest, TMissionVerdict, TMonthCarryoverResponse, TMonthReviewCriterion, TMonthReviewLink, TMonthReviewMission, TMonthReviewResponse,
  TMonthReviewTask, TPutReviewCriterionRequest, TPutReviewDispositionRequest, TReviewDisposition, TReviewLinkCandidate, TReviewRating, TTaskSettlement,
} from "@warmap/contracts";
import { effectiveOutcome } from "./cardProjection.js";
import { inTransaction } from "./collector.js";
import { reviewWindow } from "./homeWaiting.js";
import { enqueueJob, type JobHandler, type RecurringJob } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import type { MonthReviewAgent, MonthReviewAgentInput } from "./monthReviewAgent.js";
import { LOCATE_BUDGET_MS, taskBasis } from "./planTaskAccess.js";
import { readPlanTasks, type PlanTask, type PlanTaskSource } from "./planTasks.js";
import { settlementsOf, stopTask, unstopTask } from "./taskContinuity.js";
import { CardError } from "./taskCards.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 月底复盘第三版（契约 monthReview.ts，设计《复盘进新首页_设计第三版_2026-11-10》）。天枢自己的数据：不写本体、不转 M2、不调 Co-Agent。
 *
 * 复盘页包括哪些 Task（本人 11/11 定）：本人负责的 Mission 一个一块，放这个 Mission 下所有人的 Task；
 * 别人 Mission 下本人负责的 Task 按那个 Mission 单独一块（能评、能改去向，没有确认按钮）。Mission 下没有 Task 的不出块。
 * 一条标准一行：本体验收标准，没有就按完成定义算一条，两样都没有用 Task 名算一条。
 * 预评按人排后台任务：去向和能机械判的评定直接判，判不了的交统一评审员（monthReviewAgent.ts）。
 */

export const MONTH_REVIEW_PREFILL_KIND = "month_review.prefill";
export const MONTH_REVIEW_TICK_KIND = "month_review.tick";
const TICK_MS = 30 * 60_000;

export type MonthReviewDeps = { pool: Pool; planTasks: PlanTaskSource; names: () => Map<string, string>; now: () => Date };
/** 只读复盘页要的：查询、本体 Task 来源、人名。 */
export type MonthReviewRead = { q: Query; planTasks: PlanTaskSource; names: Map<string, string> };
const readerOf = (deps: MonthReviewDeps): MonthReviewRead => ({ q: deps.pool.query.bind(deps.pool), planTasks: deps.planTasks, names: deps.names() });
/** 本体里这件 Task 的事件（只读），给评审员看；读不到为空。 */
export type TaskEventReader = (task: { taskId: string; scopeId: string | null }) => Promise<{ at: string; text: string }[]>;

const periodIndex = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1;
const periodOf = (index: number) => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
export const nextPeriod = (period: string) => periodOf(periodIndex(period) + 1);

/** 本轮截止：下个月 1 号 18:00（公司时区，本人 11/11 定）；过了截止也还能改。 */
export function reviewDeadline(period: string): string {
  const next = periodIndex(period) + 1;
  return new Date(Date.UTC(Math.floor(next / 12), next % 12, 1, 10)).toISOString();
}

/** 这个月能不能出预评：月份已经过去，或者在它的复盘窗口里。 */
function reviewable(period: string, now: Date): boolean {
  return period < shanghaiDate(now).slice(0, 7) || reviewWindow(now)?.period === period;
}

type MissionRow = { id: string; code: string; title: string; owner_id: string; world_scope_id: string | null; world_object_id: string | null; world_domain_id: string | null };
type ScopeTask = { task: PlanTask; mission: MissionRow; ownerId: string; criteria: string[] };
type Scope = { blocks: { mission: MissionRow; own: boolean; tasks: ScopeTask[] }[]; tasks: Map<string, ScopeTask> };

/** 复盘的标准：本体验收标准，没有按完成定义算一条，两样都没有用 Task 名算一条。 */
const criteriaOf = (task: PlanTask) => {
  const { criteria } = taskBasis(task);
  return criteria.length ? criteria : [task.name];
};

/** 本人这个月复盘页上的 Mission 和 Task（见文件头）。本体读不到时为空。 */
async function reviewScope(q: Query, planTasks: PlanTaskSource, personId: string, period: string): Promise<Scope> {
  const missions = (await q(`SELECT id,code,title,owner_id,world_scope_id,world_object_id,world_domain_id FROM missions
    WHERE period=$1 AND NOT placeholder ORDER BY code,id`, [period])).rows as MissionRow[];
  const scope: Scope = { blocks: [], tasks: new Map() };
  if (!missions.length) return scope;
  const all = await readPlanTasks(planTasks, missions.map((m) => ({ id: m.id, code: m.code,
    world: m.world_scope_id && m.world_object_id && m.world_domain_id ? { scopeId: m.world_scope_id, objectId: m.world_object_id, domainId: m.world_domain_id } : null })),
  LOCATE_BUDGET_MS);
  const own = missions.filter((m) => m.owner_id === personId), others = missions.filter((m) => m.owner_id !== personId);
  for (const mission of [...own, ...others]) {
    const mine = mission.owner_id === personId;
    const tasks = all.filter((task) => task.missionId === mission.id && (mine || task.responsibleId === personId))
      .sort((a, b) => a.name.localeCompare(b.name, "zh") || a.taskId.localeCompare(b.taskId))
      .map((task) => ({ task, mission, ownerId: task.responsibleId || mission.owner_id, criteria: criteriaOf(task) }));
    if (!tasks.length) continue;
    scope.blocks.push({ mission, own: mine, tasks });
    for (const task of tasks) scope.tasks.set(task.task.taskId, task);
  }
  return scope;
}

/** Agent 预填的去向：已经延续出去的算延期到那件所在的月份（不晚于本月时算下个月），到此为止的算已取消，其余本期验收。 */
function defaultDisposition(settlement: TTaskSettlement | undefined, period: string): { disposition: TReviewDisposition; deferredTo: string | null } {
  if (settlement?.kind === "continued") {
    const to = settlement.to?.period;
    return { disposition: "deferred", deferredTo: to && to > period ? to : nextPeriod(period) };
  }
  if (settlement?.kind === "stopped") return { disposition: "cancelled", deferredTo: null };
  return { disposition: "current", deferredTo: null };
}

type TaskRow = { task_id: string; disposition: TReviewDisposition; deferred_to: string | null; set_by: string | null };
type CriterionRow = { task_id: string; idx: number; text: string; agent_rating: TReviewRating | null; agent_basis: string | null; rating: TReviewRating | null;
  note: string | null; rated_by: string | null };
type LinkRow = { id: string; task_id: string; idx: number; url: string; title: string; source: "agent" | "person" };
const key = (taskId: string, index: number) => `${taskId}\n${index}`;

async function loadRows(q: Query, period: string, taskIds: string[]) {
  const [tasks, criteria, links, confirms] = await Promise.all([
    q("SELECT task_id,disposition,deferred_to,set_by FROM month_review_tasks WHERE period=$1 AND task_id=ANY($2::text[])", [period, taskIds]),
    q("SELECT task_id,idx,text,agent_rating,agent_basis,rating,note,rated_by FROM month_review_criteria WHERE period=$1 AND task_id=ANY($2::text[])", [period, taskIds]),
    q("SELECT id::text,task_id,idx,url,title,source FROM month_review_links WHERE period=$1 AND task_id=ANY($2::text[]) ORDER BY added_at,id", [period, taskIds]),
    q("SELECT mission_id,confirmed_by,confirmed_at FROM month_review_missions WHERE period=$1", [period]),
  ]);
  const linkMap = new Map<string, TMonthReviewLink[]>();
  for (const row of links.rows as LinkRow[])
    linkMap.set(key(row.task_id, row.idx), [...linkMap.get(key(row.task_id, row.idx)) ?? [], { id: row.id, title: row.title, url: row.url, source: row.source }]);
  return {
    tasks: new Map((tasks.rows as TaskRow[]).map((row) => [row.task_id, row])),
    criteria: new Map((criteria.rows as CriterionRow[]).map((row) => [key(row.task_id, row.idx), row])),
    links: linkMap,
    confirms: new Map((confirms.rows as { mission_id: string; confirmed_by: string; confirmed_at: Date }[]).map((row) => [row.mission_id, row])),
  };
}

const verdictOf = (ratings: (TReviewRating | null)[]): TMissionVerdict | null => {
  if (!ratings.length || ratings.some((rating) => rating === null)) return null;
  const met = ratings.filter((rating) => rating === "met").length;
  return met === ratings.length ? "achieved" : met === 0 ? "not_achieved" : "partial";
};

/** GET /api/me/months/:period/review：只读，不排预评（排预评看 requestPrefill）。 */
export async function readMonthReview(read: MonthReviewRead, viewerId: string, period: string): Promise<TMonthReviewResponse> {
  const { q, names } = read;
  const scope = await reviewScope(q, read.planTasks, viewerId, period);
  const ids = [...scope.tasks.keys()];
  const [rows, settlements, prefill] = await Promise.all([loadRows(q, period, ids), settlementsOf(q, ids),
    q("SELECT status,error FROM month_review_prefills WHERE owner_id=$1 AND period=$2", [viewerId, period])]);
  const person = (id: string) => ({ personId: id, name: names.get(id) ?? id });
  const setAside: TMonthReviewTask[] = [];
  const missions: TMonthReviewMission[] = scope.blocks.map(({ mission, own, tasks }) => {
    const current: TMonthReviewTask[] = [];
    let deferred = 0, cancelled = 0;
    for (const item of tasks) {
      const row = rows.tasks.get(item.task.taskId);
      const disposition = row ? { disposition: row.disposition, deferredTo: row.deferred_to } : defaultDisposition(settlements.get(item.task.taskId), period);
      const view: TMonthReviewTask = { taskId: item.task.taskId, name: item.task.name, missionId: mission.id, missionTitle: mission.title,
        responsible: item.task.responsibleId ? person(item.task.responsibleId) : null, ...disposition, dispositionBy: row?.set_by ? person(row.set_by) : null,
        canChange: own || item.task.responsibleId === viewerId, criteria: [] };
      if (disposition.disposition !== "current") {
        if (disposition.disposition === "deferred") deferred++; else cancelled++;
        setAside.push(view);
        continue;
      }
      view.criteria = item.criteria.map((text, i): TMonthReviewCriterion => {
        const stored = rows.criteria.get(key(item.task.taskId, i + 1));
        const valid = stored?.text === text ? stored : undefined;
        return { index: i + 1, text, agentRating: valid?.agent_rating ?? null, agentBasis: valid?.agent_basis ?? null, rating: valid?.rating ?? null,
          ratedBy: valid?.rating && valid.rated_by ? person(valid.rated_by) : null, note: valid?.note ?? null,
          links: valid ? rows.links.get(key(item.task.taskId, i + 1)) ?? [] : [] };
      });
      current.push(view);
    }
    const ratings = current.flatMap((task) => task.criteria.map((criterion) => criterion.rating ?? criterion.agentRating));
    const confirm = rows.confirms.get(mission.id);
    return { missionId: mission.id, code: mission.code, title: mission.title, owner: person(mission.owner_id), verdict: verdictOf(ratings),
      met: ratings.filter((rating) => rating === "met").length, total: ratings.length, deferred, cancelled,
      confirmedAt: confirm?.confirmed_at.toISOString() ?? null, confirmedBy: confirm ? person(confirm.confirmed_by) : null, canConfirm: own, tasks: current };
  });
  const status = prefill.rows[0] as { status: TMonthReviewResponse["prefill"]["status"]; error: string | null } | undefined;
  return { period, deadline: reviewDeadline(period), prefill: { status: status?.status ?? "pending", error: status?.error ?? null },
    toConfirm: missions.filter((mission) => mission.canConfirm && !mission.confirmedAt).length,
    deferred: setAside.filter((task) => task.disposition === "deferred").length, cancelled: setAside.filter((task) => task.disposition === "cancelled").length,
    missions, setAside };
}

/**
 * 页面上本期验收的条目里还有没出预评的（第一次打开、改回本期验收、本体里的标准改了），就按本人排一次预评。
 * 同一批没出预评的条目只排一次；在评的时候不排；还没过完的月份不排。
 */
export async function requestPrefill(deps: MonthReviewDeps, viewerId: string, view: TMonthReviewResponse): Promise<boolean> {
  if (!reviewable(view.period, deps.now()) || view.prefill.status === "running") return false;
  const missing = view.missions.flatMap((mission) => mission.tasks.flatMap((task) => task.criteria.filter((criterion) => !criterion.agentRating)
    .map((criterion) => `${task.taskId}:${criterion.index}:${criterion.text}`)));
  if (!missing.length) return false;
  return enqueuePrefill(deps.pool.query.bind(deps.pool), viewerId, view.period, createHash("sha256").update(missing.sort().join("\n")).digest("hex").slice(0, 16));
}

async function enqueuePrefill(q: Query, personId: string, period: string, tag: string): Promise<boolean> {
  const queued = await enqueueJob(q, { kind: MONTH_REVIEW_PREFILL_KIND, dedupeKey: `${MONTH_REVIEW_PREFILL_KIND}:${personId}:${period}:${tag}`, payload: { personId, period } });
  if (queued) await q(`INSERT INTO month_review_prefills(owner_id,period,status,updated_at) VALUES($1,$2,'pending',now())
    ON CONFLICT (owner_id,period) DO UPDATE SET status='pending',error=NULL,updated_at=now() WHERE month_review_prefills.status<>'running'`, [personId, period]);
  return queued;
}

/** 写操作要的那件 Task：不在本人这次复盘里 404，改不了 403。 */
async function changeable(deps: MonthReviewDeps, viewerId: string, period: string, taskId: string): Promise<ScopeTask> {
  const scope = await reviewScope(deps.pool.query.bind(deps.pool), deps.planTasks, viewerId, period);
  const found = scope.tasks.get(taskId);
  if (!found) throw new CardError(404, "NOT_FOUND", "这次复盘里没有这件 Task");
  if (found.mission.owner_id !== viewerId && found.task.responsibleId !== viewerId) throw new CardError(403, "FORBIDDEN", "只有 Mission 负责人和这件 Task 的负责人能改");
  return found;
}

/** 复盘行没有就按 Agent 预填的去向补上（评定、交付挂在它下面）。 */
async function ensureTaskRow(tx: Query, period: string, item: ScopeTask, settlement: TTaskSettlement | undefined, now: Date): Promise<TaskRow> {
  const fallback = defaultDisposition(settlement, period);
  await tx(`INSERT INTO month_review_tasks(period,task_id,mission_id,task_name,owner_id,disposition,deferred_to,set_by,set_at) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8)
    ON CONFLICT (period,task_id) DO UPDATE SET mission_id=EXCLUDED.mission_id,task_name=EXCLUDED.task_name,owner_id=EXCLUDED.owner_id`,
  [period, item.task.taskId, item.mission.id, item.task.name, item.ownerId, fallback.disposition, fallback.deferredTo, now]);
  return (await tx("SELECT task_id,disposition,deferred_to,set_by FROM month_review_tasks WHERE period=$1 AND task_id=$2", [period, item.task.taskId])).rows[0] as TaskRow;
}

/** 确认以后这个 Mission 下任何一处改动都清掉确认。 */
const unconfirm = (tx: Query, period: string, missionId: string) => tx("DELETE FROM month_review_missions WHERE period=$1 AND mission_id=$2", [period, missionId]);

/** PUT …/review/tasks/:taskId/disposition。已取消同时定了到此为止；从已取消改走就撤销到此为止（本人 11/11 定）。 */
export async function setDisposition(deps: MonthReviewDeps, viewerId: string, period: string, taskId: string, body: TPutReviewDispositionRequest): Promise<void> {
  const deferredTo = body.disposition === "deferred" ? body.deferredTo ?? nextPeriod(period) : null;
  if (body.disposition !== "deferred" && body.deferredTo) throw new CardError(400, "INVALID_INPUT", "只有延期要选月份");
  if (deferredTo !== null && deferredTo <= period) throw new CardError(400, "INVALID_INPUT", "延期要延到以后的月份");
  const item = await changeable(deps, viewerId, period, taskId);
  const settlement = (await settlementsOf(deps.pool.query.bind(deps.pool), [taskId])).get(taskId);
  const now = deps.now();
  await inTransaction(deps.pool, async (tx) => {
    const before = await ensureTaskRow(tx, period, item, settlement, now);
    await tx("UPDATE month_review_tasks SET disposition=$3,deferred_to=$4,set_by=$5,set_at=$6 WHERE period=$1 AND task_id=$2",
      [period, taskId, body.disposition, deferredTo, viewerId, now]);
    if (body.disposition === "cancelled") await stopTask(tx, taskId, viewerId, null, now);
    else if (before.disposition === "cancelled" || settlement?.kind === "stopped") await unstopTask(tx, taskId);
    await unconfirm(tx, period, item.mission.id);
  });
}

/** 本期验收的那件 Task 里的第几条；不是本期验收的 409，没有这一条 404。 */
async function currentCriterion(deps: MonthReviewDeps, viewerId: string, period: string, taskId: string, index: number) {
  const item = await changeable(deps, viewerId, period, taskId);
  const text = item.criteria[index - 1];
  if (!Number.isInteger(index) || !text) throw new CardError(404, "NOT_FOUND", "这件 Task 没有这一条");
  const settlement = (await settlementsOf(deps.pool.query.bind(deps.pool), [taskId])).get(taskId);
  const row = (await deps.pool.query("SELECT disposition FROM month_review_tasks WHERE period=$1 AND task_id=$2", [period, taskId])).rows[0] as { disposition: TReviewDisposition } | undefined;
  if ((row?.disposition ?? defaultDisposition(settlement, period).disposition) !== "current") throw new CardError(409, "NOT_CURRENT", "这件不在本期验收，不评定、不挂交付");
  return { item, text, settlement };
}

/** 那一条的行：没有就建；本体里的标准原文改了就换成新的，预评、本人评定和备注一起作废。 */
async function ensureCriterionRow(tx: Query, period: string, taskId: string, index: number, text: string): Promise<CriterionRow> {
  await tx(`INSERT INTO month_review_criteria(period,task_id,idx,text) VALUES($1,$2,$3,$4)
    ON CONFLICT (period,task_id,idx) DO UPDATE SET text=EXCLUDED.text,agent_rating=NULL,agent_basis=NULL,vague=false,rating=NULL,note=NULL,rated_by=NULL
    WHERE month_review_criteria.text<>EXCLUDED.text`, [period, taskId, index, text]);
  return (await tx("SELECT task_id,idx,text,agent_rating,agent_basis,rating,note,rated_by FROM month_review_criteria WHERE period=$1 AND task_id=$2 AND idx=$3",
    [period, taskId, index])).rows[0] as CriterionRow;
}

/** PUT …/criteria/:index：和预评不同时备注必填；和预评一样就算没改（rating 存空）。 */
export async function rateCriterion(deps: MonthReviewDeps, viewerId: string, period: string, taskId: string, index: number, body: TPutReviewCriterionRequest): Promise<void> {
  const note = body.note?.trim() || null;
  const { item, text, settlement } = await currentCriterion(deps, viewerId, period, taskId, index);
  const now = deps.now();
  await inTransaction(deps.pool, async (tx) => {
    await ensureTaskRow(tx, period, item, settlement, now);
    const row = await ensureCriterionRow(tx, period, taskId, index, text);
    const changed = row.agent_rating !== body.rating;
    if (changed && row.agent_rating && !note) throw new CardError(400, "NOTE_REQUIRED", "改了预评，要写一句实际完成得怎么样");
    await tx("UPDATE month_review_criteria SET rating=$4,note=$5,rated_by=$6 WHERE period=$1 AND task_id=$2 AND idx=$3",
      [period, taskId, index, changed ? body.rating : null, note, changed || note ? viewerId : null]);
    await unconfirm(tx, period, item.mission.id);
  });
}

type OutputRow = { id: string; title: string; kind: string; evidence_kind: string | null; url: string | null; created_at: Date };
const outputUrl = (row: OutputRow) => row.kind === "artifact" ? `/api/me/local-outputs/${row.id}` : row.evidence_kind === "link" && row.url ? row.url : null;

/** 「+ 添加」弹层：这件 Task 的交付物条目（各版，新的在前）和本人在这件 Task 下的子会话产出（卡和专题的，能打开的）。 */
export async function linkCandidates(deps: MonthReviewDeps, viewerId: string, period: string, taskId: string): Promise<TReviewLinkCandidate[]> {
  await changeable(deps, viewerId, period, taskId);
  return candidatesOf(deps.pool.query.bind(deps.pool), viewerId, taskId);
}

async function candidatesOf(q: Query, viewerId: string, taskId: string): Promise<TReviewLinkCandidate[]> {
  const [items, outputs] = await Promise.all([
    q(`SELECT i.id::text,i.kind,i.name,i.url,v.created_at FROM deliverable_items i JOIN deliverable_versions v ON v.id=i.version_id
      WHERE v.task_id=$1 ORDER BY v.number DESC,i.position`, [taskId]),
    q(`SELECT o.id::text,o.title,o.kind,o.evidence_kind,o.url,o.created_at FROM local_outputs o
      LEFT JOIN tasks t ON t.id=o.task_id LEFT JOIN research_topics r ON r.id=o.topic_id
      WHERE o.owner_id=$2 AND (t.plan_task_id=$1 OR r.plan_task_id=$1) ORDER BY o.created_at DESC`, [taskId, viewerId]),
  ]);
  const deliverables = (items.rows as { id: string; kind: string; name: string; url: string | null; created_at: Date }[]).map((row): TReviewLinkCandidate => ({
    kind: "deliverable", id: row.id, title: row.name.slice(0, 200), url: row.kind === "link" && row.url ? row.url : `/api/plan-tasks/${encodeURIComponent(taskId)}/deliverable/items/${row.id}`,
    at: row.created_at.toISOString() }));
  const produced = (outputs.rows as OutputRow[]).flatMap((row): TReviewLinkCandidate[] => {
    const url = outputUrl(row);
    return url ? [{ kind: "output", id: row.id, title: row.title, url, at: row.created_at.toISOString() }] : [];
  });
  return [...deliverables, ...produced].sort((a, b) => b.at.localeCompare(a.at));
}

/** POST …/criteria/:index/links：粘贴的只收 http / https，标题不写用网址；弹层里点的按候选填标题和链接。 */
export async function addLink(deps: MonthReviewDeps, viewerId: string, period: string, taskId: string, index: number, body: TAddReviewLinkRequest): Promise<void> {
  let link: { url: string; title: string };
  if ("candidate" in body) {
    const found = (await candidatesOf(deps.pool.query.bind(deps.pool), viewerId, taskId)).find((item) => item.kind === body.candidate.kind && item.id === body.candidate.id);
    if (!found) throw new CardError(404, "NOT_FOUND", "找不到这一样交付");
    link = { url: found.url, title: found.title };
  } else {
    const url = body.url.trim();
    const parsed = URL.canParse(url) ? new URL(url) : null;
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) throw new CardError(400, "INVALID_INPUT", "要一个 http 或 https 的链接");
    link = { url, title: (body.title?.trim() || url).slice(0, 200) };
  }
  const { item, text, settlement } = await currentCriterion(deps, viewerId, period, taskId, index);
  const now = deps.now();
  await inTransaction(deps.pool, async (tx) => {
    await ensureTaskRow(tx, period, item, settlement, now);
    await ensureCriterionRow(tx, period, taskId, index, text);
    await tx(`INSERT INTO month_review_links(id,period,task_id,idx,url,title,source) VALUES($1,$2,$3,$4,$5,$6,'person')`,
      [randomUUID(), period, taskId, index, link.url, link.title]);
    await unconfirm(tx, period, item.mission.id);
  });
}

/** DELETE …/review/links/:linkId。 */
export async function deleteLink(deps: MonthReviewDeps, viewerId: string, period: string, linkId: string): Promise<void> {
  const row = (await deps.pool.query("SELECT task_id FROM month_review_links WHERE id=$1 AND period=$2", [linkId, period])).rows[0] as { task_id: string } | undefined;
  if (!row) throw new CardError(404, "NOT_FOUND", "找不到这个交付");
  const item = await changeable(deps, viewerId, period, row.task_id);
  await inTransaction(deps.pool, async (tx) => {
    await tx("DELETE FROM month_review_links WHERE id=$1", [linkId]);
    await unconfirm(tx, period, item.mission.id);
  });
}

/** POST …/missions/:missionId/confirm：只有 Mission 负责人能点；本期验收的条目还有没评的 409。 */
export async function confirmMission(deps: MonthReviewDeps, viewerId: string, period: string, missionId: string): Promise<void> {
  const view = await readMonthReview(readerOf(deps), viewerId, period);
  const mission = view.missions.find((item) => item.missionId === missionId);
  if (!mission) throw new CardError(404, "NOT_FOUND", "这次复盘里没有这个 Mission");
  if (!mission.canConfirm) throw new CardError(403, "FORBIDDEN", "只有 Mission 负责人能确认");
  if (mission.tasks.some((task) => task.criteria.some((criterion) => !(criterion.rating ?? criterion.agentRating))))
    throw new CardError(409, "NOT_RATED", "还有没评的条目");
  await deps.pool.query(`INSERT INTO month_review_missions(period,mission_id,confirmed_by,confirmed_at) VALUES($1,$2,$3,$4)
    ON CONFLICT (period,mission_id) DO UPDATE SET confirmed_by=EXCLUDED.confirmed_by,confirmed_at=EXCLUDED.confirmed_at`, [period, missionId, viewerId, deps.now()]);
}

/**
 * GET /api/me/months/:period/carryover：本人（Task 负责人，没登记时是 Mission 负责人）延期到这个月的，加上延期到更早、到现在还没了结的。
 * 到此为止的不带；延到这个月的已经延续出去也照样带（草稿里对得上那件）。
 */
export async function readCarryover(q: Query, personId: string, period: string): Promise<TMonthCarryoverResponse> {
  const rows = (await q(`SELECT t.period,t.task_id,t.task_name,t.mission_id,t.deferred_to,coalesce(m.title,'') AS mission_title
    FROM month_review_tasks t LEFT JOIN missions m ON m.id=t.mission_id
    WHERE t.owner_id=$1 AND t.disposition='deferred' AND t.deferred_to<=$2 AND t.period<$2
    ORDER BY t.deferred_to,t.period,t.mission_id,t.task_name`, [personId, period])).rows as
    { period: string; task_id: string; task_name: string; mission_id: string; deferred_to: string; mission_title: string }[];
  const settlements = await settlementsOf(q, rows.map((row) => row.task_id));
  const kept = rows.filter((row) => {
    const settled = settlements.get(row.task_id)?.kind;
    return settled !== "stopped" && (row.deferred_to === period || !settled);
  });
  const tasks = await Promise.all(kept.map(async (row) => {
    const loaded = await loadRows(q, row.period, [row.task_id]);
    const criteria = [...loaded.criteria.values()].sort((a, b) => a.idx - b.idx).map((criterion) => ({ index: criterion.idx, text: criterion.text,
      rating: criterion.rating ?? criterion.agent_rating, note: criterion.note, links: loaded.links.get(key(row.task_id, criterion.idx)) ?? [] }));
    return { taskId: row.task_id, name: row.task_name, missionId: row.mission_id, missionTitle: row.mission_title, fromPeriod: row.period, deferredTo: row.deferred_to, criteria };
  }));
  return { period, tasks };
}

/**
 * 「等你」里的「复盘 N 月」（本人 11/11 定：预评做完推一次飞书，截止前不再推）：预评做完了、本人还有能确认没确认的 Mission；
 * 本人没有能确认的（只有别人 Mission 下自己负责的 Task）就到截止为止。
 */
export async function monthReviewWaiting(read: MonthReviewRead, now: Date, personId: string, period: string): Promise<boolean> {
  const view = await readMonthReview(read, personId, period);
  if (view.prefill.status !== "done") return false;
  const confirmable = view.missions.some((mission) => mission.canConfirm);
  return confirmable ? view.toConfirm > 0 : view.missions.length > 0 && now.toISOString() < view.deadline;
}

type CardRow = { id: string; title: string; status: string; criterion_index: number | null };

/**
 * 预评一个人：去向没定的按 Agent 预填写下；标准原文写下（改了的作废重评）；本期验收里还没预评的条目：
 * 本人确认完成的每条「达到」、对这条的卡验收过了「达到」、有卡没过「部分达到」，其余交统一评审员；什么都读不到「未达到」。
 */
export async function prefillReview(deps: MonthReviewDeps & { agent: MonthReviewAgent; events: TaskEventReader }, personId: string, period: string): Promise<void> {
  const q: Query = deps.pool.query.bind(deps.pool);
  const mark = (status: string, error: string | null) => q(`INSERT INTO month_review_prefills(owner_id,period,status,error,updated_at) VALUES($1,$2,$3,$4,now())
    ON CONFLICT (owner_id,period) DO UPDATE SET status=EXCLUDED.status,error=EXCLUDED.error,updated_at=now()`,
  [personId, period, status, error]);
  await mark("running", null);
  try {
    const scope = await reviewScope(q, deps.planTasks, personId, period);
    const items = [...scope.tasks.values()];
    const settlements = await settlementsOf(q, items.map((item) => item.task.taskId));
    const now = deps.now();
    const pending: { item: ScopeTask; indexes: number[] }[] = [];
    await inTransaction(deps.pool, async (tx) => {
      for (const item of items) {
        const row = await ensureTaskRow(tx, period, item, settlements.get(item.task.taskId), now);
        await tx("DELETE FROM month_review_criteria WHERE period=$1 AND task_id=$2 AND idx>$3", [period, item.task.taskId, item.criteria.length]);
        const indexes: number[] = [];
        for (const [i, text] of item.criteria.entries()) {
          const criterion = await ensureCriterionRow(tx, period, item.task.taskId, i + 1, text);
          if (!criterion.agent_rating) indexes.push(i + 1);
        }
        if (row.disposition === "current" && indexes.length) pending.push({ item, indexes });
      }
    });
    for (const { item, indexes } of pending) await rateTask(deps, item, indexes, settlements.get(item.task.taskId), period);
    await mark("done", null);
  } catch (cause) {
    await mark("failed", "预评没做成，稍后会再试").catch(() => undefined);
    throw cause;
  }
}

type Rated = { index: number; rating: TReviewRating; basis: string; vague: boolean; links: { url: string; title: string }[] };

async function rateTask(deps: MonthReviewDeps & { agent: MonthReviewAgent; events: TaskEventReader }, item: ScopeTask, indexes: number[],
  settlement: TTaskSettlement | undefined, period: string): Promise<void> {
  const q: Query = deps.pool.query.bind(deps.pool);
  const taskId = item.task.taskId;
  const rated: Rated[] = [];
  const versions = (await q(`SELECT id::text,number,statement,review,delivered_at FROM deliverable_versions WHERE task_id=$1 ORDER BY number DESC LIMIT 1`, [taskId])).rows as
    { id: string; number: number; statement: string | null; review: { criteria?: unknown[] } | null; delivered_at: Date | null }[];
  const latest = versions[0];
  const latestItems = latest ? (await q("SELECT id::text,kind,name,url,extracted_text FROM deliverable_items WHERE version_id=$1 ORDER BY position", [latest.id])).rows as
    { id: string; kind: string; name: string; url: string | null; extracted_text: string | null }[] : [];
  const itemLink = (row: { id: string; kind: string; name: string; url: string | null }) => ({ url: row.kind === "link" && row.url ? row.url
    : `/api/plan-tasks/${encodeURIComponent(taskId)}/deliverable/items/${row.id}`, title: row.name.slice(0, 200) });
  let rest = indexes;
  if (settlement?.kind === "completed" && latest) {
    for (const index of rest) rated.push({ index, rating: "met", basis: `第 ${latest.number} 版交付了，本人确认完成`, vague: false, links: latestItems.map(itemLink) });
    rest = [];
  }
  const cards = rest.length ? (await q("SELECT id::text,title,status,criterion_index FROM tasks WHERE plan_task_id=$1 AND status<>'returned'", [taskId])).rows as CardRow[] : [];
  const handbacks = cards.length ? (await q(`SELECT task_id::text,status,outcome,overruled_at,gap_closed_at FROM card_handbacks WHERE task_id=ANY($1::uuid[]) ORDER BY attempt DESC`,
    [cards.map((card) => card.id)])).rows as { task_id: string; status: string; outcome: "pass" | "fail" | null; overruled_at: Date | null; gap_closed_at: Date | null }[] : [];
  const passed = (card: CardRow) => {
    const latestDone = handbacks.find((row) => row.task_id === card.id && row.status === "done" && effectiveOutcome(row) !== null);
    return latestDone ? effectiveOutcome(latestDone) === "pass" : false;
  };
  const outputs = cards.length ? (await q(`SELECT id::text,task_id::text,title,kind,evidence_kind,url,text,created_at FROM local_outputs WHERE task_id=ANY($1::uuid[]) ORDER BY created_at DESC`,
    [cards.map((card) => card.id)])).rows as (OutputRow & { task_id: string; text: string | null })[] : [];
  const toModel: number[] = [];
  for (const index of rest) {
    const mine = cards.filter((card) => card.criterion_index === index);
    const done = mine.filter(passed);
    if (done.length) rated.push({ index, rating: "met", basis: "对这条的卡验收通过了", vague: false,
      links: outputs.filter((row) => done.some((card) => card.id === row.task_id)).flatMap((row) => {
        const url = outputUrl(row);
        return url ? [{ url, title: row.title }] : [];
      }) });
    else if (mine.length) rated.push({ index, rating: "partial", basis: "对这条的卡还没验收通过", vague: false, links: [] });
    else toModel.push(index);
  }
  if (toModel.length) {
    const events = await deps.events({ taskId, scopeId: item.mission.world_scope_id }).catch(() => []);
    const input: MonthReviewAgentInput = {
      period, missionTitle: item.mission.title, taskName: item.task.name,
      criteria: toModel.map((index) => ({ index, text: item.criteria[index - 1] })),
      deliverable: latest ? { number: latest.number, delivered: latest.delivered_at !== null, statement: latest.statement, review: latest.review?.criteria ?? null,
        items: latestItems.map((row) => ({ kind: row.kind, name: row.name, url: row.url, text: row.extracted_text?.slice(0, 2000) ?? null })) } : null,
      cards: cards.map((card) => ({ title: card.title, status: card.status, criterionIndex: card.criterion_index, accepted: passed(card) })),
      outputs: outputs.slice(0, 20).map((row) => ({ title: row.title, text: row.text?.slice(0, 1000) ?? null })),
      events: events.slice(0, 30),
    };
    if (!input.deliverable && !input.cards.length && !input.outputs.length && !input.events.length)
      for (const index of toModel) rated.push({ index, rating: "unmet", basis: "没有读到交付、卡或本体事件", vague: false, links: [] });
    else {
      const result = await deps.agent.rate(input, { taskId, personId: item.ownerId });
      for (const index of toModel) {
        const found = result.criteria.find((criterion) => criterion.index === index);
        if (!found) throw new Error(`评审员漏了第 ${index} 条`);
        rated.push({ index, rating: found.rating, basis: found.basis, vague: found.vague,
          links: found.deliverable && latest ? latestItems.map(itemLink) : [] });
      }
    }
  }
  await inTransaction(deps.pool, async (tx) => {
    for (const result of rated) {
      await tx("UPDATE month_review_criteria SET agent_rating=$4,agent_basis=$5,vague=$6 WHERE period=$1 AND task_id=$2 AND idx=$3",
        [period, taskId, result.index, result.rating, result.basis.slice(0, 300), result.vague]);
      await tx("DELETE FROM month_review_links WHERE period=$1 AND task_id=$2 AND idx=$3 AND source='agent'", [period, taskId, result.index]);
      for (const link of result.links) await tx(`INSERT INTO month_review_links(id,period,task_id,idx,url,title,source) VALUES($1,$2,$3,$4,$5,$6,'agent')`,
        [randomUUID(), period, taskId, result.index, link.url, link.title]);
    }
  });
}

/**
 * 后台任务：复盘窗口里每 30 分钟给 DRI 工作台的每个人排一次本轮的预评（同一轮只排一次）；预评按人跑。
 */
export function monthReviewJobs(deps: MonthReviewDeps & { agent: MonthReviewAgent; events: TaskEventReader; people: () => string[] }):
  { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  const q: Query = deps.pool.query.bind(deps.pool);
  return {
    handlers: {
      [MONTH_REVIEW_TICK_KIND]: async () => {
        const window = reviewWindow(deps.now());
        if (!window) return;
        for (const personId of deps.people()) await enqueuePrefill(q, personId, window.period, "window");
      },
      [MONTH_REVIEW_PREFILL_KIND]: async (payload) => {
        const { personId, period } = payload as { personId: string; period: string };
        await prefillReview(deps, personId, period);
      },
    },
    recurring: [{ kind: MONTH_REVIEW_TICK_KIND, everyMs: TICK_MS }],
  };
}
