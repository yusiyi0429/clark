/**
 * N2′：**在 N1/N2 底下顺便跑一次通义深研，只要它那一面 url。**
 *
 * 这一步的产物是一张种子表 —— 几十条「外面值得抓的地址」，交给 N3 每条链当第一批抓取
 * 目标。它不产出任何断言、任何证据、任何结论：报告丢掉，正文照旧由 `fetch.ts` 自己抓、
 * 由 N3 自己抽（接口那一侧的理由写在 `research/qwen-research.ts` 文件头）。
 *
 * ## 为什么发在 N0 之后，而不是 N2 之后
 *
 * 直觉上它该排在 N2 后面：那时手上有八维的具体命题，题面能写得准得多。但这条链的墙上
 * 时间上限是 30 分钟，一遍顺利的运行 27.3 分钟，**余量只有 165 秒**（`deadline.ts`），而
 * 一次深研要几分钟 —— 排在 N2 和 N3 之间是净增几分钟，那条线现在装不下。
 *
 * 排在 N0 之后就不一样了：它跑在 N1 草稿（265 秒）和 N2 检索计划（200 秒）底下，那两步
 * 一共 465 秒的掩护，**墙上时间净增接近零**。代价是题面里只有主体卡和八个固定维度
 * （`dims.ts` 那八维本来就是写死的，不用等 N2），没有 N2 抽出来的具体命题。
 *
 * 换回来的东西比丢掉的多：丢的是题面精度，得的是这一步真的跑得起来。
 *
 * ## 分给哪条链是**在 N3 那一刻**算的，不是发的时候
 *
 * 发的时候手上没有命题，但 `routeSeeds` 是 N3 开跑时才叫的 —— 那时 N2 早交完了。所以
 * 题面粗、分派细：每条种子按字面重合度归给最沾边的那条链（`sweep.ts` 的 `CHAINS`）。
 *
 * 归错的代价是有限的：一条 D6 的页分给了「需求与供给」那条链，抽取那一次会交回零条
 * （`extract` 只认这条链手上的命题），成本是一次 `flash` 调用。归对的收益是那一页本来
 * 我们的检索式搜不到。所以这里宁可全都分出去 —— **一条都不沾边的也分**（轮流摊给各链），
 * 扔掉才是白花了那一次深研的钱。
 *
 * ## 这张表不是 `resupply.ts` 说的那个「种子」
 *
 * 那边的种子是**一条已经入账的证据**，拿它的数字去找旁证。这边的种子是**一条还没抓过的
 * 地址**。两个词在两个文件里各自成立，合起来读会串，所以这里写明一次。
 */

import type { SearchHit } from "@/lib/research/search";
import {
  qwenResearch,
  qwenResearchSetup,
  QWEN_RESEARCH_LABEL,
  type QwenResearchAccount,
} from "@/lib/research/qwen-research";

import type { SubjectCard } from "./anchor";
import { DIMENSIONS, type DimId } from "./dims";
import type { PlannedProposition } from "./plan";

export type SeedTable = {
  hits: readonly SearchHit[];
  /** 空 = 正常。非空 = 这一步没跑/没跑完，原话在里面，会进报告文首那份缺口清单。 */
  reason: string;
  account: QwenResearchAccount;
};

export const emptySeedTable = (reason: string): SeedTable => ({
  hits: [],
  reason,
  account: { phases: [], seen: 0, kept: 0, clarify: "", ms: { clarify: 0, research: 0 } },
});

/* -------------------------------------------------------------------------- */
/* 题面                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 发给它的研究题面。
 *
 * 三件事说清楚就够：研究谁、按哪八个角度、要什么时间窗。**不要求它写报告，也不阻止它写**
 * —— 那一段我们根本不读（收完地址就断流）。写「多给一手来源」是唯一一句对我们有用的指令：
 * 它决定了它的检索工具往哪个方向去，而我们要的正是它踩过的那些地址。
 */
export function buildSeedBrief(card: SubjectCard): string {
  const segs = card.segments.map((x) => `${x.name}（${x.weight}，${x.lifecycle}）`).join("、");
  return [
    `请就下面这个主体所在的行业做一次深度调研，时间窗：${card.window || "当前时点 ± 未来 3 年"}。`,
    "",
    `主体：${card.subject}`,
    card.industry ? `行业定义：${card.industry}` : "",
    segs ? `业务板块：${segs}` : "",
    card.customers ? `下游客户：${card.customers}` : "",
    "",
    "请覆盖这八个角度，每个角度都去找一手材料：",
    ...DIMENSIONS.map((d) => `${d.id} ${d.name}：${d.brief}`),
    "",
    "优先找行业协会与研究机构的统计、公司披露（年报/公告/招股书）、监管与政策原文；",
    "尽量给出可核对的原始出处，而不是二次转述。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 它反问之后我们的回答。**就地答，不叫模型** —— 它要问的口径全在主体卡里，再发一次模型
 * 调用只是把同一份信息换个说法，还多一次可能挂掉的调用。
 *
 * 语气写成「按这个口径来，不要再问」是有意的：这个模型的合同是一问一答之后开跑，回答里
 * 留了活口的话它可能再问一轮，而我们没有第三次的时间。
 */
export function answerFor(card: SubjectCard): string {
  return [
    "按以下口径直接开始，不用再确认：",
    `· 研究对象：${card.subject}${card.industry ? `，行业范围以「${card.industry}」为准` : ""}`,
    `· 时间窗：${card.window || "当前时点 ± 未来 3 年"}`,
    "· 地域：以中国大陆市场为主，涉及全球供需与技术路线时一并覆盖",
    "· 深度：八个角度都要，宁可每个角度少写几句，也不要漏掉角度",
    "· 来源：优先一手材料与可核对的原始出处",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 跑                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 发这一次。**永不抛** —— 这一步是加出来的一层，它挂掉不该让整轮深研跟着挂（没有它的
 * 时候 N3 本来就自己搜）。
 *
 * 返回的是 `Promise`，调用方**不要 await**：它的全部意义是跑在 N1/N2 底下（文件头第二节）。
 */
export async function runSeed(card: SubjectCard, opts: { timeoutMs?: number } = {}): Promise<SeedTable> {
  const setup = qwenResearchSetup();
  if (!setup.on) return emptySeedTable(setup.reason);
  try {
    const r = await qwenResearch(buildSeedBrief(card), answerFor(card), opts);
    return { hits: r.hits, reason: r.reason, account: r.account };
  } catch (e) {
    // `qwenResearch` 自己已经不抛了，这一层是兜底：这个 Promise 没人 await，漏出去的
    // 拒绝在 Node 上是一次 unhandledRejection，而那会连累整个进程。
    return emptySeedTable(
      `${QWEN_RESEARCH_LABEL}这一步没跑成：${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 分派                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 拆成字二元组。中文没有空格，按词切要带分词表 —— 二元组是这里够用的最省事的办法：
 * 「面板」和「面板厂」重合两个组，「面板」和「政策」重合零个。
 *
 * 标点和空白是**断点**，不是要剥掉的杂质：剥掉再切的话「产能、扩产」会切出一个「能扩」，
 * 而那个组在别处是真词片，于是两段本来不沾边的话凭一个不存在的词片对上了分。
 */
export function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const seg of text.toLowerCase().split(/[^\p{Script=Han}\p{L}\p{N}]+/u)) {
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return out;
}

/** 重合几个组。不做归一化 —— 这里只比大小，除以长度不改变谁大谁小的次序。 */
const overlap = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  for (const g of a) if (b.has(g)) n += 1;
  return n;
};

/**
 * 把种子表分给几条链。
 *
 * 每条链的画像 = 它那几维的名字与说明（`dims.ts`）+ 它手上那几条命题的正文和检索式。
 * 每条种子拿标题和摘要去比，归给分最高的那条链。
 *
 * **一条都不沾边的（各链都是 0 分）轮流摊出去**，不扔：题面是在 N0 那一刻写的、粗，
 * 沾不上边多半是这一条的标题写得含糊，不是这一页没用。扔掉等于白花那一次深研的钱，
 * 而多抓一页的代价只是一次 `flash` 抽取。
 *
 * 返回按 `chains` 的顺序，长度一致 —— 调用方按下标取，不用查表。
 */
export function routeSeeds(
  hits: readonly SearchHit[],
  chains: readonly { label: string; dims: readonly DimId[] }[],
  props: readonly PlannedProposition[]
): SearchHit[][] {
  const out: SearchHit[][] = chains.map(() => []);
  if (!hits.length || !chains.length) return out;

  const profiles = chains.map((c) => {
    const dims = DIMENSIONS.filter((d) => c.dims.includes(d.id));
    const mine = props.filter((p) => c.dims.includes(p.dimension));
    return bigrams(
      [
        ...dims.map((d) => `${d.name}${d.brief}`),
        ...mine.map((p) => `${p.statement}${p.queries.join("")}${p.counterQueries.join("")}`),
      ].join("")
    );
  });

  let spare = 0;
  for (const hit of hits) {
    const g = bigrams(`${hit.title}${hit.snippet}`);
    let best = -1;
    let bestScore = 0;
    profiles.forEach((prof, i) => {
      const score = overlap(g, prof);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best < 0) {
      // 谁都不沾边：轮流摊。`spare` 是跨条累加的，所以摊得均匀。
      best = spare % chains.length;
      spare += 1;
    }
    out[best].push(hit);
  }
  return out;
}
