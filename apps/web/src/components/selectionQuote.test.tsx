import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readSelection, SelectionToolbar } from "./SelectionQuote";

/** B4 划词：对话正文里只认消息正文里的选区；对话里的按钮写「回复」（页面材料上的划词写「批注提问」）。 */
function fakeHost(inside: (node: unknown) => boolean) {
  return {
    contains: inside, scrollTop: 120, clientWidth: 600,
    getBoundingClientRect: () => ({ top: 100, left: 20, width: 600, height: 400 }),
  } as unknown as HTMLElement;
}
function fakeSelection(text: string, anchor: unknown) {
  return {
    isCollapsed: !text, toString: () => text, anchorNode: anchor,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 300, left: 220, width: 80, height: 20 }) }),
  } as unknown as Selection;
}

describe("readSelection", () => {
  const prose = { nodeType: 3, parentElement: { closest: (selector: string) => (selector === "[data-chat-role]" ? {} : null) } };
  const card = { nodeType: 3, parentElement: { closest: () => null } };

  it("选区在容器里的消息正文中：位置相对容器（加回 scrollTop），文字去掉首尾空白", () => {
    const host = fakeHost(() => true);
    expect(readSelection(host, fakeSelection("  灯塔已签约  ", prose), "[data-chat-role]")).toEqual({ top: 300 - 100 + 120 - 40, left: 220 - 20 + 40 - 52, text: "灯塔已签约" });
  });

  it("选区在卡片、思考行等非正文处，或在容器外、或没选中文字时不浮出", () => {
    const host = fakeHost(() => true);
    expect(readSelection(host, fakeSelection("确认并应用", card), "[data-chat-role]")).toBeNull();
    expect(readSelection(fakeHost(() => false), fakeSelection("别处的字", prose), "[data-chat-role]")).toBeNull();
    expect(readSelection(host, fakeSelection("", prose), "[data-chat-role]")).toBeNull();
    // 不限定范围时（议题、会议页原有用法）容器内的选区都算。
    expect(readSelection(host, fakeSelection("确认并应用", card))?.text).toBe("确认并应用");
  });
});

describe("SelectionToolbar", () => {
  it("默认写「批注提问」；对话里传 label 写「回复」", () => {
    const selected = { top: 0, left: 0, text: "灯塔已签约" };
    expect(renderToStaticMarkup(<SelectionToolbar selected={selected} onQuote={vi.fn()} />)).toContain("批注提问");
    const html = renderToStaticMarkup(<SelectionToolbar selected={selected} label="回复" onQuote={vi.fn()} />);
    expect(html).toContain("回复");
    expect(html).not.toContain("批注提问");
  });
});
