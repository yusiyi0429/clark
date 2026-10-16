import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { ConversationData } from "./useConversation";

/**
 * 深度讨论 v2：对话层放大（首页全局对话）。没有 jsdom：按钮的回调直接调用。
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
vi.mock("./ConversationTimeline", () => ({ ConversationTimeline: () => <p>先说结论：本月应先保灯塔交付。来源：<a href="cite:memory:kd-principles.md#s2">《经营原则》第 2 节</a></p> }));
vi.mock("./ConversationAttachments", () => ({ AttachButton: () => <button aria-label="添加附件" />, AttachmentStatus: () => null }));
vi.mock("@/components/TianshuMark", () => ({ TianshuMark: ({ className }: { className?: string }) => <svg data-mark={className} /> }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: (props: { children?: ReactNode; onPress?: () => void; "aria-label"?: string }) => {
  if (props["aria-label"]) h.buttons.set(props["aria-label"], props);
  return <button aria-label={props["aria-label"]}>{props.children}</button>;
} }));

import { ConversationHistorySheet } from "./ConversationHistorySheet";

const data = { scope: "global", messages: [{ sequence: 1, role: "assistant", content: "先说结论" }], status: "complete", streaming: false, partial: "",
  stage: "answering", startedAt: 0, error: null, historyStatus: "ready", historyError: null, retryHistory: vi.fn(), attachments: [], stop: vi.fn() } as unknown as ConversationData;

beforeEach(() => { h.buttons.clear(); vi.clearAllMocks(); });

describe("对话层放大（首页全局对话）", () => {
  it("给了 onWide 才有 ⤢（叫「深度讨论」）；按下去放大，放大后是 ⤡「收起」", () => {
    expect(renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={vi.fn()} />)).not.toContain("深度讨论");
    const onWide = vi.fn();
    const html = renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={vi.fn()} onWide={onWide} />);
    expect(html).toContain('aria-label="深度讨论"');
    expect(html).not.toContain("data-wide");
    h.buttons.get("深度讨论")?.onPress?.();
    expect(onWide).toHaveBeenCalledWith(true);
    const wide = renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={vi.fn()} onWide={onWide} wide />);
    expect(wide).toContain('data-wide="true"');
    expect(wide).toContain('aria-label="收起"');
    h.buttons.get("收起")?.onPress?.();
    expect(onWide).toHaveBeenLastCalledWith(false);
  });
});
