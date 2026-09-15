/**
 * N2′ 那张种子表：题面怎么写、分给哪条链。**纯计算，不出网也不叫模型。**
 *
 * 这里钉的两件事都属于「坏了没有症状」那一类：
 *
 * 1. **一条都不许丢。** 分派是按字面重合度归组的，而重合度为零的那几条最容易在某次
 *    「顺手清理一下」里被 `filter` 掉 —— 表现是那一次深研的钱白花了一部分，而屏幕上
 *    只看得到「这一轮种子少一点」。所以这里数总数。
 * 2. **题面里八个维度一个都不能少。** 少一维的后果不是报错，是那一维在 N3 永远只能靠
 *    自己搜；而覆盖表上它和「外面就是没有材料」长得一模一样。
 */
import { describe, expect, it } from "vitest";

import type { SearchHit } from "@/lib/research/search";

import type { SubjectCard } from "./anchor";
import { DIMENSIONS } from "./dims";
import type { PlannedProposition } from "./plan";
import { answerFor, bigrams, buildSeedBrief, routeSeeds, runSeed } from "./seed";
import { CHAINS } from "./sweep";

const card = (): SubjectCard => ({
  subject: "维信诺",
  segments: [{ name: "柔性 AMOLED", weight: "八成", lifecycle: "成长" }],
  projects: [
    { name: "第 8.6 代 AMOLED 产线", investment: "550 亿", onlineAt: "2027", techRoute: "AMOLED", heavy: true },
  ],
  inward: false,
  decision: false,
  customers: "国内手机品牌与车厂",
  website: "visionox.com",
  industry: "柔性中小尺寸 AMOLED 面板",
  window: "当前时点 ± 未来 3 年",
});

const hit = (title: string, url = `https://x.example.com/${encodeURIComponent(title)}`): SearchHit => ({
  title,
  url,
  snippet: "",
  sourceDomain: "x.example.com",
});

/** 一条挂在某一维上的空壳命题。分派只读 `statement` 和两组检索式。 */
const prop = (dimension: PlannedProposition["dimension"], statement: string): PlannedProposition => ({
  id: `P-${dimension}`,
  dimension,
  sourceKinds: ["行业机构"],
  statement,
  requiredEvidence: "",
  queries: [statement],
  counterQueries: [],
  material: true,
  freshnessUrgent: false,
  extraRoundsCap: 1,
});

describe("题面", () => {
  it("八个维度一个不少，主体和时间窗都在", () => {
    const brief = buildSeedBrief(card());
    for (const d of DIMENSIONS) expect(brief).toContain(d.name);
    expect(brief).toContain("维信诺");
    expect(brief).toContain("当前时点 ± 未来 3 年");
  });

  it("回答里把口径钉死，不给它再问一轮的余地", () => {
    const a = answerFor(card());
    expect(a).toContain("不用再确认");
    expect(a).toContain("柔性中小尺寸 AMOLED 面板");
  });

  it("主体卡缺栏位时不留空行 —— 那几行会原样发出去", () => {
    const bare = { ...card(), industry: "", customers: "", segments: [] };
    expect(buildSeedBrief(bare)).not.toMatch(/\n\n\n/);
  });
});

describe("分字二元组", () => {
  it("标点两边不许粘成一组", () => {
    // 「能、扩」跨了顿号，不是一个真的词片。
    expect(bigrams("产能、扩产").has("能扩")).toBe(false);
    expect(bigrams("产能扩产").has("能扩")).toBe(true);
  });
});

describe("分派", () => {
  const props = [
    prop("D2", "在建产线的扩产节奏与供需平衡预期"),
    prop("D6", "面板行业的产业政策与监管约束"),
  ];

  it("按字面重合度归到最沾边的那条链", () => {
    const routed = routeSeeds(
      [hit("2026 年产能周期与扩产节奏跟踪"), hit("新一轮显示产业政策与监管口径")],
      CHAINS,
      props
    );
    const at = (label: string) => routed[CHAINS.findIndex((c) => c.label === label)];
    expect(at("需求与供给").map((x) => x.title)).toEqual(["2026 年产能周期与扩产节奏跟踪"]);
    expect(at("政策、风险与主体").map((x) => x.title)).toEqual(["新一轮显示产业政策与监管口径"]);
  });

  it("谁都不沾边的轮流摊出去 —— 一条都不许丢", () => {
    const strays = ["ZZZ 季报", "QQQ 纪要", "WWW 简报", "YYY 备忘", "VVV 通函"].map((t) => hit(t));
    const routed = routeSeeds(strays, CHAINS, props);
    expect(routed.flat()).toHaveLength(strays.length);
    // 摊得开：五条不该全压在同一条链上。
    expect(routed.filter((x) => x.length).length).toBeGreaterThan(1);
  });

  it("空表交回等长的空数组 —— 调用方按下标取，不用判 null", () => {
    const routed = routeSeeds([], CHAINS, props);
    expect(routed).toHaveLength(CHAINS.length);
    expect(routed.flat()).toEqual([]);
  });

  it("一条命题都没有时照样分得下去（只按维度说明比）", () => {
    const routed = routeSeeds([hit("现有技术路线与挑战者路线的切换成本")], CHAINS, []);
    expect(routed.flat()).toHaveLength(1);
    expect(routed[CHAINS.findIndex((c) => c.label === "技术与上游")]).toHaveLength(1);
  });
});

describe("没配就不跑", () => {
  it("交一张带原话的空表，不抛 —— 这一步挂掉不该带倒整轮深研", async () => {
    process.env.TKOS_MODEL_MOCK = "";
    delete process.env.TKOS_QWEN_RESEARCH_URL;
    const t = await runSeed(card());
    expect(t.hits).toEqual([]);
    expect(t.reason).toContain("TKOS_QWEN_RESEARCH_URL");
  });
});
