import type { TMissionRoundSummary } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";

/** 任务卡与战场统一投影审核进度；其他阶段直接使用后台状态。 */
export function roundStatusText(round: TMissionRoundSummary, { cardId, confirmation, corrected = 0 }: {
  cardId?: string | null;
  feedbackCount: number;
  confirmation?: { byName: string; at: string } | null;
  /** 这张卡已采纳的更正数（GAP-04）。 */
  corrected?: number;
}): string {
  if (round.phase === "drafting") return "Co-Agent 正在起草";
  if (round.phase === "draft") return round.approver ? round.todo ?? "任务草稿已就绪，可以下发本人确认" : `草稿已整理 · 等${round.deciderName}下发本人确认`;
  if (round.phase === "open") {
    if (round.approver || !cardId) return `本人已确认 ${round.counts.cards - round.counts.unreviewed}/${round.counts.cards}`;
    return round.cards.find((row) => row.cardId === cardId)?.ownerConfirmedAt ? "本人已确认" : "待本人确认";
  }
  if (round.phase === "closed") return round.counts.unreviewed ? `仍有 ${round.counts.unreviewed} 人待本人确认` : "Co-Agent 正在统一核对";
  if (round.phase === "reviewing") {
    if (round.coAgentReview?.status === "queued" || round.coAgentReview?.status === "running") return "Co-Agent 正在统一核对";
    if (round.coAgentReview?.status === "failed") return "Co-Agent 核对未完成";
    if (round.approver) return round.todo ?? "待战场 DRI 确认任务组合";
    return `待战场 DRI ${round.deciderName}确认任务组合`;
  }
  // 已确定后拍板人还有更正申请要处理时，状态句就是服务端的待办，与通知同一句；月份过了服务端不再给待办。
  if (round.approver && round.todo) return round.todo;
  return `已确定${confirmation ? ` · ${confirmation.byName} ${monthDayTime(confirmation.at)}` : ""}${corrected ? ` · 更正 ${corrected} 处` : ""}`;
}
