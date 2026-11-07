import type { TCardMerge, TTaskFeedItem, TTaskFeedResponse } from "@warmap/contracts";
import { effectiveOutcome, failStreak, type HandbackRow } from "./cardProjection.js";
import type { Query } from "./meetingStore.js";

/**
 * Task 管线里的验收行（契约 workHome.ts 的 TaskFeedItem，设计第 4.5 节）：从卡和交回现算，不另存事件。
 * 卡验收过了、受阻、约定都达到、合回后推翻开了返工卡，网页按 at 插进 Task 管线。
 */

/** 本机报的合回结果（迁移 237 的 card_handbacks.merge，同一次交回存本机序号最大的一条，localSync.ts 写）。 */
export type StoredMerge = { merged: boolean; commit: string | null; baseBranch: string | null; reason: TCardMerge["reason"]; message: string | null; at: string };
type FeedHandback = HandbackRow & { merge: StoredMerge | null };

/** 合回结果给界面：合成了是 merged；没合成是 needs_merge，带原因和给人看的话。没报过为 null。 */
export const cardMerge = (stored: StoredMerge | null): TCardMerge | null => stored ? {
  state: stored.merged ? "merged" : "needs_merge", commit: stored.commit ?? null, baseBranch: stored.baseBranch ?? null,
  reason: stored.reason ?? null, message: stored.message ?? null, at: new Date(stored.at).toISOString() } : null;

/** 一次交回有结论的时间：推翻过的按推翻的时间，没推翻的按验完的时间。 */
const judgedAt = (row: FeedHandback) => (row.overruled_at ?? row.finished_at ?? row.created_at).toISOString();

/** 最近一次有结论的交回（排队、在验的不算）；handbacks 是新的在前。 */
const latestJudged = (handbacks: FeedHandback[]) => handbacks.find((row) => row.status === "done" && effectiveOutcome(row) !== null);

type FeedCard = { id: string; title: string; status: string; criterion_index: number | null; rework_of_card_id: string | null; created_at: Date };

/**
 * GET /api/me/tasks/:taskId/feed：本人在这件 Task 下的卡（不读别人的卡），从旧到新，同一时间按 id。
 * criteria 是 Task 的标准（boardTask 给的，本体没写标准时是完成定义那一条）。
 */
export async function readTaskFeed(q: Query, ownerId: string, taskId: string, criteria: string[]): Promise<TTaskFeedResponse> {
  const cards = (await q("SELECT id::text,title,status,criterion_index,rework_of_card_id::text,created_at FROM tasks WHERE plan_task_id=$1 AND owner_id=$2",
    [taskId, ownerId])).rows as FeedCard[];
  const handbacks = cards.length ? (await q("SELECT * FROM card_handbacks WHERE task_id=ANY($1::uuid[]) ORDER BY attempt DESC",
    [cards.map((card) => card.id)])).rows as FeedHandback[] : [];
  const byCard = new Map(cards.map((card) => [card.id, handbacks.filter((row) => row.task_id === card.id)]));
  const items: TTaskFeedItem[] = [];

  for (const card of cards) {
    const mine = byCard.get(card.id)!;
    // 验收过了：每次算通过的交回一行（含本人「仍然通过」，那种算全部达到）。
    for (const row of mine) if (row.status === "done" && effectiveOutcome(row) === "pass") {
      const verdicts = row.result?.criteria ?? [];
      const total = row.result ? verdicts.length : row.criteria.length;
      items.push({ kind: "card_passed", id: `passed:${row.id}`, at: judgedAt(row), cardId: card.id, title: card.title,
        met: row.overruled_at ? total : verdicts.filter((item) => item.verdict === "met").length, total, merge: cardMerge(row.merge) });
    }
    // 受阻（连续两次没过，同卡的投影；完成了的卡不算）：最近那次没过的交回一行，改法是它的 return_text。
    if (card.status !== "done" && failStreak(mine) >= 2) {
      const failed = latestJudged(mine)!;
      items.push({ kind: "card_blocked", id: `blocked:${failed.id}`, at: judgedAt(failed), cardId: card.id, title: card.title, handbackId: failed.id, fix: failed.return_text });
    }
    // 合回后推翻开的返工卡：理由在原卡被推翻的那次（本来通过的）交回上，取最近一次。
    if (card.rework_of_card_id) {
      const overruled = (byCard.get(card.rework_of_card_id) ?? []).find((row) => row.outcome === "pass" && row.overruled_at);
      items.push({ kind: "rework_opened", id: `rework:${card.id}`, at: card.created_at.toISOString(), cardId: card.id, title: card.title,
        fromCardId: card.rework_of_card_id, reason: overruled?.overrule_reason ?? "" });
    }
  }

  // 约定都达到：每一条都至少有一张对它的卡、最近一次有结论的交回算通过；at 是让最后一条达到的那次通过
  // （每条取对它的卡里最早的那次通过，再取各条里最晚的）。没有标准的 Task 不出。
  if (criteria.length) {
    const metAt = criteria.map((_, index) => cards.filter((card) => card.criterion_index === index + 1)
      .flatMap((card) => { const latest = latestJudged(byCard.get(card.id)!); return latest && effectiveOutcome(latest) === "pass" ? [judgedAt(latest)] : []; }).sort()[0]);
    if (metAt.every(Boolean)) items.push({ kind: "criteria_met", id: `criteria:${taskId}:${criteria.length}`, at: metAt.sort().at(-1)!,
      met: criteria.length, total: criteria.length });
  }

  items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { items };
}
