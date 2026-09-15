import { describe, expect, it } from "vitest";

import { numeric, recompute } from "./calc";
import type { Evidence } from "./ledger";

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  id: "E1",
  propositionId: "P1",
  claim: "示例",
  exactQuote: "示例",
  excerpt: "示例",
  span: [0, 2],
  url: "https://stats.example.gov.cn/a",
  sourceDomain: "stats.example.gov.cn",
  supportRelation: "supports",
  evidenceType: "statistic",
  authorityClass: "official_statistics",
  sourceTier: "A",
  usedAs: "current_state",
  value: 1590,
  unit: "EFLOPS",
  period: "2025-12-31",
  geography: "中国",
  contentHash: "h",
  retrievedAt: "2026-08-25T00:00:00.000Z",
  verificationStatus: "span_matched",
  independenceGroup: "src:国家某局",
  ...over,
});

const kinds = (report: string, entries: Evidence[] = []) => recompute(report, entries).map((c) => c.kind);

describe("数字认读", () => {
  it("认中文数量级和千分位", async () => {
    expect(numeric("8.82亿")).toBeCloseTo(8.82e8);
    expect(numeric("1,037.3")).toBeCloseTo(1037.3);
    expect(numeric("1.2 万亿")).toBeCloseTo(1.2e12);
    expect(numeric("30万")).toBeCloseTo(3e5);
  });

  it("「万亿」不能先撞上「万」", async () => {
    // SCALE 表的顺序就是这一条。撞上「万」的话 1.2 万亿会读成 1.2 万，差八个数量级。
    expect(numeric("1.2万亿")).toBeGreaterThan(numeric("999亿")!);
  });

  it("认不出返回 null", async () => {
    expect(numeric("若干")).toBeNull();
    expect(numeric("")).toBeNull();
  });
});

describe("一：占比加总", () => {
  it("区间按上界加总 —— 按中值算正好落在 100% 以内，那才是这类错能活下来的原因", async () => {
    const text = "成本结构上，折旧占比 40–50%，电费 30–50%，运维 10–20%。";
    const out = recompute(text, []);
    expect(out.map((c) => c.kind)).toEqual(["share_sum"]);
    expect(out[0].ok).toBe(false);
    expect(out[0].note).toContain("120");
  });

  it("同一指标的几个时点放一句里不是占比结构，不加（ISS-229 的假警报，2026-09-04）", async () => {
    expect(
      kinds("中国大陆厂商 2024 年全年合计份额 49.2%，尚未过半；半年口径为 50.7%、Q1 口径为 53.4%。")
    ).toEqual([]);
  });

  it("括号里的百分数是另一个分母的旁注，不进加总（ISS-232 的假警报，2026-09-06）", async () => {
    expect(kinds("2024Q3 柔性 AMOLED 手机面板中国内厂商出货份额 54.8%（该季柔性占比 76.4%），过半仅见于这一季。")).toEqual([]);
  });

  it("标着未核的句子不算（ISS-230 的假警报，2026-09-04）", async () => {
    expect(
      kinds("市场与客户结构待核：手机 AMOLED 收入约 60%、穿戴约 20%、前三大手机客户收入占比超过 80%。")
    ).toEqual([]);
  });

  it("阈值不是结构里的一块：「超过 80%」「5% 以上」不进加总", async () => {
    expect(kinds("收入构成上手机占比约 60%、穿戴约 20%，前三大客户合计占比超过 80%。")).toEqual([]);
    expect(kinds("成本结构上，折旧占比 40%，电费 35%，运维 15%，其中进口件占 30% 以上。")).toEqual([]);
    // 阈值词不在紧挨着的位置时照旧算：这一句是真的加爆了
    expect(kinds("成本结构上，折旧占比 60%，电费 35%，运维 15%。")).toEqual(["share_sum"]);
    // 「达」是陈述一块占多少的常规写法，不是阈值
    expect(kinds("成本结构上，折旧占比达 60%，电费达 35%，运维达 15%。")).toEqual(["share_sum"]);
  });

  it("加起来不超界的不报", async () => {
    expect(kinds("成本结构上，折旧占比 40%，电费 35%，运维 15%。")).toEqual([]);
  });

  it("留一点余量给「约」和四舍五入", async () => {
    // 差一个百分点就报的闸，会在运营台上一直亮着 —— 亮着的门等于没有门。
    expect(kinds("成本结构上，折旧占比约 51%，电费约 50%。")).toEqual([]);
  });

  it("没有占比线索的句子不碰", async () => {
    /*
     * 全文所有百分数乱加会满屏假警报。这一条不是宽松，是为了让这道闸活下来 ——
     * 一个天天误报的检查，人会去把它关掉。
     */
    expect(kinds("毛利率 45%，同期客户续约率 62%，NPS 到了 70%。")).toEqual([]);
  });
});

describe("二：增速", () => {
  it("证据编号里的数字不是起点，回溯出来的「44.」不是终点（ISS-238 的假警报，2026-09-07）", async () => {
    expect(kinds("行业出货创新高[E2]，维信诺自身出货同比增长 44.3%、位居全球第三[E7]，营收同比增长 33.80%[E28]。")).toEqual([]);
  });

  it("「A 亿元、同比增长 B%，其中……同比增长 C%」不是从 A 到 B（ISS-235 的假警报，2026-09-06）", async () => {
    expect(
      kinds("2024 年营业收入 79.29 亿元、同比增长 33.8%，其中 OLED 产品收入 74.94 亿元、同比增长 46.01%。")
    ).toEqual([]);
  });

  it("按文中自己给的两个数复算，对不上就报", async () => {
    const out = recompute("规模从 1037.3 亿元增长至 2185 亿元，同比增长 177%。", []);
    expect(out.map((c) => c.kind)).toEqual(["growth_rate"]);
    // 实际 +110.6%。差六十多个百分点，这不是口径问题。
    expect(out[0].note).toContain("110.6");
  });

  it("算对了的不报", async () => {
    expect(kinds("规模从 1000 亿元增长至 2000 亿元，同比增长 100%。")).toEqual([]);
  });

  it("三个数不在同一句里就不配对", async () => {
    // 跨句配对必然配错：上一句的基数配下一句的增幅，报出来的每一条都是假的。
    expect(kinds("规模从 1000 亿元增长至 2000 亿元。另据测算，某细分市场同比增长 12%。")).toEqual([]);
  });
});

describe("三：数量级", () => {
  it("同命题同口径同期差两个数量级 —— 二者不可同真", async () => {
    const out = recompute("", [
      ev({ id: "E1", value: 1590 }),
      ev({ id: "E2", value: 15.9 }),
    ]);
    expect(out.map((c) => c.kind)).toEqual(["magnitude"]);
    expect(out[0].note).toContain("E1");
    expect(out[0].note).toContain("E2");
  });

  it("差在合理范围内的不报", async () => {
    expect(kinds("", [ev({ id: "E1", value: 1590 }), ev({ id: "E2", value: 1420 })])).toEqual([]);
  });

  it("口径对不上就不比", async () => {
    /*
     * 单位、地域、期间任一不同都不比。口径没填齐的比出来的「矛盾」全是假的，而假警报
     * 会让整道闸被关掉。
     *
     * 代价要写明：**改一个 period 就能让这道闸失效**。抽取器把两条同期数据标成两个期间，
     * 这里就沉默了。这一版没有把口径字段跟引句原文对一遍的能力（见 ledger 那边的
     * EV-MUT），所以这道闸只拦得住「口径填对了但数字矛盾」这一种。
     */
    expect(kinds("", [ev({ id: "E1", value: 1590 }), ev({ id: "E2", value: 15.9, period: "2024-12-31" })])).toEqual([]);
    expect(kinds("", [ev({ id: "E1", value: 1590 }), ev({ id: "E2", value: 15.9, unit: "PFLOPS" })])).toEqual([]);
    expect(kinds("", [ev({ id: "E1", value: 1590 }), ev({ id: "E2", value: 15.9, geography: "全球" })])).toEqual([]);
  });

  it("跨命题不比", async () => {
    expect(kinds("", [ev({ id: "E1", value: 1590 }), ev({ id: "E2", value: 15.9, propositionId: "P2" })])).toEqual([]);
  });

  it("不是统计类、或者没填数值单位的不比", async () => {
    expect(kinds("", [ev({ id: "E1" }), ev({ id: "E2", value: 15.9, evidenceType: "statement" })])).toEqual([]);
    expect(kinds("", [ev({ id: "E1" }), ev({ id: "E2", value: 15.9, unit: undefined })])).toEqual([]);
    expect(kinds("", [ev({ id: "E1" }), ev({ id: "E2", value: undefined })])).toEqual([]);
  });
});

describe("只报错不报对", () => {
  it("三条规则都没话说时返回空数组", async () => {
    /*
     * 空数组等于「没有站不住的算术」，**不等于**「每个衍生数字都反查得到 calc_id」。
     * 后者要等沙箱那一档：模型先输出模型定义、代码填值、正文绑 id。现在做不到，
     * 就不假装做到。
     */
    expect(recompute("这一段里没有任何算术。", [ev()])).toEqual([]);
  });
});
