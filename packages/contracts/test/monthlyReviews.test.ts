import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  ConversationScope,
  MonthlyReviewDecideLtcoInput,
  MonthlyReviewReturnInput,
  MonthlyReviewSummaryCandidate,
} from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const judgment = { title: "灯塔项目", body: "按期交付，客户验收通过" };

describe("monthly review contracts", () => {
  it("LTCO 决定：保持不变不带文字，修订必须带非空文字", () => {
    expect(Value.Check(MonthlyReviewDecideLtcoInput, { decision: "keep" })).toBe(true);
    expect(Value.Check(MonthlyReviewDecideLtcoInput, { decision: "revise", ltco: "新的长期目标" })).toBe(true);
    expect(Value.Check(MonthlyReviewDecideLtcoInput, { decision: "revise", ltco: "   " })).toBe(false);
    // 「修订但什么都没改」由服务端拒绝（ltco 与 units 都可选）
    expect(Value.Check(MonthlyReviewDecideLtcoInput, { decision: "revise", ltco: "x", units: [{ subjectType: "battlefield", subjectId: "b", sixMonthOutcome: " " }] })).toBe(false);
    expect(Value.Check(MonthlyReviewDecideLtcoInput, { decision: "keep", ltco: "x" })).toBe(false);
  });

  it("打回必须写原因", () => {
    expect(Value.Check(MonthlyReviewReturnInput, { reason: "差距没写清楚" })).toBe(true);
    expect(Value.Check(MonthlyReviewReturnInput, { reason: " " })).toBe(false);
  });

  it("公司复盘汇总是四部分：总体结果、1–8 条判断、下周期重点、长期目标建议（含单元建议）", () => {
    const ltcoSuggestion = { change: false, proposedLtco: "现 LTCO", rationale: "战略未变", units: [] };
    const candidate = { overall: "整体按计划推进", judgments: [judgment], nextFocus: ["补齐第三个场景"], ltcoSuggestion };
    expect(Value.Check(MonthlyReviewSummaryCandidate, candidate)).toBe(true);
    expect(Value.Check(MonthlyReviewSummaryCandidate, { ...candidate, judgments: [] })).toBe(false);
    expect(Value.Check(MonthlyReviewSummaryCandidate, { ...candidate, nextFocus: [] })).toBe(false);
    expect(Value.Check(MonthlyReviewSummaryCandidate, { ...candidate, ltcoSuggestion: { ...ltcoSuggestion,
      units: [{ subjectType: "battlefield", subjectId: "bf-01", proposedOutcome: "新目标", rationale: "依据" }] } })).toBe(true);
  });

  it("LTCO 修订可以只改单元长期目标", () => {
    expect(Value.Check(MonthlyReviewDecideLtcoInput, { decision: "revise", units: [{ subjectType: "capability", subjectId: "cap-1", sixMonthOutcome: "新目标" }] })).toBe(true);
  });

  it("复盘项有自己的对话范围", () => {
    expect(Value.Check(ConversationScope, "monthly-review-item:0b0f6a3e-1111-4222-8333-444455556666")).toBe(true);
  });

  it("OpenAPI 暴露复盘接口", () => {
    const doc = buildOpenApiDocument();
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining([
      "/api/monthly-reviews/{period}",
      "/api/monthly-review-items/{itemId}",
      "/api/monthly-review-items/{itemId}/comments",
      "/api/me/monthly-reviews",
      "/api/monthly-reviews/actions/execute",
    ]));
  });
});
