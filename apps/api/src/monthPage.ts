import type { TMonthPageResponse, TMonthTask } from "@warmap/contracts";
import { effectiveOutcome, failStreak, type HandbackRow } from "./cardProjection.js";
import { latestRuns } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { defaultDisposition } from "./monthReview.js";
import { LOCATE_BUDGET_MS, taskBasis } from "./planTaskAccess.js";
import { readPlanTasks, type PlanTask, type PlanTaskMission, type PlanTaskSource } from "./planTasks.js";
import { continuedFrom, settlementsOf } from "./taskContinuity.js";
import { deliverableStatuses } from "./taskDeliverables.js";
import { dueDatesOf } from "./taskDueDates.js";
import type { EditedPlanTask, TaskGoalEdit } from "./taskGoalEdits.js";
import { ACTIVE } from "./workers.js";

/**
 * 月份页（契约 taskContinuity.ts 的 MonthPageResponse，设计 10.4、10.5）：这个月本人的 Task 和每件的状态摘要。复盘在 monthReview.ts。
 * 下个月 Co-Agent 的草稿（draft）等溪南的接口，现在一律为 null。
 */

type MissionRow = { id: string; code: string; title: string; outcome: string | null;
  world_scope_id: string | null; world_object_id: string | null; world_domain_id: string | null };
type MonthTasks = { tasks: PlanTask[]; missions: Map<string, MissionRow> };

/**
 * 这个月本人的 Task：本人这个月的 Mission（不是占位的）下本人负责的（本体没登记负责人的算本人的），和左栏本月那一组同一个口径。
 * 按 Mission 编号、再按 Task 名排。本体读不到（超时、出错）时为空。
 */
async function monthTasks(q: Query, planTasks: PlanTaskSource, personId: string, period: string): Promise<MonthTasks> {
  const rows = (await q(`SELECT id,code,title,outcome,world_scope_id,world_object_id,world_domain_id FROM missions
    WHERE owner_id=$1 AND period=$2 AND NOT placeholder ORDER BY code,id`, [personId, period])).rows as MissionRow[];
  if (!rows.length) return { tasks: [], missions: new Map() };
  const missions: PlanTaskMission[] = rows.map((m) => ({ id: m.id, code: m.code,
    world: m.world_scope_id && m.world_object_id && m.world_domain_id ? { scopeId: m.world_scope_id, objectId: m.world_object_id, domainId: m.world_domain_id } : null }));
  const order = new Map(rows.map((row, index) => [row.id, index]));
  const tasks = (await readPlanTasks(planTasks, missions, LOCATE_BUDGET_MS)).filter((task) => !task.responsibleId || task.responsibleId === personId)
    .sort((a, b) => order.get(a.missionId)! - order.get(b.missionId)! || a.name.localeCompare(b.name, "zh") || a.taskId.localeCompare(b.taskId));
  return { tasks, missions: new Map(rows.map((row) => [row.id, row])) };
}

type CardTally = { met: Map<string, Set<number>>; blocked: Map<string, number> };
/**
 * 本人在这几件 Task 下的卡：约定的哪几条达到了（对这条的卡里有一张最近一次有结论的验收算通过，含本人「仍然通过」，同 Task 管线的验收行）；
 * 受阻的几张（没完成、连续两次验收没过，同首页）。达到的那几条按卡对的序号记（本人改了标准时序号已按原文重排，taskGoalEdits.ts），同项目、首页。
 */
async function tallyCards(q: Query, personId: string, taskIds: string[]): Promise<CardTally> {
  const cards = (await q(`SELECT id::text,plan_task_id,status,criterion_index FROM tasks WHERE plan_task_id=ANY($1::text[]) AND owner_id=$2 AND status<>'returned'`,
    [taskIds, personId])).rows as { id: string; plan_task_id: string; status: string; criterion_index: number | null }[];
  const handbacks = cards.length ? (await q(`SELECT task_id::text,status,outcome,overruled_at,gap_closed_at FROM card_handbacks WHERE task_id=ANY($1::uuid[]) ORDER BY attempt DESC`,
    [cards.map((card) => card.id)])).rows as Pick<HandbackRow, "task_id" | "status" | "outcome" | "overruled_at" | "gap_closed_at">[] : [];
  const tally: CardTally = { met: new Map(), blocked: new Map() };
  for (const card of cards) {
    const mine = handbacks.filter((row) => row.task_id === card.id);
    const latest = mine.find((row) => row.status === "done" && effectiveOutcome(row) !== null);
    if (card.criterion_index && latest && effectiveOutcome(latest) === "pass")
      tally.met.set(card.plan_task_id, (tally.met.get(card.plan_task_id) ?? new Set()).add(card.criterion_index));
    if (card.status !== "done" && failStreak(mine) >= 2) tally.blocked.set(card.plan_task_id, (tally.blocked.get(card.plan_task_id) ?? 0) + 1);
  }
  return tally;
}

/** 还在跑的子会话：本人这件 Task 下没做完的卡和还开着的专题，本机会话还开着的（worker 列表同一套 ACTIVE）。 */
async function runningSubSessions(q: Query, personId: string, taskIds: string[]): Promise<Map<string, number>> {
  const [cards, topics] = await Promise.all([
    q(`SELECT id::text,plan_task_id FROM tasks WHERE plan_task_id=ANY($1::text[]) AND owner_id=$2 AND status NOT IN ('done','returned')
      AND (executor='claude_code' OR role_id IS NOT NULL)`, [taskIds, personId]),
    q("SELECT id::text,plan_task_id FROM research_topics WHERE plan_task_id=ANY($1::text[]) AND owner_id=$2 AND status='active'", [taskIds, personId]),
  ]);
  const cardRows = cards.rows as { id: string; plan_task_id: string }[], topicRows = topics.rows as { id: string; plan_task_id: string }[];
  const [cardRuns, topicRuns] = await Promise.all([latestRuns(q, "task_id", cardRows.map((row) => row.id), "card"),
    latestRuns(q, "topic_id", topicRows.map((row) => row.id), "topic")]);
  const count = new Map<string, number>();
  const add = (rows: { id: string; plan_task_id: string }[], runs: Map<string, { state: string }>) => {
    for (const row of rows) if (ACTIVE.has(runs.get(row.id)?.state ?? "")) count.set(row.plan_task_id, (count.get(row.plan_task_id) ?? 0) + 1);
  };
  add(cardRows, cardRuns);
  add(topicRows, topicRuns);
  return count;
}

/** 复盘的去向表里定过的（月中也能定）；没定过的按了结推，同复盘页。 */
async function dispositions(q: Query, period: string, taskIds: string[]): Promise<Map<string, { disposition: TMonthTask["disposition"]; deferredTo: string | null }>> {
  const rows = (await q("SELECT task_id,disposition,deferred_to FROM month_review_tasks WHERE period=$1 AND task_id=ANY($2::text[])", [period, taskIds])).rows as
    { task_id: string; disposition: TMonthTask["disposition"]; deferred_to: string | null }[];
  return new Map(rows.map((row) => [row.task_id, { disposition: row.disposition, deferredTo: row.deferred_to }]));
}

/**
 * 改过的标准：改的那条「原」是它从本体哪条来的那条原文（按来处对，不按序号；新加的没有「原」，原文还在的也不写）；
 * 删掉的本体标准（没有哪条从它来、原文也不在了）留在原位置，removed，不算达到、不算条数。达到按改后的序号。
 */
function editedCriteria(criteria: string[], edit: TaskGoalEdit, met: Set<number>): TMonthTask["criteria"] {
  const world = edit.worldCriteria;
  const gone = world.flatMap((text, index) => (criteria.includes(text) || edit.criteriaFrom.includes(index) ? [] : [index]));
  const rows: TMonthTask["criteria"] = [];
  const flush = (before: number) => { while (gone.length && gone[0]! < before) rows.push({ text: world[gone.shift()!]!, met: false, changed: false, original: null, removed: true }); };
  criteria.forEach((text, index) => {
    const from = edit.criteriaFrom[index] ?? null;
    if (from !== null) flush(from);
    const changed = !world.includes(text);
    const source = from === null ? undefined : world[from];
    rows.push({ text, met: met.has(index + 1), changed, original: changed && source !== undefined && !criteria.includes(source) ? source : null, removed: false });
  });
  flush(Infinity);
  return rows;
}

/** GET /api/me/months/:period。 */
export async function readMonthPage(q: Query, planTasks: PlanTaskSource, personId: string, period: string, now: Date): Promise<TMonthPageResponse> {
  const { tasks, missions } = await monthTasks(q, planTasks, personId, period);
  const ids = tasks.map((task) => task.taskId);
  const [settlements, sources, deliverables, cards, running, dues, chosen] = await Promise.all([settlementsOf(q, ids), continuedFrom(q, ids),
    deliverableStatuses(q, ids), tallyCards(q, personId, ids), runningSubSessions(q, personId, ids), dueDatesOf(q, tasks, now), dispositions(q, period, ids)]);
  const rows: TMonthTask[] = tasks.map((task) => {
    const met = cards.met.get(task.taskId) ?? new Set<number>();
    const { edit, added } = task as EditedPlanTask;
    const criteria = taskBasis(task).criteria;
    const settlement = settlements.get(task.taskId) ?? null;
    const mission = missions.get(task.missionId);
    const due = dues.get(task.taskId);
    return { taskId: task.taskId, missionId: task.missionId, missionTitle: mission?.title ?? "", missionOutcome: mission?.outcome?.trim() || null, name: task.name,
      criteria: edit?.criteria ? editedCriteria(criteria, edit, met)
        : criteria.map((text, index) => ({ text, met: met.has(index + 1), changed: false, original: null, removed: false })),
      edited: edit ? { name: edit.name ? edit.worldName : null, criteria: edit.criteria ? edit.worldCriteria : null } : null,
      added: added === true,
      dueDate: due?.dueDate ?? null, missionDueDate: due?.planned ?? null,
      ...chosen.get(task.taskId) ?? defaultDisposition(settlement ?? undefined, period),
      version: deliverables.get(task.taskId)?.version ?? null, running: running.get(task.taskId) ?? 0, blocked: cards.blocked.get(task.taskId) ?? 0,
      done: settlement?.kind === "completed", settlement, continuedFrom: sources.get(task.taskId) ?? null };
  });
  return { period, tasks: rows, draft: null };
}

