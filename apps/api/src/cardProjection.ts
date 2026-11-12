import type { TCardCriterionVerdict, TCardFixBy, TCardGapItem, TCardGit, TCardHandbackBrief, TCardHandbackOutcome, TCardModel, TCardRelayView, TCardWait, TDeliverableInclusion, TLocalGitRef,
  TLocalHandbackCriterion, TTaskCard, TTaskView, TCardSourceWordIssue } from "@warmap/contracts";
import { askingQuestion, runBrief, type RunRow } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { roleRef, rolesById } from "./roles.js";

/**
 * 卡的投影（V2 设计第 3 节）：每件执行事项的 card——列、标记、岗位、最近一次执行和交回、进交付物到哪了，读的时候算。
 * 单独一个文件，执行事项的投影（tasks.ts）和看板（taskCards.ts）都用它，不互相引用。
 */

/** 一次交回在库里的验收结论。 */
/** sourceWordIssues：和本人原话对不上的几处（16.8，本机验收员报的；云端验收和老的结论没有）。 */
/** 主循环第 61 条：verdict 多 needs_person，fixBy 是没达到时谁来补（老结论没有）。 */
export type StoredCriterion = { index: number; verdict: TCardCriterionVerdict; reason: string; evidence: string | null; fix: string | null; fixBy?: TCardFixBy | null };
export type StoredAcceptance = { headline: string | null; criteria: StoredCriterion[]; beyondScope: string[]; sourceWordIssues?: TCardSourceWordIssue[] };
export type HandbackRow = { id: string; task_id: string; run_id: string | null; owner_id: string; attempt: number; criteria: string[]; claims: TLocalHandbackCriterion[];
  summary: string | null; output_ids: string[]; status: TCardHandbackBrief["status"]; started_at: Date | null; finished_at: Date | null; error: string | null;
  result: StoredAcceptance | null; outcome: TCardHandbackOutcome | null; return_text: string | null; returned_at: Date | null; overruled_at: Date | null;
  overruled_by: string | null; overrule_reason: string | null; created_at: Date;
  /** 本人推翻过的通过造成受阻后「就到这里」的时间和原因（迁移 279）。 */
  gap_closed_at?: Date | null; gap_close_reason?: string | null;
  verifier_source: "cloud" | "local" | null; verifier_model: string | null; verifier_role_id: string | null; verifier_role_version: number | null;
  git: TLocalGitRef | null; verified_commit: string | null;
  /** 「我来补」送到的时间（主循环第 61 条）。 */
  supplied_at?: Date | null;
  /** 这次交回最近一次登记的「再改一轮」「我来补」（HANDBACKS_WITH_RELAY 读的才有）。 */
  relay?: StoredRelay | null };
/** session_commands 里登记的那一条（json_build_object 读出来的，时间是字符串）。 */
export type StoredRelay = { id: string; relay: "return" | "supply"; text: string; requested_at: string; done_at: string | null; result: string | null; message: string | null };

/** 读交回连同最近一次登记的「再改一轮」「我来补」（看板、卡的详情用）。条件接在后面，表名 h。 */
export const HANDBACKS_WITH_RELAY = `SELECT h.*,(SELECT json_build_object('id',c.id,'relay',c.relay,'text',c.command->>'text','requested_at',c.requested_at,'done_at',c.done_at,
  'result',c.result,'message',c.message) FROM session_commands c WHERE c.handback_id=h.id ORDER BY c.requested_at DESC,c.id DESC LIMIT 1) AS relay FROM card_handbacks h`;

const RELAY_FAILED: Record<string, string> = { not_running: "那台电脑上已经没有这个会话了", expired: "已经失效了" };
function relayView(relay: StoredRelay): TCardRelayView {
  const state = !relay.done_at ? "pending" : relay.result === "done" ? "delivered" : "failed";
  return { id: relay.id, kind: relay.relay, state, text: relay.text, requestedAt: new Date(relay.requested_at).toISOString(),
    doneAt: relay.done_at ? new Date(relay.done_at).toISOString() : null,
    message: state === "failed" ? relay.message ?? RELAY_FAILED[relay.result ?? ""] ?? "没送成" : null };
}
export type CardRow = { id: string; status: TTaskView["status"]; executor: TTaskCard["executor"]; model: TCardModel | null; brief: string | null;
  criterion_index: number | null; criterion_text: string | null; plan_task_id: string | null; done_definition: string | null; mission_id: string | null;
  role_id: string | null; after_card_ids: string[]; source_words: string[] };

/** 本机报 hold（订阅额度用完，停着等恢复）时会话的几种状态：排着没开始、一轮停在中间（等你说话的状态）、进程退了。 */
export const HOLD_STATES = ["queued", "idle", "exited"];

/** 没达到的一条该谁补：needs_person 一定是本人；老结论没写 fixBy 的按执行方。 */
export const fixByOf = (item: Pick<StoredCriterion, "verdict" | "fixBy">): TCardFixBy => item.verdict === "needs_person" ? "person" : item.fixBy ?? "worker";

/**
 * 一次交回的结论（契约 CardHandbackOutcome，主循环第 61 条）：每条都达到、原话对得上 → pass；
 * 否则有一条要本人补（needs_person 或 fixBy = person）→ needs_person（第一次就这样也直接等你补）；其余 → fail。
 */
export function outcomeOf(result: StoredAcceptance): TCardHandbackOutcome {
  if (result.criteria.every((item) => item.verdict === "met") && !result.sourceWordIssues?.length) return "pass";
  return result.criteria.some((item) => item.verdict !== "met" && fixByOf(item) === "person") ? "needs_person" : "fail";
}

/**
 * 推翻过的验收按本人的判断算：通过的推翻算没过；没过的、等本人补的推翻（「就到这里」）算通过。
 * 通过的推翻以后又「就到这里」了（gap_closed_at）算通过。
 */
export const effectiveOutcome = (row: Pick<HandbackRow, "outcome" | "overruled_at" | "gap_closed_at">): TCardHandbackOutcome | null =>
  row.gap_closed_at ? "pass" : row.outcome && row.overruled_at ? (row.outcome === "pass" ? "fail" : "pass") : row.outcome;

/** 有缺口通过（主循环第 62 条「就到这里」）：没过、等本人补的那次被推翻成通过；或本人推翻过的通过又「就到这里」了。不是为 null。 */
export function gapPass(row: Pick<HandbackRow, "outcome" | "overruled_at" | "overrule_reason" | "gap_closed_at" | "gap_close_reason">): { reason: string; at: Date } | null {
  if (row.gap_closed_at && row.gap_close_reason) return { reason: row.gap_close_reason, at: row.gap_closed_at };
  return row.overruled_at && row.outcome !== "pass" && row.overrule_reason ? { reason: row.overrule_reason, at: row.overruled_at } : null;
}

/** 连续几次没过（从最近一次往前数，排队或在验收的不算；等本人补的那次跳过，不算也不打断）。 */
export function failStreak(handbacks: Pick<HandbackRow, "status" | "outcome" | "overruled_at">[]): number {
  let streak = 0;
  for (const row of handbacks) {
    const outcome = row.status === "done" ? effectiveOutcome(row) : null;
    if (outcome === null || outcome === "needs_person") continue;
    if (outcome !== "fail") break;
    streak++;
  }
  return streak;
}

/** 一条标准的短标题（「就到这里」「我来补」预填用）：到第一个逗号、句号、分号、冒号、括号为止，最多 20 字。 */
export function shortStandard(text: string, index: number): string {
  const head = text.trim().split(/[，,。；;：:（(]/)[0].trim();
  return (head || text.trim()).slice(0, 20) || `第 ${index} 条`;
}

/** 交回里没达到的几条（契约 CardGapItem），按 index 排。fix 没写时用执行方交回时写的 need。 */
export function handbackGaps(row: Pick<HandbackRow, "criteria" | "claims" | "result">): TCardGapItem[] {
  return (row.result?.criteria ?? []).filter((item) => item.verdict !== "met").sort((a, b) => a.index - b.index).map((item) => ({
    index: item.index, short: shortStandard(row.criteria[item.index - 1] ?? "", item.index), verdict: item.verdict, fixBy: fixByOf(item),
    fix: item.fix ?? row.claims.find((claim) => claim.index === item.index)?.need ?? null }));
}

/** 交回的分支和提交、验的提交（卡在工作树里做时才有，ADR 0038）。 */
export const cardGit = (row: Pick<HandbackRow, "git" | "verified_commit">): TCardGit | null => row.git ? { ...row.git, verifiedCommit: row.verified_commit } : null;

export function handbackBrief(row: HandbackRow): TCardHandbackBrief {
  const criteria = row.result?.criteria ?? [], gap = gapPass(row);
  return { id: row.id, attempt: row.attempt, status: row.status, outcome: row.outcome, met: criteria.filter((item) => item.verdict === "met").length, total: criteria.length,
    headline: row.result?.headline ?? null, returnText: row.return_text, returnedAt: row.returned_at?.toISOString() ?? null, overruled: row.overruled_at !== null,
    createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null, git: cardGit(row),
    sourceWordIssues: row.result?.sourceWordIssues ?? [], gaps: handbackGaps(row), relay: row.relay ? relayView(row.relay) : null,
    // 有缺口通过（主循环第 62 条「就到这里」）：没过、等本人补的那次被本人推翻成通过。
    passedWithGap: gap ? { reason: gap.reason, at: gap.at.toISOString() } : null,
    // 受阻是本人推翻造成的时候（通过被推翻成没过），受阻框第一行写推翻的原因。
    overruleReason: row.overruled_at ? row.overrule_reason : null };
}

/** 列和标记（第 3 节）：handbacks、runs 都是新的在前。 */
function stageAndWait(row: CardRow, handbacks: HandbackRow[], runs: RunRow[]): Pick<TTaskCard, "stage" | "wait"> {
  if (row.status === "not_started") return { stage: "todo", wait: null };
  if (row.status === "done") return { stage: "done", wait: null };
  const latest = handbacks[0];
  if (latest && (latest.status === "queued" || latest.status === "running")) return { stage: "review", wait: null };
  // 等你补（主循环第 61 条）：最近一次交回是等本人补、本人还没「就到这里」，排在受阻前面。
  // 「我来补」送到了就不再等。
  if (latest?.status === "done" && effectiveOutcome(latest) === "needs_person" && !latest.supplied_at) return { stage: "doing", wait: "needs_person" };
  const failedRuns = runs.length >= 2 && runs.slice(0, 2).every((run) => run.state === "failed");
  // 受阻：「再改一轮」送到（returnedAt）以后就不是了（主循环第 62 条）。
  if ((failStreak(handbacks) >= 2 && !latest?.returned_at) || failedRuns) return { stage: "doing", wait: "blocked" };
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
  const handbacks = (await q(`${HANDBACKS_WITH_RELAY} WHERE h.task_id=ANY($1::uuid[]) ORDER BY h.attempt DESC`, [ids])).rows as HandbackRow[];
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
