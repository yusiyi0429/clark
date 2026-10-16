import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { ConversationTurn } from "../Transcript";
import {
  formatDate, isLargeBlock, metricReading, parseRichBlock, partialTitle, readDate, richFallbackList, richSummary, timelinePhase, timelineProgress,
  type MetricCompareBlock, type TimelineBlock,
} from "./parse";
import { holdOpenMath } from "./markdown";
import { REVEAL_TOP_GAP, revealScrollTop, sheetDragCloses, SHEET_DRAG_CLOSE, RichSheet } from "./RichBlocks";
import { expandRoute, RichSurfaceProvider } from "./surface";

/**
 * 对话里的富内容块（第一批）：```metric-compare / ```timeline 声明式代码块 + KaTeX 公式。
 * 没有 jsdom：渲染用 renderToStaticMarkup，交互（放大 / 底部 sheet、下拉收起、滚进视野）按纯函数验，样式读 CSS 文件。
 */

const METRIC = { title: "三条收入线 · 本季度", unit: "万元/季度", items: [
  { label: "咨询服务收入", current: 180, target: 300 },
  { label: "解决方案订阅收入", current: 40, target: 120 },
  { label: "Token 收入", current: 25, target: 60 },
] };
const TIMELINE = { title: "到春节长期目标", now: "2026-10-13", items: [
  { date: "2026-10-13", label: "现在", kind: "now" },
  { date: "2026-10-15", label: "AIDC 目标确认会", kind: "milestone" },
  { date: "2026-12-31", label: "Q4 结束", kind: "milestone" },
  { date: "2027-02-06", label: "长期目标截止", kind: "deadline" },
] };
const fence = (language: string, value: unknown) => `\`\`\`${language}\n${typeof value === "string" ? value : JSON.stringify(value)}\n\`\`\``;
const ANSWER = `按现在的节奏，三条收入线本季度都达不到目标。\n\n${fence("metric-compare", METRIC)}\n\n照这个节奏推算：\n\n$$\n\\text{所需月均增量} = \\frac{300 - 180}{2.5} = 48\n$$\n\n${fence("timeline", TIMELINE)}`;

const turn = (content: string, { streaming = false, expanded = false, expand }: { streaming?: boolean; expanded?: boolean; expand?: () => void } = {}) =>
  renderToStaticMarkup(createElement(RichSurfaceProvider, { expanded, expand, children: null },
    createElement(ConversationTurn, { message: { sequence: streaming ? -1 : 1, role: "assistant", content }, streaming })));

describe("解析与校验", () => {
  it("metric-compare：标题、共用单位、条目；数值可写成数字字符串", () => {
    const block = parseRichBlock("metric-compare", JSON.stringify({ ...METRIC, items: [...METRIC.items, { label: "新签", current: "1,200", target: "2000", unit: "万元", note: "含框架" }] })) as MetricCompareBlock;
    expect(block.kind).toBe("metric-compare");
    expect(block.title).toBe("三条收入线 · 本季度");
    expect(block.items).toHaveLength(4);
    expect(block.items[3]).toEqual({ label: "新签", current: 1200, target: 2000, unit: "万元", note: "含框架" });
  });

  it("timeline：日期读成年月日、按时间排序，now 缺省时取 kind=now 的节点", () => {
    const shuffled = { ...TIMELINE, now: undefined, items: [TIMELINE.items[2], TIMELINE.items[0], TIMELINE.items[3], TIMELINE.items[1]] };
    const block = parseRichBlock("timeline", JSON.stringify(shuffled)) as TimelineBlock;
    expect(block.items.map((item) => item.label)).toEqual(["现在", "AIDC 目标确认会", "Q4 结束", "长期目标截止"]);
    expect(block.now).toEqual({ year: 2026, month: 10, day: 13 });
    expect(readDate("2027-02")).toEqual({ year: 2027, month: 2 });
    expect(readDate("2026-02-30")).toBeNull();
    expect(readDate("10月15日")).toBeNull();
  });

  it("JSON 读不出、字段不合法一律 null（界面退回原文）", () => {
    for (const [language, source] of [
      ["metric-compare", "{\"items\":[{\"label\":\"甲\",\"current\":1"],
      ["metric-compare", JSON.stringify({ items: [] })],
      ["metric-compare", JSON.stringify({ items: [{ label: "甲", current: 1, target: 0 }] })],
      ["metric-compare", JSON.stringify({ items: [{ label: "甲", current: "约 20", target: 30 }] })],
      ["metric-compare", JSON.stringify({ items: [{ current: 1, target: 3 }] })],
      ["timeline", JSON.stringify({ items: [{ date: "2026-10-13", label: "现在" }] })],
      ["timeline", JSON.stringify({ items: [{ date: "下周", label: "甲" }, { date: "2026-10-13", label: "乙" }] })],
      ["timeline", JSON.stringify({ items: [{ date: "2026-10-13", label: "甲", kind: "phase" }, { date: "2026-10-14", label: "乙" }] })],
      ["timeline", "[1,2]"],
      ["chart", JSON.stringify(METRIC)],
    ] as const) expect(parseRichBlock(language, source), `${language} ${source}`).toBeNull();
  });

  it("流式中没收全：从已到的 JSON 读出标题", () => {
    expect(partialTitle('{"title":"三条收入线 · 本季度","unit":"万')).toBe("三条收入线 · 本季度");
    expect(partialTitle('{"title":"三条收')).toBeNull();
    expect(partialTitle('{"items":[')).toBeNull();
  });
});

describe("完成度色阶（同首页战况面）", () => {
  it("≥80 绿、50–80 蓝、<50 琥珀、0 灰；未到 100 向下取整，差额不为负", () => {
    expect(metricReading({ current: 180, target: 300 })).toMatchObject({ percent: "60%", band: "steady", gap: 120 });
    expect(metricReading({ current: 40, target: 120 })).toMatchObject({ percent: "33%", band: "low", gap: 80 });
    expect(metricReading({ current: 25, target: 60 })).toMatchObject({ percent: "41%", band: "low" });
    expect(metricReading({ current: 80, target: 100 }).band).toBe("good");
    expect(metricReading({ current: 79.9, target: 100 })).toMatchObject({ percent: "79%", band: "steady" });
    expect(metricReading({ current: 0, target: 100 })).toMatchObject({ percent: "0%", band: "none" });
    expect(metricReading({ current: 0.5, target: 100 }).percent).toBe("<1%");
    expect(metricReading({ current: 130, target: 100 })).toMatchObject({ percent: "130%", band: "good", gap: 0 });
  });

  it("色值与首页战况面一致", () => {
    const css = readFileSync(new URL("../../styles/rich-blocks.module.css", import.meta.url), "utf8");
    for (const color of ["[data-band=good]{--band:#178a6b}", "[data-band=steady]{--band:#3b6fc9}", "[data-band=low]{--band:#bf7a10}", ".metric{--band:#8e959e"]) expect(css).toContain(color);
  });
});

describe("时间线：中文日期与已过 / 剩余", () => {
  const block = parseRichBlock("timeline", JSON.stringify(TIMELINE)) as TimelineBlock;
  it("同年写月日，跨年带年份；只到月写年月", () => {
    expect(formatDate({ year: 2026, month: 10, day: 15 }, 2026)).toBe("10月15日");
    expect(formatDate({ year: 2027, month: 2, day: 6 }, 2026)).toBe("2027年2月6日");
    expect(formatDate({ year: 2027, month: 2 }, 2026)).toBe("2027年2月");
  });
  it("从第一个节点到最后一个节点按 now 算；没有 now 不画", () => {
    expect(timelineProgress(block)).toMatchObject({ passed: 0, remaining: 116 });
    expect(timelineProgress({ ...block, now: { year: 2026, month: 12, day: 31 } })).toMatchObject({ passed: 79, remaining: 37 });
    expect(timelineProgress({ ...block, now: undefined })).toBeNull();
    expect(timelinePhase(block.items[1], { year: 2026, month: 12, day: 1 })).toBe("past");
    expect(timelinePhase(block.items[3], block.now)).toBe("future");
  });
});

describe("缩略卡判定", () => {
  const metric = parseRichBlock("metric-compare", JSON.stringify(METRIC))!;
  const timeline = parseRichBlock("timeline", JSON.stringify(TIMELINE))!;
  const short = parseRichBlock("timeline", JSON.stringify({ ...TIMELINE, items: TIMELINE.items.slice(0, 3) }))!;
  it("时间线节点 > 3 默认算大块；三项对比条、三个节点照常内联", () => {
    expect(isLargeBlock(timeline)).toBe(true);
    expect(isLargeBlock(short, { contentWidth: 420, areaHeight: 700 })).toBe(false);
    expect(isLargeBlock(metric, { contentWidth: 420, areaHeight: 700 })).toBe(false);
  });
  it("高度 > 对话区约 60%、宽度 > 内容区也算大块", () => {
    expect(isLargeBlock(metric, { contentWidth: 420, areaHeight: 300 })).toBe(true);
    expect(isLargeBlock(short, { contentWidth: 300, areaHeight: 700 })).toBe(true);
  });
  it("摘要一行", () => {
    expect(richSummary(timeline)).toBe("4 个节点 · 至 2027年2月6日");
    expect(richSummary(metric)).toBe("3 项 · 最低完成度 33%");
  });
});

describe("对话里渲染", () => {
  it("历史消息：结论句、对比条（色阶、当前 / 目标、差额）、KaTeX 公式；原文 JSON 不进 DOM", () => {
    const html = turn(ANSWER);
    expect(html).toContain("本季度都达不到目标");
    expect(html).toMatch(/data-rich="metric-compare"/);
    expect(html).toMatch(/data-band="steady"[\s\S]*咨询服务收入[\s\S]*60%/);
    expect(html).toContain("差 120");
    expect(html).toContain("/ 目标 300");
    expect(html).not.toMatch(/&quot;items&quot;|"items"|```/);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("所需月均增量");
    expect(html).not.toContain("katex-error");
  });

  it("收起态：4 个节点的时间线只显示缩略卡「内容较多 · 展开查看」；放大时完整铺开", () => {
    const collapsed = turn(ANSWER);
    expect(collapsed).toMatch(/data-rich-block="timeline" data-rich-size="thumb"/);
    expect(collapsed).toContain("内容较多 · 展开查看");
    expect(collapsed).toContain("4 个节点 · 至 2027年2月6日");
    expect(collapsed).not.toContain("AIDC 目标确认会");
    const expanded = turn(ANSWER, { expanded: true });
    expect(expanded).toMatch(/data-rich-block="timeline" data-rich-size="full"/);
    expect(expanded).toContain("10月15日");
    expect(expanded).toContain("2027年2月6日");
    expect(expanded).toContain("已过 0 天 · 剩余 116 天");
    expect(expanded).not.toContain("展开查看");
  });

  it("流式中块没收全：骨架（标题 + 正在生成…），不露出 JSON；收全后渲染", () => {
    const head = `结论先行。\n\n\`\`\`metric-compare\n{"title":"三条收入线 · 本季度","items":[{"label":"咨询服务收入","current":180`;
    const streaming = turn(head, { streaming: true });
    expect(streaming).toContain("data-rich-skeleton");
    expect(streaming).toContain("三条收入线 · 本季度");
    expect(streaming).toContain("正在生成…");
    expect(streaming).not.toMatch(/&quot;label|"label|current/);
    const done = turn(`结论先行。\n\n${fence("metric-compare", METRIC)}`, { streaming: true });
    expect(done).toMatch(/data-rich="metric-compare"/);
  });

  it("流式中没写完的块级公式：先画「公式」骨架，不露出半截 LaTeX", () => {
    const html = turn("推算如下：\n\n$$\n\\text{所需月均增量} = \\frac{300", { streaming: true });
    expect(html).toContain("data-rich-skeleton");
    expect(html).not.toContain("\\frac");
    expect(holdOpenMath("增量 $x = \\frac{1")).toEqual({ text: "增量", pending: false });
    expect(holdOpenMath("增量 $x$ 与 $y$。")).toEqual({ text: "增量 $x$ 与 $y$。", pending: false });
  });

  it("流式结束字段不合法但读得出节点：退成普通列表，不露 JSON，不报错", () => {
    const html = turn(`结论。\n\n${fence("metric-compare", '{"items":[{"label":"甲","current":"约 20","target":30}]}')}`);
    expect(html).not.toContain("data-rich-skeleton");
    expect(html).not.toContain("data-rich=");
    expect(html).toContain("data-rich-fallback");
    expect(html).toContain("<li>甲：当前 约 20 / 目标 30</li>");
    expect(html).not.toContain("&quot;items&quot;");
    // 模型没看到完整写法时自己写的路线图：日期写成季度、kind 写成 phase
    const roadmap = turn(`结论。\n\n${fence("timeline", '{"title":"路线图","items":[{"date":"2026Q4","label":"产品上线","kind":"phase"},{"date":"2027Q1","label":"规模化","note":"复制到三城"}]}')}`);
    expect(roadmap).toContain("<strong>路线图</strong>");
    expect(roadmap).toContain("<li>2026Q4 · 产品上线</li>");
    expect(roadmap).toContain("<li>2027Q1 · 规模化（复制到三城）</li>");
    expect(richFallbackList('{"items":[{"date":"2026-10"}]}')).toBeNull();
  });

  it("流式结束 JSON 都读不出：退回原文代码块，不报错", () => {
    const html = turn(`结论。\n\n${fence("timeline", '{"items":[{"date":"2026-10","label":"甲"')}`);
    expect(html).not.toContain("data-rich-skeleton");
    expect(html).toContain("<pre><code class=\"language-timeline\">");
  });

  it("普通代码块、其他语言照旧", () => {
    expect(turn(fence("ts", "const a = 1;"))).toContain('<pre><code class="language-ts">');
  });
});

describe("展开入口", () => {
  it("能放大（≥1280 的右列、首页对话层）走放大；不能放大（手机、窄屏）走底部 sheet", () => {
    expect(expandRoute({ expanded: false, expand: () => undefined })).toBe("desk");
    expect(expandRoute({ expanded: false })).toBe("sheet");
  });

  it("右列与对话层都提供放大入口：放大中不再给 expand", () => {
    const column = readFileSync(new URL("../ConversationColumn.tsx", import.meta.url), "utf8");
    const sheet = readFileSync(new URL("../ConversationHistorySheet.tsx", import.meta.url), "utf8");
    expect(column).toContain("<RichSurfaceProvider expanded={deskOn} expand={onDesk && !deskOn ? () => onDesk(true) : undefined}>");
    // 对话层的 expand 身份固定（useCallback）：宿主流式中每帧重画，富内容块的上下文值不跟着变。
    expect(sheet).toContain("const expand = useCallback(() => onWide?.(true), [onWide]);");
    expect(sheet).toContain("<RichSurfaceProvider expanded={wide} expand={onWide && !wide ? expand : undefined}>");
  });

  it("放大后滚到这一块完整显示：矮块整块露出（上沿让开页头），高块开头对齐上沿", () => {
    // 视野 0–600；块在 700–900（下方看不见）→ 滚到块底 + 16 露出。
    expect(revealScrollTop(1000, { top: 0, height: 600 }, { top: 700, height: 200 })).toBe(1000 + 900 - 584);
    // 已完整可见：不动。
    expect(revealScrollTop(1000, { top: 0, height: 600 }, { top: 120, height: 200 })).toBe(1000);
    // 开头被页头盖住（在上沿 76 以内）：开头放到页头下面。
    expect(revealScrollTop(1000, { top: 0, height: 600 }, { top: 30, height: 200 })).toBe(1000 + 30 - REVEAL_TOP_GAP);
    // 比视野高：开头对齐上沿。
    expect(revealScrollTop(1000, { top: 0, height: 600 }, { top: 300, height: 900 })).toBe(1000 + 300 - REVEAL_TOP_GAP);
    // 在上方：开头对齐上沿。
    expect(revealScrollTop(1000, { top: 50, height: 600 }, { top: -200, height: 100 })).toBe(1000 - 250 - REVEAL_TOP_GAP);
  });
});

describe("手机 sheet", () => {
  it("下拉页头超过阈值收起；关闭键 ≥44；正文两向可滚；Esc 在捕获阶段先收 sheet", () => {
    expect(sheetDragCloses(SHEET_DRAG_CLOSE + 1)).toBe(true);
    expect(sheetDragCloses(SHEET_DRAG_CLOSE)).toBe(false);
    const css = readFileSync(new URL("../../styles/rich-blocks.module.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sheetClose\{[^}]*width:44px;height:44px/);
    expect(css).toMatch(/\.thumb\{[^}]*min-height:44px/);
    expect(css).toMatch(/\.sheetBody\{[^}]*overflow:auto/);
    expect(css).toMatch(/\.track\{[^}]*overflow-x:auto/);
    const source = readFileSync(new URL("./RichBlocks.tsx", import.meta.url), "utf8");
    expect(source).toContain('document.addEventListener("keydown", onKey, true)');
    // 服务端那一帧不画（portal 要等挂载）。
    const block = parseRichBlock("timeline", JSON.stringify(TIMELINE))!;
    expect(renderToStaticMarkup(createElement(RichSheet, { block, onClose: () => undefined }))).toBe("");
  });
});
