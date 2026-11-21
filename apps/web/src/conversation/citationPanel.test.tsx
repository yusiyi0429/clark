import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { citationPanelRect, IssueEvidence } from "./CitationPanel";
import { WorldEvidence, worldLocator } from "./WorldSource";

// 深度讨论 v2 的依据面板：开在对话左边，和对话同屏。
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
const doc = (elements: Record<string, { getBoundingClientRect: () => ReturnType<typeof rect> } | null>) =>
  ({ querySelector: (selector: string) => elements[selector] ?? null }) as unknown as Document;

describe("依据面板放在哪", () => {
  it("右列放大：盖在左侧材料那一块上", () => {
    const pane = { getBoundingClientRect: () => rect(84, 14, 478, 900) };
    expect(citationPanelRect("rail", null, doc({ '[data-testid="expanded-panel"]': pane }))).toEqual({ left: 84, top: 14, width: 478, height: 900 });
    expect(citationPanelRect("rail", null, doc({}))).toBeNull();
  });

  it("首页对话层放大：对话层左边露出来的那一块（左右各留 14）；太窄（<320）就不开", () => {
    const sheet = { getBoundingClientRect: () => rect(524, 14, 742, 880) };
    const trigger = { closest: () => sheet } as unknown as HTMLElement;
    expect(citationPanelRect("sheet", trigger, doc({}))).toEqual({ left: 14, top: 14, width: 496, height: 880 });
    const narrow = { getBoundingClientRect: () => rect(300, 14, 900, 880) };
    expect(citationPanelRect("sheet", null, doc({ '[data-testid="conversation-sheet"]': narrow }))).toBeNull();
  });
});

describe("本体出处卡在依据面板里看", () => {
  it("先写正在读取；标签那一行写本体和引用时的版本；有关闭键", () => {
    const html = renderToStaticMarkup(createElement(WorldEvidence, { citeRef: "world:m-1@5", trigger: null, onClose: vi.fn() }));
    expect(html).toContain("本体 · 第 5 版");
    expect(html).toContain("正在读取…");
    expect(html).toContain('aria-label="关闭依据"');
    expect(html).toContain("data-source-drawer");
    expect(html.replace(/<[^>]+>/g, "")).not.toContain("m-1");
  });

  it("读到后标签写类型；本体里已有更新的版本时注明", () => {
    const source = { ref: "m-1@6", objectId: "m-1", version: 6, type: "PeriodGoal", title: "10 月目标", status: "已确认", owners: [], progress: null };
    expect(worldLocator(5, source)).toBe("本体 · 周期目标 · 第 5 版 · 已有新版");
    expect(worldLocator(6, { ...source, type: "Mission" })).toBe("本体 · Mission · 第 6 版");
  });
});

describe("议题研究在依据面板里看", () => {
  it("先写正在读取；有关闭键（Esc 同样先关它）与「打开议题」；标签 12px 那一行写明是议题研究与依据", () => {
    const html = renderToStaticMarkup(createElement(IssueEvidence, { issueId: "i-1", research: true, trigger: null, onClose: vi.fn(), onOpenIssue: vi.fn() }));
    expect(html).toContain("议题研究与依据");
    expect(html).toContain("正在读取议题…");
    expect(html).toContain('aria-label="关闭依据"');
    expect(html).toContain("打开议题");
    expect(html).toContain("data-source-drawer");
    expect(html).not.toMatch(/演示|demo|本场/i);
  });
});
