import type { TMissionRoundSummary } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";

/** 个人卡与战场的本轮摘要使用同一状态句；有本人卡时才说「这张卡」。 */
export function roundStatusText(round: TMissionRoundSummary, { cardId, feedbackCount, confirmation }: {
  cardId?: string | null;
  feedbackCount: number;
  confirmation?: { byName: string; at: string } | null;
}): string {
  if (round.phase === "draft") return round.approver ? round.todo ?? "个人卡草稿已就绪，可以统一开放讨论" : `草稿已整理 · 等${round.deciderName}统一开放讨论`;
  if (round.phase === "open") return `讨论中 · ${round.approver || !cardId ? `全战场 ${round.counts.feedback}` : `这张卡 ${feedbackCount}`} 条意见`;
  if (round.phase === "closed") return "已截止 · 汇总中";
  if (round.phase === "reviewing") {
    if (round.approver) return round.todo ?? (round.counts.pending ? `${round.counts.pending} 条待你处理` : "意见已全部处理，待你确认");
    if (!cardId) return `等${round.deciderName}拍板`;
    // 没有进入 Review 的意见时卡行写「等拍板」，接在「等某某拍板」后面会重复。
    const line = round.cards.find((row) => row.cardId === cardId)?.line ?? "候选版本就绪";
    return `等${round.deciderName}拍板${line === "等拍板" ? "" : ` · ${line}`}`;
  }
  return `已确定${confirmation ? ` · ${confirmation.byName} ${monthDayTime(confirmation.at)}` : ""}`;
}
