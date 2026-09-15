// src/lib/agent/a4/sweep.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Harness } from "@/lib/agent/harness";
import type { Evidence } from "@/lib/research/ledger";
import { providers, type SearchProvider } from "@/lib/research/search";
import { DIM_IDS, decisionScope, gateOpen, type ScopeQuestion } from "./dims";
import { CHAINS, coverageTable, MAX_WAVES, maxWavesFor, scopeTrace, sweep } from "./sweep";
import type { PlannedProposition } from "./plan";

const prop = (dim: string, i: number): PlannedProposition =>
  ({
    id: `${dim}-P${i}`,
    dimension: dim,
    statement: `${dim} 第 ${i} 条命题`,
    requiredEvidence: "机构数据",
    queries: [`${dim} q${i}`],
    counterQueries: [`${dim} 反 ${i}`],
    sourceKinds: ["行业机构", "公司披露"],
    material: true,
    freshnessUrgent: true,
    extraRoundsCap: 1,
  }) as PlannedProposition;

describe("分链", () => {
  it("八个维度分完，一维只属于一条链", () => {
    const all = CHAINS.flatMap((c) => c.dims);
    expect(new Set(all).size).toBe(8);
    expect(all).toHaveLength(8);
  });

  it("链数在三到四条之间 —— 按维度分工，不按模型分工", () => {
    expect(CHAINS.length).toBeGreaterThanOrEqual(3);
    expect(CHAINS.length).toBeLessThanOrEqual(4);
  });
});

/**
 * **决策题上一条链最多发几波。**
 *
 * 波数是这一层最贵的旋钮：每波两分半钟真金白银，而多发的那一波在三轮实测里一条独立来源都
 * 没换回来（共源率 74% / 77% / 50%）。它改错的两头都没有症状 —— 少发一波是报告里少一块内容
 * 而屏幕上照旧写着「已完成」，多发一波是他多等两分半而看不出多出来的是重复。
 *
 * 按 `CHAINS` 逐条推，不是记几个数：新加一条链而忘了给它定波数的话，下面第一条会红。
 */
describe("决策题的波数", () => {
  it("格局一波，其余三条两波", () => {
    for (const c of CHAINS) {
      expect(maxWavesFor(true, c.label), c.label).toBe(c.label === "格局" ? 1 : 2);
    }
  });

  it("行业题一条都不压 —— 那种题的价值就在证据的宽度上", () => {
    for (const c of CHAINS) {
      expect(maxWavesFor(false, c.label), c.label).toBe(MAX_WAVES);
    }
    expect(MAX_WAVES).toBe(3);
  });

  it("决策题上每一条链都真的比行业题少 —— 少一条就等于这一刀白切了那条链", () => {
    for (const c of CHAINS) {
      expect(maxWavesFor(true, c.label), c.label).toBeLessThan(maxWavesFor(false, c.label));
    }
  });
});

describe("覆盖门控", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
  });

  it("每个维度都上覆盖表，一个不缺", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, DIM_IDS.flatMap((d) => [prop(d, 1), prop(d, 2)]), {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(r.coverage.map((x) => x.dim).sort()).toEqual([...DIM_IDS].sort());
  });

  it("一条命题都没有的维度也上表，标成已搜未得", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, [prop("D1", 1), prop("D1", 2)], {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    const d5 = r.coverage.find((x) => x.dim === "D5");
    expect(d5?.independentGroups).toBe(0);
    expect(d5?.notFound).toBeDefined();
  });

  it("门没开时不抛异常，缺口写在 gate.missing 里", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, [prop("D1", 1)], { slot: "pro", strongDims: [], substep: () => {} });
    expect(r.gate.ok).toBe(false);
    expect(r.gate.missing.length).toBeGreaterThan(0);
  });

  it("每一轮只替自己那条链的维度搜 —— 链之间不串命题", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, DIM_IDS.flatMap((d) => [prop(d, 1), prop(d, 2)]), {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(r.rounds.length).toBeGreaterThan(0);
    for (const round of r.rounds) {
      const dims = new Set(round.propositionIds.map((id) => id.split("-")[0]));
      const chain = CHAINS.find((c) => [...dims].every((d) => (c.dims as readonly string[]).includes(d)));
      expect(chain, `这一轮跨了链：${round.propositionIds.join("、")}`).toBeDefined();
    }
  });

  /*
   * 这一条测的是覆盖表**怎么数**，所以直接喂台账条目给 `coverageTable`：要让 `sweep()` 整跑
   * 出一条知乎来源，得连检索家、抓取和抽取一起换掉，那时候测的就不是这个数了。
   *
   * 数错的后果不在这张表上，在屏幕上：`gateOpen` 拿它判强判断那几维够不够两个独立来源
   * （§2.2），少数一次就等于「两个独立来源都印证了」可以由一条论坛帖子凑成第二个。
   */
  it("论坛帖子不算独立来源那一组 —— 强判断的维度不许拿它凑第二组", () => {
    const ev = (propositionId: string, domain: string, group: string): Evidence =>
      ({ propositionId, sourceDomain: domain, independenceGroup: group }) as Evidence;
    const rows = coverageTable(
      [prop("D4", 1)],
      [
        // 一份机构来源 + 一条知乎，折叠出来是两个不同的组。
        ev("D4-P1", "gov.cn", "grp-A"),
        ev("D4-P1", "zhihu.com", "grp-B"),
      ],
      new Map()
    );
    const d4 = rows.find((r) => r.dim === "D4");
    expect(d4?.independentGroups).toBe(1);
    // 有一组，所以不是「已搜未得」那一态 —— 它得走「组数不够」那一句，别的话都不对。
    expect(d4?.notFound).toBeUndefined();

    const gate = gateOpen(rows, ["D4"]);
    expect(gate.ok).toBe(false);
    expect(
      gate.missing.some((m) => m.startsWith("D4 ") && m.includes("独立来源 1 组") && m.includes("要 2 组"))
    ).toBe(true);
  });

  it("两组都有机构担责时照常算两组 —— 别把门一起焊死", () => {
    const ev = (propositionId: string, domain: string, group: string): Evidence =>
      ({ propositionId, sourceDomain: domain, independenceGroup: group }) as Evidence;
    const rows = coverageTable(
      [prop("D4", 1)],
      [ev("D4-P1", "gov.cn", "grp-A"), ev("D4-P1", "stats.gov.cn", "grp-B")],
      new Map()
    );
    expect(rows.find((r) => r.dim === "D4")?.independentGroups).toBe(2);
    expect(gateOpen(rows, ["D4"]).missing.some((m) => m.startsWith("D4 "))).toBe(false);
  });

  /*
   * 时间不够那一路。25 秒的上限比「一次调用值得发」的下限（20 秒）大，所以调用本身还发得
   * 出去 —— 被压掉的是「这一波 + 后面出稿要留的位置」凑不出来的那一问（`deadline.ts`）。
   *
   * 两条断言缺一不可：**每条链都留一句原话**，以及**没试过的问法一条都不许上表**。后者是
   * 这一版最容易漏的一处：原来 `tried` 是进循环之前按计划一次性记上的，那时候「已搜未得，
   * 试过 12 条问法」在一波都没发的链上是一句假话，而覆盖表上它和真搜过一遍长得一样。
   */
  it("时间不够时一波都不发，每条链留一句原话，而且不许报没试过的问法", async () => {
    const h = new Harness({ agent: "A4", slot: "pro", deadlineMs: 25_000 });
    const r = await sweep(h, providers().list, DIM_IDS.flatMap((d) => [prop(d, 1), prop(d, 2)]), {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(r.rounds).toEqual([]);
    expect(r.capped).toHaveLength(CHAINS.length);
    for (const c of CHAINS) {
      expect(r.capped.some((x) => x.includes(`「${c.label}」这条链一波都没发`))).toBe(true);
    }
    // 八维都是「已搜未得」，而试过的问法一条都没有 —— 因为确实一条都没发出去。
    for (const row of r.coverage) {
      expect(row.independentGroups).toBe(0);
      expect(row.notFound?.tried, row.dim).toEqual([]);
    }
  });

  it("假检索给的是三个不同域名，共源率不过线 —— 不该触发改写", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, [prop("D1", 1), prop("D1", 2)], {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(r.rewrites).toEqual([]);
    expect(r.capped).toEqual([]);
  });

  it("一条都没入账时换问法再发一波，且只补一次（2026-09-05）", async () => {
    const zero: SearchProvider = { name: "zero", label: "零", windowed: false, reason: "", async search() { return []; } };
    const h = new Harness({ agent: "A4", slot: "pro" });
    const original = h.callMessages.bind(h);
    const labels: string[] = [];
    vi.spyOn(h, "callMessages").mockImplementation(async (label, messages, opts, meta, hint) => {
      labels.push(label);
      if (label.includes("a4.rewrite")) return { text: '{"queries":["换过的问法"]}' } as never;
      return original(label, messages, opts, meta, hint);
    });
    const r = await sweep(h, [zero], [prop("D1", 1)], { slot: "pro", strongDims: [], substep: () => {} });
    expect(labels.filter((l) => l.includes("a4.rewrite"))).toHaveLength(1);
    expect(r.rewrites).toHaveLength(1);
    expect(r.rewrites[0].to).toEqual(["换过的问法"]);
    // 两波都发了（第二波用的是改写后的问法），第二波仍是零就收口，没有第三波。
    expect(r.rounds).toHaveLength(2);
    expect(r.coverage.find((c) => c.dim === "D1")?.notFound?.tried).toContain("换过的问法");
  });
});

/* -------------------------------------------------------------------------- */
/* 任务范围                                                                     */
/* -------------------------------------------------------------------------- */

const question = (over: Partial<ScopeQuestion> = {}): ScopeQuestion => ({
  id: "Q1-1",
  question: "对方 8.6 代线的验收口径由谁定",
  dimension: "D1",
  routeIds: ["R1"],
  dependsOn: ["A1"],
  changesChoice: true,
  needsInternal: false,
  ...over,
});

/** 带 `questionId` 的命题 —— 决策题上它是命题和关键问题之间唯一的绑定。 */
const qprop = (dim: string, i: number, questionId: string): PlannedProposition =>
  ({ ...prop(dim, i), questionId }) as PlannedProposition;

/** 什么都搜不到的那一家。零收获那几条要靠它造。 */
const zeroSearch: SearchProvider = {
  name: "zero",
  label: "零",
  windowed: false,
  reason: "",
  async search() {
    return [];
  },
};

describe("覆盖表按任务范围", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
  });

  /**
   * 决策题只有几维时，表上就该只有几行。
   *
   * 多出来那几行不是无害的：它们每一行都是「0 组、已搜未得、试过 0 条问法」，`gateOpen`
   * 会把它们报成缺失，而那几条会在报告文首那份机检清单里挤掉真正缺的那一条。
   */
  it("范围外的维度不上表、也不进门 —— 不传 scope 时照旧八行", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const scope = decisionScope({ dims: ["D1", "D2"] });
    const props = [prop("D1", 1), prop("D2", 1)];
    const r = await sweep(h, providers().list, props, {
      slot: "pro",
      strongDims: [],
      substep: () => {},
      scope,
    });
    expect(r.coverage.map((x) => x.dim)).toEqual(["D1", "D2"]);
    expect(r.gate.missing.some((m) => m.startsWith("D5"))).toBe(false);

    const wide = await sweep(new Harness({ agent: "A4", slot: "pro" }), providers().list, props, {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(wide.coverage).toHaveLength(8);
  });

  it("四处口径一致：编译丢掉的维度不会在覆盖表上冒出来", () => {
    const scope = decisionScope({ dims: ["D1"] });
    const rows = coverageTable([prop("D1", 1), prop("D5", 1)], [], new Map(), scope);
    expect(rows.map((r) => r.dim)).toEqual(["D1"]);
    expect(gateOpen(rows, [], scope).missing.join("")).not.toContain("D5");
  });
});

/**
 * **「没搜」和「搜了没找到」必须分得开。**
 *
 * ISS-239 那一轮最贵的一处错就在这个区分上：报告写「外界没有公开材料」，而真实情况是那条
 * 问题压根没进过检索。两者在屏幕上长得一模一样 —— 一个是结论，一个是欠账。
 */
describe("关键问题的 trace", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
  });

  it("计划里没有它 = 未搜，而且话要说成「没搜过，不是外面没有」", () => {
    const scope = decisionScope({ dims: ["D1"], questions: [question()] });
    const t = scopeTrace(scope, { props: [prop("D1", 1)], entries: [], tried: new Map() })[0];
    expect(t.status).toBe("未搜");
    expect(t.why).toContain("检索计划里没有它");
    expect(t.why).toContain("不是外面没有");
    expect(t.tried).toEqual([]);
  });

  it("排了命题但一条问法都没发出去 = 未搜，不是已搜未得", () => {
    const scope = decisionScope({ dims: ["D1"], questions: [question()] });
    const t = scopeTrace(scope, {
      props: [qprop("D1", 1, "Q1-1")],
      entries: [],
      // `tried` 是发出去之后才记的，所以空表的意思就是一条都没发出去。
      tried: new Map(),
    })[0];
    expect(t.status).toBe("未搜");
    expect(t.why).toContain("一条都没发出去");
  });

  it("发出去了、回来是空的 = 已搜未得，并列全试过的问法", () => {
    const scope = decisionScope({ dims: ["D1"], questions: [question()] });
    const p = qprop("D1", 1, "Q1-1");
    const t = scopeTrace(scope, {
      props: [p],
      entries: [],
      tried: new Map([["D1" as const, [...p.queries, ...p.counterQueries]]]),
    })[0];
    expect(t.status).toBe("已搜未得");
    expect(t.tried).toEqual([...p.queries, ...p.counterQueries]);
    expect(t.why).toContain("试过 2 条问法");
  });

  it("答案在内部材料里 = 不适用，不是缺口也不是再搜一轮", () => {
    const scope = decisionScope({ dims: ["D1"], questions: [question({ needsInternal: true })] });
    const t = scopeTrace(scope, { props: [], entries: [], tried: new Map() })[0];
    expect(t.status).toBe("不适用");
    expect(t.why).toContain("需要内部材料或客户确认");
  });

  it("有入账 = 已得，路线和证据编号都留在账上", () => {
    const scope = decisionScope({ dims: ["D1"], questions: [question()] });
    const p = qprop("D1", 1, "Q1-1");
    const t = scopeTrace(scope, {
      props: [p],
      entries: [{ id: "E3", propositionId: p.id } as Evidence],
      tried: new Map([["D1" as const, p.queries]]),
    })[0];
    expect(t.status).toBe("已得");
    expect(t.evidenceIds).toEqual(["E3"]);
    expect(t.routeIds).toEqual(["R1"]);
    expect(t.dependsOn).toEqual(["A1"]);
    expect(t.why).toBe("");
  });

  it("时间不够一波都没发时，关键问题是「未搜」而不是「已搜未得」", async () => {
    const h = new Harness({ agent: "A4", slot: "pro", deadlineMs: 25_000 });
    const scope = decisionScope({ dims: ["D1"], questions: [question()] });
    const r = await sweep(h, providers().list, [qprop("D1", 1, "Q1-1")], {
      slot: "pro",
      strongDims: [],
      substep: () => {},
      scope,
    });
    expect(r.questions?.[0].status).toBe("未搜");
    expect(r.questions?.[0].tried).toEqual([]);
  });
});

/**
 * **零收获的关键问题要补，无关的不足不补。**
 *
 * 改之前这一层是反的：补搜只有「补旁证」一层，而它按设计跳过一组来源都没有的维度
 * （`resupply.ts` 的 `shortfalls`：没有种子就无从找旁证）。于是「有 1 组、去凑第 2 组」会补，
 * 「会改变选哪条路线的问题一条证据都没拿到」反而不补。
 */
describe("补搜的优先级", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
  });

  /** 改写那一步固定交回一条问法，好让波数是确定的（同上面那条零入账的用法）。 */
  const withRewrite = (h: Harness): void => {
    const original = h.callMessages.bind(h);
    vi.spyOn(h, "callMessages").mockImplementation(async (label, messages, opts, meta, hint) => {
      if (label.includes("a4.rewrite")) return { text: '{"queries":["换过的问法"]}' } as never;
      return original(label, messages, opts, meta, hint);
    });
  };

  const runZero = async (q: ScopeQuestion) => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    withRewrite(h);
    return sweep(h, [zeroSearch], [qprop("D1", 1, "Q1-1")], {
      slot: "pro",
      strongDims: [],
      substep: () => {},
      scope: decisionScope({ dims: ["D1"], questions: [q] }),
    });
  };

  it("会改变路线又零收获的，两波跑完之后再补一波", async () => {
    const key = await runZero(question());
    const background = await runZero(question({ changesChoice: false }));
    // 两波是链里的（第二波用改写后的问法），第三波是这一层补的。
    expect(background.rounds).toHaveLength(2);
    expect(key.rounds).toHaveLength(3);
    expect(key.questions?.[0].status).toBe("已搜未得");
  });

  it("补完仍然空手的，挂成「留到首访当面问」，但缺口照旧在账上（ISS-240）", async () => {
    /*
     * 三波（两波链里 + 一波补搜）都空手之后，这一条外网就是查不到 —— ISS-240 那五条问的是
     * 对方的组织、系统栈和采购门槛，都是当面问的事。它该变成一句可执行的话，而不是缺陷
     * 清单上又一条「没查到」。**但缺口不许被藏起来**：状态仍是「已搜未得」，A4-G08 照报。
     */
    const key = await runZero(question());
    const line = key.capped.find((x) => x.includes("留到首访当面问"));
    expect(line).toBeTruthy();
    expect(line).toContain("外网试过");
    expect(key.questions?.[0].status).toBe("已搜未得");
  });

  it("答案在内部的那条不补 —— 它不该无限变成网络查询", async () => {
    const internal = await runZero(question({ needsInternal: true }));
    expect(internal.rounds).toHaveLength(2);
    expect(internal.questions?.[0].status).toBe("不适用");
  });

  it("行业题一条关键问题都没有，这一层整段不跑", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    withRewrite(h);
    const r = await sweep(h, [zeroSearch], [prop("D1", 1)], {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(r.rounds).toHaveLength(2);
    expect(r.questions).toEqual([]);
  });

  it("时间不够补不成时留一句原话，不是静默跳过", async () => {
    /*
     * 25 秒：一波都发不起（`room` 判的是这一波 + 出稿要留的位置），所以链里零波、
     * 这一层也零波 —— 而**没补成必须说出来**，否则一份「没来得及查」的报告和一份
     * 「查了没有」的报告在正文里长得一模一样。
     */
    const h = new Harness({ agent: "A4", slot: "pro", deadlineMs: 25_000 });
    const r = await sweep(h, [zeroSearch], [qprop("D1", 1, "Q1-1")], {
      slot: "pro",
      strongDims: [],
      substep: () => {},
      scope: decisionScope({ dims: ["D1"], questions: [question()] }),
    });
    expect(r.rounds).toEqual([]);
    expect(r.capped.some((x) => x.includes("会改变路线的关键问题零收获"))).toBe(true);
  });
});
