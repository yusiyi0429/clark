import type { TRouteResponse } from "@warmap/contracts";

/**
 * 首页输入框选「自动」时这一句发给谁（契约 workHome.ts 的 RouteResponse）。先不用模型，只看字面：
 * - 句子里有某件 Task 的完整名字，就发给那件（几件都有时取名字最长的）；
 * - 否则按关键词打分：名字、完成定义、标准里的英文数字词（V1、PR80，不分大小写，至少 2 个字符）和连续汉字的两字一组；
 *   名字里来的词分量 ×2，一个词几件 Task 都有时分量按件数平分（几件都有的词分不出是哪件）；
 *   最高分至少 1、而且严格高过第二名才发给那件，不然发给伙伴的总管线。
 */
export type RouteTask = { taskId: string; name: string; doneDefinition: string | null; criteria: string[] };

/** 一段文字里的词：英文数字词（小写）和汉字两字一组。 */
function words(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (word.length >= 2) found.add(word);
  for (const run of text.match(/[一-鿿]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) found.add(run.slice(i, i + 2));
  return found;
}

export function routeMessage(text: string, tasks: RouteTask[]): TRouteResponse {
  const sentence = text.toLowerCase();
  const named = tasks.filter((task) => task.name.trim() && sentence.includes(task.name.trim().toLowerCase()))
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  if (named.length) return { target: { taskId: named[0].taskId } };

  // 每件 Task 的词和分量：名字里的 2，别处的 1。
  const weights = tasks.map((task) => {
    const own = new Map<string, number>();
    for (const word of words([task.doneDefinition ?? "", ...task.criteria].join("\n"))) own.set(word, 1);
    for (const word of words(task.name)) own.set(word, 2);
    return own;
  });
  const spread = new Map<string, number>();
  for (const own of weights) for (const word of own.keys()) spread.set(word, (spread.get(word) ?? 0) + 1);
  const asked = words(text);
  const scores = tasks.map((task, index) => ({ taskId: task.taskId,
    score: [...weights[index]].reduce((sum, [word, weight]) => asked.has(word) ? sum + weight / spread.get(word)! : sum, 0) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (best && best.score >= 1 && (!second || best.score > second.score)) return { target: { taskId: best.taskId } };
  return { target: "main" };
}
