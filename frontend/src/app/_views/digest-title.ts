/**
 * 潜在议题那一屏的标题。
 *
 * 这一屏上有两份数据：立了案的卡，和还没立案的待挑信号。标题要对两份都负责 ——
 * 卡都处置完了、底下还躺着几条待挑的信号时，「今天的信号您都处置过了」是假话；
 * 一张卡都没有、雷达却过线了几条时，「还没有发现新情报」也是假话。
 *
 * 四句话按「有没有卡 → 有没有信号」分，一个分支一句，不拼。
 */
export function digestTitle({
  openCards,
  totalCards,
  openSignals,
}: {
  /** 今天这一批里还没处置的卡。 */
  openCards: number;
  /** 今天这一批一共几张卡（含处置过的）。0 = 今天一张都没进来。 */
  totalCards: number;
  /** 还在等他挑的信号。 */
  openSignals: number;
}): string {
  if (openCards > 0) return "值得注意的新议题";
  if (totalCards > 0) {
    return openSignals > 0
      ? `潜在议题都处置过了，还有 ${openSignals} 条信号等您挑。`
      : "今天的信号您都处置过了。";
  }
  return openSignals > 0 ? `雷达过线了 ${openSignals} 条，还没有一件立案。` : "还没有发现新情报";
}
