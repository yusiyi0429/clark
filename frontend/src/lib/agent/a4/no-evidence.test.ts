/**
 * 「这一份手上有没有外部证据」这句话。
 *
 * 钉的是一件真发生过的事：两家检索一家 403、一家免费额度用尽，二十条检索式条条报错，
 * 一份外部证据都没入账 —— 而这一轮的产出是一份格式漂亮的报告，运行记录写着 ok，报告
 * 顶上什么都没写。要翻到运营台、展开那条折起来的事件明细，才看得见「入账 0 条」。
 *
 * 所以这一层要答的不是「有没有」（那是一个布尔值，早就有了），是**空在哪一格** ——
 * 检索全线失败、检索通了但搜不到、搜到了抓不下来、抓下来了没过入账闸，四种的下一步
 * 动作完全不同（去控制台 / 换问法 / 看抓取 / 看抽取），而它们在报告上长得一模一样。
 */
import { describe as group, expect, it } from "vitest";

import type { Round } from "./evidence";
import { noExternalEvidence } from "./no-evidence";

/** 一轮取证的账，只给这条用例关心的那几格，其余归零。 */
const round = (r: Partial<Round> = {}): Round => ({
  no: 1,
  propositionIds: ["P1"],
  queries: 0,
  counterQueries: 0,
  hits: 0,
  hitsByProvider: {},
  fetched: 0,
  fetchFailed: 0,
  recorded: 0,
  rejected: 0,
  searchErrors: [],
  ...r,
});

/** 两家都在的一轮：`searchAll` 给每一家都留一格账，挂掉的那家也有。 */
const twoProviders = {
  bocha: { label: "博查", returned: 0, unique: 0 },
  doubao: { label: "豆包搜索", returned: 0, unique: 0 },
};

const args = (rounds: Round[], propositions = 4) => ({
  providerLabel: "博查 + 豆包搜索",
  propositions,
  recorded: rounds.reduce((n, r) => n + r.recorded, 0),
  rounds,
});

group("入账过证据就没什么要声明的", () => {
  it("入账 ≥1 条就返回 undefined —— 这一句只在空手时出现", () => {
    const rounds = [round({ queries: 20, hits: 40, fetched: 8, recorded: 6 })];
    expect(noExternalEvidence(args(rounds))).toBeUndefined();
  });

  it("入账了但同时有几条检索式报错，仍然不声明", () => {
    /*
     * 报错不等于空手。一家限流、另一家照常出结果的那一轮手上是有证据的，把它也标成
     * 「没有外部证据」会让这句声明贬值 —— 声明贬值之后真空手的那一轮就没人看了。
     */
    const rounds = [round({ queries: 20, hits: 12, fetched: 4, recorded: 3, searchErrors: ["「问法」· 博查：HTTP 403"] })];
    expect(noExternalEvidence(args(rounds))).toBeUndefined();
  });
});

group("空在哪一格", () => {
  it("压根没联网：说的是没编命题，不是检索坏了", () => {
    const n = noExternalEvidence(args([], 0));
    expect(n?.headline).toContain("没有外部证据");
    expect(n?.why).toContain("没有联网取证");
    // 不许提检索家 —— 这一轮一条检索式都没发出去，提了会让人去查一个通着的接口。
    expect(n?.why).not.toContain("博查");
  });

  it("每条检索式都失败：说清是条条都失败，并带上厂商原话", () => {
    /*
     * 这是那一轮的真实形状：20 条检索式 × 2 家 = 40 次尝试，40 条报错。
     * 「每条都失败」和「失败了几条」是两句话，前者才说得出「这一份等于没联网」。
     */
    const errors = Array.from({ length: 40 }, (_, i) =>
      i % 2
        ? `「问法${i}」· 豆包搜索：豆包搜索失败 code=10406: Free quota has been exhausted.`
        : `「问法${i}」· 博查：检索接口返回 HTTP 403`
    );
    const rounds = [round({ queries: 20, hitsByProvider: twoProviders, searchErrors: errors })];
    const n = noExternalEvidence(args(rounds));
    expect(n?.headline).toContain("没有外部证据");
    expect(n?.headline).toContain("检索");
    expect(n?.why).toContain("每一条都失败");
    expect(n?.why).toContain("博查 + 豆包搜索");
    // 原话要带 —— 「检索失败了」答不出该去充值、换 key 还是降并发。
    expect(n?.why).toContain("10406");
    expect(n?.why).toContain("403");
    // 但不许把四十条原话全贴出来：同一句重复三十遍不多给一点信息。
    expect(n?.why.length).toBeLessThan(600);
  });

  it("只有一部分检索式失败而仍然空手：不说成全线失败", () => {
    const rounds = [
      round({
        queries: 20,
        hitsByProvider: twoProviders,
        searchErrors: ["「问法1」· 博查：检索接口返回 HTTP 429"],
      }),
    ];
    const n = noExternalEvidence(args(rounds));
    expect(n?.why).toContain("40 次里有 1 次报错");
    expect(n?.why).not.toContain("每一条都失败");
  });

  it("检索是通的、就是搜不到：这一条要和检索坏掉分开", () => {
    // 下一步动作是换问法，不是去控制台 —— 说错了他会去查一个好着的账号。
    const rounds = [round({ queries: 20, hitsByProvider: twoProviders })];
    const n = noExternalEvidence(args(rounds));
    expect(n?.why).toContain("一条结果都没搜到");
    expect(n?.why).not.toContain("报错");
  });

  it("搜到了但一页都没抓下来", () => {
    const rounds = [round({ queries: 20, hits: 36, fetched: 0, fetchFailed: 8 })];
    const n = noExternalEvidence(args(rounds));
    expect(n?.why).toContain("搜到 36 条");
    expect(n?.why).toContain("一页都没抓下来");
  });

  it("抓下来了，没有一条过入账闸 —— 这一格说明抽取那一层在出问题", () => {
    const rounds = [round({ queries: 20, hits: 36, fetched: 8, rejected: 12 })];
    const n = noExternalEvidence(args(rounds));
    expect(n?.why).toContain("抓下 8 页");
    expect(n?.why).toContain("12 条");
    expect(n?.why).toContain("入账闸");
  });

  it("几轮的账要加起来看，不只看最后一轮", () => {
    // 补搜轮换了问法，第一轮搜到过东西而第二轮空手 —— 整轮的形状是「搜到过」。
    const rounds = [
      round({ no: 1, queries: 12, hits: 20, fetched: 5, rejected: 7 }),
      round({ no: 2, queries: 8, hitsByProvider: twoProviders }),
    ];
    const n = noExternalEvidence(args(rounds));
    expect(n?.why).toContain("搜到 20 条");
  });
});

group("这句话是给人看的", () => {
  it("headline 一句话说完，不带换行", () => {
    const n = noExternalEvidence(args([round({ queries: 20, hitsByProvider: twoProviders })]));
    expect(n?.headline).not.toContain("\n");
    expect(n?.headline.length).toBeLessThan(60);
  });

  it("四种空法的 why 各不相同 —— 否则这一层白做", () => {
    const whys = [
      noExternalEvidence(args([], 0)),
      noExternalEvidence(args([round({ queries: 20, hitsByProvider: twoProviders, searchErrors: ["a", "b"] })])),
      noExternalEvidence(args([round({ queries: 20, hitsByProvider: twoProviders })])),
      noExternalEvidence(args([round({ queries: 20, hits: 36, fetched: 0, fetchFailed: 8 })])),
      noExternalEvidence(args([round({ queries: 20, hits: 36, fetched: 8, rejected: 12 })])),
    ].map((n) => n?.why);
    expect(new Set(whys).size).toBe(whys.length);
  });
});
