import { describe, expect, it } from "vitest";
import type { Harness } from "@/lib/agent/harness";
import type { EvidenceLite, TargetHit } from "./stages";
import { proposeImpact } from "./impact";

const hit: TargetHit = {
  target: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
  match: "challenges", why: "正是新玩家", hops: 1,
};
function ev(id: string, group: string): EvidenceLite {
  return {
    id, claim: `${id} 的说法`, sourceRef: `https://a.com/${id}`, date: "2026-08-27T00:00:00.000Z",
    tier: "A", cosourceKey: group, provenance: { issueId: "I-7", stage: "pre_research" },
  };
}
function stub(reply: unknown, notes: string[] = []): Harness {
  return {
    async callMessages() { return { text: JSON.stringify(reply) }; },
    note(label: string) { notes.push(label); },
    substep() {},
  } as unknown as Harness;
}
const base = { question: "值不值得看？", material: "某公司发布了同类产品", hits: [hit], searchless: false };

describe("proposeImpact", () => {
  it("两组独立源撑得起「推翻」，靶点对回既有那一条", async () => {
    const h = stub({
      impactType: "overturns", proposalType: "reopenDecision", targetId: "J-2",
      statement: "那条判断的前提已经不成立", basis: ["E1", "E2"],
    });
    const r = await proposeImpact(h, { ...base, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")] });
    expect(r.downgraded).toBe(false);
    expect(r.impact).toEqual({
      impactType: "overturns", proposalType: "reopenDecision", targetRef: hit.target,
      statement: "那条判断的前提已经不成立", basis: ["E1", "E2"],
    });
  });

  it("只有一组独立源时机械把「推翻」降成「削弱」，并把降档写进理由", async () => {
    const notes: string[] = [];
    const h = stub({
      impactType: "overturns", proposalType: "reopenDecision", targetId: "J-2",
      statement: "那条判断的前提已经不成立", basis: ["E1", "E2"],
    }, notes);
    const r = await proposeImpact(h, { ...base, evidence: [ev("E1", "dom:a"), ev("E2", "dom:a")] });
    expect(r.downgraded).toBe(true);
    expect(r.impact.impactType).toBe("weakens");
    expect(r.impact.proposalType).toBe("adjustJudgment");
    expect(notes.some((n) => n.includes("降档"))).toBe(true);
  });

  it("引了台账里没有的编号就摘掉那一条依据", async () => {
    const h = stub({
      impactType: "weakens", proposalType: "adjustJudgment", targetId: "J-2",
      statement: "那条判断要收窄适用范围", basis: ["E1", "E9", "[P] 这类产品通常先做海外"],
    });
    const r = await proposeImpact(h, { ...base, evidence: [ev("E1", "dom:a")] });
    expect(r.impact.basis).toEqual(["E1", "[P] 这类产品通常先做海外"]);
  });

  it("先验依据（[P] 打头）留着 —— 模型自己的知识是要用的，只是要标出来", async () => {
    const h = stub({
      impactType: "confirms", proposalType: "noAction", targetId: null,
      statement: "跟原判断一致", basis: ["[P] 这家公司三年没进过这个市场"],
    });
    const r = await proposeImpact(h, { ...base, evidence: [], searchless: true });
    expect(r.impact.basis).toEqual(["[P] 这家公司三年没进过这个市场"]);
  });

  it("一条依据都不剩时提案退成不动作，不许留一句没依据的重议提案", async () => {
    const h = stub({
      impactType: "overturns", proposalType: "reopenDecision", targetId: "J-2",
      statement: "推翻它", basis: ["E9"],
    });
    const r = await proposeImpact(h, { ...base, evidence: [] });
    expect(r.impact.proposalType).toBe("noAction");
    expect(r.impact.impactType).toBe("outOfScope");
    expect(r.impact.basis).toEqual([]);
  });

  it("枚举外的值一律退成不动作", async () => {
    const h = stub({ impactType: "kaboom", proposalType: "doItNow", targetId: "J-2", statement: "x", basis: [] });
    const r = await proposeImpact(h, { ...base, evidence: [ev("E1", "dom:a")] });
    expect(r.impact.impactType).toBe("outOfScope");
    expect(r.impact.proposalType).toBe("noAction");
  });

  it("返回不是合法 JSON 时空手回来，不抛", async () => {
    const h = { async callMessages() { return { text: "呃" }; }, note() {}, substep() {} } as unknown as Harness;
    const r = await proposeImpact(h, { ...base, evidence: [] });
    expect(r.impact.proposalType).toBe("noAction");
    expect(r.impact.statement).toContain("读不懂");
  });
});
