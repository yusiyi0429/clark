/**
 * 字符二元组重叠。**这个文件零 import，是有意的。**
 *
 * 两条链路要用同一个算法：预研拿它收窄靶点候选（`a3/targets.ts`），
 * 立案那一段拿它比「这条新信号和那条既有议题说的是不是同一件事」（`a1a/delta.ts`）。
 * 住在 `a3/targets.ts` 里的话，立案那一段会顺着它把 `Harness` 与 `a3/prompt.ts`
 * 整条预研依赖拖进自己的模块图 —— 那不是共用一个算法该付的代价。
 */

function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 字符二元组的 Jaccard 重叠。中文没有词边界，二元组是不引入分词器的最省办法。
 * 一个字的名字取不出二元组，退化成整串相等 —— 否则「A」和「B」会算成 1。
 */
export function bigramOverlap(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) {
    return a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase() ? 1 : 0;
  }
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}
