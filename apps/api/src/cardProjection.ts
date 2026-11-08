import type { TCardGit, TCardHandbackBrief, TCardModel, TCardWait, TCriterionVerdict, TDeliverableInclusion, TLocalGitRef, TLocalHandbackCriterion, TTaskCard, TTaskView, TCardSourceWordIssue } from "@warmap/contracts";
import { askingQuestion, runBrief, type RunRow } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { roleRef, rolesById } from "./roles.js";

/**
 * 卡的投影（V2 设计第 3 节）：每件执行事项的 card——列、标记、岗位、最近一次执行和交回、进交付物到哪了，读的时候算。
 * 单独一个文件，执行事项的投影（tasks.ts）和看板（taskCards.ts）都用它，不互相引用。
 */

/** 一次交回在库里的验收结论。 */
/** sourceWordIssues：和本人原话对不上的几处（16.8，本机验收员报的；云端验收和老的结论没有）。 */
export type StoredAcceptance = { headline: string | null; criteria: { index: number; verdict: TCriterionVerdict; reason: string; evidence: string | null; fix: string | null }[];
  beyondScope: string[]; sourceWordIssues?: TCardSourceWordIssue[] };
export type HandbackRow = { id: string; task_id: string; run_id: string | null; owner_id: string; attempt: number; criteria: string[]; claims: TLocalHandbackCriterion[];
  summary: string | null; output_ids: string[]; status: TCardHandbackBrief["status"]; started_at: Date | null; finished_at: Date | null; error: string | null;
  result: StoredAcceptance | null; outcome: "pass" | "fail" | null; return_text: string | null; returned_at: Date | null; overruled_at: Date | null;
  overruled_by: string | null; overrule_reason: string | null; created_at: Date;
  verifier_source: "cloud" | "local" | null; verifier_model: string | null; verifier_role_id: string | null; verifier_role_version: number | null;
  git: TLocalGitRef | null; verified_commit: string | null };
export type CardRow = { id: string; status: TTaskView["status"]; executor: TTaskCard["executor"]; model: TCardModel | null; brief: string | null;
  criterion_index: number | null; criterion_text: string | null; plan_task_id: string | null; done_definition: string | null; mission_id: string | null;
  role_id: string | null; after_card_ids: string[]; source_words: string[] };

/** 本机报 hold（订阅额度用完，停着等恢复）时会话的几种状态：排着没开始、一轮停在中间（等你说话的状态）、进程退了。 */
export const HOLD_STATES = ["queued", "idle", "exited"];

/** 推翻过的验收按本人的判断算：通过的推翻算没过，没过的推翻算通过。 */
export const effectiveOutcome = (row: Pick<HandbackRow, "outcome" | "overruled_at">) =>
  row.outcome && row.overruled_at ? (row.outcome === "pass" ? "fail" : "pass") : row.outcome;

/** 连续几次没过（从最近一次往前数，排队或在验收的不算）。 */
export function failStreak(handbacks: Pick<HandbackRow, "status" | "outcome" | "overruled_at">[]): number {
  let streak = 0;
  for (const row of handbacks) {
    if (row.status !== "done" || effectiveOutcome(row) === null) continue;
    if (effectiveOutcome(row) !== "fail") break;
    streak++;
  }
  return streak;
}

/** 交回的分支和提交、验的提交（卡在工作树里做时才有，ADR 0038）。 */
export const cardGit = (row: Pick<HandbackRow, "git" | "verified_commit">): TCardGit | null => row.git ? { ...row.git, verifiedCommit: row.verified_commit } : null;

export function handbackBrief(row: HandbackRow): TCardHandbackBrief {
  const criteria = row.result?.criteria ?? [];
  return { id: row.id, attempt: row.attempt, status: row.status, outcome: row.outcome, met: criteria.filter((item) => item.verdict === "met").length, total: criteria.length,
    headline: row.result?.headline ?? null, returnText: row.return_text, returnedAt: row.returned_at?.toISOString() ?? null, overruled: row.overruled_at !== null,
    createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null, git: cardGit(row),
    sourceWordIssues: row.result?.sourceWordIssues ?? [] };
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
  // 停着等额度恢复的不是等你回复、也不是已暂停（契约的标记里没有额度，给 null）；停下了、异常退出了一次都算已暂停。
  if (runs[0]?.hold?.reason === "usage_limit" && HOLD_STATES.includes(runs[0].state)) return { stage: "doing", wait: null };
  // 一轮做完停下、没在问你（idle 不带 question）算已暂停（「已停下」），不是等你回复（新首页 9.6）。
  if (runs[0]?.state === "idle") return { stage: "doing", wait: askingQuestion(runs[0]) ? "reply" : "paused" };
  const waits: Partial<Record<RunRow["state"], TCardWait>> = { waiting_permission: "approval", exited: "paused", failed: "paused" };
  return { stage: "doing", wait: runs[0] ? waits[runs[0].state] ?? null : null };
}

export const CARD_COLUMNS = "id::text,status,executor,model,brief,criterion_index,criterion_text,plan_task_id,done_definition,mission_id,role_id::text,after_card_ids::text[],source_words";

/** 一批执行事项各自的 card。 */
export async function cardsOf(q: Query, rows: CardRow[]): Promise<Map<string, TTaskCard>> {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return new Map();
  // 依次读：执行事项的投影有时在事务里（q 是同一个连接），有时用连接池，并发读会多占连接。
  const handbacks = (await q("SELECT * FROM card_handbacks WHERE task_id=ANY($1::uuid[]) ORDER BY attempt DESC", [ids])).rows as HandbackRow[];
  // 每张卡最近两次执行：最近一次给摘要和标记，两次都异常退出算受阻。
  const runs = (await q(`SELECT * FROM (SELECT r.*,d.name AS device_name,row_number() OVER (PARTITION BY r.task_id ORDER BY r.started_at DESC,r.id) AS n
    FROM local_runs r LEFT JOIN local_devices d ON d.owner_id=r.owner_id AND d.id=r.device_id WHERE r.task_id=ANY($1::uuid[]) AND r.kind='card') x
    WHERE n<=2 ORDER BY started_at DESC,id`, [ids])).rows as RunRow[];
  const inclusions = (await q(`SELECT h.task_id::text,v.number,p.version_id FROM deliverable_pending_items p JOIN card_handbacks h ON h.id=p.handback_id
    LEFT JOIN deliverable_versions v ON v.id=p.version_id WHERE h.task_id=ANY($1::uuid[]) ORDER BY p.added_at DESC`, [ids])).rows as { task_id: string; number: number | null; version_id: string | null }[];
  const roles = await rolesById(q, rows.map((row) => row.role_id));
  // 先后只算 Agent 做的卡（claude_code）：本机等前面的卡在本机合回才放行，本人自己做的卡不会在本机合回，等它就永远等着。
  // 读的时候按那几张卡此刻的执行方筛（看板、卡的详情、开工都从这里拿），执行方后来改了也跟着变。
  const afterIds = [...new Set(rows.flatMap((row) => row.after_card_ids))];
  const agentCards = new Set(afterIds.length ? ((await q("SELECT id::text FROM tasks WHERE id=ANY($1::uuid[]) AND executor='claude_code'", [afterIds])).rows as
    { id: string }[]).map((row) => row.id) : []);
  // 下一版的号只有准备中的卡要。
  const next = await nextVersions(q, [...new Set(rows.flatMap((row) => row.plan_task_id && inclusions.some((item) => item.task_id === row.id && !item.version_id)
    ? [row.plan_task_id] : []))]);
  return new Map(rows.map((row) => {
    const own = handbacks.filter((item) => item.task_id === row.id), ownRuns = runs.filter((item) => item.task_id === row.id);
    const inclusion = inclusions.find((item) => item.task_id === row.id);
    const deliverable: TDeliverableInclusion | null = !inclusion ? null : inclusion.version_id ? { state: "included", versionNumber: inclusion.number! }
      : { state: "pending", versionNumber: next.get(row.plan_task_id ?? "") ?? 1 };
    const role = row.role_id ? roles.get(row.role_id) : undefined;
    return [row.id, { ...stageAndWait(row, own, ownRuns), role: role ? roleRef(role) : null, executor: row.executor, model: row.model,
      criterion: row.criterion_index && row.criterion_text ? { index: row.criterion_index, text: row.criterion_text } : null,
      run: ownRuns[0] ? runBrief(ownRuns[0]) : null, handback: own[0] ? handbackBrief(own[0]) : null, deliverable, after: row.after_card_ids.filter((id) => agentCards.has(id)), sourceWords: row.source_words }];
  }));
}

/** 每个 Task 下一版交付物的号。 */
export async function nextVersions(q: Query, planTaskIds: string[]): Promise<Map<string, number>> {
  if (!planTaskIds.length) return new Map();
  const rows = (await q("SELECT task_id,max(number)::int AS number FROM deliverable_versions WHERE task_id=ANY($1::text[]) GROUP BY task_id", [planTaskIds])).rows as { task_id: string; number: number }[];
  return new Map(planTaskIds.map((id) => [id, (rows.find((row) => row.task_id === id)?.number ?? 0) + 1]));
}
