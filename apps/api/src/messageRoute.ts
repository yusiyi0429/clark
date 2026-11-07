import type { TRouteResponse } from "@warmap/contracts";

/**
 * 首页输入框选「自动」时这一句发给谁（契约 workHome.ts 的 RouteResponse；简报第 4.1 节、设计 16.4）。
 * 目标只有伙伴的总管线（main）或某个项目的对话，不直接发给子会话。网页打字时每 300 ms 左右调一次给「发给」标签预览，所以只看字面、不用模型：
 * - 一个项目「命中」= 句子里有它的完整名字（项目名，或它挂着的 Task 的名字），或有它**独有**的关键词（这些名字、完成定义、标准里的英文数字词如 V2、PR80，
 *   不分大小写；连续汉字的两字一组）。几个项目都有的词不算任何一个的；纯数字（日期、时间）不算词。
 * - 恰好一个项目命中就发给它；没有命中、或不止一个命中，都发给伙伴（伙伴能自己答，也能问一句转到哪个项目）。
 * - 完整名字一个套一个时（「上线」和「上线 V1」都出现在「上线 V1 怎么样」里），只算最长的那个。
 */
export type RouteProject = { projectId: string; names: string[]; text: string[] };

/** 一段文字里的词：英文数字词（小写，至少 2 个字符，不要纯数字）和汉字两字一组。 */
function words(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (word.length >= 2 && !/^\d+$/.test(word)) found.add(word);
  for (const run of text.match(/[一-鿿]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) found.add(run.slice(i, i + 2));
  return found;
}

export function routeMessage(text: string, projects: RouteProject[]): TRouteResponse {
  const sentence = text.toLowerCase();
  const names = projects.flatMap((project) => project.names.map((name) => ({ projectId: project.projectId, name: name.trim().toLowerCase() })))
    .filter((entry) => entry.name && sentence.includes(entry.name));
  // 名字出现在句子里的；被别的项目一个出现了的、更长的名字包住的不算（说的是同一处）。
  const named = names.filter((entry) => !names.some((other) => other.projectId !== entry.projectId && other.name.length > entry.name.length
    && other.name.includes(entry.name)));

  const own = projects.map((project) => words([...project.names, ...project.text].join("\n")));
  const spread = new Map<string, number>();
  for (const set of own) for (const word of set) spread.set(word, (spread.get(word) ?? 0) + 1);
  const asked = words(text);
  const keyed = projects.filter((_, index) => [...own[index]].some((word) => spread.get(word) === 1 && asked.has(word)));

  const hit = new Set([...named.map((entry) => entry.projectId), ...keyed.map((project) => project.projectId)]);
  return hit.size === 1 ? { target: { projectId: [...hit][0] } } : { target: "main" };
}
