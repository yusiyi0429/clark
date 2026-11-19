import type { TMonthPageResponse, TMonthTask } from "@warmap/contracts";
import { effectiveOutcome, failStreak, type HandbackRow } from "./cardProjection.js";
import { latestRuns } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { defaultDisposition } from "./monthReview.js";
import { missionGate } from "./monthPlan.js";
import { LOCATE_BUDGET_MS, taskBasis } from "./planTaskAccess.js";
import { readPlanTasks, type PlanTask, type PlanTaskMission, type PlanTaskSource } from "./planTasks.js";
import { continuedFrom, settlementsOf } from "./taskContinuity.js";
import { deliverableStatuses } from "./taskDeliverables.js";
import { taskDueDates } from "./taskDueDates.js";
import type { EditedPlanTask } from "./taskGoalEdits.js";
import { ACTIVE } from "./workers.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 月份页（契约 taskContinuity.ts 的 MonthPageResponse，设计 10.4、10.5）：这个月本人的 Task 和每件的状态摘要。复盘在 monthReview.ts。
 * 下个月 Co-Agent 的草稿（draft）等溪南的接口，现在一律为 null。
 */

type MissionRow = { id: string; code: string; title: string; outcome: string | null; milestones: string[]; period: string;
  world_scope_id: string | null; world_object_id: string | null; world_domain_id: string | null };
type MonthTasks = { tasks: PlanTask[]; missions: Map<string, MissionRow> };

/**
 * 这个月本人的 Task：本人这个月的 Mission（不是占位的）下本人负责的（本体没登记负责人的算本人的），和左栏本月那一组同一个口径。
 * 按 Mission 编号、再按 Task 名排。本体读不到（超时、出错）时为空。
 */
async function monthTasks(q: Query, planTasks: PlanTaskSource, personId: string, period: string): Promise<MonthTasks> {
  const rows = (await q(`SELECT id,code,title,outcome,milestones,period,world_scope_id,world_object_id,world_domain_id FROM missions
    WHERE owner_id=$1 AND period=$2 AND NOT placeholder ORDER BY code,id`, [personId, period])).rows as MissionRow[];
  if (!rows.length) return { tasks: [], missions: new Map() };
  const missions: PlanTaskMission[] = rows.map((m) => ({ id: m.id, code: m.code,
    world: m.world_scope_id && m.world_object_id && m.world_domain_id ? { scopeId: m.world_scope_id, objectId: m.world_object_id, domainId: m.world_domain_id } : null }));
  const order = new Map(rows.map((row, index) => [row.id, index]));
  const tasks = (await readPlanTasks(planTasks, missions, LOCATE_BUDGET_MS)).filter((task) => !task.responsibleId || task.responsibleId === personId)
    .sort((a, b) => order.get(a.missionId)! - order.get(b.missionId)! || a.name.localeCompare(b.name, "zh") || a.taskId.localeCompare(b.taskId));
  return { tasks, missions: new Map(rows.map((row) => [row.id, row])) };
}

type CardTally = { met: Map<string, Set<number>>; metTexts: Map<string, Set<string>>; blocked: Map<string, number> };
/**
 * 本人在这几件 Task 下的卡：约定的哪几条达到了（对这条的卡里有一张最近一次有结论的验收算通过，含本人「仍然通过」，同 Task 管线的验收行）；
 * 受阻的几张（没完成、连续两次验收没过，同首页）。达到的那几条按序号记，也按卡上记的标准原文记（本人改过标准的 Task 按原文对）。
 */
async function tallyCards(q: Query, personId: string, taskIds: string[]): Promise<CardTally> {
  const cards = (await q(`SELECT id::text,plan_task_id,status,criterion_index,criterion_text FROM tasks WHERE plan_task_id=ANY($1::text[]) AND owner_id=$2 AND status<>'returned'`,
    [taskIds, personId])).rows as { id: string; plan_task_id: string; status: string; criterion_index: number | null; criterion_text: string | null }[];
  const handbacks = cards.length ? (await q(`SELECT task_id::text,status,outcome,overruled_at,gap_closed_at FROM card_handbacks WHERE task_id=ANY($1::uuid[]) ORDER BY attempt DESC`,
    [cards.map((card) => card.id)])).rows as Pick<HandbackRow, "task_id" | "status" | "outcome" | "overruled_at" | "gap_closed_at">[] : [];
  const tally: CardTally = { met: new Map(), metTexts: new Map(), blocked: new Map() };
  for (const card of cards) {
    const mine = handbacks.filter((row) => row.task_id === card.id);
    const latest = mine.find((row) => row.status === "done" && effectiveOutcome(row) !== null);
    if (card.criterion_index && latest && effectiveOutcome(latest) === "pass") {
      tally.met.set(card.plan_task_id, (tally.met.get(card.plan_task_id) ?? new Set()).add(card.criterion_index));
      if (card.criterion_text) tally.metTexts.set(card.plan_task_id, (tally.metTexts.get(card.plan_task_id) ?? new Set()).add(card.criterion_text));
    }
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

/** GET /api/me/months/:period。 */
export async function readMonthPage(q: Query, planTasks: PlanTaskSource, personId: string, period: string, now: Date): Promise<TMonthPageResponse> {
  const { tasks, missions } = await monthTasks(q, planTasks, personId, period);
  const ids = tasks.map((task) => task.taskId);
  const [settlements, sources, deliverables, cards, running, stored, chosen] = await Promise.all([settlementsOf(q, ids), continuedFrom(q, ids),
    deliverableStatuses(q, ids), tallyCards(q, personId, ids), runningSubSessions(q, personId, ids), taskDueDates(q, ids), dispositions(q, period, ids)]);
  const today = shanghaiDate(now);
  const rows: TMonthTask[] = tasks.map((task) => {
    const met = cards.met.get(task.taskId) ?? new Set<number>();
    const metTexts = cards.metTexts.get(task.taskId) ?? new Set<string>();
    const { edit, added } = task as EditedPlanTask;
    const criteria = taskBasis(task).criteria;
    const settlement = settlements.get(task.taskId) ?? null;
    const mission = missions.get(task.missionId);
    const missionDueDate = mission ? missionGate(mission.milestones, mission.period, today) : null;
    return { taskId: task.taskId, missionId: task.missionId, missionTitle: mission?.title ?? "", missionOutcome: mission?.outcome?.trim() || null, name: task.name,
      criteria: criteria.map((text, index) => {
        if (!edit?.criteria) return { text, met: met.has(index + 1), changed: false, original: null };
        const replaced = edit.worldCriteria[index];
        return { text, met: metTexts.has(text), changed: !edit.worldCriteria.includes(text),
          original: !edit.worldCriteria.includes(text) && replaced !== undefined && !criteria.includes(replaced) ? replaced : null };
      }),
      edited: edit ? { name: edit.name ? edit.worldName : null, criteria: edit.criteria ? edit.worldCriteria : null } : null,
      added: added === true,
      dueDate: stored.get(task.taskId) ?? missionDueDate, missionDueDate,
      ...chosen.get(task.taskId) ?? defaultDisposition(settlement ?? undefined, period),
      version: deliverables.get(task.taskId)?.version ?? null, running: running.get(task.taskId) ?? 0, blocked: cards.blocked.get(task.taskId) ?? 0,
      done: settlement?.kind === "completed", settlement, continuedFrom: sources.get(task.taskId) ?? null };
  });
  return { period, tasks: rows, draft: null };
}

