import { describe, expect, it } from "vitest";
import type { Harness } from "@/lib/agent/harness";
import { bigramOverlap } from "@/lib/agent/overlap";
import type { EntityRef, TargetRef } from "./stages";
import { matchTargets, narrowTargets, normalizeEntities } from "./targets";

const targets: TargetRef[] = [
  { kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" },
  { kind: "strategy", id: "S-1", text: "把渠道压在一线城市的代理商上" },
  { kind: "hypothesis", id: "H-4", text: "客户愿意为可核验的证据链多付钱" },
];

/** 只用到 callMessages / note / substep 三格，其余不碰 —— 这一段是纯装配。 */
function stubHarness(reply: unknown): Harness {
  return {
    async callMessages() { return { text: JSON.stringify(reply) }; },
    note() {},
    substep() {},
  } as unknown as Harness;
}

// `bigramOverlap` 住在 `@/lib/agent/overlap`，但它这一轮的两个消费方
// （`normalizeEntities` / `narrowTargets`）都在这个文件里，所以覆盖也放这里 ——
// 单开一个只有两条断言的测试文件，读的人得开两个文件才看得完这一件事。
describe("bigramOverlap", () => {
  it("同一个名字是 1，毫不相干是 0", () => {
    expect(bigramOverlap("智谱 AI", "智谱 AI")).toBe(1);
    expect(bigramOverlap("智谱", "渠道")).toBe(0);
  });

  it("一个字的名字也不炸（没有二元组时退化成整串比对）", () => {
    expect(bigramOverlap("A", "A")).toBe(1);
    expect(bigramOverlap("A", "B")).toBe(0);
  });
});

describe("normalizeEntities", () => {
  it("重名的并成一条", () => {
    const raw: EntityRef[] = [
      { name: "智谱 AI", kind: "company" },
      { name: "智谱 AI", kind: "company" },
    ];
    expect(normalizeEntities(raw)).toEqual([{ name: "智谱 AI", kind: "company" }]);
  });

  it("写法接近的并到先出现的那个名字下，并留下 aliasOf", () => {
    const raw: EntityRef[] = [
      { name: "智谱 AI", kind: "company" },
      { name: "智谱AI", kind: "company" },
    ];
    const out = normalizeEntities(raw);
    expect(out).toEqual([
      { name: "智谱 AI", kind: "company" },
      { name: "智谱AI", kind: "company", aliasOf: "智谱 AI" },
    ]);
  });

  it("不同类的不并 —— 同名的产品和公司是两件事", () => {
    const out = normalizeEntities([
      { name: "谛听", kind: "company" },
      { name: "谛听", kind: "product" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].aliasOf).toBeUndefined();
  });
});

describe("narrowTargets", () => {
  it("按重叠度排序，重叠为 0 的不进候选", () => {
    const out = narrowTargets([{ name: "agent 编排", kind: "topic" }], targets);
    expect(out.map((t) => t.id)).toEqual(["J-2"]);
  });

  it("k 是硬上限", () => {
    const many: TargetRef[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "judgment" as const, id: `J-${i}`, text: "agent 编排这件事",
    }));
    expect(narrowTargets([{ name: "agent 编排", kind: "topic" }], many, 5)).toHaveLength(5);
  });
});

describe("matchTargets", () => {
  it("把模型判的方向对回靶点，量级也带回来", async () => {
    const h = stubHarness({
      entities: [{ name: "智谱 AI", kind: "company" }],
      hits: [{ targetId: "J-2", match: "challenges", why: "这条信号里那家公司正是新玩家" }],
      magnitude: "material",
    });
    const r = await matchTargets(h, { signalText: "某公司发布了 agent 编排产品", entities: ["智谱 AI"], targets });
    expect(r.entities).toEqual([{ name: "智谱 AI", kind: "company" }]);
    expect(r.hits).toEqual([
      { target: targets[0], match: "challenges", why: "这条信号里那家公司正是新玩家", hops: null },
    ]);
    expect(r.magnitude).toBe("material");
  });

  it("模型报了个不存在的靶点编号就丢掉，不许凭空造靶点", async () => {
    const h = stubHarness({
      entities: [], hits: [{ targetId: "J-999", match: "supports", why: "编的" }], magnitude: "unknown",
    });
    const r = await matchTargets(h, { signalText: "x", entities: [], targets });
    expect(r.hits).toEqual([]);
  });

  it("match 不在四个合法值里就当没命中", async () => {
    const h = stubHarness({
      entities: [], hits: [{ targetId: "J-2", match: "maybe", why: "说不清" }], magnitude: "unknown",
    });
    const r = await matchTargets(h, { signalText: "x", entities: [], targets });
    expect(r.hits).toEqual([]);
  });

  it("模型回的不是合法 JSON —— 空手回来，不抛", async () => {
    const h = { async callMessages() { return { text: "不是 JSON" }; }, note() {}, substep() {} } as unknown as Harness;
    const r = await matchTargets(h, { signalText: "x", entities: [], targets });
    expect(r).toEqual({ entities: [], hits: [], magnitude: "unknown" });
  });

  it("跳数由调用方给 —— 给得出就带上", async () => {
    const h = stubHarness({
      entities: [], hits: [{ targetId: "J-2", match: "extends", why: "同一条线往下走" }], magnitude: "immaterial",
    });
    const r = await matchTargets(h, { signalText: "x", entities: [], targets, hopsOf: () => 1 });
    expect(r.hits[0].hops).toBe(1);
  });
});
