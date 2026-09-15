import { describe, expect, it } from "vitest";

import { attributable, satisfied, tally, weakness, type CoverageInput } from "./coverage";

const it_ = (propositionId: string, group: string, sourceDomain: string): CoverageInput => ({
  propositionId,
  group,
  sourceDomain,
});

describe("谁背后有人担责", () => {
  it("个人发布的平台不算，子域一并算", async () => {
    expect(attributable("zhihu.com")).toBe(false);
    expect(attributable("zhuanlan.zhihu.com")).toBe(false);
    expect(attributable("WWW.Zhihu.com")).toBe(false);
    expect(attributable("wenku.baidu.com")).toBe(false);
    expect(attributable("csdn.net")).toBe(false);
  });

  it("自媒体平台的独立子域也不算", async () => {
    /*
     * 百家号、雪球和表里已有的头条号、新浪财经号（`t.cj.sina.com.cn`）是同一种东西：
     * **整个子域都是用户发布的内容，平台不为其署名**。它们不属于下面那条「混合门户」
     * 豁免 —— 那一条豁免的是搜狐/网易/新浪**主站**（同站既有自家采编又有个人号，按
     * 路径判会不稳）。按子域判是稳的，`t.cj.sina.com.cn` 已经在用这个判法。
     *
     * 加这两条是从真运行里来的：一轮深研的 69 条证据里有 24 条百家号，它们被当成了
     * 「可计入印证的来源」，于是一批只有自媒体转载撑着的断言通过了覆盖判定。
     */
    expect(attributable("baijiahao.baidu.com")).toBe(false);
    expect(attributable("xueqiu.com")).toBe(false);
    // 百度和新浪的别处不受影响。
    expect(attributable("www.baidu.com")).toBe(true);
    expect(attributable("finance.sina.com.cn")).toBe(true);
  });

  it("混合门户放过", async () => {
    /*
     * 搜狐、网易既有自家采编也有个人号。按路径判会不稳（同一个站两条路径两种结论），
     * 所以一律放过，转载交给独立性折叠去处理。宁可多算一个可引用来源，也不要一条今天
     * 成立明天不成立的判定规则。
     */
    expect(attributable("www.sohu.com")).toBe(true);
    expect(attributable("163.com")).toBe(true);
  });

  it("正常机构站算", async () => {
    expect(attributable("stats.gov.cn")).toBe(true);
    expect(attributable("miit.gov.cn")).toBe(true);
  });

  it("不是「档次低」，是「没人署名」—— 判档次是 sourceTier 的事", async () => {
    // 一个 D 级的媒体转载仍然可以计入印证；一个内容完全正确的知乎回答不行。
    expect(attributable("some-small-media.com")).toBe(true);
  });
});

describe("按命题清点", () => {
  it("同组只算一次", async () => {
    const [t] = tally([
      it_("P1", "src:国家统计局", "a.com"),
      it_("P1", "src:国家统计局", "b.com"),
      it_("P1", "dom:c.com", "c.com"),
    ]);
    expect(t.groups).toBe(2);
    expect(t.citableGroups).toBe(2);
    expect(satisfied(t)).toBe(true);
  });

  it("两个数都留着：「找到 4 组、可引用 0 组」和「找到 0 组」不是一件事", async () => {
    /*
     * 前者要换检索方向（去找有人署名的源），后者要换问法。漏斗上只留一个数就分不出
     * 该做哪一件。
     */
    const [t] = tally([
      it_("P1", "dom:zhihu.com", "zhihu.com"),
      it_("P1", "dom:weibo.com", "weibo.com"),
    ]);
    expect(t.groups).toBe(2);
    expect(t.citableGroups).toBe(0);
    expect(t.ugcOnly).toBe(true);
    expect(satisfied(t)).toBe(false);
  });

  it("一组不算印证", async () => {
    const [t] = tally([it_("P1", "src:国家统计局", "stats.gov.cn")]);
    expect(t.citableGroups).toBe(1);
    expect(satisfied(t)).toBe(false);
    expect(weakness(t)).toContain("只有一个独立来源");
  });

  it("命题之间不串", async () => {
    const out = tally([
      it_("P1", "dom:a.com", "a.com"),
      it_("P2", "dom:b.com", "b.com"),
      it_("P2", "dom:c.com", "c.com"),
    ]);
    expect(out.find((t) => t.propositionId === "P1")!.citableGroups).toBe(1);
    expect(out.find((t) => t.propositionId === "P2")!.citableGroups).toBe(2);
  });

  it("一条都没有的命题压根不出现在清点结果里", async () => {
    // 判定那一层要自己给这种命题补一个空 tally（见 `evidence.ts`）—— 这里不替它编。
    expect(tally([])).toEqual([]);
  });
});

describe("差在哪要说成人话", () => {
  it("够了就不说话", async () => {
    expect(weakness({ propositionId: "P1", groups: 2, citableGroups: 2, ugcOnly: false })).toBe("");
  });

  it("一条来源都没找到", async () => {
    expect(weakness({ propositionId: "P1", groups: 0, citableGroups: 0, ugcOnly: false })).toContain(
      "没找到任何来源"
    );
  });

  it("全是个人发布时点明这一点", async () => {
    // 「没找到」和「找到了但没人为它署名」在检索策略上要做的事完全不同。
    const w = weakness({ propositionId: "P1", groups: 3, citableGroups: 0, ugcOnly: true });
    expect(w).toContain("个人发布");
    expect(w).toContain("3 组");
  });
});

/**
 * 「没搜」和「搜了没找到」在这一句话上也要分得开（2026-09-07，ISS-239 §3.B）。
 *
 * 这句话会被报告的「未能核实」一节照抄。共用「没找到任何来源」的话，屏幕上「我们没查」
 * 和「外面没有」就再也分不开了 —— 后者是结论，前者是欠账。
 */
describe("没搜过和搜了没找到", () => {
  const empty = { propositionId: "P1", groups: 0, citableGroups: 0, ugcOnly: false };

  it("没发出过检索时说的是「没搜过，不是外面没有」", () => {
    const w = weakness(empty, { searched: false });
    expect(w).toContain("没搜过");
    expect(w).not.toContain("没找到任何来源");
  });

  it("不传就是原来那句话，一个字不变 —— 老调用点都是搜过之后才算的", () => {
    expect(weakness(empty)).toBe(weakness(empty, { searched: true }));
    expect(weakness(empty)).toContain("没找到任何来源");
  });

  it("够了就还是不说话，不管搜没搜", () => {
    const ok = { propositionId: "P1", groups: 2, citableGroups: 2, ugcOnly: false };
    expect(weakness(ok, { searched: false })).toBe("");
  });
});
