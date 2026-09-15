/**
 * 轮内取证 —— 复用深研那套检索与共源，查不到也不让这一轮失败。
 *
 * 这一层的职责是「把对谈里这一次的问题包成一条命题，走既有那条取证路，产出同一种
 * 证据对象」。**不许重写检索、不许重写摘要核对、不许重写共源判定** —— 唯一要维护的
 * harness/pipeline 是 `src/lib/agent/a4/evidence.ts` 那套。
 *
 * ## 查不到是合法结果（HP-5）
 *
 * `not_found` 不是异常，是两个终态之一。调用方拿到它就照先验回答并声明「我的先验，
 * 未验证」，同时挂一条异步补证。轮内那 30 秒是有限的，用完了照实返回、不抛异常。
 */

import type { Harness } from "@/lib/agent/harness";
import type { Evidence } from "@/lib/research/ledger";
import type { SearchProvider } from "@/lib/research/search";

import { gatherEvidence } from "@/lib/agent/a4/evidence";
import type { Proposition } from "@/lib/agent/a4/props";

/**
 * 轮内取证的三个上限。各自映到不同位置：
 * - `maxQueries: 5` → 组命题时 `queries.length + counterQueries.length` 的上限。
 *   当前固定模板是 2 条（1 正 + 1 反），这个数是模板将来长大时的天花板。
 *   切分规则见 `capQueries`：正问优先吃额度，反证至少留一条。
 * - `maxSources: 5` → `gatherEvidence` 的 `budget.searchK`（每条检索式向每一家取几条）。
 * - `criticPasses: 1` → `budget.maxRounds`（复用既有那一次追问，不新加一轮）。
 */
export const MICRO_LIMITS = { maxQueries: 5, maxSources: 5, criticPasses: 1 } as const;

/**
 * 把正问与反证两栏检索式压到 `maxQueries` 之内。
 *
 * 规则是**正问优先吃额度，但反证至少留一条**。为什么不让正问把额度吃光：
 * 「零反证」在这个产品里是缺陷（深研那边的出口对账专门查这一项），轮内取证要是
 * 只发顺着结论的问法，找回来的材料会系统性地偏向他已经想要的那个答案 —— 这正是
 * 反谄媚那条硬原则要防的东西。所以上限触发时先砍正问，不砍反证。
 */
export function capQueries(
  queries: readonly string[],
  counterQueries: readonly string[],
  max: number,
): { queries: string[]; counterQueries: string[] } {
  const kept = counterQueries.slice(0, Math.max(1, max - queries.length));
  return { queries: queries.slice(0, max - kept.length), counterQueries: kept };
}

export type MicroResult =
  | { kind: "found"; entries: Evidence[]; independentGroups: number }
  | { kind: "not_found"; tried: string[]; why: string };

/**
 * 轮内取证 —— 把这一次的问题包成一条命题，走同一个 `gatherEvidence`，产出同一个
 * `Evidence`。
 *
 * 组命题不发模型调用 —— 一个固定模板就够，而且轮内那 30 秒不该花在「先请模型把问题
 * 改写成命题」上。
 */
export async function runMicroResearch(
  h: Harness,
  deps: { search: SearchProvider[] },
  q: { question: string; issueId: string },
  options: { maxPages?: number } = {},
): Promise<MicroResult> {
  // 组命题：固定模板，不发模型。
  const queries = [q.question];
  const counterQueries = [`${q.question} 反例`];

  // 按 maxQueries 上限截断。当前模板是 2 条，这道闸是模板将来长大时的天花板。
  const capped = capQueries(queries, counterQueries, MICRO_LIMITS.maxQueries);

  const prop: Proposition = {
    id: "P1", // 硬编码 "P1" 以匹配 a4.extract 罐头（src/lib/models/mock.ts）
    statement: q.question,
    requiredEvidence: "能直接回答这个问题的原句，带机构与统计期间",
    queries: capped.queries,
    counterQueries: capped.counterQueries,
    material: true,
    freshnessUrgent: false,
    extraRoundsCap: 0, // 补搜由 budget.maxRounds 卡，这里不再放
  };

  // 调用 gatherEvidence —— 走既有那套检索、抓取、抽取、入账、折叠、判定。
  const result = await gatherEvidence(
    h,
    deps.search,
    [prop],
    { searchK: MICRO_LIMITS.maxSources, maxRounds: MICRO_LIMITS.criticPasses, maxPages: options.maxPages },
    {
      slot: h.slot, // 抽取那几次调用要和主对谈同一个槽位
      label: "对谈取证",
      substep: () => {}, // 轮内没有 DraftReport 那块进度表可报，进度是 SSE 那一路在报的
    }
  );

  // 数独立来源组数 —— gatherEvidence 每一轮已经对全部快照重折过并写回台账了。
  if (result.ledger.entries.length === 0) {
    // 查不到是合法结果（HP-5）—— 不抛，返回 not_found。
    const tried = prop.queries.concat(prop.counterQueries);
    return {
      kind: "not_found",
      tried,
      why: tried.length === 1
        ? "这个问法没搜到能回答的材料"
        : "这些问法都没搜到能回答的材料",
    };
  }

  const independentGroups = new Set(result.ledger.entries.map((e) => e.independenceGroup)).size;

  return {
    kind: "found",
    entries: result.ledger.entries,
    independentGroups,
  };
}
