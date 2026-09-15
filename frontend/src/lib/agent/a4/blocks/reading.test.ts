import { describe, expect, it } from "vitest";
import { fixtureReport } from "./fixture";
import { appendixStart, readingDigest, readingJudgments, uniqueText } from "./reading";

describe("报告选读保留原文和分歧", () => {
  it("不合并相反判断或不同数值", () => {
    expect(uniqueText(["支持投资。", "支持投资", "不支持投资", "增长5%", "增长50%", "增长1.5%", "增长15%"], (s) => s)).toEqual(["支持投资。", "不支持投资", "增长5%", "增长50%", "增长1.5%", "增长15%"]);
  });
  it("每个证据编号只选一次，不修改源报告", () => {
    const report = fixtureReport();
    const before = JSON.stringify(report);
    const d = readingDigest(report);
    const refs = d.keyEvidence.flatMap((e) => e.traces.map((t) => t.source));
    expect(refs.length).toBe(new Set(refs).size);
    expect(d.judgment.length).toBeLessThanOrEqual(3);
    expect(readingJudgments(report).every((j) => report.blocks[j.index] === j.block)).toBe(true);
    expect(JSON.stringify(report)).toBe(before);
  });
  it("非法附录边界不隐藏正文，零边界合法", () => {
    const report = fixtureReport();
    for (const n of [-1, 1.5, 999, NaN]) expect(appendixStart({ ...report, appendixFrom: n })).toBe(report.blocks.length);
    expect(appendixStart({ ...report, appendixFrom: 0 })).toBe(0);
  });
  it("明确的高影响缺口排在行业背景之前", () => {
    const report = fixtureReport();
    report.blocks = [{ type: "unverified_panel", items: [
      { statement: "行业增长", whyMatters: "折损中等", whatWouldSettle: "查行业资料", impactIfTrue: "", impactIfFalse: "" },
      { statement: "审批权限", whyMatters: "决策人识别折损高", whatWouldSettle: "核对授权", impactIfTrue: "", impactIfFalse: "" },
    ] }];
    expect(readingDigest(report).unknowns[0].text).toContain("审批权限");
  });
});
