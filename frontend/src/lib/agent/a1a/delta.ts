import { sentences } from "@/lib/agent/rules";
// `bigramOverlap` 从 `@/lib/agent/overlap` 取，**不从 `a3/targets` 取**：那个文件顶上挂着
// `Harness` 与 `a3/prompt.ts`，从那里 import 会让 A1a 的模块图上多出整条预研依赖。
import { bigramOverlap } from "@/lib/agent/overlap";
import type { AggregateVerdict } from "@/lib/agent/a3/stages";

/** 重叠到这个程度就当同一条 —— 纯转载落在这一档，它该零产出。 */
export const SAME_MIN = 0.9;

/** 低到这个程度就当另一件事。中间那一段判成同一条但带增量。 */
export const SEPARATE_MAX = 0.3;

/**
 * 这条新信号是并进既有那条议题，还是自成一条；并的话多了哪几句。
 *
 * **它答的是文本上的问题，不替任何人判定「这两件事是同一件」** —— 调用方拿它去标注，
 * 不拿它去合卡。
 *
 * 机械判，不调模型：A1a 已经为「这是不是那条老议题」付过一次模型调用了
 * （`update_issue` 这条路由就是它的结论），这里要答的是更机械的一问 ——
 * **文本上多了什么**。同一个问题问两次模型，只会多一次说法不一致。
 *
 * 增量按句子取，而不是按整段：五天里同一事件的报道往往前半段一字不差、
 * 末尾多一句新进展，按段比会把整段判成新的。
 */
export function declareDelta(o: {
  incoming: string;
  existing: string;
}): { verdict: AggregateVerdict; delta: string[]; overlap: number } {
  const existing = o.existing.trim();
  if (!existing) return { verdict: "separate", delta: [], overlap: 0 };

  const overlap = bigramOverlap(o.incoming, existing);
  if (overlap < SEPARATE_MAX) return { verdict: "separate", delta: [], overlap };

  const old = sentences(existing);
  const delta = sentences(o.incoming).filter((s) => !old.some((t) => bigramOverlap(s, t) >= SAME_MIN));
  return { verdict: "merged", delta, overlap };
}
