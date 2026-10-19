import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  TMyOffPlanResponse, TOffPlanItem, TProgressArtifact, TProgressMissionRef, TProgressOnTrack, TProgressOverview, TProgressPerson,
  TProgressPersonSummary, TProgressRedLine, TProgressSlowReason, TProgressTask,
} from "@warmap/contracts";
import type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
import type { Query } from "./meetingStore.js";
import { milestoneDate } from "./monthPlan.js";
import { companyPeriod } from "./monthlyPlans.js";
import type { ReviewViewer } from "./monthlyReviews.js";
import { isRealPerson } from "./people.js";
import { addDays, BATTLEFIELD_MEMBERS, visibleOwners, weeklyReviewHref, weekStartOf } from "./weeklyReviews.js";

/**
 * 全局进展（② 进展）。可见范围在这一层判：CEO 看全部，其他人看自己和同一战场的人（与周复盘同一份战场名单）。
 *
 * Task 基线：挂在个人任务（Mission）下、有计划开始和截止日期、还没完成的执行事项。红线只在 Task 级判两种：
 * - 比预期慢：过了截止日还没完成；或已过开始日 3 个工作日，仍然没有核实过的进展（带链接的进展，或采集器整理后归到这件事的进展）。
 * - 按截止日做不完：同一项个人任务下，未完成的执行事项还需的计划工作日之和，超过今天到卡片截止日（最晚的里程碑日期，没有就是月底）的工作日。
 *   还需的工作日：没开始的按原计划（开始到截止）；进行中的按今天（或开始日，取晚的）到截止，至少 1 天。
 * 工作日是周一到周五，节假日不计入。没有 Task 基线的人，退回按人的进展摘要（已提交的周复盘、采集器整理结果）。
 * 计划外工作：采集器整理时归不上 Task 的进展（待挂靠、待改计划），本人挂上之前一直列着；提出改计划后照样列着，带上提出时间。
 */

const NO_PROGRESS_WORKDAYS = 3;
/** 摘要读最近几周的周复盘、最近几天的采集整理结果；计划外列最近 30 天的。 */
const WEEKLY_REVIEW_LOOKBACK_DAYS = 35;
const RECENT_DAYS = 14;
const OFF_PLAN_DAYS = 30;
const RECENT_PER_PERSON = 5;
const ARTIFACTS_PER_ROW = 6;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- 工作日 ----------

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const isWorkday = (ms: number) => { const weekday = new Date(ms).getUTCDay(); return weekday !== 0 && weekday !== 6; };
/** 上海时间的日期（YYYY-MM-DD）。 */
export const shanghaiDay = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

/** from 到 to（含首尾）之间的工作日数；to 早于 from 为 0。 */
export function workdaysBetween(from: string, to: string): number {
  let count = 0;
  for (let ms = dayMs(from), end = dayMs(to); ms <= end; ms += DAY_MS) if (isWorkday(ms)) count += 1;
  return count;
}

/** day 之后第 n 个工作日。 */
export function addWorkdays(day: string, n: number): string {
  let ms = dayMs(day);
  for (let left = n; left > 0;) { ms += DAY_MS; if (isWorkday(ms)) left -= 1; }
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------- 红线 ----------

export type PlanTask = { status: "not_started" | "in_progress"; startDate: string; dueDate: string; lastVerifiedAt: Date | null };

/** 比预期慢：过了截止日没完成（overdue），或开始日之后第 3 个工作日起还没有核实过的进展（no_progress）；都不是为 null。 */
export function slowReason(task: PlanTask, today: string): TProgressSlowReason | null {
  if (task.dueDate < today) return "overdue";
  if (!task.lastVerifiedAt && today >= addWorkdays(task.startDate, NO_PROGRESS_WORKDAYS)) return "no_progress";
  return null;
}

/** 一件未完成的执行事项还需的计划工作日。 */
export function remainingPlannedDays(task: PlanTask, today: string): number {
  if (task.status === "not_started") return workdaysBetween(task.startDate, task.dueDate);
  return Math.max(1, workdaysBetween(today > task.startDate ? today : task.startDate, task.dueDate));
}

/** 按截止日做不完：还需的工作日之和超过今天到截止日（含）的工作日时返回两个数，否则 null。 */
export function deadlineGap(tasks: PlanTask[], deadline: string, today: string): { neededDays: number; leftDays: number } | null {
  const neededDays = tasks.reduce((sum, task) => sum + remainingPlannedDays(task, today), 0);
  const leftDays = workdaysBetween(today, deadline);
  return neededDays > leftDays ? { neededDays, leftDays } : null;
}

/** 卡片上的截止日：里程碑里最晚的日期；一个日期都没有就是这个月的最后一天。 */
export function missionDeadline(milestones: string[], period: string): string {
  const dates = milestones.map((text) => milestoneDate(text, period)).filter((day): day is string => !!day).sort();
  return dates.at(-1) ?? new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
}

/** 信息截至：各采集来源 coverage_until 的最小值；本机没有的来源（not_found）和从没覆盖过的不算；一个都没有为 null。 */
export function coverageUntil(sources: { status: string; coverageUntil: Date | null }[]): Date | null {
  const values = sources.filter((source) => source.status !== "not_found" && source.coverageUntil).map((source) => source.coverageUntil!.getTime());
  return values.length ? new Date(Math.min(...values)) : null;
}

/** 周复盘正文里的出处标记 [名称](cite:…) 去掉，普通链接只留文字。 */
export const plainReviewText = (text: string) =>
  text.replace(/\[[^\]\n]+\]\(cite:[^()\s]+\)/g, "").replace(/\[([^\]\n]+)\]\([^()\s]+\)/g, "$1").replace(/[ \t]+$/gm, "").trim();

// ---------- 读 ----------

type TaskRow = {
  id: string; title: string; status: "not_started" | "in_progress"; owner_id: string; start_date: string; due_date: string;
  mission_id: string; mission_title: string; period: string; milestones: string[]; last_verified_at: Date | null;
};
type OffPlanRow = {
  id: string; person_id: string; placement: "pending_attach" | "pending_replan"; text: string; source: string; repo: string | null;
  started_at: Date; ended_at: Date; links: { url: string; title?: string }[]; task_id: string | null; task_title: string | null;
  resolution: "replan" | null; resolved_at: Date | null; spent_seconds: string | number;
};

const artifact = (link: { url: string; title?: string | null }): TProgressArtifact => ({ url: link.url, title: link.title || null });
function uniqueArtifacts(links: { url: string; title?: string | null }[], limit = ARTIFACTS_PER_ROW): TProgressArtifact[] {
  const seen = new Map<string, TProgressArtifact>();
  for (const link of links) if (link.url && !seen.has(link.url)) seen.set(link.url, artifact(link));
  return [...seen.values()].slice(0, limit);
}

/** 看得到谁：CEO 为 null（全部）；其他人是自己和同一战场的人。 */
async function visiblePeople(q: Query, viewer: ReviewViewer, now: Date): Promise<string[] | null> {
  const owners = await visibleOwners(q, viewer, weekStartOf(now));
  return owners ? [...owners] : null;
}

async function readOffPlanRows(q: Query, owners: string[] | null, now: Date): Promise<OffPlanRow[]> {
  return (await q(`SELECT cp.id::text AS id, cp.person_id, cp.placement, cp.text, cp.source, cp.repo, cp.started_at, cp.ended_at, cp.links,
      CASE WHEN cp.placement = 'pending_attach' THEN t.id::text END AS task_id, CASE WHEN cp.placement = 'pending_attach' THEN t.title END AS task_title,
      cp.resolution, cp.resolved_at,
      (SELECT COALESCE(sum(EXTRACT(EPOCH FROM (ci.ended_at - ci.started_at))), 0) FROM collector_items ci WHERE ci.id = ANY(cp.item_ids)) AS spent_seconds
    FROM collector_progress cp LEFT JOIN tasks t ON t.id = cp.task_id
    WHERE cp.placement <> 'task' AND cp.resolution IS DISTINCT FROM 'attached' AND cp.ended_at >= $2
      AND ($1::text[] IS NULL OR cp.person_id = ANY($1))
    ORDER BY cp.ended_at DESC, cp.id`, [owners, new Date(now.getTime() - OFF_PLAN_DAYS * DAY_MS)])).rows as OffPlanRow[];
}

function projectOffPlan(row: OffPlanRow, person: (id: string) => TProgressPerson): TOffPlanItem {
  return {
    id: row.id, person: person(row.person_id), kind: row.placement === "pending_attach" ? "attach" : "replan", text: row.text,
    candidateTask: row.task_id && row.task_title ? { taskId: row.task_id, title: row.task_title } : null,
    evidence: { source: row.source, repo: row.repo, startedAt: row.started_at.toISOString(), endedAt: row.ended_at.toISOString(), links: uniqueArtifacts(row.links ?? []) },
    spentMinutes: Math.round(Number(row.spent_seconds) / 60),
    replanProposedAt: row.resolution === "replan" ? row.resolved_at!.toISOString() : null,
  };
}

export async function readProgressOverview(q: Query, viewer: ReviewViewer, people: MemoryPerson[], now: Date): Promise<TProgressOverview> {
  const today = shanghaiDay(now), period = companyPeriod(now);
  const owners = await visiblePeople(q, viewer, now);
  const names = new Map(people.map((item) => [item.personId, item.displayName]));
  const person = (id: string): TProgressPerson => ({ personId: id, name: names.get(id) ?? id });

  // Task 基线：有计划日期、挂在个人任务下、没完成的执行事项。核实过的进展：带链接，或采集器整理后归到这件事。
  const tasks = (await q(`SELECT t.id::text AS id, t.title, t.status, t.owner_id, to_char(t.start_date,'YYYY-MM-DD') AS start_date,
      to_char(t.due_date,'YYYY-MM-DD') AS due_date, m.id AS mission_id, m.title AS mission_title, m.period, m.milestones,
      (SELECT max(tp.created_at) FROM task_progress tp WHERE tp.task_id = t.id
        AND (jsonb_array_length(tp.links) > 0 OR EXISTS (SELECT 1 FROM collector_progress cp WHERE cp.task_progress_id = tp.id))) AS last_verified_at
    FROM tasks t JOIN missions m ON m.id = t.mission_id
    WHERE t.status IN ('not_started', 'in_progress') AND t.start_date IS NOT NULL AND t.due_date IS NOT NULL
      AND ($1::text[] IS NULL OR t.owner_id = ANY($1))
    ORDER BY t.owner_id, m.id, t.step_order NULLS LAST, t.start_date, t.id`, [owners])).rows as TaskRow[];
  const taskIds = tasks.map((task) => task.id);

  const artifactRows = taskIds.length ? (await q(`SELECT task_id, url, title FROM (
      SELECT tp.task_id::text AS task_id, l->>'url' AS url, l->>'title' AS title, tp.created_at AS at
        FROM task_progress tp, jsonb_array_elements(tp.links) l WHERE tp.task_id = ANY($1::uuid[])
      UNION ALL
      SELECT om.object_id, om.url, om.file_name, om.created_at FROM object_materials om
        WHERE om.object_type = 'task' AND om.object_id = ANY($1::text[]) AND om.format = 'link' AND om.deleted_at IS NULL
    ) a ORDER BY at DESC`, [taskIds])).rows as { task_id: string; url: string; title: string | null }[] : [];
  const taskArtifacts = new Map<string, { url: string; title: string | null }[]>();
  for (const row of artifactRows) taskArtifacts.set(row.task_id, [...taskArtifacts.get(row.task_id) ?? [], row]);

  const health = (await q(`SELECT person_id, source_status, coverage_until FROM collector_health WHERE ($1::text[] IS NULL OR person_id = ANY($1))`, [owners]))
    .rows as { person_id: string; source_status: string; coverage_until: Date | null }[];
  const coverage = (id: string) => coverageUntil(health.filter((row) => row.person_id === id).map((row) => ({ status: row.source_status, coverageUntil: row.coverage_until })))?.toISOString() ?? null;

  const view = (task: TaskRow): TProgressTask => ({
    taskId: task.id, title: task.title, status: task.status, startDate: task.start_date, dueDate: task.due_date,
    plannedDays: workdaysBetween(task.start_date, task.due_date), usedDays: workdaysBetween(task.start_date, today),
  });
  const plan = (task: TaskRow): PlanTask => ({ status: task.status, startDate: task.start_date, dueDate: task.due_date, lastVerifiedAt: task.last_verified_at });
  const missionRef = (task: TaskRow): TProgressMissionRef => ({ missionId: task.mission_id, title: task.mission_title, deadline: missionDeadline(task.milestones, task.period) });

  const redLines: { line: TProgressRedLine; overrun: number; name: string }[] = [];
  const onTrack: TProgressOnTrack[] = [];
  const groups = new Map<string, TaskRow[]>();
  for (const task of tasks) groups.set(`${task.owner_id}\u0000${task.mission_id}`, [...groups.get(`${task.owner_id}\u0000${task.mission_id}`) ?? [], task]);
  for (const group of groups.values()) {
    const first = group[0], mission = missionRef(first), who = person(first.owner_id), covered = coverage(first.owner_id);
    const gap = deadlineGap(group.map(plan), mission.deadline, today);
    if (gap) redLines.push({ overrun: gap.neededDays - gap.leftDays, name: who.name, line: { kind: "deadline", person: who, mission, ...gap,
      tasks: group.map(view), artifacts: uniqueArtifacts(group.flatMap((task) => taskArtifacts.get(task.id) ?? [])), coverageUntil: covered } });
    for (const task of group) {
      const reason = slowReason(plan(task), today);
      const artifacts = uniqueArtifacts(taskArtifacts.get(task.id) ?? []);
      if (reason) redLines.push({ overrun: reason === "overdue" ? workdaysBetween(addDays(task.due_date, 1), today) : 0, name: who.name,
        line: { kind: "slow", reason, person: who, mission, task: view(task), artifacts, coverageUntil: covered } });
      else if (!gap) onTrack.push({ person: who, mission, task: view(task), artifacts, coverageUntil: covered });
    }
  }
  redLines.sort((a, b) => b.overrun - a.overrun || a.name.localeCompare(b.name, "zh-CN"));

  // 没有 Task 基线的人：战场名单上的人和最近有周复盘、采集整理结果的人。
  const baseline = new Set(tasks.map((task) => task.owner_id));
  const since = new Date(now.getTime() - RECENT_DAYS * DAY_MS);
  const reviews = (await q(`SELECT DISTINCT ON (person_id) id::text AS id, person_id, to_char(week_start,'YYYY-MM-DD') AS week_start, body
    FROM weekly_reviews WHERE status = 'submitted' AND week_start >= $2::date AND ($1::text[] IS NULL OR person_id = ANY($1))
    ORDER BY person_id, week_start DESC`, [owners, addDays(today, -WEEKLY_REVIEW_LOOKBACK_DAYS)]))
    .rows as { id: string; person_id: string; week_start: string; body: Record<string, { text: string }> | null }[];
  const recent = (await q(`SELECT person_id, text, ended_at, links, task_title FROM (
      SELECT cp.person_id, cp.text, cp.ended_at, cp.links, t.title AS task_title,
        row_number() OVER (PARTITION BY cp.person_id ORDER BY cp.ended_at DESC, cp.id) AS n
      FROM collector_progress cp LEFT JOIN tasks t ON t.id = cp.task_id AND (cp.placement = 'task' OR cp.resolution = 'attached')
      WHERE cp.ended_at >= $2 AND ($1::text[] IS NULL OR cp.person_id = ANY($1))) r
    WHERE n <= ${RECENT_PER_PERSON} ORDER BY ended_at DESC`, [owners, since]))
    .rows as { person_id: string; text: string; ended_at: Date; links: { url: string; title?: string }[]; task_title: string | null }[];
  const members = (await q(`SELECT DISTINCT person_id FROM (${BATTLEFIELD_MEMBERS}) members
    WHERE person_id IS NOT NULL AND ($1::text[] IS NULL OR person_id = ANY($1))`, [owners, period]))
    .rows as { person_id: string }[];
  const roles = new Map(people.map((item) => [item.personId, item]));
  const candidates = new Set([...members.map((row) => row.person_id), ...reviews.map((row) => row.person_id), ...recent.map((row) => row.person_id)]);
  const summaries: TProgressPersonSummary[] = [];
  for (const id of candidates) {
    const known = roles.get(id);
    if (!known || !isRealPerson(known) || baseline.has(id) || (owners && !owners.includes(id))) continue;
    const review = reviews.find((row) => row.person_id === id);
    const mine = recent.filter((row) => row.person_id === id);
    // CEO 没有周复盘和采集记录时不列（名单上的 CEO 多半是战场负责人，不是执行的人）。
    if (known.roles.includes("ceo") && !review && !mine.length) continue;
    const links = mine.flatMap((row) => row.links ?? []);
    summaries.push({
      person: person(id),
      weeklyReview: review ? { href: weeklyReviewHref(review.id, viewer.role === "ceo"), weekStart: review.week_start,
        weekEnd: addDays(review.week_start, 6), overall: plainReviewText(review.body?.overall?.text ?? ""), progress: plainReviewText(review.body?.progress?.text ?? "") } : null,
      recent: mine.map((row) => ({ text: row.text, endedAt: row.ended_at.toISOString(), taskTitle: row.task_title, links: uniqueArtifacts(row.links ?? []) })),
      artifacts: uniqueArtifacts(links), coverageUntil: coverage(id),
    });
  }
  // 有内容的在前，再按姓名。
  summaries.sort((a, b) => Number(!!b.weeklyReview || b.recent.length > 0) - Number(!!a.weeklyReview || a.recent.length > 0)
    || a.person.name.localeCompare(b.person.name, "zh-CN"));

  const offPlan = (await readOffPlanRows(q, owners, now)).map((row) => projectOffPlan(row, person));
  return { today, redLines: redLines.map((entry) => entry.line), onTrack, summaries, offPlan };
}

// ---------- 本人的计划外 ----------

export async function readMyOffPlan(q: Query, personId: string, names: Map<string, string>, now: Date): Promise<TMyOffPlanResponse> {
  const person = (id: string): TProgressPerson => ({ personId: id, name: names.get(id) ?? id });
  const items = (await readOffPlanRows(q, [personId], now)).map((row) => projectOffPlan(row, person));
  const tasks = (await q(`SELECT DISTINCT t.id::text AS "taskId", t.title, t.created_at FROM tasks t
      LEFT JOIN task_members tm ON tm.task_id = t.id AND tm.person_id = $1 AND tm.left_at IS NULL
    WHERE (t.owner_id = $1 OR tm.person_id IS NOT NULL) AND t.status IN ('not_started', 'in_progress')
    ORDER BY t.created_at DESC LIMIT 100`, [personId])).rows as { taskId: string; title: string }[];
  return { items, tasks: tasks.map(({ taskId, title }) => ({ taskId, title })) };
}

export type OffPlanError = { status: number; code: string; message: string };
const TASK_PROGRESS_SOURCES = new Set(["codex", "claude", "github", "web", "other"]);

/** 挂到本人的一件执行事项上：同一事务里写一条执行事项进展（时间取这段工作的结束时间），整理结果记成已挂上。 */
export async function attachOffPlan(pool: Pool, personId: string, id: string, taskId: string, now: Date): Promise<OffPlanError | null> {
  if (!UUID.test(id)) return { status: 404, code: "OFF_PLAN_NOT_FOUND", message: "计划外工作不存在" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query(`SELECT placement, resolution, text, source, links, ended_at FROM collector_progress WHERE id = $1 AND person_id = $2 FOR UPDATE`, [id, personId]))
      .rows[0] as { placement: string; resolution: string | null; text: string; source: string; links: unknown[]; ended_at: Date } | undefined;
    const fail = async (error: OffPlanError) => { await client.query("ROLLBACK"); return error; };
    if (!row) return await fail({ status: 404, code: "OFF_PLAN_NOT_FOUND", message: "计划外工作不存在" });
    if (row.placement === "task" || row.resolution === "attached") return await fail({ status: 409, code: "OFF_PLAN_RESOLVED", message: "这条已经挂到执行事项上了" });
    const task = (await client.query(`SELECT t.mission_id FROM tasks t LEFT JOIN task_members tm ON tm.task_id = t.id AND tm.person_id = $2 AND tm.left_at IS NULL
      WHERE t.id = $1 AND (t.owner_id = $2 OR tm.person_id IS NOT NULL) AND t.status IN ('not_started', 'in_progress')`, [taskId, personId])).rows[0] as { mission_id: string | null } | undefined;
    if (!task) return await fail({ status: 400, code: "TASK_NOT_ATTACHABLE", message: "只能挂到你在推进、还没完成的执行事项上" });
    const progressId = randomUUID();
    await client.query(`INSERT INTO task_progress (id, task_id, author_id, source, body, links, client_event_id, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [progressId, taskId, personId, TASK_PROGRESS_SOURCES.has(row.source) ? row.source : "other", row.text, JSON.stringify((row.links ?? []).slice(0, 5)), id, row.ended_at]);
    await client.query(`UPDATE collector_progress SET task_id = $2, mission_id = $3, task_progress_id = $4, resolution = 'attached', resolved_at = $5, resolved_by = $6 WHERE id = $1`,
      [id, taskId, task.mission_id, progressId, now, personId]);
    await client.query("COMMIT");
    return null;
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

/** 提出改计划：先只记下来。重复提出幂等；已挂上的 409。 */
export async function proposeOffPlanReplan(q: Query, personId: string, id: string, now: Date): Promise<OffPlanError | null> {
  if (!UUID.test(id)) return { status: 404, code: "OFF_PLAN_NOT_FOUND", message: "计划外工作不存在" };
  const updated = await q(`UPDATE collector_progress SET resolution = 'replan', resolved_at = $3, resolved_by = $2
    WHERE id = $1 AND person_id = $2 AND placement <> 'task' AND resolution IS NULL`, [id, personId, now]);
  if (updated.rowCount) return null;
  const row = (await q("SELECT placement, resolution FROM collector_progress WHERE id = $1 AND person_id = $2", [id, personId])).rows[0] as { placement: string; resolution: string | null } | undefined;
  if (!row) return { status: 404, code: "OFF_PLAN_NOT_FOUND", message: "计划外工作不存在" };
  return row.resolution === "replan" ? null : { status: 409, code: "OFF_PLAN_RESOLVED", message: "这条已经挂到执行事项上了" };
}
