import { describe, expect, it } from "vitest";

import type { DraftJudgement } from "@/lib/data/types";

import { validateJudgements } from "./validate";

const trace = [{ kind: "int" as const, source: "《Oasis Security 对词元云集的战略含义》" }];

/** 一条各项都过的判断。每个用例只动它要测的那一处。 */
function j(over: Partial<DraftJudgement> = {}): DraftJudgement {
  return {
    label: "企业采用逻辑",
    statement:
      "企业 AI 规模化的关键变化之一，是管理层愿意把多少真实工作和责任交给 AI；「可放心授权」是数字劳动力扩张的重要条件，但不是替代效果与投入产出的独立购买理由。",
    basis:
      "CSA 与 Oasis 的 2026 调研覆盖 383 名从业者，78% 的组织还没有 AI 身份的创建与注销政策，92% 对现有 IAM 能否管住非人身份缺乏信心。",
    boundary: "这条判断不支持公司进入机器身份或安全赛道，也不构成新增独立产品线的理由。",
    reopenIf: "如果出现一个效果与投入产出都已成立、客户仍不愿放开授权的真实场景，这条判断要重新打开。",
    traces: trace,
    ...over,
  };
}

const rules = (items: DraftJudgement[]) =>
  validateJudgements(items).map((v) => `${v.rule}/${v.severity}`);
const p0 = (items: DraftJudgement[]) => validateJudgements(items).filter((v) => v.severity === "p0");

describe("A5 质量门 · 判断的形状", () => {
  it("基线那两条一条 p0 都不该有", () => {
    expect(p0([j(), j({ label: "我们的战略边界", statement: "词元云集应把「受控地把工作交给 AI」纳入 TKOS 的长期产品原则，因为它决定产品能否从一号位助手扩展到管理者与数字劳动力。" })])).toEqual([]);
  });

  it("只有一条、或者超过五条，都记 p0", () => {
    expect(rules([j()])).toContain("A5-01/p0");
    expect(rules(Array.from({ length: 6 }, (_, i) => j({ statement: `第 ${i} 条判断的正文写得足够长，足以单独摘出去发给一个没读过这个议题的人也读得懂。` })))).toContain("A5-01/p0");
  });

  it("五个字段缺任何一个都记 p0", () => {
    for (const [field, rule] of [
      ["label", "A5-02/p0"],
      ["basis", "A5-04/p0"],
      ["boundary", "A5-05/p0"],
      ["reopenIf", "A5-06/p0"],
    ] as const) {
      expect(rules([j({ [field]: "  " }), j()]), field).toContain(rule);
    }
    expect(rules([{ ...j(), traces: [] }, j()])).toContain("A7-01/p0");
  });

  it("判断正文太短记 p0 —— 它一定会被单独摘出去用", () => {
    // 「应重视 AI 安全」这种长度的句子离开这块屏幕就废了。40 字不是文风要求。
    expect(rules([j({ statement: "公司应重视 AI 授权问题。" }), j()])).toContain("A5-03/p0");
  });

  it("重开条件写成「情况有变化」记 p0，那不是条件", () => {
    expect(rules([j({ reopenIf: "如果情况发生变化，再重新评估这条判断。" }), j()])).toContain("A5-06/p0");
  });

  it("自称已经确认、已成公司口径记 p0", () => {
    /*
     * 这一条是这道门存在的理由：参谋只产候选，确认只能由一号位按下。一条自称
     * 已确认的判断摊在板的上半层，和真候选长得一模一样。
     */
    const v = validateJudgements([j({ statement: j().statement + "该判断已确认为公司口径。" }), j()]);
    expect(v.some((x) => x.rule === "A5-07" && x.severity === "p0")).toBe(true);
  });

  it("判断依据是一句复述记 p1，不挡", () => {
    const v = validateJudgements([j({ basis: "综合研究结果与上下文材料，可以得出这一判断。" }), j()]);
    expect(v.some((x) => x.rule === "A5-04" && x.severity === "p1")).toBe(true);
    expect(v.filter((x) => x.rule === "A5-04" && x.severity === "p0")).toEqual([]);
  });

  it("正文里有回指记 p1", () => {
    expect(rules([j({ statement: "上述方案应作为公司长期原则执行，因为它决定产品能否扩展到管理者与数字劳动力。" }), j()])).toContain("A5-08/p1");
  });

  it("同一件事写成两条记 p1", () => {
    expect(rules([j(), j({ label: "另一块" })])).toContain("A5-09/p1");
  });

  it("全局那几条照样跑：markdown、空词、member: 死链", () => {
    const v = validateJudgements([
      j({ basis: "**赋能**不足，见 member:abc123 那条对象。这一段还要再长一点才够二十字。" }),
      j({ label: "我们的战略边界", statement: "词元云集应把「受控地把工作交给 AI」纳入 TKOS 的长期产品原则，因为它决定产品能否继续扩展。" }),
    ]);
    expect(v.map((x) => x.rule)).toEqual(expect.arrayContaining(["FE-md", "A7-03", "G-09"]));
  });
});
