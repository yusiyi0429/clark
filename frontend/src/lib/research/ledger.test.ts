import { describe, expect, it } from "vitest";

import type { Snapshot } from "./fetch";
import { Ledger, type EvidenceDraft } from "./ledger";

const URL = "https://stats.example.gov.cn/gongbao";
const BODY =
  "据国家某局消息，2025 年末全国算力总规模为 1590 EFLOPS，" +
  "其中智能算力约 780 EFLOPS。口径为 FP16。";

const page = (over: Partial<Snapshot> = {}): Snapshot => ({
  url: URL,
  title: "某年度算力统计公报",
  text: BODY,
  contentHash: "hash-1",
  retrievedAt: "2026-08-25T00:00:00.000Z",
  truncated: false,
  ...over,
});

const draft = (over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  propositionId: "P1",
  claim: "2025 年末全国算力总规模为 1590 EFLOPS",
  exactQuote: "2025 年末全国算力总规模为 1590 EFLOPS",
  url: URL,
  supportRelation: "supports",
  evidenceType: "statistic",
  authorityClass: "official_statistics",
  usedAs: "current_state",
  value: 1590,
  unit: "EFLOPS",
  precision: "FP16",
  period: "2025-12-31",
  geography: "中国",
  ...over,
});

/** 挂好快照的台账。 */
const armed = (over: Partial<Snapshot> = {}): Ledger => {
  const l = new Ledger();
  l.archive([page(over)]);
  return l;
};

describe("入账三道门", () => {
  it("七项必填缺一项就拒，而且说出缺的是哪一项", async () => {
    const l = armed();
    expect(l.record(draft({ authorityClass: "" as never }))).toBeNull();
    expect(l.entries).toHaveLength(0);
    expect(l.rejections[0].why).toContain("缺必填项");
    expect(l.rejections[0].why).toContain("谁在说");
  });

  it("本轮没抓过的地址一律拒 —— 检索摘要里的数字进不来", async () => {
    // 这一条就是 HP-1。摘要把口径、日期、单位都剥掉了，剩一个看着精确的数。
    const l = armed();
    expect(l.record(draft({ url: "https://another.example.com/x" }))).toBeNull();
    expect(l.rejections[0].why).toContain("没有抓到正文");
  });

  it("引句在原文里定位不到就拒", async () => {
    const l = armed();
    expect(l.record(draft({ exactQuote: "2025 年末全国算力总规模为 1600 EFLOPS" }))).toBeNull();
    expect(l.rejections[0].why).toBe("引句在原文里定位不到");
  });

  it("页被截断过时，拒绝理由要说出这个可能", async () => {
    /*
     * 「引句定位不到」在截断页上有两种含义：抽取器在编，或者那段话在被砍掉的后半页里。
     * 说成同一句话，一次真的抓取不全会被读成一次模型在编。
     */
    const l = armed({ truncated: true });
    expect(l.record(draft({ exactQuote: "全国算力总规模同比下降" }))).toBeNull();
    expect(l.rejections[0].why).toContain("截断");
  });

  it("过了三道门的条目补齐编号、坐标、原文段和档次", async () => {
    const l = armed();
    const e = l.record(draft())!;
    expect(e.id).toBe("E1");
    expect(BODY.slice(e.span[0], e.span[1])).toBe(e.excerpt);
    expect(e.excerpt).toBe("2025 年末全国算力总规模为 1590 EFLOPS");
    expect(e.sourceDomain).toBe("stats.example.gov.cn");
    expect(e.contentHash).toBe("hash-1");
    expect(e.retrievedAt).toBe("2026-08-25T00:00:00.000Z");
    expect(e.verificationStatus).toBe("span_matched");
    // 组在这一刻还是空的：折叠要等这一批抓完（见 `fold`）。
    expect(e.independenceGroup).toBe("");
  });

  it("同一页同一段原文对同一条命题只入一次", async () => {
    const l = armed();
    expect(l.record(draft())).not.toBeNull();
    expect(l.record(draft({ claim: "换个说法，还是那一段原文" }))).toBeNull();
    expect(l.rejections[0].why).toContain("已为这条命题入过账");
  });

  it("同一段原文可以为两条命题各入一次", async () => {
    // 一段话同时支持两条命题是常有的事。按命题去重，不按原文去重。
    const l = armed();
    expect(l.record(draft({ propositionId: "P1" }))).not.toBeNull();
    expect(l.record(draft({ propositionId: "P2" }))).not.toBeNull();
    expect(l.entries.map((e) => e.id)).toEqual(["E1", "E2"]);
  });

  it("被拒的留着 —— 「12 条全被拒」和「一条都没抽」要分得开", async () => {
    const l = armed();
    l.record(draft({ exactQuote: "编的第一句" }));
    l.record(draft({ exactQuote: "编的第二句" }));
    expect(l.entries).toHaveLength(0);
    expect(l.rejections).toHaveLength(2);
  });
});

describe("档次由代码定", () => {
  it("官方统计在可署名域名上是 A 级", async () => {
    expect(armed().record(draft())!.sourceTier).toBe("A");
  });

  it("行业机构 B、媒体 C、其他 D", async () => {
    const l = armed();
    expect(l.record(draft({ propositionId: "P1", authorityClass: "industry_body" }))!.sourceTier).toBe("B");
    expect(l.record(draft({ propositionId: "P2", authorityClass: "media" }))!.sourceTier).toBe("C");
    expect(l.record(draft({ propositionId: "P3", authorityClass: "other" }))!.sourceTier).toBe("D");
  });

  it("无人担责的域名一律压到 D，不管抽取器给了什么档", async () => {
    /*
     * 一份上传到文库的 PPT 里写着「工信部数据」，它仍然是一份来路不明的 PPT。
     * 这一条不压住，D 级来源只要自称转引官方就能爬到 A 级。
     */
    const url = "https://wenku.baidu.com/view/abc";
    const l = new Ledger();
    l.archive([page({ url })]);
    const e = l.record(draft({ url, authorityClass: "official_statistics" }))!;
    expect(e.sourceTier).toBe("D");
  });
});

describe("独立性组回填", () => {
  it("给了就用给的，没给按域名兜底", async () => {
    const l = armed();
    l.record(draft());
    l.fold(new Map([[URL, "src:国家某局"]]));
    expect(l.entries[0].independenceGroup).toBe("src:国家某局");

    l.fold(new Map());
    expect(l.entries[0].independenceGroup).toBe("dom:stats.example.gov.cn");
  });
});

/* -------------------------------------------------------------------------- */
/* EV-MUT                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 变异测试。**改一个字符，这道闸还拦得住吗。**
 *
 * 这一组不是在测 `locate`（那边自己有测），是在钉**这一版的能力边界**：引句里的任何
 * 数字漂移都会被拦下，而口径字段（`period` / `precision` / `geography`）的漂移**这一版
 * 拦不住** —— 没有任何代码把这几个字段跟引句原文对一遍。
 *
 * 下面那两条「拦不住」的断言是故意写成断言而不是注释的：等哪天有人加上口径与原文的
 * 交叉核对，这两条会红，逼他回来把边界改掉。写成注释的话，那句话会在功能变强之后
 * 继续挂在文件里说反话。
 */
describe("EV-MUT：改一个字之后还能不能入账", () => {
  const mutations: [string, string][] = [
    ["年份 +1", "2026 年末全国算力总规模为 1590 EFLOPS"],
    ["年份 -1", "2024 年末全国算力总规模为 1590 EFLOPS"],
    ["数值 -3%", "2025 年末全国算力总规模为 1542 EFLOPS"],
    ["数值 +10%", "2025 年末全国算力总规模为 1749 EFLOPS"],
    ["数值 ×10", "2025 年末全国算力总规模为 15900 EFLOPS"],
    ["单位替换 EFLOPS→PFLOPS", "2025 年末全国算力总规模为 1590 PFLOPS"],
    ["精度替换 FP16→FP32", "口径为 FP32。"],
    ["范围放大 全国→全球", "2025 年末全球算力总规模为 1590 EFLOPS"],
  ];

  for (const [name, quote] of mutations) {
    it(`引句里的「${name}」拦得住`, async () => {
      const l = armed();
      expect(l.record(draft({ exactQuote: quote }))).toBeNull();
      expect(l.rejections[0].why).toContain("定位不到");
    });
  }

  it("口径字段跟引句对不上，这一版拦不住（已知边界）", async () => {
    // 引句原文写的是 2025 年末、FP16，而字段填成 2024 年末、FP32 —— 照样入账。
    const l = armed();
    const e = l.record(draft({ period: "2024-12-31", precision: "FP32", geography: "全球" }));
    expect(e).not.toBeNull();
    expect(e!.period).toBe("2024-12-31");
  });

  it("口径字段整个缺掉，这一版也拦不住（已知边界）", async () => {
    /*
     * 缺口径不拒是有意的：拒了会把一大批只写了「据某局，规模在增长」的合法证据挡在
     * 门外。代价是「口径缺件」这件事只能靠 `props.judge` 的时效义务在**命题**这一层
     * 发现，单条证据上没有闸。
     */
    const l = armed();
    const e = l.record(draft({ value: undefined, unit: undefined, period: undefined }));
    expect(e).not.toBeNull();
  });
});

describe("把别处记好的证据并进来", () => {
  /**
   * 造一本已经记了 n 条的台账。模拟「另一波 / 另一条链 / 上一轮预研」记下的那些。
   */
  const filled = (n: number, urlBase = "https://a.example.com/"): Ledger => {
    const l = new Ledger();
    for (let i = 0; i < n; i += 1) {
      const url = `${urlBase}${i}`;
      l.archive([page({ url, contentHash: `hash-${urlBase}-${i}` })]);
      l.record(draft({ url, propositionId: `P${i}` }));
    }
    return l;
  };

  it("编号是实例内自增，所以两本台账的条目编号一定撞", async () => {
    /*
     * 这不是新发现的缺陷，是 `record` 契约的直接推论：`this.n` 从 0 起，每本台账各自数。
     * 写这条是为了把它**钉成一条会失败的测试**——`sweep` 合并四条链、每条又按波
     * 各调一次 `gatherEvidence`（每次一本新台账），合并时如果只是 push，
     * 证据包里就会有好几条不同的证据都叫 E1，而**报告正文引的就是这个编号**。
     */
    const a = filled(2, "https://a.example.com/");
    const b = filled(2, "https://b.example.com/");
    expect(a.entries.map((e) => e.id)).toEqual(["E1", "E2"]);
    expect(b.entries.map((e) => e.id)).toEqual(["E1", "E2"]);
  });

  it("adopt 接着本台账的号往下编，不留重号", async () => {
    const target = filled(2, "https://a.example.com/");
    const other = filled(3, "https://b.example.com/");
    const got = target.adopt(other.entries);

    expect(got.map((e) => e.id)).toEqual(["E3", "E4", "E5"]);
    expect(target.entries.map((e) => e.id)).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    // 编号之外的东西一个字都不许动 —— 引句、跨度、档次都是上一轮核过的结论。
    expect(got[0].excerpt).toBe(other.entries[0].excerpt);
    expect(got[0].sourceTier).toBe(other.entries[0].sourceTier);
    expect(got[0].span).toEqual(other.entries[0].span);
  });

  it("adopt 进来的条目也进去重表，同一段原文不会再入一次账", async () => {
    /*
     * 少了这一句，A4 用预研证据垫台账之后再自己搜一遍，同一页同一段会入两次账 ——
     * 而覆盖判定数的是**独立来源**，重复入账会让一条只有一个来源的命题看起来有两个。
     */
    const target = new Ledger();
    const other = filled(1, "https://c.example.com/");
    target.adopt(other.entries);

    // 同一页、同一命题、同一段原文，再记一次要被拒。
    target.archive([page({ url: "https://c.example.com/0", contentHash: "hash-https://c.example.com/-0" })]);
    expect(target.record(draft({ url: "https://c.example.com/0", propositionId: "P0" }))).toBeNull();
    expect(target.rejections.at(-1)!.why).toContain("已为这条命题入过账");
    expect(target.entries).toHaveLength(1);
  });

  it("adopt 空数组是安全的空操作", async () => {
    const l = filled(1);
    expect(l.adopt([])).toEqual([]);
    expect(l.entries).toHaveLength(1);
  });
});
