import { describe, expect, it } from "vitest";
import type { EntityRef, EvidenceLite, TargetHit } from "./stages";
import { bestTier, ruleBlindspot, tierAtLeast } from "./blindspot";

const entities: EntityRef[] = [{ name: "智谱 AI", kind: "company" }];
const hit: TargetHit = {
  target: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
  match: "challenges", why: "正是新玩家", hops: 1,
};
function ev(tier: EvidenceLite["tier"], id = "E1"): EvidenceLite {
  return {
    id, claim: "c", sourceRef: "https://a.gov.cn/x", date: "2026-08-27T00:00:00.000Z",
    tier, cosourceKey: `dom:${id}`, provenance: { issueId: "I-7", stage: "pre_research" },
  };
}

describe("tierAtLeast / bestTier", () => {
  it("A 比 B 高，D 垫底", () => {
    expect(tierAtLeast("A", "B")).toBe(true);
    expect(tierAtLeast("B", "B")).toBe(true);
    expect(tierAtLeast("C", "B")).toBe(false);
    expect(tierAtLeast(null, "B")).toBe(false);
  });

  it("取台账里最高的那一档；空台账是 null，不是 D", () => {
    expect(bestTier([ev("C"), ev("A", "E2")])).toBe("A");
    expect(bestTier([])).toBeNull();
  });
});

describe("ruleBlindspot", () => {
  it("已经在看的东西不是盲区 —— 它是已知", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [ev("A")], watched: ["智谱 AI"], magnitude: "material" });
    expect(r.proximity).toBe("in_watchlist");
    expect(r.isBlindspot).toBe(false);
    expect(r.why.join("")).toContain("已经在看");
  });

  it("挨着我们在看的东西、可信、量级够 —— 这才是盲区", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [ev("A")], watched: ["渠道代理商"], magnitude: "material" });
    expect(r).toEqual({
      isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material",
      why: [
        "撞上了 J-2（challenges），本体图上 1 跳",
        "台账里最高一档是 A 档，到得了 B 档这条线",
        "量级够大，值得他花时间",
      ],
    });
  });

  it("一条靶点都对不上就是太远 —— 不判盲区", () => {
    const r = ruleBlindspot({ entities, hits: [], evidence: [ev("A")], watched: [], magnitude: "material" });
    expect(r.proximity).toBe("far");
    expect(r.isBlindspot).toBe(false);
    expect(r.hops).toBeNull();
  });

  it("源不到 B 档不判盲区，而且要说清是差在哪", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [ev("C")], watched: [], magnitude: "material" });
    expect(r.isBlindspot).toBe(false);
    expect(r.credibility).toBe("C");
    expect(r.why.join("")).toContain("C 档");
  });

  it("一条外部证据都没有时如实写「这一轮没有外部证据」，不冒充可信", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [], watched: [], magnitude: "material" });
    expect(r.credibility).toBeNull();
    expect(r.isBlindspot).toBe(false);
    expect(r.why.join("")).toContain("没有外部证据");
  });

  it("量级不明不判盲区", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [ev("A")], watched: [], magnitude: "unknown" });
    expect(r.isBlindspot).toBe(false);
    expect(r.magnitude).toBe("unknown");
  });

  it("跳数算不出来（null）也能判 —— 只是理由里说清算不出", () => {
    const r = ruleBlindspot({
      entities, hits: [{ ...hit, hops: null }], evidence: [ev("B")], watched: [], magnitude: "material",
    });
    expect(r.isBlindspot).toBe(true);
    expect(r.hops).toBeNull();
    expect(r.why[0]).toBe("撞上了 J-2（challenges），本体图上的跳数这一轮算不出来");
  });
});
