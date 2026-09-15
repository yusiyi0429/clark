/**
 * 补旁证。**给已经查到的那条事实找第二个出处，不是把命题再搜一遍。**
 *
 * ## 为什么不能重搜命题
 *
 * `sweep` 文件头写着：「覆盖门没开**不重跑** —— 同一批命题对着同一批检索家再跑一遍，
 * 回来的是同一批页。」那句话是对的，而它同时说明了这一层该怎么做：**换检索式，不换问题。**
 *
 * 一条命题闭不上，通常不是「外面没有材料」，是「这个说法只被一家写过，而我们发的问法
 * 只找得到那一家」。所以这里的检索式从**已入账的那条证据**造 —— 拿它的说法本身去搜，
 * 找的是「还有谁也这么说」。
 *
 * ## 全程不调模型
 *
 * 检索式由 `corroborationQuery` 拼，旁证由 `corroborate` 在抓回来的正文里确定性定位。
 * 两件事都不叫模型：
 *
 *  · 让模型编检索式，会把「外面真没有」和「问法没编好」混成一个结果，那时拿到的
 *    命中率说明不了任何事（离线实测过，笨办法对每条一样笨，这是它的优点）。
 *  · 让模型判「这一页说的是不是同一件事」，等于在闸的上游再放一个会编的东西。
 *    而这一层要答的问题恰好是确定性的：**这个数在不在这一页上**。
 *
 * 代价是它只补得了带数值的事实（`value` 有值那些）。定性说法的旁证还得走正常取证那条路
 * —— 写在这里是因为这是**已知边界**，不是遗漏。
 */

import { attributable } from "@/lib/research/coverage";
import type { Snapshot } from "@/lib/research/fetch";
import { numeric } from "@/lib/research/calc";
import { Ledger, type AuthorityClass, type Evidence, type EvidenceDraft } from "@/lib/research/ledger";

import { DIM_IDS, type DimCoverage, type DimId } from "./dims";
import type { PlannedProposition } from "./plan";

/** 这一维差几组，以及可以拿来找旁证的那几条已入账证据。 */
export type Shortfall = {
  dim: DimId;
  have: number;
  need: number;
  /** 已经入过账、可以拿去找旁证的条目。按「有数值的排前面」排 —— 只有它们补得动。 */
  seeds: Evidence[];
};

/**
 * 哪几维还差独立来源。门槛照 `dims.gateOpen`：普通维 1 组，要下判断的维 2 组。
 *
 * **一组都没有的那些维不在这里。** 那种是「搜过没搜着」或者「压根没搜」，该做的是改问法
 * 或退回 N2 —— 而这一层要的是一条已入账的证据当种子，没有种子就无从找旁证。
 */
export function shortfalls(o: {
  coverage: readonly DimCoverage[];
  props: readonly PlannedProposition[];
  entries: readonly Evidence[];
  strongDims: Iterable<DimId>;
}): Shortfall[] {
  const strong = new Set(o.strongDims);
  const byDim = new Map(o.coverage.map((r) => [r.dim, r] as const));
  const out: Shortfall[] = [];
  for (const dim of DIM_IDS) {
    const row = byDim.get(dim);
    if (!row) continue;
    const need = strong.has(dim) ? 2 : 1;
    if (row.independentGroups >= need) continue;

    const ids = new Set(o.props.filter((p) => p.dimension === dim).map((p) => p.id));
    const seeds = o.entries
      .filter((e) => ids.has(e.propositionId))
      // 有数值的排前面：这一层只补得动带数的事实，见文件头那条已知边界。
      .sort((a, b) => Number(b.value !== undefined) - Number(a.value !== undefined));
    if (!seeds.length) continue;
    out.push({ dim, have: row.independentGroups, need, seeds });
  }
  return out;
}

/**
 * 从一条已入账的证据造检索式。**不调模型。**
 *
 * 用 `claim` 打底 —— 它是抽取那一步写出来的一句话事实，本来就是「这条证据说了什么」的
 * 最紧凑表述，比从引句里截一段强。数值和单位补在后面（`claim` 里常常已经有了，重复
 * 无所谓：检索端对重复词不敏感，而漏掉那个数会让搜回来的东西对不上）。
 *
 * 截到 60 字：再长检索端会把它当长句处理，召回反而散。
 */
export function corroborationQuery(e: Evidence): string {
  const base = (e.claim ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const num = e.value !== undefined ? `${e.value}${e.unit ?? ""}` : "";
  return num && !base.includes(String(e.value)) ? `${base} ${num}`.trim() : base;
}

/**
 * 域名 → 谁在说。**只认无歧义的那几类，其余一律 `other`。**
 *
 * 正常取证里这一栏是模型判的（它读得到正文，分得出「某部委发布」和「某媒体转述某部委」）。
 * 这一层不调模型，所以只能按域名判，而按域名判只有政府域是无歧义的。**其余全落 `other`
 * 是有意的保守**：判高了会让一条自媒体旁证在屏幕上显示成 A 级，而档次是一号位判「这句话
 * 能信到什么程度」的依据。
 *
 * 注意它不影响覆盖判定 —— 那一步看的是 `attributable(domain)` 和独立性组，不看档次。
 *
 * **政府域一律 `regulator`，不再细分 `official_statistics`。** 同一个 `.gov.cn` 上既有
 * 统计公报也有政策文件，光看域名分不出是哪一种，而两者在 `tierOf` 里都是 A 级 ——
 * 那个区分是假精度：写一个分不出来的分支，只会让下一个人以为这里真的分过。
 */
export function authorityOf(domain: string): AuthorityClass {
  return /(^|\.)gov(\.cn)?$/.test(domain.toLowerCase()) ? "regulator" : "other";
}

/** 断句用。引句要落在一句话上，截半句会让人读不出它在说什么。 */
const SENT_END = /[。！？；\n]/;

/**
 * 在新抓到的这一页里找同一个事实。找得到就交一份能直接入账的草稿，找不到回 `null`。
 *
 * 判「是不是同一个事实」的依据只有一条：**这一页上有没有一个数，和种子那条的 `value`
 * 对得上**（容差 0.05%，只吃得下记法差异如 `3.2万` ↔ `32,000`，吃不下 1.634 ↔ 1.64
 * 那种精度漂移）。这一条判得很窄，是有意的：宽到「这一页讲的是同一个话题」，补回来的
 * 就不是旁证而是又一篇泛泛而谈。
 */
export function corroborate(seed: Evidence, page: Snapshot): EvidenceDraft | null {
  if (seed.value === undefined || !Number.isFinite(seed.value) || seed.value === 0) return null;
  if (page.url === seed.url) return null; // 同一页不算旁证

  const text = page.text ?? "";
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?\s*(?:万亿|亿|万|千)?/g)) {
    const v = numeric(m[0]);
    if (v === null || v === 0) continue;
    if (Math.abs(v - seed.value) / Math.abs(seed.value) >= 0.0005) continue;

    const at = m.index ?? 0;
    // 往两头扩到句子边界，最多各 90 字 —— 引句要能读懂，但不能整段搬。
    let s = at;
    while (s > 0 && at - s < 90 && !SENT_END.test(text[s - 1])) s -= 1;
    let t = at + m[0].length;
    while (t < text.length && t - at < 90 && !SENT_END.test(text[t])) t += 1;
    const quote = text.slice(s, t).trim();
    if (!quote) continue;

    return {
      // 挂在同一条命题上 —— 这就是「第二个独立来源」那句话的物质基础。
      propositionId: seed.propositionId,
      claim: seed.claim,
      exactQuote: quote,
      url: page.url,
      supportRelation: seed.supportRelation,
      evidenceType: seed.evidenceType,
      authorityClass: authorityOf(new URL(page.url).host),
      usedAs: seed.usedAs,
      value: seed.value,
      unit: seed.unit,
      precision: seed.precision,
      period: seed.period,
      geography: seed.geography,
    };
  }
  return null;
}

/**
 * 跑一轮补旁证。**这一层唯一会出网的地方，而且只出网、不叫模型。**
 *
 * 一条种子一次检索：搜 → 挑 → 抓 → 在正文里定位同一个数 → 入账。补到这一维够了就停 ——
 * 门槛是 `need` 组，多补的那些不进覆盖判定，只是白花时间。
 *
 * 时间由调用方管（`deadline.ts` 的 `room`），这里不判 —— 判时间要知道后面还有什么，
 * 而那是 `sweep` 才知道的事。
 */
export async function resupply(o: {
  short: Shortfall;
  ledger: Ledger;
  search: (query: string, k: number) => Promise<readonly { url: string; sourceDomain: string }[]>;
  fetch: (urls: string[]) => Promise<{ pages: Snapshot[] }>;
  /** 每条种子搜几条、抓几页。 */
  k: number;
  /** 还来得及吗。false 就停在这一条，已经补上的照样算数。 */
  room: () => boolean;
}): Promise<{ added: number; tried: string[] }> {
  const tried: string[] = [];
  let added = 0;
  /** 账上已经有的域名。旁证要的是没见过的来源，所以它决定挑哪几条去抓。 */
  const seen = new Set(o.ledger.entries.map((e) => e.sourceDomain));
  let groups = new Set(
    o.ledger.entries.filter((e) => attributable(e.sourceDomain)).map((e) => e.independenceGroup)
  ).size;

  for (const seed of o.short.seeds) {
    if (groups >= o.short.need || !o.room()) break;
    if (seed.value === undefined) continue; // 补不动，见文件头
    const q = corroborationQuery(seed);
    if (!q) continue;
    tried.push(q);

    const hits = await o.search(q, o.k);
    const picked = pickForFetch(hits, seen, o.k);
    if (!picked.length) continue;

    const { pages } = await o.fetch(picked.map((p) => p.url));
    o.ledger.archive(pages);
    for (const page of pages) {
      const draft = corroborate(seed, page);
      if (!draft) continue;
      const e = o.ledger.record(draft);
      if (!e) continue;
      added += 1;
      seen.add(e.sourceDomain);
      /*
       * 组数**当场重算**，不是 `groups += 1`：新入账那条可能和已有的某条同组
       * （`fold` 之后才知道），那种情况下它不该让这一维看起来够了。这里按域名兜底算，
       * 与 `fold` 的三级折叠不完全一致 —— 折叠只会把组数**算得更少**，所以按这里的
       * 数停下来是保守的，不会少补。
       */
      groups = new Set(
        o.ledger.entries
          .filter((x) => attributable(x.sourceDomain))
          .map((x) => x.independenceGroup || `dom:${x.sourceDomain}`)
      ).size;
      if (groups >= o.short.need) break;
    }
  }
  return { added, tried };
}

/**
 * 一批检索命中里，哪几个值得抓。
 *
 * 两道筛，都不调模型：
 *  · 域名背后没人担责的直接丢 —— 它入了账也进不了覆盖判定（`coverage.attributable`）
 *  · 已经在账上的域名往后排：**旁证要的是没见过的来源**，同一家再来一篇是转载不是印证
 */
export function pickForFetch<T extends { url: string; sourceDomain: string }>(
  hits: readonly T[],
  seen: ReadonlySet<string>,
  k: number
): T[] {
  const fresh: T[] = [];
  const known: T[] = [];
  for (const h of hits) {
    if (!attributable(h.sourceDomain)) continue;
    (seen.has(h.sourceDomain) ? known : fresh).push(h);
  }
  return [...fresh, ...known].slice(0, k);
}
