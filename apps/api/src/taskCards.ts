import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TAcceptCardDraftsRequest, TCardBoardResponse, TCardBriefResponse, TCardDetailResponse, TCardHandbackBrief, TCardHandbackView, TCardModel, TCardPlanView, TCardTaskView,
  TCardWait, TCriterionVerdict, TDeliverableInclusion, TLocalHandbackCriterion, TPatchCardRequest, TPendingDeliverableItem, TTaskCard, TTaskView } from "@warmap/contracts";
import { findOwnTask, DeliverableError, type OwnTask } from "./taskDeliverables.js";
import { outputView, recentRuns, runBrief, runView, type OutputRow, type RunRow } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { UUID_PATTERN } from "./meetingStore.js";
import type { PlanTaskSource } from "./planTasks.js";
import type { TaskPageFacts } from "./pageGuides.js";
import { ownRole, roleBrief, roleRef, rolesById, type RoleRow } from "./roles.js";
import { createInTransaction, getTaskViews, taskStandards } from "./tasks.js";

/**
 * 执行看板（V2 设计第 3–5、8.3 节）：卡就是执行事项，card 是 api 算好的列、标记、最近一次执行和交回、进交付物到哪了。
 * 看板只给 Task 负责人（照交付物的规则）；卡的细节只给推进人。
 */

export class CardError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409 | 413, public readonly code: string, message: string, public readonly latestTask?: TTaskView) { super(message); }
}

/** 一次交回在库里的验收结论。 */
export type StoredAcceptance = { headline: string | null; criteria: { index: number; verdict: TCriterionVerdict; reason: string; evidence: string | null; fix: string | null }[];
  beyondScope: string[] };
export type HandbackRow = { id: string; task_id: string; run_id: string | null; owner_id: string; attempt: number; criteria: string[]; claims: TLocalHandbackCriterion[];
  summary: string | null; output_ids: string[]; status: TCardHandbackBrief["status"]; started_at: Date | null; finished_at: Date | null; error: string | null;
  result: StoredAcceptance | null; outcome: "pass" | "fail" | null; return_text: string | null; returned_at: Date | null; overruled_at: Date | null;
  overruled_by: string | null; overrule_reason: string | null; created_at: Date };
type CardRow = { id: string; status: TTaskView["status"]; executor: TTaskCard["executor"]; model: TCardModel | null; brief: string | null;
  criterion_index: number | null; criterion_text: string | null; plan_task_id: string | null; done_definition: string | null; mission_id: string | null;
  role_id: string | null };

/** 推翻过的验收按本人的判断算：通过的推翻算没过，没过的推翻算通过。 */
export const effectiveOutcome = (row: Pick<HandbackRow, "outcome" | "overruled_at">) =>
  row.outcome && row.overruled_at ? (row.outcome === "pass" ? "fail" : "pass") : row.outcome;

/** 连续几次没过（从最近一次往前数，排队或在验收的不算）。 */
export function failStreak(handbacks: HandbackRow[]): number {
  let streak = 0;
  for (const row of handbacks) {
    if (row.status !== "done" || effectiveOutcome(row) === null) continue;
    if (effectiveOutcome(row) !== "fail") break;
    streak++;
  }
  return streak;
}

export function handbackBrief(row: HandbackRow): TCardHandbackBrief {
  const criteria = row.result?.criteria ?? [];
  return { id: row.id, attempt: row.attempt, status: row.status, outcome: row.outcome, met: criteria.filter((item) => item.verdict === "met").length, total: criteria.length,
    headline: row.result?.headline ?? null, returnText: row.return_text, returnedAt: row.returned_at?.toISOString() ?? null, overruled: row.overruled_at !== null,
    createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null };
}

/** 列和标记（第 3 节）：handbacks、runs 都是新的在前。 */
function stageAndWait(row: CardRow, handbacks: HandbackRow[], runs: RunRow[]): Pick<TTaskCard, "stage" | "wait"> {
  if (row.status === "not_started") return { stage: "todo", wait: null };
  if (row.status === "done") return { stage: "done", wait: null };
  const latest = handbacks[0];
  if (latest && (latest.status === "queued" || latest.status === "running")) return { stage: "review", wait: null };
  const failedRuns = runs.length >= 2 && runs.slice(0, 2).every((run) => run.state === "failed");
  if (failStreak(handbacks) >= 2 || failedRuns) return { stage: "doing", wait: "blocked" };
  if (latest && effectiveOutcome(latest) === "fail" && !latest.returned_at) return { stage: "doing", wait: "review_failed" };
  const waits: Partial<Record<RunRow["state"], TCardWait>> = { waiting_permission: "approval", idle: "reply", exited: "paused" };
  return { stage: "doing", wait: runs[0] ? waits[runs[0].state] ?? null : null };
}

const CARD_COLUMNS = "id::text,status,executor,model,brief,criterion_index,criterion_text,plan_task_id,done_definition,mission_id,role_id::text";

/** 一批执行事项各自的 card。 */
async function cardsOf(q: Query, rows: CardRow[]): Promise<Map<string, TTaskCard>> {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return new Map();
  const handbacks = (await q("SELECT * FROM card_handbacks WHERE task_id=ANY($1::uuid[]) ORDER BY attempt DESC", [ids])).rows as HandbackRow[];
  // 每张卡最近两次执行：最近一次给摘要和标记，两次都异常退出算受阻。
  const runs = (await q(`SELECT * FROM (SELECT r.*,d.name AS device_name,row_number() OVER (PARTITION BY r.task_id ORDER BY r.started_at DESC,r.id) AS n
    FROM local_runs r LEFT JOIN local_devices d ON d.owner_id=r.owner_id AND d.id=r.device_id WHERE r.task_id=ANY($1::uuid[])) x
    WHERE n<=2 ORDER BY started_at DESC,id`, [ids])).rows as RunRow[];
  const inclusions = (await q(`SELECT h.task_id::text,v.number,p.version_id FROM deliverable_pending_items p JOIN card_handbacks h ON h.id=p.handback_id
    LEFT JOIN deliverable_versions v ON v.id=p.version_id WHERE h.task_id=ANY($1::uuid[]) ORDER BY p.added_at DESC`, [ids])).rows as { task_id: string; number: number | null; version_id: string | null }[];
  const next = await nextVersions(q, [...new Set(rows.flatMap((row) => row.plan_task_id ? [row.plan_task_id] : []))]);
  const roles = await rolesById(q, rows.map((row) => row.role_id));
  return new Map(rows.map((row) => {
    const own = handbacks.filter((item) => item.task_id === row.id), ownRuns = runs.filter((item) => item.task_id === row.id);
    const inclusion = inclusions.find((item) => item.task_id === row.id);
    const deliverable: TDeliverableInclusion | null = !inclusion ? null : inclusion.version_id ? { state: "included", versionNumber: inclusion.number! }
      : { state: "pending", versionNumber: next.get(row.plan_task_id ?? "") ?? 1 };
    const role = row.role_id ? roles.get(row.role_id) : undefined;
    return [row.id, { ...stageAndWait(row, own, ownRuns), role: role ? roleRef(role) : null, executor: row.executor, model: row.model,
      criterion: row.criterion_index && row.criterion_text ? { index: row.criterion_index, text: row.criterion_text } : null,
      run: ownRuns[0] ? runBrief(ownRuns[0]) : null, handback: own[0] ? handbackBrief(own[0]) : null, deliverable }];
  }));
}

/** 每个 Task 下一版交付物的号。 */
export async function nextVersions(q: Query, planTaskIds: string[]): Promise<Map<string, number>> {
  if (!planTaskIds.length) return new Map();
  const rows = (await q("SELECT task_id,max(number)::int AS number FROM deliverable_versions WHERE task_id=ANY($1::text[]) GROUP BY task_id", [planTaskIds])).rows as { task_id: string; number: number }[];
  return new Map(planTaskIds.map((id) => [id, (rows.find((row) => row.task_id === id)?.number ?? 0) + 1]));
}

/** 带上 card 的执行事项，按 ids 的顺序；不在了的跳过。 */
export async function cardTaskViews(q: Query, ids: string[], names: Map<string, string>): Promise<TCardTaskView[]> {
  const rows = (await q(`SELECT ${CARD_COLUMNS} FROM tasks WHERE id=ANY($1::uuid[])`, [ids])).rows as CardRow[];
  const cards = await cardsOf(q, rows);
  return (await getTaskViews(q, ids, names)).flatMap((task) => cards.has(task.id) ? [{ ...task, card: cards.get(task.id)! }] : []);
}

/** 看板只给 Task 负责人：本人 Mission 下的 Task，本体登记了别人做负责人时不给。 */
export async function boardTask(q: Query, planTasks: PlanTaskSource, personId: string, now: Date, taskId: string): Promise<OwnTask> {
  const own = await findOwnTask(q, planTasks, personId, now, taskId).catch((cause) => {
    if (cause instanceof DeliverableError) throw new CardError(cause.status, cause.code, cause.message);
    throw cause;
  });
  if (!own.canEdit) throw new CardError(403, "FORBIDDEN", "这个 Task 由负责人推进");
  return own;
}

/** 对话从 Task 页发出时带给 Chat 的这个 Task（pageGuides.ts 的 TaskPageFacts）：本人 Mission 下读不到为 null；看板各列几张卡只给负责人。 */
export async function taskPageFacts(q: Query, planTasks: PlanTaskSource, personId: string, now: Date, taskId: string): Promise<TaskPageFacts | null> {
  const own = await findOwnTask(q, planTasks, personId, now, taskId).catch((cause) => {
    if (cause instanceof DeliverableError) return null;
    throw cause;
  });
  if (!own) return null;
  if (!own.canEdit) return { name: own.task.name, criteria: own.criteria.length, cards: null };
  const rows = (await q(`SELECT ${CARD_COLUMNS} FROM tasks WHERE plan_task_id=$1 AND owner_id=$2 AND status<>'returned'`, [taskId, personId])).rows as CardRow[];
  const cards = { todo: 0, doing: 0, review: 0, done: 0 };
  for (const card of (await cardsOf(q, rows)).values()) cards[card.stage] += 1;
  return { name: own.task.name, criteria: own.criteria.length, cards };
}

type PlanRow = { id: string; status: TCardPlanView["status"]; hint: string | null; error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null };
export const planView = (row: PlanRow, expectedSeconds: number): TCardPlanView => ({ id: row.id, status: row.status, hint: row.hint, error: row.status === "failed" ? row.error : null,
  createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null, expectedSeconds });

/** 拆卡预计用时：最近 20 次拆完的中位数，30 秒到 10 分钟之间；还没有拆完过的按 1 分钟。 */
export async function planExpectedSeconds(q: Query): Promise<number> {
  const seconds = (await q(`SELECT extract(epoch FROM finished_at-started_at)::float AS s FROM card_plans WHERE status='done' AND started_at IS NOT NULL
    ORDER BY finished_at DESC LIMIT 20`)).rows.map((row) => Number(row.s)).sort((a, b) => a - b);
  if (!seconds.length) return 60;
  return Math.min(600, Math.max(30, Math.round(seconds[Math.floor(seconds.length / 2)])));
}

/** 准备中的东西（version_id 为空的）。 */
export async function pendingItems(q: Query, planTaskId: string): Promise<TPendingDeliverableItem[]> {
  const rows = (await q(`SELECT p.id,p.added_at,h.task_id::text AS card_id,t.title AS card_title,tv.id AS topic_version_id,tv.topic_id,tv.label,rt.title AS topic_title
    FROM deliverable_pending_items p LEFT JOIN card_handbacks h ON h.id=p.handback_id LEFT JOIN tasks t ON t.id=h.task_id
    LEFT JOIN topic_versions tv ON tv.id=p.topic_version_id LEFT JOIN research_topics rt ON rt.id=tv.topic_id
    WHERE p.plan_task_id=$1 AND p.version_id IS NULL ORDER BY p.added_at,p.id`, [planTaskId])).rows as { id: string; added_at: Date; card_id: string | null;
    card_title: string | null; topic_version_id: string | null; topic_id: string | null; label: string | null; topic_title: string | null }[];
  return rows.map((row) => ({ id: row.id, kind: row.card_id ? "card" : "topic", title: row.card_id ? row.card_title! : `${row.topic_title} · ${row.label}`,
    cardId: row.card_id, topicId: row.topic_id, topicVersionId: row.topic_version_id, addedAt: row.added_at.toISOString() }));
}

/** GET /api/plan-tasks/:taskId/cards */
export async function readBoard(q: Query, own: OwnTask, names: Map<string, string>): Promise<TCardBoardResponse> {
  const taskId = own.task.taskId, ownerId = own.viewerId;
  const ids = (await q("SELECT id::text FROM tasks WHERE plan_task_id=$1 AND owner_id=$2 AND status<>'returned' ORDER BY created_at,id", [taskId, ownerId])).rows.map((row) => row.id as string);
  const drafts = (await q(`SELECT d.* FROM card_drafts d JOIN card_plans p ON p.id=d.plan_id WHERE d.plan_task_id=$1 AND d.owner_id=$2 AND d.status='open'
    ORDER BY p.created_at,d.position`, [taskId, ownerId])).rows as DraftRow[];
  const plan = (await q("SELECT * FROM card_plans WHERE plan_task_id=$1 ORDER BY created_at DESC LIMIT 1", [taskId])).rows[0] as PlanRow | undefined;
  return {
    taskId, criteria: own.criteria.map((text, index) => ({ index: index + 1, text })), cards: await cardTaskViews(q, ids, names),
    drafts: drafts.map(draftView(await rolesById(q, drafts.map((draft) => draft.role_id)))), plan: plan ? planView(plan, await planExpectedSeconds(q)) : null, pending: await pendingItems(q, taskId),
    nextVersion: (await nextVersions(q, [taskId])).get(taskId)!,
  };
}

export type DraftRow = { id: string; plan_id: string; position: number; title: string; brief: string; done_definition: string; criterion_index: number | null;
  role_id: string | null; suggest_preset_key: string | null;
  executor: "claude_code" | "self"; model_tier: "strong" | "normal" | "light"; why: string | null };
const draftView = (roles: Map<string, RoleRow>) => (row: DraftRow) => {
  const role = row.role_id ? roles.get(row.role_id) : undefined;
  return { id: row.id, planId: row.plan_id, position: row.position, title: row.title, brief: row.brief, doneDefinition: row.done_definition,
    criterionIndex: row.criterion_index, role: role ? roleRef(role) : null, suggestPresetKey: row.suggest_preset_key, executor: row.executor, modelTier: row.model_tier, why: row.why };
};

/** 推进人自己的卡（锁住改用 forUpdate）；不是推进人的当找不到。 */
export async function ownCard(q: Query, ownerId: string, id: string, forUpdate = false): Promise<CardRow & { version: number; title: string }> {
  const row = UUID_PATTERN.test(id) ? (await q(`SELECT ${CARD_COLUMNS},version,title,owner_id FROM tasks WHERE id=$1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0] : undefined;
  if (!row || row.owner_id !== ownerId) throw new CardError(404, "NOT_FOUND", "找不到这张卡");
  return row as CardRow & { version: number; title: string };
}

export function handbackView(row: HandbackRow, names: Map<string, string>, expectedSeconds: number): TCardHandbackView {
  return { ...handbackBrief(row), runId: row.run_id, criteria: row.criteria, claims: row.claims, summary: row.summary, outputIds: row.output_ids,
    result: row.result ? { criteria: row.result.criteria.map((item) => ({ ...item, text: row.criteria[item.index - 1] ?? "" })), beyondScope: row.result.beyondScope } : null,
    error: row.status === "failed" ? row.error : null, startedAt: row.started_at?.toISOString() ?? null, expectedSeconds,
    overrule: row.overruled_at && row.overruled_by && row.overrule_reason
      ? { by: { personId: row.overruled_by, name: names.get(row.overruled_by) ?? row.overruled_by }, at: row.overruled_at.toISOString(), reason: row.overrule_reason } : null };
}

/** 验收预计用时：最近 20 次验收完的中位数，30 秒到 10 分钟之间；还没有验收过的按 90 秒。 */
export async function acceptanceExpectedSeconds(q: Query): Promise<number> {
  const seconds = (await q(`SELECT extract(epoch FROM finished_at-started_at)::float AS s FROM card_handbacks WHERE status='done' AND started_at IS NOT NULL
    ORDER BY finished_at DESC LIMIT 20`)).rows.map((row) => Number(row.s)).sort((a, b) => a - b);
  if (!seconds.length) return 90;
  return Math.min(600, Math.max(30, Math.round(seconds[Math.floor(seconds.length / 2)])));
}

/** GET /api/me/cards/:id */
export async function readCardDetail(q: Query, ownerId: string, id: string, names: Map<string, string>): Promise<TCardDetailResponse> {
  const card = await ownCard(q, ownerId, id);
  const [task] = await cardTaskViews(q, [id], names);
  const handbacks = (await q("SELECT * FROM card_handbacks WHERE task_id=$1 ORDER BY attempt DESC", [id])).rows as HandbackRow[];
  const outputs = (await q("SELECT * FROM local_outputs WHERE task_id=$1 ORDER BY created_at DESC,id", [id])).rows as OutputRow[];
  const expected = await acceptanceExpectedSeconds(q);
  return { task, brief: card.brief, standards: taskStandards(card.done_definition), runs: (await recentRuns(q, { taskId: id }, 5)).map(runView),
    handbacks: handbacks.map((row) => handbackView(row, names, expected)), outputs: outputs.map(outputView) };
}

/**
 * PATCH /api/me/cards/:id：执行方、岗位、模型、交代、对哪条标准。岗位要是本人没归档的；换了岗位，开工时的版本快照清掉。
 * 对哪条标准要这张卡挂着本人 Mission 下的 Task，存那一条当时的原文。
 * planTask 是读 Task 标准用的（只在改 criterionIndex 时调）。
 */
export async function patchCard(pool: Pool, ownerId: string, id: string, input: TPatchCardRequest, names: Map<string, string>,
  planTask: (planTaskId: string) => Promise<OwnTask | null>): Promise<TCardTaskView> {
  const { version, ...fields } = input;
  if (!Object.keys(fields).length) throw new CardError(400, "INVALID_INPUT", "至少改一样");
  let criterion: { index: number; text: string } | null | undefined;
  if (input.criterionIndex !== undefined && input.criterionIndex !== null) {
    const { plan_task_id: planTaskId } = await ownCard(pool.query.bind(pool), ownerId, id);
    const own = planTaskId ? await planTask(planTaskId) : null;
    if (!own) throw new CardError(400, "NO_PLAN_TASK", "这张卡没挂在你的 Task 上");
    const text = own.criteria[input.criterionIndex - 1];
    if (!text) throw new CardError(400, "CRITERION_OUT_OF_RANGE", `这个 Task 只有 ${own.criteria.length} 条标准`);
    criterion = { index: input.criterionIndex, text };
  } else if (input.criterionIndex === null) criterion = null;
  if (input.roleId) await ownRole(pool.query.bind(pool), ownerId, input.roleId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const card = await ownCard(client.query.bind(client), ownerId, id, true);
    if (card.version !== version) {
      await client.query("ROLLBACK");
      const [latest] = await getTaskViews(pool.query.bind(pool), [id], names);
      throw new CardError(409, "VERSION_CONFLICT", "执行事项已被修改，请基于最新内容重试", latest);
    }
    const roleId = fields.roleId === undefined ? card.role_id : fields.roleId;
    await client.query(`UPDATE tasks SET executor=$2,model=$3::jsonb,brief=$4,criterion_index=$5,criterion_text=$6,role_id=$7,
      role_version=CASE WHEN role_id IS DISTINCT FROM $7 THEN NULL ELSE role_version END,version=version+1,updated_at=now() WHERE id=$1`, [id,
      fields.executor ?? card.executor, JSON.stringify(fields.model === undefined ? card.model : fields.model), fields.brief === undefined ? card.brief : fields.brief?.trim() || null,
      criterion === undefined ? card.criterion_index : criterion?.index ?? null, criterion === undefined ? card.criterion_text : criterion?.text ?? null, roleId]);
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
  return (await cardTaskViews(pool.query.bind(pool), [id], names))[0];
}

/**
 * GET /api/me/cards/:id/brief：开工时交给本机的交代（第 8.3、19.4 节）。约定里的「用什么证明」「这次不包括」等 V1 的约定读取合进来以后补上，现在是空的。
 * 本体上下文先只放 Mission 和 Task。role 是卡的岗位此刻的内容（岗位改了，下一张卡的交代就变）；职责、做法由本机程序注入会话，
 * markdown 里只写岗位名和它的验收口径（干完会按它验）。
 */
export async function cardBrief(q: Query, ownerId: string, id: string, planTask: (planTaskId: string) => Promise<OwnTask | null>): Promise<TCardBriefResponse> {
  const card = await ownCard(q, ownerId, id);
  const mission = card.mission_id ? (await q("SELECT id,title FROM missions WHERE id=$1", [card.mission_id])).rows[0] as { id: string; title: string } | undefined : undefined;
  const own = card.plan_task_id ? await planTask(card.plan_task_id) : null;
  const standards = taskStandards(card.done_definition);
  const review = card.plan_task_id && card.criterion_index ? (await q(`SELECT review FROM deliverable_versions WHERE task_id=$1 AND review_status='done' AND review IS NOT NULL
    ORDER BY number DESC LIMIT 1`, [card.plan_task_id])).rows[0]?.review as StoredAcceptance | undefined : undefined;
  const gap = review?.criteria.find((item) => item.index === card.criterion_index && item.verdict !== "met")?.fix ?? null;
  const judged = (await q("SELECT * FROM card_handbacks WHERE task_id=$1 AND status='done' AND outcome IS NOT NULL ORDER BY attempt DESC LIMIT 1", [id])).rows[0] as HandbackRow | undefined;
  const lastReturn = judged && effectiveOutcome(judged) === "fail" ? judged.return_text : null;
  const criterion = card.criterion_index && card.criterion_text ? { index: card.criterion_index, text: card.criterion_text, proof: null } : null;
  const role = card.role_id ? (await rolesById(q, [card.role_id])).get(card.role_id) : undefined;
  const lines = [
    `# 执行事项：${card.title}`, "",
    ...(mission ? [`- Mission：${mission.title}`] : []),
    ...(own ? [`- Task：${own.task.name}`] : []),
    ...(criterion ? [`- 对的是 Task 的第 ${criterion.index} 条标准：${criterion.text}`] : []),
    ...(role ? [`- 岗位：${role.name}`] : []),
    "", "## 交代", "", card.brief ?? "（没写交代，按标题和完成标准做）",
    "", "## 完成标准（交回时逐条写证据）", "", ...(standards.length ? standards.map((text, index) => `${index + 1}. ${text}`) : ["（还没写完成标准）"]),
    ...(gap ? ["", "## Task 最新一版评审里这条还差", "", gap] : []),
    ...(lastReturn ? ["", "## 上一次验收没过", "", lastReturn] : []),
    ...(role?.acceptance_md.trim() ? ["", `## ${role.name}的验收口径`, "", role.acceptance_md.trim()] : []),
  ];
  return { markdown: lines.join("\n").slice(0, 20_000), role: role ? roleBrief(role) : null, mission: mission ? { missionId: mission.id, title: mission.title } : null,
    task: own ? { taskId: own.task.taskId, name: own.task.name } : null, criterion, exclusions: [], reviewGap: gap, lastReturn };
}

/** 拆卡（Task 负责人）：同一个 Task 已有一次在排队或在跑时返回那一次（created=false），不另起。 */
export async function createCardPlan(q: Query, own: OwnTask, hint: string | undefined): Promise<{ plan: TCardPlanView; created: boolean }> {
  const inserted = (await q(`INSERT INTO card_plans(id,plan_task_id,mission_id,owner_id,hint) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (plan_task_id) WHERE status IN ('queued','running') DO NOTHING RETURNING *`,
  [randomUUID(), own.task.taskId, own.task.missionId, own.viewerId, hint?.trim() || null])).rows[0] as PlanRow | undefined;
  const row = inserted ?? (await q("SELECT * FROM card_plans WHERE plan_task_id=$1 AND status IN ('queued','running')", [own.task.taskId])).rows[0] as PlanRow;
  return { plan: planView(row, await planExpectedSeconds(q)), created: Boolean(inserted) };
}

/**
 * 放进看板（Task 负责人）：草稿变成执行事项，推进人是本人，挂这个 Task 和它的 Mission，来源记「自己建」；草稿 id 当建事项的幂等键。
 * 可以顺手改标题、交代、完成标准、执行方。已经处理过的草稿 409。
 */
export async function acceptCardDrafts(pool: Pool, own: OwnTask, input: TAcceptCardDraftsRequest, names: Map<string, string>): Promise<TCardTaskView[]> {
  const ids: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const edit of input.drafts) {
      const draft = (await client.query("SELECT * FROM card_drafts WHERE id=$1 AND plan_task_id=$2 AND owner_id=$3 FOR UPDATE",
        [edit.id, own.task.taskId, own.viewerId])).rows[0] as (DraftRow & { status: string }) | undefined;
      if (!draft) throw new CardError(404, "NOT_FOUND", "找不到这张草稿");
      if (draft.status !== "open") throw new CardError(409, "DRAFT_DECIDED", "这张草稿已经处理过了");
      const created = await createInTransaction(client, own.viewerId, names, { clientId: draft.id, title: (edit.title ?? draft.title).trim(), missionId: own.task.missionId,
        doneDefinition: (edit.doneDefinition ?? draft.done_definition).trim(), planTaskId: own.task.taskId, source: "self" });
      if (!("task" in created)) throw "error" in created ? new CardError(created.error.status as 400, created.error.code, created.error.message)
        : new CardError(409, "DRAFT_DECIDED", "这张草稿已经处理过了");
      const index = draft.criterion_index && own.criteria[draft.criterion_index - 1] ? draft.criterion_index : null;
      if (edit.roleId) await ownRole(client.query.bind(client), own.viewerId, edit.roleId);
      await client.query("UPDATE tasks SET executor=$2,brief=$3,criterion_index=$4,criterion_text=$5,role_id=$6 WHERE id=$1",
        [created.task.id, edit.executor ?? draft.executor, (edit.brief ?? draft.brief).trim() || null, index, index ? own.criteria[index - 1] : null,
          edit.roleId === undefined ? draft.role_id : edit.roleId]);
      await client.query("UPDATE card_drafts SET status='accepted',task_id=$2,decided_at=now() WHERE id=$1", [draft.id, created.task.id]);
      ids.push(created.task.id);
    }
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
  return cardTaskViews(pool.query.bind(pool), ids, names);
}

/** 不要这张草稿：只有这个 Task 的负责人（就是草稿的主人）。 */
export async function dismissCardDraft(q: Query, personId: string, id: string, ownTask: (planTaskId: string) => Promise<OwnTask>): Promise<void> {
  const draft = UUID_PATTERN.test(id) ? (await q("SELECT plan_task_id,status FROM card_drafts WHERE id=$1 AND owner_id=$2", [id, personId])).rows[0] as
    { plan_task_id: string; status: string } | undefined : undefined;
  if (!draft) throw new CardError(404, "NOT_FOUND", "找不到这张草稿");
  await ownTask(draft.plan_task_id);
  if (draft.status !== "open") throw new CardError(409, "DRAFT_DECIDED", "这张草稿已经处理过了");
  await q("UPDATE card_drafts SET status='dismissed',decided_at=now() WHERE id=$1 AND status='open'", [id]);
}
