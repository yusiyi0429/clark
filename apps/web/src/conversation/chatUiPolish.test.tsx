import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ConversationData, Message } from "./useConversation";

/**
 * 全局对话区 10/13 细修：
 * 1. 进度行在窄宽度下按优先级让位（阶段不再竖排、圆点不被压扁）；
 * 2. 思考区更好读（13px、浅一级的灰，只在被切开时淡出最上面一行）；
 * 3. 进行中这一轮的呈现顺序：开场 → 思考与进度 → 正文（同一处）→ 本轮的卡（淡入）；
 * 4. 图表类富内容块与正文栏同宽，时间线先压缩、再换行、实在放不下才横向滚动并提示；
 * 5. 打开对话层不再给右侧页面盖浅灰蒙板，层级靠对话层自己的阴影。
 * 没有 jsdom：渲染用 renderToStaticMarkup，排法按纯函数验，样式读 CSS 文件。
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ConversationTimeline } from "./ConversationTimeline";
import { ThinkingStream } from "./Transcript";
import { TimelineBody } from "./richBlocks/RichBlocks";
import { parseRichBlock, timelineLayout, TIMELINE_MAX_ROWS, TIMELINE_NODE_COMPACT, type TimelineBlock } from "./richBlocks/parse";

const css = (name: string) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");
const noop = () => undefined;

const question: Message = { sequence: 1, role: "user", content: "把这四件事变成议题", createdAt: "2026-10-13T08:00:00Z" };
const live = (patch: Partial<ConversationData>) => ({ scope: "global", messages: [question], status: "streaming", streaming: true, thinking: true,
  partial: "", stage: "thinking", startedAt: Date.now(), stop: noop, route: { tier: "grounded", expectSeconds: 30 }, progress: { label: null, checked: 0 },
  thought: null, ...patch }) as unknown as ConversationData;

describe("进行中这一轮的呈现顺序：开场 → 思考与进度 → 正文（同一处）→ 本轮的卡", () => {
  it("没有卡的回答（所有档位）也一样：思考与进度紧贴正在写的那条", () => {
    for (const tier of ["quick", "grounded", "deep"] as const) {
      const html = renderToStaticMarkup(<ConversationTimeline data={live({ route: { tier, expectSeconds: 0 }, stage: "answering", partial: "正文。" })} />);
      expect(html.indexOf("正文。")).toBeLessThan(html.indexOf('data-testid="conversation-thinking"'));
    }
  });

});

describe("进度行在窄宽度下", () => {
  const rules = css("conversation-transcript.module.css");
  it("圆点、阶段、停止不压缩不换行；细节先截断，再截断用时；太窄时依次不显示细节、用时", () => {
    expect(rules).toMatch(/\.pulse\{flex:none;width:7px;height:7px/);
    expect(rules).toMatch(/\.thinking>\[role=status\]\{flex:none;white-space:nowrap\}/);
    expect(rules).toMatch(/\.thinking button\{flex:none;margin-left:auto/);
    expect(rules).toMatch(/\.progressDetail\{flex:0 1000 auto;min-width:6em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
    expect(rules).toMatch(/\.elapsed\{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
    expect(rules).toMatch(/\.thinkingGroup\{container-type:inline-size\}/);
    expect(rules).toMatch(/@container \(max-width:299px\)\{\.progressDetail\{display:none\}\}/);
    expect(rules).toMatch(/@container \(max-width:219px\)\{\.elapsed\{display:none\}\}/);
  });
});

describe("思考区可读", () => {
  const rules = css("conversation-transcript.module.css");
  it("14px（14.1 三档）、比正文浅一级的灰；不整片蒙淡，只在被切开时淡出最上面一行", () => {
    const base = /\.thinkingStream\{[^}]*\}/.exec(rules)?.[0] ?? "";
    expect(base).toContain("font-size:14px");
    expect(base).not.toContain("mask-image");
    expect(rules).toMatch(/\.thinkingStream\[data-clipped\]\{[^}]*mask-image:linear-gradient\(to bottom,transparent 0,#000 calc\(14px \* 1\.6\)\)/);
    // 浅色档读变量（新首页设计 5.2：深色下跟着变）：思考流比正文浅一级（--ink-muted），进度细节再浅一级（--ink-faint）。
    expect(rules).toMatch(/:global\(\[data-tone=light\]\) \.thinkingStream\{color:var\(--ink-muted\)\}/);
    expect(rules).toMatch(/:global\(\[data-tone=light\]\) \.progressDetail\{color:var\(--ink-faint\)\}/);
    // 只有几行时不淡出
    expect(renderToStaticMarkup(<ThinkingStream text="先比对截止日期。" />)).not.toContain("data-clipped");
  });
});

const NODES = (count: number) => Array.from({ length: count }, (_, index) => ({ date: `2026-${String(10 + Math.floor(index / 4)).padStart(2, "0")}-${String(1 + (index % 4) * 7).padStart(2, "0")}`, label: `节点${index + 1}` }));
const timeline = (count: number) => parseRichBlock("timeline", JSON.stringify({ title: "四个议题的时间节点", now: "2026-10-13", items: NODES(count) })) as TimelineBlock;

describe("图表类富内容块的显示规范", () => {
  it("时间线：一行放得下就等分；放不下按均匀列数换行（≤3 行）；再放不下才横向滚动；量不到宽度按滚动排", () => {
    expect(timelineLayout(4, 560)).toEqual({ mode: "row" });
    expect(timelineLayout(6, 6 * TIMELINE_NODE_COMPACT)).toEqual({ mode: "row" });
    expect(timelineLayout(8, 420)).toEqual({ mode: "wrap", columns: 4 });
    expect(timelineLayout(5, 400)).toEqual({ mode: "wrap", columns: 3 });
    expect(timelineLayout(12, 300)).toEqual({ mode: "scroll" });
    expect(Math.ceil(12 / Math.floor(300 / TIMELINE_NODE_COMPACT))).toBeGreaterThan(TIMELINE_MAX_ROWS);
    expect(timelineLayout(4, 0)).toEqual({ mode: "scroll" });
    expect(timelineLayout(4)).toEqual({ mode: "scroll" });
  });

  it("三种排法的画法：row 不设最小总宽；wrap 写列数；scroll 两侧渐隐、下方一行提示", () => {
    const row = renderToStaticMarkup(<TimelineBody block={timeline(4)} layout={{ mode: "row" }} />);
    expect(row).toContain('data-layout="row"');
    expect(row).not.toContain("data-rich-scroll-hint");
    const wrap = renderToStaticMarkup(<TimelineBody block={timeline(8)} layout={{ mode: "wrap", columns: 4 }} />);
    expect(wrap).toContain('data-layout="wrap"');
    expect(wrap).toContain("--columns:4");
    const scroll = renderToStaticMarkup(<TimelineBody block={timeline(12)} layout={{ mode: "scroll" }} edges={{ start: false, end: true }} />);
    expect(scroll).toContain('data-more-end="true"');
    expect(scroll).toContain("左右滑动查看全部 12 个节点");
    const rules = css("rich-blocks.module.css");
    expect(rules).toMatch(/\.block\[data-layout=row\] \.nodes\{grid-auto-columns:minmax\(0,1fr\);min-width:0\}/);
    expect(rules).toMatch(/\.block\[data-layout=wrap\] \.nodes\{grid-auto-flow:row;grid-template-columns:repeat\(var\(--columns\),minmax\(0,1fr\)\)/);
    expect(rules).toMatch(/\.track\[data-more-end\]\{[^}]*mask-image/);
    expect(rules).toMatch(/\.scrollHint\{margin:8px 0 0;font-size:12px/);
  });

  it("块与正文栏同宽：外框、骨架、块级公式都不再限 592", () => {
    const rules = css("rich-blocks.module.css");
    expect(rules).toMatch(/\.frame\{width:100%;/);
    expect(rules).not.toMatch(/max-width:592px/);
    expect(css("conversation-transcript.module.css")).not.toMatch(/katex-display\)\{max-width:592px/);
  });
});

describe("打开对话层不盖蒙板", () => {
  it("外面的点击区透明（点外面照常收起），层级靠对话层自己的阴影", () => {
    const shell = css("app-shell.module.css");
    expect(shell).toMatch(/\.historyBackdrop\{[^}]*background:transparent/);
    expect(shell).toMatch(/\.historySheet\[data-tone=light\]\{[^}]*box-shadow:0 24px 80px #1d29352e/);
  });
});
