import { describe, expect, it } from "vitest";

import type { Tally } from "@/lib/research/coverage";
import type { Evidence } from "@/lib/research/ledger";

import { compile, judge, terminalText, type Proposition } from "./props";

const RAW = {
  propositions: [
    {
      statement: "采购决策权在近一个季度已经移到业务线负责人手上",
      requiredEvidence: "公开招标文件里的评分权重变化，要带统计期间",
      queries: ["招标 技术评分 权重 下调", "采购决策 业务线", "评分办法 变更 公告", "第四条会被砍掉"],
      counterQueries: ["技术评分 权重 未变", "评分办法 未调整", "第三条会被砍掉"],
      materialityWeight: 0.8,
      freshnessUrgency: 0.9,
    },
    {
      statement: "这一变化同时出现在另外两个行业",
      requiredEvidence: "另外两个行业同期的招标文件",
      queries: ["另外两个行业 招标 评分"],
      counterQueries: ["行业间 评分 未同步"],
      materialityWeight: 0.4,
      freshnessUrgency: 0.3,
    },
  ],
};

describe("命题编译", () => {
  it("编号、检索式条数上限、分数落成布尔", async () => {
    const out = compile(RAW, 5);
    expect(out.map((p) => p.id)).toEqual(["P1", "P2"]);
    // 三条正向、两条反向是上限。多给的砍掉 —— 每条检索式都是一次真实的外部调用。
    expect(out[0].queries).toHaveLength(3);
    expect(out[0].counterQueries).toHaveLength(2);
    expect(out[0].material).toBe(true);
    expect(out[0].freshnessUrgent).toBe(true);
    expect(out[1].material).toBe(false);
    expect(out[1].freshnessUrgent).toBe(false);
  });

  it("阈值在代码里，不在提示词里", async () => {
    /*
     * 0.7 这条线由这里定。写进提示词的话，模型改一次口气这条线就动了，而「实质命题」
     * 决定的是补搜轮数上限 —— 一个会自己漂移的预算上限等于没有上限。
     */
    const at = compile({ propositions: [{ statement: "刚好落在线上的一条命题", materialityWeight: 0.7 }] }, 5);
    const below = compile({ propositions: [{ statement: "差一点点没到线的一条命题", materialityWeight: 0.69 }] }, 5);
    expect(at[0].material).toBe(true);
    expect(below[0].material).toBe(false);
  });

  it("实质命题给两轮补搜，其余一轮", async () => {
    // 无上限的补搜循环是这类系统最容易长出来的坑：它会一直搜到超时，而超时的报告和
    // 搜不到的报告在结果页上都是空白。
    const out = compile(RAW, 5);
    expect(out[0].extraRoundsCap).toBe(2);
    expect(out[1].extraRoundsCap).toBe(1);
  });

  it("按预算截断 —— 命题数是这条链最贵的乘数", async () => {
    expect(compile(RAW, 1)).toHaveLength(1);
    expect(compile(RAW, 0)).toHaveLength(0);
  });

  it("太短的陈述丢掉，脏输入不炸", async () => {
    expect(compile({ propositions: [{ statement: "太短" }] }, 5)).toHaveLength(0);
    expect(compile({}, 5)).toEqual([]);
    expect(compile({ propositions: "不是数组" }, 5)).toEqual([]);
    expect(compile({ propositions: [{ statement: 123, queries: "不是数组" }] }, 5)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 判定                                                                        */
/* -------------------------------------------------------------------------- */

const prop = (over: Partial<Proposition> = {}): Proposition => ({
  id: "P1",
  statement: "采购决策权已经移到业务线负责人手上",
  requiredEvidence: "",
  queries: [],
  counterQueries: [],
  material: false,
  freshnessUrgent: false,
  extraRoundsCap: 1,
  ...over,
});

const tally = (over: Partial<Tally> = {}): Tally => ({
  propositionId: "P1",
  groups: 2,
  citableGroups: 2,
  ugcOnly: false,
  ...over,
});

const ev = (over: Partial<Evidence> = {}): Evidence =>
  ({
    id: "E1",
    propositionId: "P1",
    claim: "示例",
    exactQuote: "示例",
    excerpt: "示例",
    span: [0, 2],
    url: "https://a.example.com/x",
    sourceDomain: "a.example.com",
    supportRelation: "supports",
    evidenceType: "statement",
    authorityClass: "media",
    sourceTier: "C",
    usedAs: "current_state",
    contentHash: "h",
    retrievedAt: "2026-08-25T00:00:00.000Z",
    verificationStatus: "span_matched",
    independenceGroup: "dom:a.example.com",
    ...over,
  }) as Evidence;

describe("够不够全部按数，不问模型", () => {
  it("三条义务都过才算过", async () => {
    // 问模型「证据够了吗」它会答够 —— 它没有不够的动机。
    const v = judge(prop(), tally(), [ev()], 1, 1);
    expect(v.ok).toBe(true);
    expect(v.unmet).toEqual([]);
    expect(v.terminal).toBe("");
  });

  it("覆盖不够就把差在哪写成人话带出来", async () => {
    const v = judge(prop(), tally({ groups: 1, citableGroups: 1 }), [ev()], 1, 1);
    expect(v.ok).toBe(false);
    expect(v.unmet[0]).toContain("只有一个独立来源");
  });

  it("实质命题不能只有媒体转述撑着", async () => {
    const v = judge(prop({ material: true }), tally(), [ev({ sourceTier: "C" })], 1, 1);
    expect(v.ok).toBe(false);
    expect(v.unmet.some((u) => u.includes("监管"))).toBe(true);
  });

  it("非实质命题不管档次", async () => {
    /*
     * 那道门开在所有命题上，会让每次深研都挂着几条永远补不上的义务 —— 而挂着的义务
     * 等于没有义务。
     */
    expect(judge(prop({ material: false }), tally(), [ev({ sourceTier: "C" })], 1, 1).ok).toBe(true);
  });

  it("有 A 或 B 级就算过", async () => {
    expect(judge(prop({ material: true }), tally(), [ev({ sourceTier: "B" })], 1, 1).ok).toBe(true);
  });

  it("时效敏感的命题要有一条带统计期间的现状证据", async () => {
    // 「拿旧数描述现状」是这类研究里最难看出来的一种错：数字是真的，只是过期了。
    const stale = judge(prop({ freshnessUrgent: true }), tally(), [ev({ usedAs: "historical_point", period: "2019-12-31" })], 1, 1);
    expect(stale.unmet.some((u) => u.includes("统计期间"))).toBe(true);

    const noPeriod = judge(prop({ freshnessUrgent: true }), tally(), [ev({ usedAs: "current_state", period: "  " })], 1, 1);
    expect(noPeriod.unmet.some((u) => u.includes("统计期间"))).toBe(true);

    expect(judge(prop({ freshnessUrgent: true }), tally(), [ev({ usedAs: "current_state", period: "2025-12-31" })], 1, 1).ok).toBe(true);
  });

  it("一条反向检索都没发出去，是漏了工序 —— 即使覆盖已经够了", async () => {
    /*
     * 这一条检的是**行为不是结果**。查了没查到是合法结果（HP-5），没查是漏了工序，
     * 而只看结果的话这两种长得一模一样。
     */
    const v = judge(prop(), tally(), [ev()], 0, 1);
    expect(v.ok).toBe(false);
    expect(v.unmet.some((u) => u.includes("反向检索"))).toBe(true);
  });
});

describe("终态：什么时候不再补搜", () => {
  it("轮数没用完就不落终态", async () => {
    const v = judge(prop({ extraRoundsCap: 2 }), tally({ groups: 0, citableGroups: 0 }), [], 1, 1);
    expect(v.ok).toBe(false);
    expect(v.terminal).toBe("");
  });

  it("轮数用完、一条来源都没有 → 快照缺口", async () => {
    const v = judge(prop({ extraRoundsCap: 1 }), tally({ groups: 0, citableGroups: 0 }), [], 1, 2);
    expect(v.terminal).toBe("unknown_snapshot_gap");
    expect(terminalText(v)).toBe("本轮检索没有找到任何可用来源");
  });

  it("轮数用完、找到了来源但凑不齐印证 → 不可得", async () => {
    // 这两种终态在报告里要写成不同的话：一种是「没这个东西」，一种是「有说法但撑不住」。
    const v = judge(prop({ extraRoundsCap: 1 }), tally({ groups: 3, citableGroups: 0, ugcOnly: true }), [ev()], 1, 2);
    expect(v.terminal).toBe("unavailable");
    expect(terminalText(v)).toContain("补搜轮数用完");
    expect(terminalText(v)).toContain("个人发布");
  });

  it("闭合了就没有终态，哪怕轮数早就用完", async () => {
    expect(judge(prop({ extraRoundsCap: 1 }), tally(), [ev()], 1, 9).terminal).toBe("");
  });

  it("过了的命题终态那句话是空的", async () => {
    expect(terminalText(judge(prop(), tally(), [ev()], 1, 1))).toBe("");
  });
});
