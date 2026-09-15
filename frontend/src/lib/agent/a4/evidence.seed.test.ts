/**
 * N2′ 那几条种子**真的走完了取证那六段**，离线跑一遍。
 *
 * 单测把 `qwen-research.ts` 和 `seed.ts` 各自钉住了，但那两个文件全都在链外：地址交出来
 * 之后要过白名单、要排进那五页、要抓、要抽、要入账。**这中间任何一处不生效，表现都是
 * 「这一轮种子一条都没用上」而没有一个错** —— 那正是这一整步最坏的失败形态（静默变回
 * 没有它的样子）。所以这里从 `gatherEvidence` 那一层验，不从更上面。
 *
 * 顺带钉住 changelog 里那句话：**一家检索都不配也跑得动**。种子是可以直接抓的地址，走的
 * 不是检索 —— 这条路上没有任何一处会替它去搜。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { Harness } from "@/lib/agent/harness";
import type { SearchHit, SearchProvider } from "@/lib/research/search";

import { gatherEvidence, SEEDS_PER_ROUND } from "./evidence";
import { compile } from "./props";
import { mockText } from "@/lib/models/mock";

/**
 * 一支不搜的检索。**不能用 `providers("none")`** —— `TKOS_MODEL_MOCK=1` 在那个函数第一句
 * 就压倒一切、返回假检索，于是这条用例会拿到一批搜来的页，而它要验的恰恰是「没有检索时
 * 只剩种子」。这个坑本身值得记一句：那个开关的含义是「不出网」，不是「不搜」。
 */
const noSearch = (): SearchProvider[] => [
  { name: "none", label: "未启用", windowed: false, reason: "", search: async () => [] },
];

/** 罐头命题。同 `evidence.test.ts` —— 罐头的引句是照 `fetch.mockPage` 的假正文写的。 */
const props = () => compile(JSON.parse(mockText("a4.props")), 4);

/**
 * 五条种子。域名尾数各不相同 —— `mockPage` 按主机名里的数字派署名机构，同号会被折成一组，
 * 那样这条用例就分不出「入账了」和「入账了但全并成一条」。
 */
const seeds = (): SearchHit[] =>
  [0, 1, 2, 3, 4].map((i) => ({
    title: `种子 ${i}`,
    url: `https://example${i}.com/qwen-seed/${i}`,
    snippet: "",
    sourceDomain: `example${i}.com`,
    matchedQuery: "通义深研交回来的地址（本轮未自行检索）",
    provider: "qwen-research",
  }));

let out: Awaited<ReturnType<typeof gatherEvidence>>;

beforeAll(async () => {
  process.env.TKOS_MODEL_MOCK = "1";
  const h = new Harness({ agent: "A4", slot: "pro" });
  out = await gatherEvidence(
    h,
    // 一家都不配，能抓下来的只可能是种子。
    noSearch(),
    props(),
    { searchK: 5, maxRounds: 1 },
    { slot: "pro", label: "需求与供给", substep: () => {} },
    { seeds: seeds() }
  );
});

describe("一家检索都不配，光靠种子也走得完六段", () => {
  it("抓到的页全部来自种子，一条都不是搜来的", () => {
    expect(out.pages.length).toBeGreaterThan(0);
    for (const p of out.pages) expect(p.url).toContain("/qwen-seed/");
  });

  it("入了账 —— 抓到不等于抽得出，这一步才是真验完了", () => {
    expect(out.ledger.entries.length).toBeGreaterThan(0);
  });

  it("漏斗上 hits 是 0 而 seeded 不是 —— 这两格分不开就看不出来源有多窄", () => {
    const r = out.rounds[0];
    expect(r.hits).toBe(0);
    expect(r.seeded).toBe(out.pages.length);
  });
});

describe("一轮不许被种子占满", () => {
  it("五条种子一轮只用得掉 SEEDS_PER_ROUND 条", () => {
    // 占满的话共源率量的就不再是「我们的问法在不在撞同一批稿子」，而改问法那条闸靠它开。
    expect(out.pages.length).toBe(SEEDS_PER_ROUND);
    expect(SEEDS_PER_ROUND).toBeLessThan(5);
  });
});

describe("白名单只放种子进来", () => {
  it("种子表以外的地址仍然抓不动", async () => {
    process.env.TKOS_MODEL_MOCK = "1";
    const h = new Harness({ agent: "A4", slot: "pro" });
    const got = await gatherEvidence(
      h,
      noSearch(),
      props(),
      { searchK: 5, maxRounds: 1 },
      { slot: "pro", label: "需求与供给", substep: () => {} },
      { seeds: [] }
    );
    // 没有种子、没有检索 = 一页都不该抓下来。抓下来说明白名单那一格被绕过去了。
    expect(got.pages).toEqual([]);
    expect(got.ledger.entries).toEqual([]);
  });
});
