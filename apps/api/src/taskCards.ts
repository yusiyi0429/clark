import { letterOfSub } from "./subSessionLetters.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TProjectBoardResponse } from "@warmap/contracts";
import type { TAcceptCardDraftsRequest, TCardBoardResponse, TCardBriefResponse, TCardDetailResponse, TCardHandbackView, TCardPlanView, TCardTaskView, TPatchCardRequest,
  TPendingDeliverableItem, TTaskAgreementResponse, TTaskView } from "@warmap/contracts";
import { DeliverableError, type OwnTask } from "./taskDeliverables.js";
import { planTaskViewer, type PlanTaskAccess } from "./planTaskAccess.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { personDisplayNames } from "./people.js";
import { openPlanTask } from "./taskAgreements.js";
import { CARD_COLUMNS, HANDBACKS_WITH_RELAY, cardGit, cardsOf, effectiveOutcome, handbackBrief, nextVersions, type CardRow, type HandbackRow, type StoredAcceptance } from "./cardProjection.js";
import { outputView, recentRuns, runViews, type OutputRow } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { UUID_PATTERN } from "./meetingStore.js";
import type { PlanTaskSource } from "./planTasks.js";
import type { TaskPageFacts } from "./pageGuides.js";
import { ensurePresetRole, ownRole, roleBrief, roleRef, rolesById, type RoleRow } from "./roles.js";
import { requestStarts } from "./sessionStarts.js";
import type { PlanTarget } from "./cardPlanner.js";
import { wordsLines } from "./sourceWords.js";

/** 没配岗位的卡兜底用的预设（roles/presets/general/executor.md）。 */
const DEFAULT_WORKER_PRESET = "executor";
import { createInTransaction, getTaskViews, taskStandards } from "./tasks.js";
import { agreementRow, agreementView, writeAgreement } from "./cardAgreements.js";

/**
 * 执行看板（V2 设计第 3–5、8.3 节）：卡就是执行事项，card 是 api 算好的列、标记、最近一次执行和交回、进交付物到哪了。
 * 看板只给 Task 负责人（照交付物的规则）；卡的细节只给推进人。
 */

export class CardError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409 | 413 | 503, public readonly code: string, message: string, public readonly latestTask?: TTaskView) { super(message); }
}

/** 卡挂的 Task：V1 的 openPlanTask 找到的（谁能看照它判：负责人、Mission 负责人、战场负责人、CEO、约定里的认可人）和此刻的约定。 */
export type CardPlanTask = PlanTaskAccess & { agreement: TTaskAgreementResponse };
/** 按人打开一个 Task；看不到、找不到抛 DeliverableError（404）。 */
export type OpenPlanTask = (personId: string, planTaskId: string) => Promise<CardPlanTask>;

export function planTaskOpener(q: Query, planTasks: PlanTaskSource, directory: PeopleDirectory, now: () => Date): OpenPlanTask {
  return async (personId, planTaskId) => {
    const { access, agreement } = await openPlanTask(q, planTasks, planTaskViewer(directory, personId), now(), planTaskId, personDisplayNames(directory));
    return { ...access, agreement };
  };
}

export { effectiveOutcome, failStreak, handbackBrief, nextVersions, type HandbackRow, type StoredAcceptance } from "./cardProjection.js";

/** 带上 card 的执行事项（TaskView 自己带 card），按 ids 的顺序；不在了的跳过。 */
export const cardTaskViews = (q: Query, ids: string[], names: Map<string, string>): Promise<TCardTaskView[]> => getTaskViews(q, ids, names);

/** 看板只给 Task 负责人（本体没登记负责人时是 Mission 负责人）；能看但不是负责人的 403，看不到的 404。 */
export async function boardTask(open: OpenPlanTask, personId: string, taskId: string): Promise<CardPlanTask> {
  const own = await open(personId, taskId).catch((cause) => {
    if (cause instanceof DeliverableError) throw new CardError(cause.status, cause.code, cause.message);
    throw cause;
  });
  if (!own.canEdit) throw new CardError(403, "FORBIDDEN", "这个 Task 由负责人推进");
  return own;
}

/**
 * 卡对的那条 Task 标准的约定（V1）：用什么证明（卡对了第几条才有）、这次不包括什么。两样都没有为 null。
 * 开工交代和验收的输入都用它。
 */
export function cardAgreement(agreement: TTaskAgreementResponse | null, criterionIndex: number | null): { proof: string | null; exclusions: string[] } | null {
  if (!agreement) return null;
  const proof = criterionIndex ? agreement.criteria.find((item) => item.index === criterionIndex)?.proof ?? null : null;
  return proof || agreement.exclusions.length ? { proof, exclusions: agreement.exclusions } : null;
}

/** 卡挂的 Task，看不到、找不到为 null（其余错误照抛）。 */
export const planTaskOrNull = (open: OpenPlanTask, personId: string) => (planTaskId: string): Promise<CardPlanTask | null> =>
  open(personId, planTaskId).catch((cause) => {
    if (cause instanceof DeliverableError) return null;
    throw cause;
  });

/** 对话从 Task 页发出时带给 Chat 的这个 Task（pageGuides.ts 的 TaskPageFacts）：看不到为 null；看板各列几张卡只给负责人。 */
export async function taskPageFacts(q: Query, open: OpenPlanTask, personId: string, taskId: string): Promise<TaskPageFacts | null> {
  const own = await planTaskOrNull(open, personId)(taskId);
  if (!own) return null;
  if (!own.canEdit) return { name: own.task.name, criteria: own.criteria.length, cards: null };
  const rows = (await q(`SELECT ${CARD_COLUMNS} FROM tasks WHERE plan_task_id=$1 AND owner_id=$2 AND status<>'returned'`, [taskId, personId])).rows as CardRow[];
  const cards = { todo: 0, doing: 0, review: 0, done: 0 };
  for (const card of (await cardsOf(q, rows)).values()) cards[card.stage] += 1;
  return { name: own.task.name, criteria: own.criteria.length, cards };
}

type PlanRow = { id: string; status: TCardPlanView["status"]; hint: string | null; error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
  source: "cloud" | "local"; summary: string | null; steps: TCardPlanView["steps"]; risks: string[]; revision: number | null ; after_sequence: number | null; started_after_sequence: number | null };
export const planView = (row: PlanRow, expectedSeconds: number): TCardPlanView => ({ id: row.id, status: row.status, hint: row.hint, error: row.status === "failed" ? row.error : null,
  createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null, expectedSeconds,
  source: row.source, summary: row.summary, steps: row.steps, risks: row.risks, revision: row.revision , afterSequence: row.after_sequence, startedAfterSequence: row.started_after_sequence });

/** 拆卡预计用时：最近 20 次拆完的中位数，30 秒到 10 分钟之间；还没有拆完过的按 1 分钟。 */
export async function planExpectedSeconds(q: Query): Promise<number> {
  const seconds = (await q(`SELECT extract(epoch FROM finished_at-started_at)::float AS s FROM card_plans WHERE status='done' AND started_at IS NOT NULL
    ORDER BY finished_at DESC LIMIT 20`)).rows.map((row) => Number(row.s)).sort((a, b) => a - b);
  if (!seconds.length) return 60;
  return Math.min(600, Math.max(30, Math.round(seconds[Math.floor(seconds.length / 2)])));
}

/** 准备中的东西（version_id 为空的）。 */
export async function pendingItems(q: Query, planTaskId: string): Promise<TPendingDeliverableItem[]> {
  const rows = (await q(`SELECT p.id,p.added_at,h.task_id::text AS card_id,t.title AS card_title,h.git,h.verified_commit,tv.id AS topic_version_id,tv.topic_id,tv.label,rt.title AS topic_title
    FROM deliverable_pending_items p LEFT JOIN card_handbacks h ON h.id=p.handback_id LEFT JOIN tasks t ON t.id=h.task_id
    LEFT JOIN topic_versions tv ON tv.id=p.topic_version_id LEFT JOIN research_topics rt ON rt.id=tv.topic_id
    WHERE p.plan_task_id=$1 AND p.version_id IS NULL ORDER BY p.added_at,p.id`, [planTaskId])).rows as { id: string; added_at: Date; card_id: string | null;
    card_title: string | null; git: HandbackRow["git"]; verified_commit: string | null; topic_version_id: string | null; topic_id: string | null; label: string | null;
    topic_title: string | null }[];
  return rows.map((row) => ({ id: row.id, kind: row.card_id ? "card" : "topic", title: row.card_id ? row.card_title! : `${row.topic_title} · ${row.label}`,
    cardId: row.card_id, topicId: row.topic_id, topicVersionId: row.topic_version_id, addedAt: row.added_at.toISOString(), git: cardGit(row) }));
}

/** GET /api/plan-tasks/:taskId/cards */
export async function readBoard(q: Query, own: OwnTask, names: Map<string, string>): Promise<TCardBoardResponse> {
  const taskId = own.task.taskId, ownerId = own.viewerId;
  const ids = (await q("SELECT id::text FROM tasks WHERE plan_task_id=$1 AND owner_id=$2 AND status<>'returned' AND trashed_at IS NULL AND archived_at IS NULL ORDER BY created_at,id",
    [taskId, ownerId])).rows.map((row) => row.id as string);
  const drafts = (await q(`SELECT d.* FROM card_drafts d JOIN card_plans p ON p.id=d.plan_id WHERE d.plan_task_id=$1 AND d.owner_id=$2 AND d.status='open'
    ORDER BY p.created_at,d.position`, [taskId, ownerId])).rows as DraftRow[];
  const plan = (await q("SELECT * FROM card_plans WHERE plan_task_id=$1 ORDER BY created_at DESC LIMIT 1", [taskId])).rows[0] as PlanRow | undefined;
  return {
    taskId, criteria: own.criteria.map((text, index) => ({ index: index + 1, text })), cards: await cardTaskViews(q, ids, names),
    drafts: drafts.map(draftView(await rolesById(q, drafts.map((draft) => draft.role_id)))), plan: plan ? planView(plan, await planExpectedSeconds(q)) : null, pending: await pendingItems(q, taskId),
    nextVersion: (await nextVersions(q, [taskId])).get(taskId)!,
  };
}

/** GET /api/me/projects/:projectId/board（16.3，项目负责人，调用方核对过）：项目里本人的、不挂 Task 的卡，还没处理的项目草稿，最近一次拆项目的计划。 */
export async function readProjectBoard(q: Query, ownerId: string, projectId: string, names: Map<string, string>): Promise<TProjectBoardResponse> {
  const ids = (await q(`SELECT id::text FROM tasks WHERE project_id=$1 AND owner_id=$2 AND plan_task_id IS NULL AND status<>'returned'
    AND trashed_at IS NULL AND archived_at IS NULL ORDER BY created_at,id`,
    [projectId, ownerId])).rows.map((row) => row.id as string);
  const drafts = (await q(`SELECT d.* FROM card_drafts d JOIN card_plans p ON p.id=d.plan_id WHERE d.project_id=$1 AND d.plan_task_id IS NULL AND d.owner_id=$2
    AND d.status='open' ORDER BY p.created_at,d.position`, [projectId, ownerId])).rows as DraftRow[];
  const plan = (await q("SELECT * FROM card_plans WHERE project_id=$1 AND plan_task_id IS NULL AND owner_id=$2 ORDER BY created_at DESC LIMIT 1",
    [projectId, ownerId])).rows[0] as PlanRow | undefined;
  return { projectId, cards: await cardTaskViews(q, ids, names), drafts: drafts.map(draftView(await rolesById(q, drafts.map((draft) => draft.role_id)))),
    plan: plan ? planView(plan, await planExpectedSeconds(q)) : null };
}

export type DraftRow = { id: string; plan_id: string; position: number; title: string; brief: string; done_definition: string; criterion_index: number | null;
  role_id: string | null; suggest_preset_key: string | null;
  executor: "claude_code" | "self"; model_tier: "strong" | "normal" | "light"; why: string | null; source_words: string[]; model_words?: string | null };
const draftView = (roles: Map<string, RoleRow>) => (row: DraftRow) => {
  const role = row.role_id ? roles.get(row.role_id) : undefined;
  return { id: row.id, planId: row.plan_id, position: row.position, title: row.title, brief: row.brief, doneDefinition: row.done_definition,
    criterionIndex: row.criterion_index, role: role ? roleRef(role) : null, suggestPresetKey: row.suggest_preset_key, executor: row.executor, modelTier: row.model_tier, why: row.why,
    sourceWords: row.source_words, modelWords: row.model_words ?? null };
};

/** 推进人自己的卡（锁住改用 forUpdate）；不是推进人的当找不到。 */
export async function ownCard(q: Query, ownerId: string, id: string, forUpdate = false): Promise<CardRow & { version: number; title: string }> {
  const row = UUID_PATTERN.test(id) ? (await q(`SELECT ${CARD_COLUMNS},version,title,owner_id FROM tasks WHERE id=$1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0] : undefined;
  if (!row || row.owner_id !== ownerId) throw new CardError(404, "NOT_FOUND", "找不到这张卡");
  return row as CardRow & { version: number; title: string };
}

export function handbackView(row: HandbackRow, names: Map<string, string>, expectedSeconds: number, cardHandbacks: HandbackRow[] = [row]): TCardHandbackView {
  return { ...handbackBrief(row, cardHandbacks), runId: row.run_id, criteria: row.criteria, claims: row.claims, summary: row.summary, outputIds: row.output_ids,
    result: row.result ? { criteria: row.result.criteria.map((item) => ({ ...item, text: row.criteria[item.index - 1] ?? "" })), beyondScope: row.result.beyondScope } : null,
    error: row.status === "failed" ? row.error : null, startedAt: row.started_at?.toISOString() ?? null, expectedSeconds,
    overrule: row.overruled_at && row.overruled_by && row.overrule_reason
      ? { by: { personId: row.overruled_by, name: names.get(row.overruled_by) ?? row.overruled_by }, at: row.overruled_at.toISOString(), reason: row.overrule_reason } : null,
    verifier: row.verifier_source ? { source: row.verifier_source, modelLabel: row.verifier_model, roleId: row.verifier_role_id, roleVersion: row.verifier_role_version } : null };
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
  const handbacks = (await q(`${HANDBACKS_WITH_RELAY} WHERE h.task_id=$1 ORDER BY h.attempt DESC`, [id])).rows as HandbackRow[];
  const outputs = (await q("SELECT * FROM local_outputs WHERE task_id=$1 ORDER BY created_at DESC,id", [id])).rows as OutputRow[];
  const expected = await acceptanceExpectedSeconds(q);
  return { task, letter: (await letterOfSub(q, "card", id))?.letter ?? null, brief: card.brief, standards: taskStandards(card.done_definition), runs: await runViews(q, await recentRuns(q, { taskId: id }, 5)),
    handbacks: handbacks.map((row) => handbackView(row, names, expected, handbacks)), outputs: outputs.map(outputView), agreement: await agreementView(q, id) };
}

/**
 * PATCH /api/me/cards/:id：执行方、岗位、模型、交代、对哪条标准。岗位要是本人没归档的；换了岗位，开工时的版本快照清掉。
 * 对哪条标准要这张卡挂着本人 Mission 下的 Task，存那一条当时的原文。
 * planTask 是读 Task 标准用的（只在改 criterionIndex 时调）。
 * 交代、完成标准是卡的约定（主循环第 60 条）：走 writeAgreement，真变了才加约定的版本号、记修改记录（by person）、在跑时转告执行方。
 */
export async function patchCard(pool: Pool, ownerId: string, id: string, input: TPatchCardRequest, names: Map<string, string>,
  planTask: (planTaskId: string) => Promise<OwnTask | null>, now: Date): Promise<TCardTaskView> {
  const { version, reason, ...fields } = input;
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
    const q: Query = client.query.bind(client);
    await writeAgreement(q, await agreementRow(q, ownerId, id), { brief: fields.brief, standards: fields.standards },
      { kind: "person", name: names.get(ownerId) ?? null }, reason?.trim() || null, now);
    await client.query(`UPDATE tasks SET executor=$2,model=$3::jsonb,criterion_index=$4,criterion_text=$5,role_id=$6,
      role_version=CASE WHEN role_id IS DISTINCT FROM $6 THEN NULL ELSE role_version END,version=version+1,updated_at=now() WHERE id=$1`, [id,
      fields.executor ?? card.executor, JSON.stringify(fields.model === undefined ? card.model : fields.model),
      criterion === undefined ? card.criterion_index : criterion?.index ?? null, criterion === undefined ? card.criterion_text : criterion?.text ?? null, roleId]);
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
  return (await cardTaskViews(pool.query.bind(pool), [id], names))[0];
}

/**
 * GET /api/me/cards/:id/brief：开工时交给本机的交代（第 8.3、19.4 节）。约定（V1）写进来：卡对的那条标准用什么证明、这次不包括什么。
 * 本体上下文先只放 Mission 和 Task。role 是卡的岗位此刻的内容（岗位改了，下一张卡的交代就变）；职责、做法由本机程序注入会话，
 * markdown 里只写岗位名和它的验收口径（干完会按它验）。
 */
export async function cardBrief(q: Query, ownerId: string, id: string, planTask: (planTaskId: string) => Promise<CardPlanTask | null>): Promise<TCardBriefResponse> {
  const card = await ownCard(q, ownerId, id);
  const mission = card.mission_id ? (await q("SELECT id,title FROM missions WHERE id=$1", [card.mission_id])).rows[0] as { id: string; title: string } | undefined : undefined;
  const own = card.plan_task_id ? await planTask(card.plan_task_id) : null;
  const standards = taskStandards(card.done_definition);
  const review = card.plan_task_id && card.criterion_index ? (await q(`SELECT review FROM deliverable_versions WHERE task_id=$1 AND review_status='done' AND review IS NOT NULL
    ORDER BY number DESC LIMIT 1`, [card.plan_task_id])).rows[0]?.review as StoredAcceptance | undefined : undefined;
  const gap = review?.criteria.find((item) => item.index === card.criterion_index && item.verdict !== "met")?.fix ?? null;
  const judged = (await q("SELECT * FROM card_handbacks WHERE task_id=$1 AND status='done' AND outcome IS NOT NULL ORDER BY attempt DESC LIMIT 1", [id])).rows[0] as HandbackRow | undefined;
  const lastReturn = judged && effectiveOutcome(judged) === "fail" ? judged.return_text : null;
  const agreement = cardAgreement(own?.agreement ?? null, card.criterion_index);
  const criterion = card.criterion_index && card.criterion_text ? { index: card.criterion_index, text: card.criterion_text, proof: agreement?.proof ?? null } : null;
  const exclusions = agreement?.exclusions ?? [];
  const role = card.role_id ? (await rolesById(q, [card.role_id])).get(card.role_id) : undefined;
  // 本人原话（16.8）放在最前面，目标和完成标准之前。
  const lines = [
    `# 执行事项：${card.title}`, "",
    ...wordsLines(card.source_words, "这件事依据的本人原话。做的时候以它为准：不加原话里没要的，不漏原话里明说的。"),
    ...(mission ? [`- Mission：${mission.title}`] : []),
    ...(own ? [`- Task：${own.task.name}`] : []),
    ...(criterion ? [`- 对的是 Task 的第 ${criterion.index} 条标准：${criterion.text}`] : []),
    ...(criterion?.proof ? [`- 这条用什么证明：${criterion.proof}`] : []),
    ...(role ? [`- 技能：${role.name}`] : []),
    "", "## 交代", "", card.brief ?? "（没写交代，按标题和完成标准做）",
    "", "## 完成标准（交回时逐条写证据）", "", ...(standards.length ? standards.map((text, index) => `${index + 1}. ${text}`) : ["（还没写完成标准）"]),
    ...(exclusions.length ? ["", "## 这次不包括", "", ...exclusions.map((text) => `- ${text}`)] : []),
    ...(gap ? ["", "## Task 最新一版评审里这条还差", "", gap] : []),
    ...(lastReturn ? ["", "## 上一次验收没过", "", lastReturn] : []),
    ...(role?.acceptance_md.trim() ? ["", `## ${role.name}的验收口径`, "", role.acceptance_md.trim()] : []),
  ];
  return { markdown: lines.join("\n").slice(0, 20_000), role: role ? roleBrief(role) : null, mission: mission ? { missionId: mission.id, title: mission.title } : null,
    task: own ? { taskId: own.task.taskId, name: own.task.name } : null, criterion, exclusions, reviewGap: gap, lastReturn, sourceWords: card.source_words };
}

/** 拆卡（Task 负责人）：同一个 Task 已有一次在排队或在跑时返回那一次（created=false），不另起。 */
export async function createCardPlan(q: Query, own: OwnTask, hint: string | undefined, afterSequence: number | null = null): Promise<{ plan: TCardPlanView; created: boolean }> {
  const inserted = (await q(`INSERT INTO card_plans(id,plan_task_id,mission_id,owner_id,hint,after_sequence) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT (plan_task_id) WHERE status IN ('queued','running') DO NOTHING RETURNING *`,
  [randomUUID(), own.task.taskId, own.task.missionId, own.viewerId, hint?.trim() || null, afterSequence])).rows[0] as PlanRow | undefined;
  const row = inserted ?? (await q("SELECT * FROM card_plans WHERE plan_task_id=$1 AND status IN ('queued','running')", [own.task.taskId])).rows[0] as PlanRow;
  return { plan: planView(row, await planExpectedSeconds(q)), created: Boolean(inserted) };
}

/**
 * 放进看板（Task 负责人）：草稿变成执行事项，推进人是本人，挂这个 Task 和它的 Mission，来源记「自己建」；草稿 id 当建事项的幂等键。
 * 可以顺手改标题、交代、完成标准、执行方。已经处理过的草稿 409。
 * 交给 Claude Code 的卡都要有岗位（worker 列表按岗位列）：没配时照草稿建议的预设、没建议时照「执行员」预设给本人加上并挂上。
 * start（新首页第 4.4 节）：交给 Claude Code 的卡同时登记要开工，由本人电脑上开着的网页认领后交给本机程序。
 */
export async function acceptCardDrafts(pool: Pool, own: OwnTask, input: TAcceptCardDraftsRequest, names: Map<string, string>, now: Date,
  afterSequence: number | null = null): Promise<TCardTaskView[]> {
  return acceptDrafts(pool, own.viewerId, { taskId: own.task.taskId, missionId: own.task.missionId, projectId: null, criteria: own.criteria }, input, names, now, afterSequence);
}

/** 把没挂 Task 的项目的派活单草稿放进看板（16.3，项目负责人，调用方核对过）：卡挂项目、不挂 Task 和 Mission，按自己的完成标准验。 */
export async function acceptProjectCardDrafts(pool: Pool, ownerId: string, projectId: string, input: TAcceptCardDraftsRequest, names: Map<string, string>, now: Date,
  afterSequence: number | null = null): Promise<TCardTaskView[]> {
  return acceptDrafts(pool, ownerId, { taskId: null, missionId: null, projectId, criteria: [] }, input, names, now, afterSequence);
}

/** afterSequence：开工那一下本人看到的项目对话最后一条（17.2 第 29 条），记成这几份派活单的 startedAfterSequence（第一次开工记了就不改）。 */
async function acceptDrafts(pool: Pool, ownerId: string, target: PlanTarget, input: TAcceptCardDraftsRequest, names: Map<string, string>, now: Date,
  afterSequence: number | null): Promise<TCardTaskView[]> {
  const ids: string[] = [], plans = new Set<string>(), starts: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const edit of input.drafts) {
      const draft = (await client.query(`SELECT * FROM card_drafts WHERE id=$1 AND ${target.taskId ? "plan_task_id=$2" : "project_id=$2 AND plan_task_id IS NULL"}
        AND owner_id=$3 FOR UPDATE`, [edit.id, target.taskId ?? target.projectId, ownerId])).rows[0] as (DraftRow & { status: string }) | undefined;
      if (!draft) throw new CardError(404, "NOT_FOUND", "找不到这张草稿");
      if (draft.status !== "open") throw new CardError(409, "DRAFT_DECIDED", "这张草稿已经处理过了");
      const created = await createInTransaction(client, ownerId, names, { clientId: draft.id, title: (edit.title ?? draft.title).trim(), missionId: target.missionId,
        doneDefinition: (edit.doneDefinition ?? draft.done_definition).trim(), ...target.taskId ? { planTaskId: target.taskId } : {}, source: "self" });
      if (!("task" in created)) throw "error" in created ? new CardError(created.error.status as 400, created.error.code, created.error.message)
        : new CardError(409, "DRAFT_DECIDED", "这张草稿已经处理过了");
      const index = draft.criterion_index && target.criteria[draft.criterion_index - 1] ? draft.criterion_index : null;
      if (edit.roleId) await ownRole(client.query.bind(client), ownerId, edit.roleId);
      const executor = edit.executor ?? draft.executor;
      let roleId = edit.roleId === undefined ? draft.role_id : edit.roleId;
      if (!roleId && executor === "claude_code") roleId = (await (draft.suggest_preset_key ? ensurePresetRole(client, ownerId, draft.suggest_preset_key, now) : null)
        ?? await ensurePresetRole(client, ownerId, DEFAULT_WORKER_PRESET, now))?.id ?? null;
      // 本人原话（16.8）跟着草稿进卡。
      await client.query(`UPDATE tasks SET executor=$2,brief=$3,criterion_index=$4,criterion_text=$5,role_id=$6,project_id=COALESCE($7,project_id),source_words=$8::jsonb
        WHERE id=$1`, [created.task.id, executor, (edit.brief ?? draft.brief).trim() || null, index, index ? target.criteria[index - 1] : null, roleId, target.projectId,
        JSON.stringify(draft.source_words)]);
      await client.query("UPDATE card_drafts SET status='accepted',task_id=$2,decided_at=now() WHERE id=$1", [draft.id, created.task.id]);
      ids.push(created.task.id);
      plans.add(draft.plan_id);
      if (executor === "claude_code") starts.push(created.task.id);
    }
    // 先后：草稿要等的那几张草稿放进看板了，换成它们的卡 id（先放后放都对得上；不要了的那张不等）。
    await client.query(`UPDATE tasks t SET after_card_ids=w.ids FROM (
      SELECT d.task_id,coalesce(array_agg(a.task_id ORDER BY a.position) FILTER (WHERE a.task_id IS NOT NULL),'{}') AS ids
      FROM card_drafts d LEFT JOIN card_drafts a ON a.id=ANY(d.after_draft_ids) AND a.status='accepted'
      WHERE d.plan_id=ANY($1::uuid[]) AND d.status='accepted' AND d.task_id IS NOT NULL AND cardinality(d.after_draft_ids)>0 GROUP BY d.task_id) w
      WHERE t.id=w.task_id`, [[...plans]]);
    if (input.start && starts.length) await requestStarts(client.query.bind(client), { ownerId, origin: "web", now,
      items: starts.map((cardId) => ({ kind: "card", cardId, planTaskId: target.taskId })) });
    if (afterSequence !== null && plans.size)
      await client.query("UPDATE card_plans SET started_after_sequence=$2 WHERE id=ANY($1::uuid[]) AND started_after_sequence IS NULL", [[...plans], afterSequence]);
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
  return cardTaskViews(pool.query.bind(pool), ids, names);
}

/** 不要这张草稿：只有这个 Task 的负责人（就是草稿的主人）；项目的草稿（16.3）是项目负责人。 */
export async function dismissCardDraft(q: Query, personId: string, id: string, ownTask: (planTaskId: string) => Promise<OwnTask>,
  ownProject: (projectId: string) => Promise<unknown>): Promise<void> {
  const draft = UUID_PATTERN.test(id) ? (await q("SELECT plan_task_id,project_id::text,status FROM card_drafts WHERE id=$1 AND owner_id=$2", [id, personId])).rows[0] as
    { plan_task_id: string | null; project_id: string | null; status: string } | undefined : undefined;
  if (!draft) throw new CardError(404, "NOT_FOUND", "找不到这张草稿");
  await (draft.plan_task_id ? ownTask(draft.plan_task_id) : ownProject(draft.project_id!));
  if (draft.status !== "open") throw new CardError(409, "DRAFT_DECIDED", "这张草稿已经处理过了");
  await q("UPDATE card_drafts SET status='dismissed',decided_at=now() WHERE id=$1 AND status='open'", [id]);
}
