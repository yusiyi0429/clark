import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { ConversationData } from "./useConversation";

/**
 * B4 划词引用（全局对话层）与 D1 去掉页头横条。没有 jsdom：选区 hook 用桩给出「已选中」，按钮的回调直接调用。
 */
const h = vi.hoisted(() => ({
  selected: null as { top: number; left: number; text: string } | null,
  clear: vi.fn(), selectionOptions: null as unknown,
  toolbar: null as { label?: string; onQuote: () => void; selected: unknown } | null,
  buttons: new Map<string, { onPress?: () => void }>(),
}));
vi.mock("@/components/SelectionQuote", () => ({
  useSelectionQuote: (_host: unknown, options: unknown) => { h.selectionOptions = options; return { selected: h.selected, clear: h.clear, onMouseUp: vi.fn() }; },
  SelectionToolbar: (props: NonNullable<typeof h.toolbar>) => { h.toolbar = props; return props.selected ? <div data-toolbar>{props.label}</div> : null; },
}));
vi.mock("./useConversationScroll", () => ({ useConversationScroll: () => ({ scrollRef: { current: null }, contentRef: { current: null }, atBottom: true, jumpToLatest: vi.fn() }) }));
vi.mock("./ConversationTimeline", () => ({ ConversationTimeline: () => <p>先说结论：本月应先保灯塔交付。</p> }));
vi.mock("./ConversationAttachments", () => ({ AttachButton: () => <button aria-label="添加附件" />, AttachmentStatus: () => null }));
vi.mock("@/components/TianshuMark", () => ({ TianshuMark: ({ className }: { className?: string }) => <svg data-mark={className} /> }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: (props: { children?: ReactNode; onPress?: () => void; "aria-label"?: string }) => {
  if (props["aria-label"]) h.buttons.set(props["aria-label"], props);
  return <button aria-label={props["aria-label"]}>{props.children}</button>;
} }));

import { ConversationHistorySheet } from "./ConversationHistorySheet";

const data = { scope: "global", messages: [{ sequence: 1, role: "assistant", content: "先说结论" }], status: "complete", streaming: false, partial: "",
  stage: "answering", startedAt: 0, error: null, historyStatus: "ready", historyError: null, retryHistory: vi.fn(), attachments: [], stop: vi.fn() } as unknown as ConversationData;

beforeEach(() => { h.selected = null; h.toolbar = null; h.buttons.clear(); vi.clearAllMocks(); });

describe("全局对话层划词引用（B4）", () => {
  it("只认消息正文里的选区；浮出的按钮写「回复」", () => {
    h.selected = { top: 10, left: 20, text: "灯塔已签约" };
    const html = renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onQuote={vi.fn()} onClose={vi.fn()} />);
    expect(h.selectionOptions).toEqual({ within: "[data-chat-role]" });
    expect(h.toolbar?.label).toBe("回复");
    expect(html).toMatch(/<div data-toolbar="[^"]*">回复<\/div>/);
  });

  it("点「回复」：这段交给本对话（onQuote），清掉选区，对话层不关", () => {
    h.selected = { top: 10, left: 20, text: "灯塔已签约" };
    const onQuote = vi.fn(), onClose = vi.fn();
    renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onQuote={onQuote} onClose={onClose} />);
    h.toolbar!.onQuote();
    expect(onQuote).toHaveBeenCalledWith("灯塔已签约");
    expect(h.clear).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("没传 onQuote 时不浮出引用", () => {
    h.selected = { top: 10, left: 20, text: "灯塔已签约" };
    const html = renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={vi.fn()} />);
    expect(html).not.toContain("data-toolbar");
  });
});

describe("对话层没有页头横条（D1，取代 B7 的薄栏）", () => {
  it("没有页头横条；左上星标只是标识（不可聚焦、不挂动作），右上「收起 ⌄」收起对话层；附件不在这里", () => {
    const onClose = vi.fn();
    const html = renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={onClose} />);
    expect(html).not.toContain("<header");
    expect(html).not.toContain("仅你可见");
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*data-testid="conversation-sheet-mark"[^>]*><svg data-mark/);
    expect(html).not.toMatch(/<button[^>]*>\s*<svg data-mark/);
    expect(html).not.toContain('aria-label="添加附件"');
    expect(h.buttons.get("收起对话记录")?.onPress).toBe(onClose);
    // 拖拽条不动，在最前面。
    expect(html.indexOf('aria-hidden="true"')).toBeLessThan(html.indexOf("conversation-sheet-mark"));
  });
});
