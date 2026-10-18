import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TReadScope } from "@warmap/contracts";
import { ConversationTurn, ConversationTurns } from "./Transcript";
import { RescopeContext, ScopeEditor, scopeLabelOf } from "./ScopeChip";
import { parseIssueSuggest } from "./IssueSuggestCard";

/** 三层取用的范围标签、转议题的建议卡与留痕行（已定设计 5a、第 2 节）。 */
const visible = (html: string) => html.replace(/<[^>]+>/g, "");
const SCOPE: TReadScope = { label: "全员 · 7–10 月", params: { people: "all", from: "2026-07", to: "2026-10" },
  choices: { people: [{ id: "p1", name: "刘人豪" }, { id: "p2", name: "唐巨杰" }, { id: "p3", name: "孙铭泽" }] } };

describe("范围标签", () => {
  it("回答上显示「全员 · 7–10 月」；时间线给了重读能力才是可以点开的按钮", () => {
    const message = { sequence: 2, role: "assistant" as const, content: "整理好了。", readScope: SCOPE };
    const still = renderToStaticMarkup(createElement(ConversationTurn, { message }));
    expect(visible(still)).toContain("全员 · 7–10 月");
    expect(still).not.toContain("<button");
    const live = renderToStaticMarkup(createElement(RescopeContext.Provider, { value: { rescope: () => undefined, busy: false } }, createElement(ConversationTurn, { message })));
    expect(live).toMatch(/<button[^>]*data-testid="scope-chip"[^>]*aria-haspopup="dialog"/);
    const busy = renderToStaticMarkup(createElement(RescopeContext.Provider, { value: { rescope: () => undefined, busy: true } }, createElement(ConversationTurn, { message })));
    expect(busy).toMatch(/<button[^>]*disabled=""/);
  });

  it("改范围的标签写法与服务端一致；点开是谁、月份和「重新读」，没改时不能点", () => {
    const names = new Map([["p1", "刘人豪"], ["p2", "唐巨杰"], ["p3", "孙铭泽"]]);
    expect(scopeLabelOf({ people: ["p1"], from: "2026-09", to: "2026-10" }, names)).toBe("刘人豪 · 9–10 月");
    expect(scopeLabelOf({ people: ["p1", "p2", "p3"], from: "2025-11", to: "2026-02" }, names)).toBe("刘人豪、唐巨杰等 3 人 · 2025.11–2026.2");
    expect(scopeLabelOf({ people: "me", from: "2026-10", to: "2026-10" }, names)).toBe("我 · 10 月");
    const html = renderToStaticMarkup(createElement(ScopeEditor, { scope: SCOPE, onApply: () => undefined, onCancel: () => undefined, now: new Date("2026-10-18T00:00:00Z") }));
    for (const text of ["全员", "我", "刘人豪", "唐巨杰", "孙铭泽", "重新读", "取消"]) expect(visible(html)).toContain(text);
    expect(html).toMatch(/aria-pressed="true"[^>]*>全员</);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).toContain('value="2026-07"');
  });
});

describe("转议题", () => {
  it("建议卡的块只认 draftId，坏的不显示", () => {
    expect(parseIssueSuggest('{"draftId":"5f0e8c1a-0000-4000-8000-000000000001"}')).toBe("5f0e8c1a-0000-4000-8000-000000000001");
    expect(parseIssueSuggest('{"draftId":"x"}')).toBeNull();
    expect(parseIssueSuggest('{"draftId":"5f0e')).toBeNull();
    // 正在写的回答里块还没收全：骨架，不露出代码。
    const streaming = renderToStaticMarkup(createElement(ConversationTurn, { message: { sequence: 1, role: "assistant", content: "建议转议题。\n\n```issue-suggest\n{\"draftId\":\"5f0e" }, streaming: true }));
    expect(streaming).not.toContain("draftId");
  });

  it("首页留痕是一行可以点的「已转到议题 X」，直达议题页；带过来的那段前面有一行「首页 · 日期」", () => {
    const trace = renderToStaticMarkup(createElement(ConversationTurn, { message: { sequence: 9, role: "assistant", content: "已转到议题「渠道预算要不要转」", kind: "trace",
      meta: { issueId: "i1", title: "渠道预算要不要转", href: "/issues/i1" } } }));
    expect(trace).toContain('href="/issues/i1"');
    expect(visible(trace)).toBe("已转到议题「渠道预算要不要转」");
    expect(trace).not.toContain("<article");
    const carried = renderToStaticMarkup(createElement(ConversationTurns, { messages: [
      { sequence: 1, role: "user", content: "华南值不值得投", kind: "carried", createdAt: "2026-10-18T02:00:00.000Z" },
      { sequence: 2, role: "assistant", content: "值得", kind: "carried", createdAt: "2026-10-18T02:00:05.000Z" },
      { sequence: 3, role: "user", content: "接着说" },
    ] }));
    expect(carried.match(/data-testid="conversation-carried"/g)).toHaveLength(1);
    expect(visible(carried)).toContain("首页 · 10月18日");
  });
});
