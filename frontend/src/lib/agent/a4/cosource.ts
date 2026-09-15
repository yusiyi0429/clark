// src/lib/agent/a4/cosource.ts
/**
 * 共源率与改写触发。**共源判定放在检索循环里，不留到合成阶段。**
 *
 * 上一版是在合成时才去重的：26 条证据弃用 15 条 —— 检索预算已经花掉了，弃用清单只是
 * 事后记账。放进循环之后，一波回来共源率过半就当场改写问法：那一波已经说明这个问法只
 * 通向同一批稿子的转载，再发一遍原问法（或它的微调）只会再取回同一批。
 *
 * 独立性折叠本身不在这里 —— `research/independence.ts` 干那件事，`Ledger.fold` 把组号
 * 写回每条证据。这个文件只回答「这一波的组号分布该不该触发改写」以及「改写问什么」。
 */

import type { Evidence } from "@/lib/research/ledger";

/** 这一波的共源情况。`share` = 1 - 独立组数/条数：零表示条条独立，越高表示越挤在一起。 */
export function waveShare(entries: readonly Pick<Evidence, "independenceGroup">[]): {
  total: number;
  distinct: number;
  share: number;
} {
  const total = entries.length;
  const distinct = new Set(entries.map((e) => e.independenceGroup || "?")).size;
  return { total, distinct, share: total ? 1 - distinct / total : 0 };
}

/** 过了这条线就改写。一半是分界：半数以上来自同几组，说明这个问法通向的是转载群。 */
export const REWRITE_TRIGGER = 0.5;

export const needsRewrite = (share: number): boolean => share > REWRITE_TRIGGER;

/**
 * 一波回来之后，这条链下一步做什么。
 *
 * - `coSourced`：入账了，但过半来自同一批来源 —— 换方向再发（原来唯一的改写理由）。
 * - `zeroYield`：**一条都没入账** —— 也改写再发一次，但只给一次。
 * - `stop`：入账了且来源分散，按现状收口；或者零入账已经补过一次，不再追。
 *
 * ## 为什么零入账也要一次（2026-09-05）
 *
 * ISS-231 抓回 29 页入账 4 条；R-11 那两轮同题同命题，入账 4 和 19。零入账的链原来直接收口
 * （`if (!needsRewrite(share)) break;`）：共源率是 0，读起来像「来源很分散」，其实是「什么都
 * 没拿到」。命题决定抓到什么页，这条停止条件决定零收获的链有没有第二次机会 —— 两者都要改，
 * 这里改的是后者。只给一次：第二次仍是零，多半是外面就没有这份材料，再追只是把出稿的时间
 * 搜掉，而覆盖表上「已搜未得」正是为这种情况留的位置。
 */
export type WaveDecision = "stop" | "coSourced" | "zeroYield";

/**
 * 2026-09-06 两处收紧（ISS-232 实测）：
 *
 * - **共源改写一条链只给一次。** 「格局」三波共源率 75% → 67% → 74%，「需求与供给」78% → 70%；改写
 *   换不回分散的来源，每一波却要两分半。第二次改写的期望收益是负的。
 * - **零入账按维度看，不只按链看。** 「技术与上游」这条链 D3 入账 6 条、D5 零，链的总数不为零，
 *   原来的判法不会给 D5 第二次机会 —— 覆盖表上 D5「已搜未得」。现在链里哪几维零入账就只为
 *   它们改写再发一波（`dims`），同样只给一次。
 */
export function waveDecision(o: {
  total: number;
  share: number;
  zeroYieldRetried: boolean;
  coSourceRetried?: boolean;
  /** 这一波里一条都没入账的维度（链里有命题的那几维）。 */
  zeroDims?: readonly string[];
}): { kind: WaveDecision; dims: readonly string[] | null } {
  if (o.total === 0) return { kind: o.zeroYieldRetried ? "stop" : "zeroYield", dims: null };
  if (o.zeroDims?.length && !o.zeroYieldRetried) return { kind: "zeroYield", dims: o.zeroDims };
  if (needsRewrite(o.share) && !o.coSourceRetried) return { kind: "coSourced", dims: null };
  return { kind: "stop", dims: null };
}

export const REWRITE_SYSTEM = `刚发出去的一波检索里，过半的结果来自同一批来源（同机构、同口径、
同数值的转载）。再发一次原问法只会取回同一批。

给一组**换过方向**的问法。四条路，至少走两条：

· 换机构 —— 点名另一家会发布这类数据的机构
· 换来源类型 —— 从行业机构转向公司披露、监管与政策原文、行业协会
· 换语言 —— 同一件事的英文问法（境外机构的原始发布往往只有英文那一份）
· 换限定词 —— 换统计期间、换应用细分、换环节

**禁止原问法微调**：改个语序、加个「最新」、把年份从 2025 换成 2026 都不算换方向。

交：{"queries":["改写后的问法"]}`;

/**
 * 零入账那一支的提示词。和共源那一支分开写：共源是「问法通向转载群」，零入账是「问法和
 * 页面对不上」—— 抓回来的页里没有一条能回答命题，或者压根没抓到页。两者的换法不同。
 */
export const REWRITE_ZERO_SYSTEM = `刚发出去的一波检索一条证据都没入账：要么没搜到页，要么搜到的页里
没有一句能回答命题。再发一次原问法拿回来的还是这些。

给一组**换过问法**的查询。三条路，至少走两条：

· 换成对方会用的词 —— 公告标题里的写法、数据表的指标名、机构报告的栏目名，不用你自己的概括语
· 拆细 —— 把一条大命题拆成两三个能被一页材料直接回答的小问题（一个数、一个日期、一个名字）
· 换语言或换载体 —— 英文原始发布、交易所公告、招股书与年报的具体章节、行业协会的统计表

**禁止原问法微调**：改个语序、加个「最新」都不算换。**不要把命题放宽到「行业概况」**：宽问法
拿回来的是综述，综述里没有能核命题的那一个数。

交：{"queries":["改写后的问法"]}`;

export function rewriteSystemFor(reason: Exclude<WaveDecision, "stop">): string {
  return reason === "zeroYield" ? REWRITE_ZERO_SYSTEM : REWRITE_SYSTEM;
}

export function buildRewriteUser(o: {
  dimension: string;
  tried: readonly string[];
  coSourced: readonly string[];
  /** 不给按共源处理。零入账时递命题原文（`statements`）而不是撞上的来源 —— 那一栏是空的。 */
  reason?: WaveDecision;
  statements?: readonly string[];
}): string {
  const zero = o.reason === "zeroYield";
  return [
    `## 这一维在查什么`,
    o.dimension,
    ...(zero && o.statements?.length ? ["\n## 要核的命题（原文）", ...o.statements.map((x) => `- ${x}`)] : []),
    "\n## 已经试过的问法",
    ...o.tried.map((q) => `- ${q}`),
    ...(zero
      ? ["\n这些问法一条证据都没换回来。"]
      : ["\n## 撞上的那批来源", ...o.coSourced.map((x) => `- ${x}`)]),
    zero ? "\n按上面三条路换问法，交那一行 JSON。" : "\n按上面四条路换方向，交那一行 JSON。",
  ].join("\n");
}

/** 读改写后的问法。读不出来返回空数组 —— 改写失败不该让这一维的取证整段中断。 */
export function readRewrite(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^```[a-zA-Z]*\n?|```$/g, "").trim());
  } catch {
    return [];
  }
  const list = (raw && typeof raw === "object" ? (raw as { queries?: unknown }).queries : null) ?? [];
  const out: string[] = [];
  for (const q of (Array.isArray(list) ? list : []).map((x) => (typeof x === "string" ? x.trim() : ""))) {
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}
