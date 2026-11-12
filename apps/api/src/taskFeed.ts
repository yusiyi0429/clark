import type { TCardMerge, TProjectFeedItem, TProjectFeedResponse, TProjectTransfer, TTaskFeedItem } from "@warmap/contracts";
import { HANDBACKS_WITH_RELAY, effectiveOutcome, failStreak, gapPass, handbackBrief, type HandbackRow } from "./cardProjection.js";
import type { Query } from "./meetingStore.js";
import type { GoalRow } from "./projects.js";

/**
 * 项目对话里的验收行（契约 workHome.ts 的 TaskFeedItem、projects.ts 的 ProjectFeedItem，设计第 4.5、16.3 节）：从卡和交回现算，不另存事件。
 * 卡验收过了、受阻、约定都达到、合回后推翻开了返工卡，加挂上新目标的分隔线，网页按 at 插进项目对话。
 */

/** 本机报的合回结果（迁移 237 的 card_handbacks.merge，同一次交回存本机序号最大的一条，localSync.ts 写）。 */
export type StoredMerge = { merged: boolean; commit: string | null; baseBranch: string | null; reason: TCardMerge["reason"]; message: string | null; at: string };
type FeedHandback = HandbackRow & { merge: StoredMerge | null };

/** 合回结果给界面：合成了是 merged；没合成是 needs_merge，带原因和给人看的话。没报过为 null。 */
export const cardMerge = (stored: StoredMerge | null): TCardMerge | null => stored ? {
  state: stored.merged ? "merged" : "needs_merge", commit: stored.commit ?? null, baseBranch: stored.baseBranch ?? null,
  reason: stored.reason ?? null, message: stored.message ?? null, at: new Date(stored.at).toISOString() } : null;

/** 一次交回有结论的时间：「就到这里」过的按那个时间，推翻过的按推翻的时间，没推翻的按验完的时间。 */
const judgedAt = (row: FeedHandback) => (row.gap_closed_at ?? row.overruled_at ?? row.finished_at ?? row.created_at).toISOString();

/** 最近一次有结论的交回（排队、在验的不算）；handbacks 是新的在前。 */
const latestJudged = (handbacks: FeedHandback[]) => handbacks.find((row) => row.status === "done" && effectiveOutcome(row) !== null);

type FeedCard = { id: string; title: string; status: string; plan_task_id: string | null; criterion_index: number | null; rework_of_card_id: string | null; created_at: Date };

/** 这些卡的交回，按卡分（新的在前）。 */
async function handbacksOf(q: Query, cards: FeedCard[]): Promise<Map<string, FeedHandback[]>> {
  const handbacks = cards.length ? (await q(`${HANDBACKS_WITH_RELAY} WHERE h.task_id=ANY($1::uuid[]) ORDER BY h.attempt DESC`,
    [cards.map((card) => card.id)])).rows as FeedHandback[] : [];
  return new Map(cards.map((card) => [card.id, handbacks.filter((row) => row.task_id === card.id)]));
}

/** 每条标准最早让它达到的那次通过（对它的卡里最近一次有结论的交回算通过）；没达到的为 undefined。 */
function criteriaMetAt(cards: FeedCard[], byCard: Map<string, FeedHandback[]>, taskId: string, count: number): (string | undefined)[] {
  return Array.from({ length: count }, (_, index) => cards.filter((card) => card.plan_task_id === taskId && card.criterion_index === index + 1)
    .flatMap((card) => { const latest = latestJudged(byCard.get(card.id)!); return latest && effectiveOutcome(latest) === "pass" ? [judgedAt(latest)] : []; }).sort()[0]);
}

/** 卡的验收行：过了（每次算通过的交回一行）、受阻、等你补（每次一行）、合回后推翻开的返工卡。 */
function cardItems(cards: FeedCard[], byCard: Map<string, FeedHandback[]>): TTaskFeedItem[] {
  const items: TTaskFeedItem[] = [];
  for (const card of cards) {
    const mine = byCard.get(card.id)!;
    // 验收过了：每次算通过的交回一行（含本人「就到这里」，那种算全部达到，gap 写本人的原因）。
    for (const row of mine) if (row.status === "done" && effectiveOutcome(row) === "pass") {
      const verdicts = row.result?.criteria ?? [];
      const total = row.result ? verdicts.length : row.criteria.length;
      items.push({ kind: "card_passed", id: `passed:${row.id}`, at: judgedAt(row), cardId: card.id, title: card.title,
        met: row.overruled_at ? total : verdicts.filter((item) => item.verdict === "met").length, total, merge: cardMerge(row.merge),
        gap: gapPass(row)?.reason ?? null });
    }
    // 等你补（主循环第 61 条）：每次结论是等本人补的交回一行（在验完的时间），项目对话里照第 54 条只指过去；handback 带一句人话、逐条、送到没有。
    for (const row of mine) if (row.status === "done" && row.outcome === "needs_person")
      items.push({ kind: "card_needs_person", id: `needs_person:${row.id}`, at: (row.finished_at ?? row.created_at).toISOString(), cardId: card.id, title: card.title,
        handbackId: row.id, fix: row.return_text, sourceWordIssues: row.result?.sourceWordIssues ?? [], handback: handbackBrief(row) });
    // 受阻（连续两次没过，同卡的投影；完成了的卡不算）：最近那次没过的交回一行，改法是它的 return_text。
    if (card.status !== "done" && failStreak(mine) >= 2) {
      const failed = mine.find((row) => row.status === "done" && effectiveOutcome(row) === "fail")!;
      items.push({ kind: "card_blocked", id: `blocked:${failed.id}`, at: judgedAt(failed), cardId: card.id, title: card.title, handbackId: failed.id, fix: failed.return_text,
        sourceWordIssues: failed.result?.sourceWordIssues ?? [], handback: handbackBrief(failed) });
    }
    // 合回后推翻开的返工卡：理由在原卡被推翻的那次（本来通过的）交回上，取最近一次。
    if (card.rework_of_card_id) {
      const overruled = (byCard.get(card.rework_of_card_id) ?? []).find((row) => row.outcome === "pass" && row.overruled_at);
      items.push({ kind: "rework_opened", id: `rework:${card.id}`, at: card.created_at.toISOString(), cardId: card.id, title: card.title,
        fromCardId: card.rework_of_card_id, reason: overruled?.overrule_reason ?? "" });
    }
  }
  return items;
}

/** 约定都达到：每一条都至少有一张对它的卡、最近一次有结论的交回算通过；at 是让最后一条达到的那次通过。没有标准的 Task 不出。 */
function criteriaMetItem(cards: FeedCard[], byCard: Map<string, FeedHandback[]>, taskId: string, criteria: string[]): TTaskFeedItem[] {
  if (!criteria.length) return [];
  const metAt = criteriaMetAt(cards, byCard, taskId, criteria.length);
  return metAt.every(Boolean) ? [{ kind: "criteria_met", id: `criteria:${taskId}:${criteria.length}`, at: (metAt as string[]).sort().at(-1)!, taskId,
    met: criteria.length, total: criteria.length }] : [];
}

const byTime = (a: { at: string; id: string }, b: { at: string; id: string }) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
const FEED_CARD = "id::text,title,status,plan_task_id,criterion_index,rework_of_card_id::text,created_at";

/** 这几件 Task 各有几条标准达到了（首页项目行的「标准 1/3」）。 */
export async function criteriaMetCounts(q: Query, ownerId: string, tasks: { taskId: string; count: number }[]): Promise<Map<string, number>> {
  const wanted = tasks.filter((task) => task.count > 0);
  const cards = wanted.length ? (await q(`SELECT ${FEED_CARD} FROM tasks WHERE owner_id=$1 AND plan_task_id=ANY($2::text[]) AND criterion_index IS NOT NULL`,
    [ownerId, wanted.map((task) => task.taskId)])).rows as FeedCard[] : [];
  const byCard = await handbacksOf(q, cards);
  return new Map(tasks.map((task) => [task.taskId, criteriaMetAt(cards, byCard, task.taskId, task.count).filter(Boolean).length]));
}

/**
 * 转交那几行（16.7）：接手了的两边都有换人分隔线；接手人那边紧跟一条交接说明（同一时刻按 id，handover: 在 summary: 前面）；没接的只给原负责人一行。
 */
function transferItems(viewer: string, transfers: TProjectTransfer[]): TProjectFeedItem[] {
  return transfers.flatMap((transfer): TProjectFeedItem[] => {
    const at = transfer.decidedAt!;
    if (transfer.status === "declined") return transfer.from.personId === viewer
      ? [{ kind: "transfer_declined", id: `declined:${transfer.id}`, at, transferId: transfer.id, by: transfer.to }] : [];
    return [{ kind: "handover", id: `handover:${transfer.id}`, at, transferId: transfer.id, from: transfer.from, to: transfer.to },
      ...transfer.to.personId === viewer ? [{ kind: "handover_summary" as const, id: `summary:${transfer.id}`, at, transferId: transfer.id, from: transfer.from,
        note: transfer.note ?? [] }] : []];
  });
}

/**
 * GET /api/me/projects/:projectId/feed：项目里的卡（挂过的 Task 下的，和直接放在项目里的；owners 是负责过这个项目的人）的验收行，每件挂过的 Task 的「约定都达到」，
 * 加每次挂上一件 Task 的分隔线（goal_linked）和转交那几行，从旧到新。criteria：每件 Task 的标准（读不到为空，不出「约定都达到」）。
 */
export async function readProjectFeed(q: Query, owners: string[], projectId: string, goals: GoalRow[], criteria: Map<string, string[]>,
  transfer: { viewer: string; transfers: TProjectTransfer[] } = { viewer: "", transfers: [] }, extra: TProjectFeedItem[] = []): Promise<TProjectFeedResponse> {
  const taskIds = goals.map((goal) => goal.task_id);
  const cards = (await q(`SELECT ${FEED_CARD} FROM tasks WHERE owner_id=ANY($1::text[]) AND (plan_task_id=ANY($2::text[]) OR plan_task_id IS NULL AND project_id=$3)`,
    [owners, taskIds, projectId])).rows as FeedCard[];
  const byCard = await handbacksOf(q, cards);
  const items: TProjectFeedItem[] = [
    ...goals.map((goal) => ({ kind: "goal_linked" as const, id: `goal:${goal.task_id}`, at: goal.linked_at.toISOString(), period: goal.period, taskId: goal.task_id,
      taskName: goal.task_name })),
    ...cardItems(cards, byCard),
    ...goals.flatMap((goal) => criteriaMetItem(cards, byCard, goal.task_id, criteria.get(goal.task_id) ?? [])),
    ...transferItems(transfer.viewer, transfer.transfers),
    ...extra,
  ];
  return { items: items.sort(byTime) };
}
