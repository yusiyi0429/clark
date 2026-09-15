import { describe, expect, it } from "vitest";
import { makeProvenance } from "./provenance";
import { cardPriority, CONTRA_WEIGHT, suggestDisposition } from "./dispose";
import type { BlindspotRuling, EvidenceLite, ImpactProposal, TargetHit } from "./stages";

const prov = makeProvenance("I-7");
const now = "2026-08-27T00:00:00.000Z";
const target = { kind: "judgment" as const, id: "J-2", text: "今年不会有新玩家" };
const blind: BlindspotRuling = {
  isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material", why: [],
};
function ev(id: string, group: string): EvidenceLite {
  return {
    id, claim: "c", sourceRef: `https://a.com/${id}`, date: now,
    tier: "A", cosourceKey: group, provenance: prov,
  };
}
const impact: ImpactProposal = {
  impactType: "weakens", proposalType: "adjustJudgment", targetRef: target,
  statement: "那条判断要收窄适用范围", basis: ["E1"],
};

describe("suggestDisposition", () => {
  it("要改判断、又有两组独立源 —— 建议议一议，不挂监控条件", () => {
    const r = suggestDisposition({
      impact, blindspot: blind, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("discuss");
    expect(r.trigger).toBeNull();
    // 「2 组」不是「两组」：`why` 是 `有 ${groups} 组独立源` 拼出来的，`groups` 是数字。
    // **这条断言红了不许把模板串改成中文数字** —— 一到十以上就没法渲染，
    // 而这个数是台账里真实的组数，不是文案。要改的一律是断言这一侧。
    expect(r.why).toContain("2 组");
  });

  it("要改判断但只有一组独立源 —— 建议待定，并给出监控条件", () => {
    const r = suggestDisposition({
      impact, blindspot: blind, evidence: [ev("E1", "dom:a")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("watch");
    expect(r.trigger).not.toBeNull();
    expect(r.trigger!.status).toBe("proposed");
    expect(r.trigger!.source).toBe("watch");
    expect(r.trigger!.onFire).toBe("proposeDiscuss");
    expect(r.trigger!.targetRef).toEqual(target);
    expect(r.trigger!.expiresAt).toBe("2026-11-25T00:00:00.000Z");
  });

  it("不相干或量级不够 —— 建议不看了，也不挂监控条件", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "outOfScope", proposalType: "noAction" },
      blindspot: { ...blind, isBlindspot: false, magnitude: "immaterial" },
      evidence: [], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("dismiss");
    expect(r.trigger).toBeNull();
  });

  it("要重议决定的按议一议那一档办（够两组源时）", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "overturns", proposalType: "reopenDecision" },
      blindspot: blind, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("discuss");
  });

  it("判成盲区但提案是不动作 —— 建议待定：盯着，别现在占他时间", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "confirms", proposalType: "noAction", targetRef: target },
      blindspot: blind, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("watch");
    expect(r.trigger!.onFire).toBe("proposeDiscuss");
  });

  it("监控条件超长时截到上限再造 —— 不因为一句话太长就丢掉整条监控", () => {
    const r = suggestDisposition({
      impact: { ...impact, statement: "长".repeat(200) },
      blindspot: blind, evidence: [ev("E1", "dom:a")], nowIso: now, provenance: prov,
    });
    expect(r.trigger!.condition.length).toBeLessThanOrEqual(80);
  });

  it("没有靶点可挂时不造监控条件 —— 挂不到东西上的监控没法核", () => {
    const r = suggestDisposition({
      impact: { ...impact, targetRef: null },
      blindspot: blind, evidence: [ev("E1", "dom:a")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("watch");
    expect(r.trigger).toBeNull();
    expect(r.why).toContain("挂不到");
  });
});

const supportHit: TargetHit = { target, match: "supports", why: "跟原判断一致", hops: 1 };
const contraHit: TargetHit = { target, match: "challenges", why: "跟原判断相反", hops: 1 };

describe("反确认", () => {
  it("同等强度下，方向相反的排在支持方向前面", () => {
    const evidence = [ev("E1", "dom:a"), ev("E2", "dom:b")];
    const contra = cardPriority({ hits: [contraHit], blindspot: blind, evidence });
    const support = cardPriority({ hits: [supportHit], blindspot: blind, evidence });
    expect(contra).toBeGreaterThan(support);
    expect(contra / support).toBeCloseTo(CONTRA_WEIGHT, 5);
  });

  it("强度更高的支持方向信号，不会被弱的相反方向信号盖住", () => {
    const strong = cardPriority({ hits: [supportHit], blindspot: blind, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b"), ev("E3", "dom:c"), ev("E4", "dom:d")] });
    const weakContra = cardPriority({ hits: [contraHit], blindspot: blind, evidence: [ev("E1", "dom:a")] });
    expect(strong).toBeGreaterThan(weakContra);
  });

  it("盲区也加权 —— 他没在看的东西不该排在末尾", () => {
    const evidence = [ev("E1", "dom:a")];
    expect(cardPriority({ hits: [], blindspot: blind, evidence }))
      .toBeGreaterThan(cardPriority({ hits: [], blindspot: { ...blind, isBlindspot: false }, evidence }));
  });

  it("方向相反的一律不判「不看了」 —— 哪怕量级判成不够", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "outOfScope", proposalType: "noAction" },
      blindspot: { ...blind, isBlindspot: false, magnitude: "immaterial" },
      evidence: [], nowIso: now, provenance: prov, hits: [contraHit],
    });
    expect(r.action).toBe("watch");
    expect(r.why).toContain("方向相反");
  });

  it("方向一致又不相干的，照旧判「不看了」", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "outOfScope", proposalType: "noAction" },
      blindspot: { ...blind, isBlindspot: false, magnitude: "immaterial" },
      evidence: [], nowIso: now, provenance: prov, hits: [supportHit],
    });
    expect(r.action).toBe("dismiss");
  });
});
