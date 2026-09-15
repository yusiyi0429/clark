import { describe, expect, it } from "vitest";
import {
  DIM_IDS,
  DIMENSIONS,
  INDUSTRY_SCOPE,
  MIN_PROPS_PER_DIM,
  decisionScope,
  gateOpen,
  inScope,
  isDimId,
  keyQuestions,
  overBudget,
  type ScopeQuestion,
} from "./dims";

describe("维度框架", () => {
  it("八个维度，编号不重复，每个都有一句说明", () => {
    expect(DIMENSIONS).toHaveLength(8);
    expect(new Set(DIM_IDS).size).toBe(8);
    for (const d of DIMENSIONS) expect(d.brief.length).toBeGreaterThan(4);
  });

  it("认得出维度编号", () => {
    expect(isDimId("D3")).toBe(true);
    expect(isDimId("D9")).toBe(false);
    expect(isDimId(3)).toBe(false);
  });
});

describe("单维度检索预算", () => {
  it("占比超过三成的维度报出来，按占比从大到小", () => {
    const over = overBudget({ D1: 10, D2: 1, D3: 1, D4: 8 });
    expect(over.map((x) => x.dim)).toEqual(["D1", "D4"]);
    expect(over[0].share).toBeCloseTo(0.5);
  });

  it("平均分配时一个都不报", () => {
    expect(overBudget({ D1: 2, D2: 2, D3: 2, D4: 2 })).toEqual([]);
  });

  it("一条检索式都没有时不报（那是别的门要拦的事）", () => {
    expect(overBudget({})).toEqual([]);
  });
});

describe("覆盖门控", () => {
  const full = DIM_IDS.map((dim) => ({ dim, independentGroups: 1 }));

  it("每个维度都有一组独立来源就开门", () => {
    expect(gateOpen(full, []).ok).toBe(true);
  });

  it("强判断所在维度要两组，一组不够", () => {
    const r = gateOpen(full, ["D4"]);
    expect(r.ok).toBe(false);
    expect(r.missing.join("")).toContain("D4");
    expect(r.missing.join("")).toContain("2 组");
  });

  it("已搜未得也算过门，但试过的问法要够四条", () => {
    const rows = full.map((r) =>
      r.dim === "D6" ? { dim: r.dim, independentGroups: 0, notFound: { tried: ["a", "b", "c", "d"] } } : r
    );
    expect(gateOpen(rows, []).ok).toBe(true);

    const thin = full.map((r) =>
      r.dim === "D6" ? { dim: r.dim, independentGroups: 0, notFound: { tried: ["a", "b"] } } : r
    );
    expect(gateOpen(thin, []).ok).toBe(false);
    expect(gateOpen(thin, []).missing.join("")).toContain("4 条");
  });

  it("整个维度没上表和有表但空着，报的是两句不同的话", () => {
    const absent = gateOpen(full.filter((r) => r.dim !== "D7"), []);
    const empty = gateOpen(full.map((r) => (r.dim === "D7" ? { ...r, independentGroups: 0 } : r)), []);
    expect(absent.missing.join("")).not.toBe(empty.missing.join(""));
  });
});

describe("任务范围", () => {
  const q = (over: Partial<ScopeQuestion> = {}): ScopeQuestion => ({
    id: "Q1-1",
    question: "对方的验收口径由谁定",
    dimension: "D2",
    routeIds: ["R1"],
    dependsOn: [],
    changesChoice: true,
    needsInternal: false,
    ...over,
  });

  it("行业题那一份是八维、每维两条、三成上限 —— 不传 scope 时用的就是它", () => {
    expect(INDUSTRY_SCOPE.kind).toBe("industry");
    expect(INDUSTRY_SCOPE.dims).toEqual(DIM_IDS);
    expect(INDUSTRY_SCOPE.minPropsPerDim).toBe(MIN_PROPS_PER_DIM);
    expect(INDUSTRY_SCOPE.dimShareCap).toBe(0.3);
    expect(INDUSTRY_SCOPE.questions).toEqual([]);
  });

  it("决策题：维度按 DIM_IDS 排序，每维下限降到 1，三成上限关掉", () => {
    const s = decisionScope({ dims: ["D8", "D2"], questions: [q({ dimension: "D3" })] });
    expect(s.dims).toEqual(["D2", "D3", "D8"]);
    expect(s.minPropsPerDim).toBe(1);
    expect(s.dimShareCap).toBeNull();
  });

  it("一维都推不出来时落兜底表，而且那三维要和 draft.ts 的 DECISION_DIMS 对得上", () => {
    expect(decisionScope({}).dims).toEqual(["D2", "D3", "D8"]);
  });

  it("要优先补的是「会改变选择、而且外部搜得到」的那几条", () => {
    const s = decisionScope({
      dims: ["D2"],
      questions: [
        q({ id: "Q1" }),
        q({ id: "Q2", changesChoice: false }),
        // 内部那条不进：它的补法是要材料、问客户，再发多少轮检索都不会有结果。
        q({ id: "Q3", needsInternal: true }),
      ],
    });
    expect(keyQuestions(s).map((x) => x.id)).toEqual(["Q1"]);
  });

  it("在不在范围里", () => {
    const s = decisionScope({ dims: ["D2", "D3"] });
    expect(inScope(s, "D2")).toBe(true);
    expect(inScope(s, "D6")).toBe(false);
    expect(inScope(INDUSTRY_SCOPE, "D6")).toBe(true);
  });
});

/**
 * 覆盖门按范围查。**这是 ISS-239 那一轮多花掉的那几分钟的闸门那一头。**
 *
 * 决策题的草稿只写三维，而这道门照旧要八维 —— 于是每一轮都挂着五条永远补不上的缺口。
 * 挂着的义务等于没有义务：真正缺的那一条被淹在五条噪声里，谁也不会去看。
 */
describe("覆盖门控按任务范围", () => {
  const three = decisionScope({ dims: ["D2", "D3", "D8"] });

  it("范围外的维度不报缺失，范围内的照旧一维一组", () => {
    const rows = three.dims.map((dim) => ({ dim, independentGroups: 1 }));
    const r = gateOpen(rows, [], three);
    expect(r.ok).toBe(true);
    // 同一份行按八维去判就是五条缺失 —— 这正是改之前每一轮的样子。
    expect(gateOpen(rows, []).missing).toHaveLength(5);
  });

  it("放宽的只有查哪几维：范围内那一维空着照旧不开门", () => {
    const rows = three.dims.map((dim) => ({ dim, independentGroups: dim === "D3" ? 0 : 1 }));
    const r = gateOpen(rows, [], three);
    expect(r.ok).toBe(false);
    expect(r.missing.join("")).toContain("D3");
    // 强判断那一维照旧要两组。
    expect(gateOpen(three.dims.map((dim) => ({ dim, independentGroups: 1 })), ["D2"], three).ok).toBe(false);
  });
});
