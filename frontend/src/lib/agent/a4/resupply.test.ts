import { describe, expect, it } from "vitest";

import type { Snapshot } from "@/lib/research/fetch";
import { Ledger, type Evidence } from "@/lib/research/ledger";

import type { DimCoverage } from "./dims";
import type { PlannedProposition } from "./plan";
import { authorityOf, corroborate, corroborationQuery, pickForFetch, resupply, shortfalls } from "./resupply";

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  id: "E1",
  propositionId: "P1",
  claim: "2025 年末全国智能算力规模为 1590 EFLOPS",
  exactQuote: "2025 年末全国智能算力规模为 1590 EFLOPS",
  url: "https://a.example.com/x",
  supportRelation: "supports",
  evidenceType: "statistic",
  authorityClass: "official_statistics",
  usedAs: "current_state",
  value: 1590,
  unit: "EFLOPS",
  precision: "FP16",
  period: "2025-12-31",
  geography: "中国",
  sourceDomain: "a.example.com",
  contentHash: "h1",
  retrievedAt: "2026-08-25T00:00:00.000Z",
  sourceTier: "A",
  span: [0, 10],
  excerpt: "2025 年末全国智能算力规模为 1590 EFLOPS",
  verificationStatus: "span_matched",
  independenceGroup: "dom:a.example.com",
  ...over,
});

const page = (over: Partial<Snapshot> = {}): Snapshot => ({
  url: "https://b.example.com/y",
  title: "另一家的报道",
  text: "行业观察｜多家机构给出同一口径。工信部披露，截至去年末，全国智能算力规模达到 1590 EFLOPS，同比增长明显。业内认为这一节奏还会延续。",
  contentHash: "h2",
  retrievedAt: "2026-08-26T00:00:00.000Z",
  truncated: false,
  ...over,
});

const prop = (id: string, dimension: PlannedProposition["dimension"]): PlannedProposition =>
  ({ id, dimension }) as PlannedProposition;

const cov = (dim: DimCoverage["dim"], groups: number): DimCoverage => ({ dim, independentGroups: groups });

describe("哪几维差旁证", () => {
  it("普通维要 1 组、下判断的维要 2 组 —— 门槛照 gateOpen", async () => {
    const out = shortfalls({
      coverage: [cov("D1", 1), cov("D2", 1)],
      props: [prop("P1", "D1"), prop("P2", "D2")],
      entries: [ev({ propositionId: "P1" }), ev({ propositionId: "P2" })],
      strongDims: ["D2"],
    });
    // D1 有 1 组、只要 1 组 → 不差；D2 有 1 组、要 2 组 → 差。
    expect(out.map((x) => x.dim)).toEqual(["D2"]);
    expect(out[0]).toMatchObject({ have: 1, need: 2 });
  });

  it("一条已入账证据都没有的维不进来 —— 没有种子就无从找旁证", async () => {
    /*
     * 那种维是「搜过没搜着」或者「压根没搜」，该做的是改问法或退回 N2。
     * 混进来的话，这一层会对着一个空种子发检索，而发出去的问法还会被记进「已搜未得」——
     * 屏幕上就成了「试过很多问法都没有」，而其实一条都没真发。
     */
    const out = shortfalls({
      coverage: [cov("D3", 0)],
      props: [prop("P9", "D3")],
      entries: [],
      strongDims: ["D3"],
    });
    expect(out).toEqual([]);
  });

  it("带数值的种子排前面 —— 只有它们补得动", async () => {
    const out = shortfalls({
      coverage: [cov("D1", 0)],
      props: [prop("P1", "D1")],
      entries: [ev({ id: "E1", value: undefined }), ev({ id: "E2", value: 1590 })],
      strongDims: [],
    });
    expect(out[0].seeds.map((s) => s.id)).toEqual(["E2", "E1"]);
  });
});

describe("检索式", () => {
  it("拿说法本身去搜，找的是「还有谁也这么说」", async () => {
    expect(corroborationQuery(ev())).toBe("2025 年末全国智能算力规模为 1590 EFLOPS");
  });

  it("说法里没有那个数时补上 —— 漏了它搜回来的东西会对不上", async () => {
    const q = corroborationQuery(ev({ claim: "全国智能算力规模继续增长", value: 1590, unit: "EFLOPS" }));
    expect(q).toBe("全国智能算力规模继续增长 1590EFLOPS");
  });
});

describe("在新页里找同一个事实", () => {
  it("数对得上就交一份能入账的草稿，引句落在整句上", async () => {
    const d = corroborate(ev(), page());
    expect(d).not.toBeNull();
    expect(d!.propositionId).toBe("P1");
    expect(d!.url).toBe("https://b.example.com/y");
    expect(d!.exactQuote).toContain("1590 EFLOPS");
    // 引句要能读懂 —— 不是光秃秃一个数。
    expect(d!.exactQuote).toContain("工信部披露");
  });

  it("交出来的草稿真能被 Ledger 收下（引句在原文里定得到）", async () => {
    /*
     * 这一条是这个模块的出口契约：`corroborate` 的产物必须过得了 `record` 的三道门。
     * 引句是从这一页正文里切出来的，所以 `spanmatch` 一定定得到 —— 但「一定」得有测试
     * 钉着，不然哪天改了切法就变成静默的全量入账失败。
     */
    const l = new Ledger();
    const p = page();
    l.archive([p]);
    const d = corroborate(ev(), p)!;
    const e = l.record(d);
    expect(e).not.toBeNull();
    expect(e!.sourceDomain).toBe("b.example.com");
  });

  it("数对不上就不算旁证 —— 宽到「同一个话题」补回来的是泛泛而谈", async () => {
    expect(corroborate(ev(), page({ text: "全国智能算力规模达到 2185 EFLOPS。" }))).toBeNull();
  });

  it("记法不同算同一个数（3.2万 ↔ 32,000），精度漂移不算", async () => {
    expect(corroborate(ev({ value: 32000 }), page({ text: "月产能 3.2万 片。" }))).not.toBeNull();
    // 1.634亿 和 1.64亿 是两个数，不能混。
    expect(corroborate(ev({ value: 1.64e8 }), page({ text: "出货 1.634亿 片。" }))).toBeNull();
  });

  it("同一页不算旁证", async () => {
    expect(corroborate(ev(), page({ url: "https://a.example.com/x" }))).toBeNull();
  });

  it("种子没有数值就补不动 —— 这是已知边界，不是遗漏", async () => {
    expect(corroborate(ev({ value: undefined }), page())).toBeNull();
  });
});

describe("挑哪几条去抓", () => {
  const hit = (url: string, sourceDomain: string) => ({ url, sourceDomain });

  it("没人担责的直接丢 —— 它入了账也进不了覆盖判定", async () => {
    const out = pickForFetch([hit("u1", "zhihu.com"), hit("u2", "stats.gov.cn")], new Set(), 5);
    expect(out.map((x) => x.sourceDomain)).toEqual(["stats.gov.cn"]);
  });

  it("账上已经有的域名往后排 —— 同一家再来一篇是转载不是印证", async () => {
    const out = pickForFetch(
      [hit("u1", "a.example.com"), hit("u2", "b.example.com")],
      new Set(["a.example.com"]),
      5,
    );
    expect(out.map((x) => x.sourceDomain)).toEqual(["b.example.com", "a.example.com"]);
  });

  it("按 k 截断", async () => {
    const out = pickForFetch([hit("u1", "x.com"), hit("u2", "y.com"), hit("u3", "z.com")], new Set(), 2);
    expect(out).toHaveLength(2);
  });
});

describe("域名判谁在说", () => {
  it("政府域一律 regulator，其余一律 other —— 保守是有意的", async () => {
    /*
     * 不分「统计」和「监管」：同一个 .gov.cn 上既有统计公报也有政策文件，光看域名
     * 分不出，而两者在 tierOf 里都是 A 级。写一个分不出来的分支，只会让下一个人
     * 以为这里真的分过。
     */
    expect(authorityOf("stats.gov.cn")).toBe("regulator");
    expect(authorityOf("www.miit.gov.cn")).toBe("regulator");
    expect(authorityOf("dsj.guizhou.gov.cn")).toBe("regulator");
    // 判高了会让一条自媒体旁证在屏幕上显示成 A 级。
    expect(authorityOf("baijiahao.baidu.com")).toBe("other");
    expect(authorityOf("finance.sina.com.cn")).toBe("other");
  });
});

describe("跑一轮补旁证", () => {
  const seedEv = ev({ value: 1590, sourceDomain: "a.example.com", independenceGroup: "dom:a.example.com" });

  /** 账上已经有一条种子证据的台账。 */
  const armed = (): Ledger => {
    const l = new Ledger();
    l.adopt([seedEv]);
    return l;
  };

  const short = (need = 2) => ({ dim: "D1" as const, have: 1, need, seeds: [seedEv] });

  it("搜到、抓到、数对得上 —— 入账，这一维够了就停", async () => {
    const l = armed();
    let searches = 0;
    const r = await resupply({
      short: short(2),
      ledger: l,
      k: 3,
      room: () => true,
      search: async () => {
        searches += 1;
        return [{ url: "https://b.example.com/y", sourceDomain: "b.example.com" }];
      },
      fetch: async () => ({ pages: [page()] }),
    });
    expect(r.added).toBe(1);
    expect(searches).toBe(1);
    expect(l.entries).toHaveLength(2);
    expect(l.entries[1].sourceDomain).toBe("b.example.com");
    // 发出去的问法要记下来 —— 「已搜未得」那一栏读它，编的不算。
    expect(r.tried).toHaveLength(1);
  });

  it("这一维本来就够了，一次网都不出", async () => {
    const l = armed();
    let searches = 0;
    const r = await resupply({
      short: short(1), // 已经有 1 组，要 1 组
      ledger: l,
      k: 3,
      room: () => true,
      search: async () => { searches += 1; return []; },
      fetch: async () => ({ pages: [] }),
    });
    expect(searches).toBe(0);
    expect(r.added).toBe(0);
  });

  it("时间不够就停在这一条，已经补上的照样算数", async () => {
    const l = armed();
    let searches = 0;
    const r = await resupply({
      short: short(2),
      ledger: l,
      k: 3,
      room: () => false,
      search: async () => { searches += 1; return []; },
      fetch: async () => ({ pages: [] }),
    });
    expect(searches).toBe(0);
    expect(r.added).toBe(0);
  });

  it("抓回来的页里没有那个数 —— 不入账，也不报错", async () => {
    const l = armed();
    const r = await resupply({
      short: short(2),
      ledger: l,
      k: 3,
      room: () => true,
      search: async () => [{ url: "https://c.example.com/z", sourceDomain: "c.example.com" }],
      fetch: async () => ({ pages: [page({ url: "https://c.example.com/z", text: "这一页讲的是别的事，规模 2185 EFLOPS。" })] }),
    });
    expect(r.added).toBe(0);
    expect(l.entries).toHaveLength(1);
  });

  it("搜回来全是没人担责的源 —— 一页都不抓", async () => {
    const l = armed();
    let fetched = 0;
    await resupply({
      short: short(2),
      ledger: l,
      k: 3,
      room: () => true,
      search: async () => [{ url: "https://zhuanlan.zhihu.com/p/1", sourceDomain: "zhuanlan.zhihu.com" }],
      fetch: async () => { fetched += 1; return { pages: [] }; },
    });
    expect(fetched).toBe(0);
  });
});
