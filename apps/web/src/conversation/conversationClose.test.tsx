import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { nextPresence } from "@/lib/motion";
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { SHEET_EXIT_MS } from "./ConversationHost";
import type { ConversationData } from "./useConversation";

vi.mock("./ConversationTimeline", () => ({ ConversationTimeline: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/components/SelectionQuote", () => ({ SelectionToolbar: () => null, useSelectionQuote: () => ({ selected: null, onMouseUp: undefined, clear: () => undefined }) }));

/**
 * 收起对话层与打开对称：对话层淡出下移播完再卸载，输入条宽度连续收窄（附件键随之收起，内容区不先跳到 136）。
 * 没有 jsdom：退场的状态推导按纯函数验，样式规则直接读 CSS 文件。
 */
const css = (name: string) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");
const noop = () => undefined;

describe("退场推导", () => {
  it("关上的那一刻进入离开中；又打开直接回到开着；减少动态效果时不留退场", () => {
    const open = { open: true, leaving: false };
    expect(nextPresence(open, false, false)).toEqual({ open: false, leaving: true });
    expect(nextPresence({ open: false, leaving: true }, true, false)).toEqual({ open: true, leaving: false });
    expect(nextPresence(open, false, true)).toEqual({ open: false, leaving: false });
    expect(nextPresence(open, true, false)).toBe(open);
  });
});

describe("对话层收起", () => {
  it("离开中的对话层带 data-leaving、不可交互", () => {
    const data = { scope: "global", messages: [], status: "idle", streaming: false, partial: "", stage: "thinking", startedAt: 0, error: null,
      historyStatus: "ready", attachments: [], uploading: false, attachmentError: null, stop: noop } as unknown as ConversationData;
    const html = renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={noop} leaving />);
    expect(html).toMatch(/data-testid="conversation-sheet"[^>]*data-leaving="true"[^>]*inert=""/);
    expect(renderToStaticMarkup(<ConversationHistorySheet data={data} label="天枢" global onClose={noop} />)).not.toContain("data-leaving");
  });

  it("退场动画淡出下移，时长与宿主卸载时机一致，在打开动画之后定义", () => {
    const shell = css("app-shell.module.css");
    const rule = /\.historySheet\[data-leaving\]\{animation:historySink (\d+)ms/.exec(shell);
    expect(Number(rule?.[1])).toBe(SHEET_EXIT_MS);
    expect(SHEET_EXIT_MS).toBeGreaterThanOrEqual(200);
    expect(SHEET_EXIT_MS).toBeLessThanOrEqual(240);
    expect(shell).toMatch(/@keyframes historySink\{from\{opacity:1;transform:translateY\(0\)\}to\{opacity:0;transform:translateY\(\d+px\)\}\}/);
    expect(shell.indexOf(".historySheet[data-leaving]")).toBeGreaterThan(shell.indexOf(".historySheet{"));
    expect(shell).toMatch(/\.historyBackdrop\[data-leaving\]\{animation:historyVeilOut/);
  });

  it("收起时内容区填满输入条（不固定 136），附件键、小麦克风收起时收窄淡出", () => {
    const dock = css("conversation-dock.module.css");
    expect(dock).not.toMatch(/\.layer \.dock:not\(\.typing\) \.content\{flex:none;width:136px\}/);
    expect(dock).toMatch(/\.layer \.dock:not\(\.typing\) \.content\{flex:1 1 0;width:auto;min-width:0\}/);
    expect(dock).toMatch(/\.dock \.attachLeaving\{width:0;min-width:0;margin-left:-5px;opacity:0/);
    expect(dock).toMatch(/prefers-reduced-motion:reduce\) \{ \.layer \* \{ animation:none!important; transition:none!important; \} \}/);
  });
});
