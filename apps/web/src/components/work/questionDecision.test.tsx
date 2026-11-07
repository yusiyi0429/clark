import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TLocalQuestionRequestView } from "@warmap/contracts";
import { QuestionDecision } from "./decisions";
import { budgetOf } from "@/components/home/PlanDecision";

const question = (multiSelect: boolean) => ({ question: multiSelect ? "要哪几项？" : "用哪个库？", header: "", multiSelect, options: [{ label: "A", description: "" }, { label: "B", description: "" }] });

describe("几个问题一起问时只有一个「提交」（5.4.3）", () => {
  it("多选那一页不再另画自己的「提交」", () => {
    const request = { requestId: "q1", questions: [question(true), question(false)] } as unknown as TLocalQuestionRequestView;
    const html = renderToStaticMarkup(<QuestionDecision request={request} onAnswer={vi.fn()} />);
    expect(html.match(/>提交</g) ?? []).toHaveLength(1);
  });

  it("只有一个多选问题：框里那个「提交」就是整件的", () => {
    const request = { requestId: "q1", questions: [question(true)] } as unknown as TLocalQuestionRequestView;
    expect(renderToStaticMarkup(<QuestionDecision request={request} onAnswer={vi.fn()} />).match(/>提交</g) ?? []).toHaveLength(1);
  });

  it("子会话停了：收成「已失效」", () => {
    const request = { requestId: "q1", questions: [question(false)] } as unknown as TLocalQuestionRequestView;
    expect(renderToStaticMarkup(<QuestionDecision request={request} onAnswer={vi.fn()} expired />)).toContain("已失效");
  });
});

describe("开工的模式（11.3）", () => {
  const none = { hours: "", percent: "", money: "" };
  it("自动、无上限不带上限", () => {
    expect(budgetOf("auto", { hours: "3", percent: "", money: "" })).toEqual({ mode: "auto", hours: null, weeklyPercent: null, money: null });
    expect(budgetOf("unlimited", none)).toEqual({ mode: "unlimited", hours: null, weeklyPercent: null, money: null });
  });
  it("设预算只收填对了的那几项；一项都没有时发不出去", () => {
    expect(budgetOf("set", { hours: "2.5", percent: "6", money: "30" })).toEqual({ mode: "set", hours: 2.5, weeklyPercent: 6, money: { amount: 30, currency: "CNY" } });
    expect(budgetOf("set", { hours: "", percent: "6.5", money: "-1" })).toBeNull();
    expect(budgetOf("set", none)).toBeNull();
  });
});
