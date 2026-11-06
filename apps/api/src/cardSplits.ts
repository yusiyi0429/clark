import { randomUUID } from "node:crypto";
import type { TCardPlanBriefResponse, TCardSplitRequestView, TPlanBriefRole } from "@warmap/contracts";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { isPlannerRole, plannerRole, roleBrief, type RoleRow } from "./roles.js";
import type { CardPlanTask } from "./taskCards.js";
import type { OwnTask } from "./taskDeliverables.js";

/**
 * 拆卡改在本机（V2 第 21 节）的云端这一侧：登记拆卡（伙伴的 register_card_split、Task 页「拆一下」）只记下「本人要拆这个 Task」，不起作业；
 * 网页读本人还没开工的登记，在这台电脑上开规划员，开了以后去掉登记。规划员开工时拿 planBrief 的交代。
 */

type SplitRow = { id: string; owner_id: string; plan_task_id: string; mission_id: string; task_name: string; origin: "buddy" | "web"; created_at: Date };
const splitView = (row: SplitRow): TCardSplitRequestView => ({ id: row.id, taskId: row.plan_task_id, taskName: row.task_name, missionId: row.mission_id,
  origin: row.origin, createdAt: row.created_at.toISOString() });

/** 登记拆卡（Task 负责人，调用方核对过）：同一个 Task 已有一条没开工的登记时返回那一条（created=false）。 */
export async function registerCardSplit(q: Query, own: OwnTask, origin: "buddy" | "web", now: Date): Promise<{ request: TCardSplitRequestView; created: boolean }> {
  const inserted = (await q(`INSERT INTO card_split_requests(id,owner_id,plan_task_id,mission_id,task_name,origin,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (owner_id,plan_task_id) WHERE closed_at IS NULL DO NOTHING RETURNING *`,
  [randomUUID(), own.viewerId, own.task.taskId, own.task.missionId, own.task.name, origin, now])).rows[0] as SplitRow | undefined;
  const row = inserted ?? (await q("SELECT * FROM card_split_requests WHERE owner_id=$1 AND plan_task_id=$2 AND closed_at IS NULL",
    [own.viewerId, own.task.taskId])).rows[0] as SplitRow;
  return { request: splitView(row), created: Boolean(inserted) };
}

/** GET /api/me/card-splits：本人还没开工的登记，先登记的在前。 */
export async function listCardSplits(q: Query, ownerId: string): Promise<TCardSplitRequestView[]> {
  return ((await q("SELECT * FROM card_split_requests WHERE owner_id=$1 AND closed_at IS NULL ORDER BY created_at,id", [ownerId])).rows as SplitRow[]).map(splitView);
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
 * GET /api/plan-tasks/:taskId/plan-brief（Task 负责人，调用方核对过）：开规划员会话的交代。
 * 派活单能写的岗位：本人干活的岗位（规划员自己除外），和本人还没加的干活预设（没有合适岗位时写预设，放进看板时云端照预设给本人加上）。
 * 看板上已有的卡和还没处理的草稿也写进去，免得重复派。
 */
export async function planBrief(q: Query, own: CardPlanTask): Promise<TCardPlanBriefResponse> {
  const ownerId = own.viewerId, taskId = own.task.taskId;
  const workers = (await q(`SELECT * FROM roles WHERE kind='worker' AND archived_at IS NULL AND (owner_id=$1 OR owner_id IS NULL) ORDER BY created_at,preset_key`,
    [ownerId])).rows as RoleRow[];
  const team = workers.filter((row) => row.owner_id === ownerId && !isPlannerRole(row));
  const added = new Set(workers.flatMap((row) => row.owner_id === ownerId && row.preset_key ? [row.preset_key] : []));
  const presets = workers.filter((row) => row.owner_id === null && !isPlannerRole(row) && !added.has(row.preset_key!));
  const roles: TPlanBriefRole[] = [...team, ...presets].map((row) => ({ id: row.owner_id ? row.id : null, presetKey: row.owner_id ? null : row.preset_key,
    name: row.name, kind: row.kind, dutiesSummary: dutiesSummary(row.duties_md), modelTier: row.model_tier }));
  const planner = await plannerRole(q, ownerId);
  const criteria = own.criteria.map((text, position) => ({ index: position + 1, text,
    proof: own.agreement.criteria.find((item) => item.index === position + 1)?.proof ?? null }));
  const cards = (await q(`SELECT title,criterion_index,status FROM tasks WHERE plan_task_id=$1 AND owner_id=$2 AND status<>'returned' ORDER BY created_at`,
    [taskId, ownerId])).rows as { title: string; criterion_index: number | null; status: string }[];
  const drafts = (await q("SELECT title,criterion_index FROM card_drafts WHERE plan_task_id=$1 AND owner_id=$2 AND status='open' ORDER BY created_at,position",
    [taskId, ownerId])).rows as { title: string; criterion_index: number | null }[];
  const against = (index: number | null) => index ? `（对第 ${index} 条）` : "";
  const roleLine = (role: TPlanBriefRole) => `- ${role.name}（${role.presetKey ? `预设 ${role.presetKey}，` : ""}${TIER[role.modelTier]}档）：${role.dutiesSummary || "没写职责"}`;
  const lines = [
    `# 拆卡：${own.task.name}`, "",
    "把这个 Task 拆成计划和派活单，用 propose_plan 交上去。先用 get_task_context 读 Mission 和战场目标、近期相关的事和决定、上一版交付物和评审结果。",
    `Task id：${taskId}`, "",
    "## 验收标准和约定", "",
    ...(criteria.length ? criteria.flatMap((item) => [`${item.index}. ${item.text}`, ...(item.proof ? [`   用什么证明：${item.proof}`] : [])]) : ["这个 Task 还没写验收标准。"]),
    ...(own.agreement.exclusions.length ? ["", "## 这次不包括", "", ...own.agreement.exclusions.map((text) => `- ${text}`)] : []),
    ...(cards.length || drafts.length ? ["", "## 已经有的（不要重复派）", "",
      ...cards.map((card) => `- 卡：${card.title}${against(card.criterion_index)}`), ...drafts.map((draft) => `- 草稿：${draft.title}${against(draft.criterion_index)}`)] : []),
    "", "## 能派的岗位", "",
    ...(team.length ? team.map((row) => roleLine(roles.find((role) => role.id === row.id)!)) : ["本人还没加干活的岗位。"]),
    ...(presets.length ? ["", "本人还没加的预设（没有合适的岗位时写预设名，放进看板时会给本人加上）：", "",
      ...roles.filter((role) => role.presetKey).map(roleLine)] : []),
    "", "## 派活单的要求", "",
    "3 到 8 件，每件能独立交回：标题写要交付的结果；交代写清做什么；完成标准每行一条、能核对；写对约定第几条（对不上写 null）；岗位从上面挑；模型档位 strong / normal / light；一句为什么这么拆。",
  ];
  return { markdown: lines.join("\n").slice(0, 20_000), role: planner ? roleBrief(planner) : null,
    task: { taskId, name: own.task.name, missionId: own.task.missionId }, criteria, exclusions: own.agreement.exclusions, roles };
}
