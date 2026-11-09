import { randomUUID } from "node:crypto";
import type { TCardPlanBriefResponse, TCardSplitRequestView, TPlanBriefRole } from "@warmap/contracts";
import { CARD_TITLE_RULE } from "./cardTitle.js";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { projectGoalRows, verdicts, type ProjectRow } from "./projects.js";
import { isPlannerRole, plannerRole, roleBrief, type RoleRow } from "./roles.js";
import { latestSplitWords, wordsLines } from "./sourceWords.js";
import type { CardPlanTask } from "./taskCards.js";
import type { OwnTask } from "./taskDeliverables.js";

/**
 * 拆卡改在本机（V2 第 21 节）的云端这一侧：登记拆卡（伙伴的 register_card_split、Task 页「拆一下」）只记下「本人要拆这个 Task」，不起作业；
 * 网页读本人还没开工的登记，在这台电脑上开规划员，开了以后去掉登记。规划员开工时拿 planBrief 的交代。
 * 没挂 Task 的项目也能拆（新首页 16.3）：登记、交代按项目走（registerProjectCardSplit、projectPlanBrief），没有 Task 的验收标准，每件派活单自带完成标准。
 */

type SplitRow = { id: string; owner_id: string; plan_task_id: string | null; mission_id: string | null; task_name: string | null; origin: "buddy" | "web"; created_at: Date;
  project: string | null; project_name: string | null; source_words: string[]; after_sequence: number | null };
/** 登记连同所属项目：拆项目的是登记上的项目，拆 Task 的是 Task 挂的项目。 */
const SPLITS = `SELECT s.*,p.id::text AS project,p.name AS project_name FROM card_split_requests s
  LEFT JOIN projects p ON p.id=COALESCE(s.project_id,(SELECT g.project_id FROM project_goals g WHERE g.task_id=s.plan_task_id))`;
const splitView = (row: SplitRow): TCardSplitRequestView => ({ id: row.id, taskId: row.plan_task_id, taskName: row.task_name, missionId: row.mission_id,
  projectId: row.project, projectName: row.project_name, origin: row.origin, sourceWords: row.source_words, createdAt: row.created_at.toISOString(),
  afterSequence: row.after_sequence });
const splitById = async (q: Query, id: string) => (await q(`${SPLITS} WHERE s.id=$1`, [id])).rows[0] as SplitRow;

/** 已有一条没开工的登记：这次带了原话（words 不是 undefined）就换成这次的。 */
const replaceWords = async (q: Query, id: string, words: string[] | undefined) => {
  if (words !== undefined) await q("UPDATE card_split_requests SET source_words=$2::jsonb WHERE id=$1", [id, JSON.stringify(words)]);
};

/**
 * 登记拆卡（Task 负责人，调用方核对过）：同一个 Task 已有一条没开工的登记时返回那一条（created=false）。
 * words 是这次依据的本人原话（16.8）；undefined 是没带（新登记存空数组，已有的不动）。
 * afterSequence：开拆那一下本人看到的项目对话最后一条（17.2 第 29 条）；已有的登记不改。
 */
export async function registerCardSplit(q: Query, own: OwnTask, origin: "buddy" | "web", now: Date, words?: string[], afterSequence: number | null = null):
  Promise<{ request: TCardSplitRequestView; created: boolean }> {
  const inserted = (await q(`INSERT INTO card_split_requests(id,owner_id,plan_task_id,mission_id,task_name,origin,created_at,source_words,after_sequence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
    ON CONFLICT (owner_id,plan_task_id) WHERE closed_at IS NULL DO NOTHING RETURNING id`,
  [randomUUID(), own.viewerId, own.task.taskId, own.task.missionId, own.task.name, origin, now, JSON.stringify(words ?? []), afterSequence])).rows[0] as
    { id: string } | undefined;
  const id = inserted?.id ?? (await q("SELECT id FROM card_split_requests WHERE owner_id=$1 AND plan_task_id=$2 AND closed_at IS NULL",
    [own.viewerId, own.task.taskId])).rows[0].id as string;
  if (!inserted) await replaceWords(q, id, words);
  return { request: splitView(await splitById(q, id)), created: Boolean(inserted) };
}

/** 登记拆一个项目（16.3，项目负责人，调用方核对过）：同一个项目已有一条没开工的项目登记时返回那一条（created=false）。 */
export async function registerProjectCardSplit(q: Query, ownerId: string, projectId: string, origin: "buddy" | "web", now: Date, words?: string[],
  afterSequence: number | null = null): Promise<{ request: TCardSplitRequestView; created: boolean }> {
  const inserted = (await q(`INSERT INTO card_split_requests(id,owner_id,project_id,origin,created_at,source_words,after_sequence) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT (owner_id,project_id) WHERE closed_at IS NULL AND plan_task_id IS NULL DO NOTHING RETURNING id`,
  [randomUUID(), ownerId, projectId, origin, now, JSON.stringify(words ?? []), afterSequence])).rows[0] as { id: string } | undefined;
  const id = inserted?.id ?? (await q("SELECT id FROM card_split_requests WHERE owner_id=$1 AND project_id=$2 AND plan_task_id IS NULL AND closed_at IS NULL",
    [ownerId, projectId])).rows[0].id as string;
  if (!inserted) await replaceWords(q, id, words);
  return { request: splitView(await splitById(q, id)), created: Boolean(inserted) };
}

/** GET /api/me/card-splits：本人还没开工的登记，先登记的在前。 */
export async function listCardSplits(q: Query, ownerId: string): Promise<TCardSplitRequestView[]> {
  return ((await q(`${SPLITS} WHERE s.owner_id=$1 AND s.closed_at IS NULL ORDER BY s.created_at,s.id`, [ownerId])).rows as SplitRow[]).map(splitView);
}

/** 去掉一条登记（开了规划员，或本人不拆了）；不是本人的、已经去掉的当找不到。 */
export async function closeCardSplit(q: Query, ownerId: string, id: string, now: Date): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;
  return Boolean((await q("UPDATE card_split_requests SET closed_at=$3 WHERE id=$1 AND owner_id=$2 AND closed_at IS NULL", [id, ownerId, now])).rowCount);
}

const DUTIES_CHARS = 200;
/** 职责的第一段，最多 200 字。 */
const dutiesSummary = (duties: string) => (duties.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) ?? "").slice(0, DUTIES_CHARS);
const TIER = { strong: "强", normal: "普通", light: "轻" } as const;

/**
 * 派活单能写的岗位：本人干活的岗位（规划员自己除外），和本人还没加的干活预设（没有合适岗位时写预设，放进看板时云端照预设给本人加上）。
 * lines 是交代里「能派的岗位」那一段。
 */
async function briefRoles(q: Query, ownerId: string): Promise<{ roles: TPlanBriefRole[]; lines: string[] }> {
  const workers = (await q(`SELECT * FROM roles WHERE kind='worker' AND archived_at IS NULL AND (owner_id=$1 OR owner_id IS NULL) ORDER BY created_at,preset_key`,
    [ownerId])).rows as RoleRow[];
  const team = workers.filter((row) => row.owner_id === ownerId && !isPlannerRole(row));
  const added = new Set(workers.flatMap((row) => row.owner_id === ownerId && row.preset_key ? [row.preset_key] : []));
  const presets = workers.filter((row) => row.owner_id === null && !isPlannerRole(row) && !added.has(row.preset_key!));
  const roles: TPlanBriefRole[] = [...team, ...presets].map((row) => ({ id: row.owner_id ? row.id : null, presetKey: row.owner_id ? null : row.preset_key,
    name: row.name, kind: row.kind, dutiesSummary: dutiesSummary(row.duties_md), modelTier: row.model_tier }));
  const roleLine = (role: TPlanBriefRole) => `- ${role.name}（${role.presetKey ? `预设 ${role.presetKey}，` : ""}${TIER[role.modelTier]}档）：${role.dutiesSummary || "没写职责"}`;
  return { roles, lines: [
    "## 技能清单", "",
    ...(team.length ? team.map((row) => roleLine(roles.find((role) => role.id === row.id)!)) : ["本人还没加干活的技能。"]),
    ...(presets.length ? ["", "本人还没加的预设技能（没有合适的技能时写预设名，放进看板时会给本人加上）：", "",
      ...roles.filter((role) => role.presetKey).map(roleLine)] : []),
  ] };
}

const against = (index: number | null) => index ? `（对第 ${index} 条）` : "";
/** 交代里的原话一段和对派活单的要求（16.8）。 */
const briefWords = (words: string[]) => wordsLines(words, "这是本人说的原话。每件派活单从这里摘出和它有关的片段写进 sourceWords，只能原样摘，不能改写、不能补充；"
  + "派活单的交代和完成标准不能加原话里没有的约束。");
/** 「已经有的」一段：看板上的卡和还没处理的草稿，免得重复派。 */
const existingLines = (cards: { title: string; criterion_index: number | null }[], drafts: { title: string; criterion_index: number | null }[]) =>
  cards.length || drafts.length ? ["", "## 已经有的（不要重复派）", "",
    ...cards.map((card) => `- 卡：${card.title}${against(card.criterion_index)}`), ...drafts.map((draft) => `- 草稿：${draft.title}${against(draft.criterion_index)}`)] : [];

/**
 * GET /api/plan-tasks/:taskId/plan-brief（Task 负责人，调用方核对过）：开规划员会话的交代。
 * 看板上已有的卡和还没处理的草稿也写进去，免得重复派。
 */
export async function planBrief(q: Query, own: CardPlanTask): Promise<TCardPlanBriefResponse> {
  const ownerId = own.viewerId, taskId = own.task.taskId;
  const { roles, lines: roleLines } = await briefRoles(q, ownerId);
  const planner = await plannerRole(q, ownerId);
  const criteria = own.criteria.map((text, position) => ({ index: position + 1, text,
    proof: own.agreement.criteria.find((item) => item.index === position + 1)?.proof ?? null }));
  const cards = (await q(`SELECT title,criterion_index,status FROM tasks WHERE plan_task_id=$1 AND owner_id=$2 AND status<>'returned' ORDER BY created_at`,
    [taskId, ownerId])).rows as { title: string; criterion_index: number | null; status: string }[];
  const drafts = (await q("SELECT title,criterion_index FROM card_drafts WHERE plan_task_id=$1 AND owner_id=$2 AND status='open' ORDER BY created_at,position",
    [taskId, ownerId])).rows as { title: string; criterion_index: number | null }[];
  const project = (await q("SELECT p.id::text,p.name FROM project_goals g JOIN projects p ON p.id=g.project_id WHERE g.task_id=$1", [taskId])).rows[0] as
    { id: string; name: string } | undefined;
  const words = await latestSplitWords(q, ownerId, { taskId, projectId: null });
  const lines = [
    `# 拆卡：${own.task.name}`, "",
    "把这个 Task 拆成计划和派活单，用 propose_plan 交上去。先用 get_task_context 读 Mission 和战场目标、近期相关的事和决定、上一版交付物和评审结果。",
    `Task id：${taskId}`, "",
    "## 验收标准和约定", "",
    ...(criteria.length ? criteria.flatMap((item) => [`${item.index}. ${item.text}`, ...(item.proof ? [`   用什么证明：${item.proof}`] : [])]) : ["这个 Task 还没写验收标准。"]),
    ...(own.agreement.exclusions.length ? ["", "## 这次不包括", "", ...own.agreement.exclusions.map((text) => `- ${text}`)] : []),
    ...existingLines(cards, drafts),
    ...(words.length ? ["", ...briefWords(words)] : []),
    "", ...roleLines,
    "", "## 派活单的要求", "",
    "3 到 8 件，每件能独立交回：" + CARD_TITLE_RULE + "；交代写清做什么；完成标准每行一条、能核对；写对约定第几条（对不上写 null）；技能从上面的技能清单里挑；模型档位 strong / normal / light；一句为什么这么拆。"
      + (words.length ? "每件带 sourceWords：从上面「本人原话」里原样摘的相关片段。" : ""),
  ];
  return { markdown: lines.join("\n").slice(0, 20_000), role: planner ? roleBrief(planner) : null,
    task: { taskId, name: own.task.name, missionId: own.task.missionId }, project: project ? { projectId: project.id, name: project.name } : null,
    criteria, exclusions: own.agreement.exclusions, roles, sourceWords: words };
}

const VERDICT = { open: "进行中", completed: "确认完成", stopped: "到此为止", continued: "已延续" } as const;

/**
 * GET /api/me/projects/:projectId/plan-brief（16.3，项目负责人，调用方核对过）：拆一个项目的交代。没有 Task 的验收标准：
 * 写项目名、目标历史（每月挂过的 Task 和了结）、项目里不挂 Task 的卡和草稿，要求每件派活单自带能核对的完成标准，对约定第几条一律写 null。
 */
export async function projectPlanBrief(q: Query, project: ProjectRow): Promise<TCardPlanBriefResponse> {
  const ownerId = project.owner_id;
  const { roles, lines: roleLines } = await briefRoles(q, ownerId);
  const planner = await plannerRole(q, ownerId);
  const goals = (await projectGoalRows(q, project.id)).reverse();
  const verdict = await verdicts(q, goals.map((goal) => goal.task_id));
  const cards = (await q(`SELECT title,criterion_index FROM tasks WHERE project_id=$1 AND owner_id=$2 AND plan_task_id IS NULL AND status<>'returned' ORDER BY created_at`,
    [project.id, ownerId])).rows as { title: string; criterion_index: number | null }[];
  const drafts = (await q(`SELECT title,criterion_index FROM card_drafts WHERE project_id=$1 AND plan_task_id IS NULL AND owner_id=$2 AND status='open'
    ORDER BY created_at,position`, [project.id, ownerId])).rows as { title: string; criterion_index: number | null }[];
  const words = await latestSplitWords(q, ownerId, { taskId: null, projectId: project.id });
  const lines = [
    `# 拆卡：${project.name}`, "",
    "把这个项目接下来要做的拆成计划和派活单，用 propose_plan 交上去。这个项目这次没挂 Task，没有 Task 的验收标准，不用 get_task_context；需要时读工作目录里的文件。",
    `项目 id：${project.id}`, "",
    "## 目标历史", "",
    ...(goals.length ? goals.map((goal) => `- ${goal.period} · ${goal.task_name}${goal.mission_title ? `（Mission：${goal.mission_title}）` : ""} · ${VERDICT[verdict.get(goal.task_id) ?? "open"]}`)
      : ["这个项目还没挂过 Task。"]),
    ...existingLines(cards, drafts),
    ...(words.length ? ["", ...briefWords(words)] : []),
    "", ...roleLines,
    "", "## 派活单的要求", "",
    "3 到 8 件，每件能独立交回：" + CARD_TITLE_RULE + "；交代写清做什么；完成标准每行一条、能核对（没有 Task 的验收标准，验收员只照这几条验）；对约定第几条一律写 null；技能从上面的技能清单里挑；模型档位 strong / normal / light；一句为什么这么拆。"
      + (words.length ? "每件带 sourceWords：从上面「本人原话」里原样摘的相关片段。" : ""),
  ];
  return { markdown: lines.join("\n").slice(0, 20_000), role: planner ? roleBrief(planner) : null, task: null,
    project: { projectId: project.id, name: project.name }, criteria: [], exclusions: [], roles, sourceWords: words };
}
