import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { ConversationTurn } from "../Transcript";
import { isLargeBlock, parseRichBlock, richFallbackList, richSummary, skeletonTitle, type RoadmapBlock, type VisualBlock } from "./parse";
import { ROADMAP_DEFAULT_WIDTH, ROADMAP_MAX_ROWS, ROADMAP_MONTH_MIN, roadmapDomain, roadmapLayout, textWidth } from "./roadmapLayout";
import { RoadmapBody } from "./Roadmap";
import { VisualFallback } from "./Visual";
import {
  parseVisual, partialVisualTitle, readVisualMessage, sanitizeCss, sanitizeVisual, svgFit, visualCsp, visualDocument, visualSizeOk, VISUAL_MAX_HEIGHT,
  VISUAL_MESSAGE, VISUAL_SANDBOX, VISUAL_TOKENS,
} from "./visualSandbox";
import { RichSurfaceProvider } from "./surface";

/**
 * 第二批富内容块：多泳道路线图 ```roadmap 与自由图示 ```visual（沙箱 iframe）。
 * 没有 jsdom：版式、清洗、沙箱文档、消息校验按纯函数验，组件用 renderToStaticMarkup，样式读 CSS 文件。
 */

const ROADMAP = { title: "词元云集到春节前", now: "2026-10-14", lanes: [
  { label: "灯塔 → TKOS 持续经营", items: [
    { label: "灯塔客户部署", start: "2026-10-10", end: "2026-11-30", status: "planned" },
    { label: "持续经营验证", start: "2026-12", end: "2027-02-06", status: "inferred" },
  ] },
  { label: "TokenHub / TokenOps", items: [
    { label: "首个商业闭环", start: "2026-11", end: "2026-12-31", status: "planned" },
    { label: "外部付费验证", date: "2026-12-31", status: "inferred" },
  ] },
  { label: "客户拓展", items: [{ label: "季度收入目标截止", date: "2026-12-31", status: "confirmed" }] },
  { label: "决策与会议", items: [
    { label: "AIDC 目标确认会", date: "2026-10-17", status: "confirmed" },
    { label: "长期目标截止", date: "2027-02-06", status: "planned" },
  ] },
] };
const fence = (language: string, value: unknown) => `\`\`\`${language}\n${typeof value === "string" ? value : JSON.stringify(value)}\n\`\`\``;
const turn = (content: string, { streaming = false, expanded = true }: { streaming?: boolean; expanded?: boolean } = {}) =>
  renderToStaticMarkup(createElement(RichSurfaceProvider, { expanded, children: null },
    createElement(ConversationTurn, { message: { sequence: streaming ? -1 : 1, role: "assistant", content }, streaming })));
const css = readFileSync(new URL("../../styles/rich-blocks.module.css", import.meta.url), "utf8");

describe("roadmap：解析与校验", () => {
  it("泳道、单点与一段、状态缺省为计划；泳道里按开始时间排；只到月的结束算到月底", () => {
    const shuffled = { ...ROADMAP, lanes: [{ ...ROADMAP.lanes[0], items: [ROADMAP.lanes[0].items[1], { label: "无状态", date: "2026-10-20" }, ROADMAP.lanes[0].items[0]] }] };
    const block = parseRichBlock("roadmap", JSON.stringify(shuffled)) as RoadmapBlock;
    expect(block.kind).toBe("roadmap");
    expect(block.now).toEqual({ year: 2026, month: 10, day: 14 });
    expect(block.lanes[0].items.map((item) => item.label)).toEqual(["灯塔客户部署", "无状态", "持续经营验证"]);
    expect(block.lanes[0].items[1]).toEqual({ label: "无状态", status: "planned", start: { year: 2026, month: 10, day: 20 } });
    expect(block.lanes[0].items[2].end).toEqual({ year: 2027, month: 2, day: 6 });
    // 只到月：12 月这一段从 12 月 1 日算到 12 月 31 日（时间轴右端是 1 月 1 日）
    const month = parseRichBlock("roadmap", JSON.stringify({ lanes: [{ label: "甲", items: [{ label: "乙", start: "2026-12", end: "2026-12" }] }] })) as RoadmapBlock;
    expect(roadmapDomain(month).months.map((item) => `${item.year}-${item.month}`)).toEqual(["2026-12"]);
  });

  it("字段不合法一律 null：状态写错、结束早于开始、没有泳道、泳道或项太多、日期写成季度", () => {
    const bad = [
      { lanes: [] },
      { lanes: [{ label: "甲", items: [{ label: "乙", date: "2026-10-10", status: "done" }] }] },
      { lanes: [{ label: "甲", items: [{ label: "乙", start: "2026-11-10", end: "2026-10-01" }] }] },
      { lanes: [{ label: "甲", items: [{ label: "乙", date: "2026Q4" }] }] },
      { lanes: [{ label: "甲", items: [] }] },
      { lanes: [{ items: [{ label: "乙", date: "2026-10-10" }] }] },
      { lanes: Array.from({ length: 7 }, (_, index) => ({ label: `线${index}`, items: [{ label: "乙", date: "2026-10-10" }] })) },
      { lanes: [{ label: "甲", items: Array.from({ length: 9 }, () => ({ label: "乙", date: "2026-10-10" })) }] },
      { now: "下周", lanes: [{ label: "甲", items: [{ label: "乙", date: "2026-10-10" }] }] },
    ];
    for (const value of bad) expect(parseRichBlock("roadmap", JSON.stringify(value)), JSON.stringify(value)).toBeNull();
    expect(parseRichBlock("roadmap", '{"lanes":[{"label":"甲","items":[')).toBeNull();
  });

  it("读得出 JSON 但不合规：各泳道的项摊平成普通列表，每项带泳道名", () => {
    const list = richFallbackList(JSON.stringify({ title: "路线图", lanes: [{ label: "灯塔", items: [{ label: "部署", start: "2026Q4" }, { label: "验证", date: "2027-02" }] }] }));
    expect(list).toEqual({ title: "路线图", lines: ["2026Q4 · 灯塔 · 部署", "2027-02 · 灯塔 · 验证"] });
  });
});

describe("roadmap：版式（先在栏宽里排，放不下才横向滚动）", () => {
  const block = parseRichBlock("roadmap", JSON.stringify(ROADMAP)) as RoadmapBlock;

  it("时间轴从最早一项所在月的 1 日到最晚一项所在月底：10 月到 2027 年 2 月共 5 个月", () => {
    expect(roadmapDomain(block).months.map((month) => `${month.year}-${month.month}`)).toEqual(["2026-10", "2026-11", "2026-12", "2027-1", "2027-2"]);
  });

  it("收起态 388、首页对话层 560、放大 828、手机 sheet 343：都在栏宽里排下，不滚动", () => {
    for (const width of [343, 388, 560, 828]) {
      const layout = roadmapLayout(block, width);
      expect(layout.mode, String(width)).toBe("fit");
      expect(layout.width).toBe(width);
      for (const lane of layout.lanes) {
        expect(lane.rows).toBeLessThanOrEqual(ROADMAP_MAX_ROWS);
        for (const item of lane.items) {
          expect(item.left, `${width} ${item.item.label}`).toBeGreaterThanOrEqual(-5);
          expect(item.left + item.width).toBeLessThanOrEqual(width + 0.5);
          expect(item.labelLeft).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("刻度：放大时每月一个，「2027年1月」在跨年那一格；窄栏抽稀；与「现在」重叠的刻度名隐去", () => {
    const wide = roadmapLayout(block, 828);
    expect(wide.ticks.map((tick) => tick.label)).toEqual(["10月", "11月", "12月", "2027年1月", "2月"]);
    const narrow = roadmapLayout(block, 200);
    expect(narrow.ticks.length).toBeLessThan(5);
    // 「现在」在 10 月 14 日，离 10 月刻度（最左）约 45%×一格：放大时不重叠，刻度保留
    expect(wide.now!.left).toBeGreaterThan(wide.ticks[0].left);
    expect(wide.ticks[0].hidden).toBe(false);
    const crowded = roadmapLayout({ ...block, now: { year: 2026, month: 11, day: 1 } }, 560);
    expect(crowded.ticks.find((tick) => tick.label === "11月")!.hidden).toBe(true);
  });

  it("同一泳道里时间（连同名称）重叠的项分到下一行；项多到 3 行放不下才加宽成横向滚动", () => {
    const overlap = parseRichBlock("roadmap", JSON.stringify({ now: "2026-10-14", lanes: [{ label: "甲", items: [
      { label: "第一项比较长的名称", start: "2026-10-01", end: "2026-10-20" },
      { label: "第二项", start: "2026-10-05", end: "2026-10-25" },
      { label: "第三项", start: "2026-11-01", end: "2026-11-30" },
    ] }] })) as RoadmapBlock;
    const layout = roadmapLayout(overlap, 560);
    expect(layout.mode).toBe("fit");
    expect(layout.lanes[0].rows).toBe(2);
    expect(layout.lanes[0].items.map((item) => item.row)).toEqual([0, 1, 0]);
    const crowded = parseRichBlock("roadmap", JSON.stringify({ lanes: [{ label: "甲", items: Array.from({ length: 8 }, (_, index) => ({ label: `并行事项${index + 1}`, date: "2026-10-1" + index })) }] })) as RoadmapBlock;
    const scrolled = roadmapLayout(crowded, 388);
    expect(scrolled.mode).toBe("scroll");
    expect(scrolled.width).toBeGreaterThan(388);
  });

  it("跨度很长（3 年）在窄栏里每月不到 26px：加宽成横向滚动；量不到宽度时按 560 横向滚动排", () => {
    const long = parseRichBlock("roadmap", JSON.stringify({ lanes: [{ label: "甲", items: [{ label: "起", date: "2026-01-05" }, { label: "止", date: "2028-12-20" }] }] })) as RoadmapBlock;
    const layout = roadmapLayout(long, 388);
    expect(layout.mode).toBe("scroll");
    expect(layout.width / 36).toBeGreaterThanOrEqual(ROADMAP_MONTH_MIN);
    expect(layout.ticks.every((tick, index, all) => index === 0 || tick.left - all[index - 1].left >= 60)).toBe(true);
    expect(roadmapLayout(block).mode).toBe("scroll");
    expect(roadmapLayout(block).width).toBe(ROADMAP_DEFAULT_WIDTH);
  });

  it("名称写在条上方、从起点开始；贴右边放不下往左挪，不截断、不出界", () => {
    const layout = roadmapLayout(block, 560);
    const deploy = layout.lanes[0].items[0];
    expect(deploy.labelLeft).toBe(deploy.left);
    const edge = parseRichBlock("roadmap", JSON.stringify({ lanes: [{ label: "甲", items: [{ label: "起", date: "2026-10-01" }, { label: "月底的长名称节点", date: "2026-11-29" }] }] })) as RoadmapBlock;
    const last = roadmapLayout(edge, 388).lanes[0].items[1];
    expect(last.point).toBe(true);
    expect(last.labelSide).toBe("left");
    expect(last.labelLeft + last.labelWidth).toBeLessThanOrEqual(388);
    for (const lane of layout.lanes) for (const item of lane.items) expect(item.labelLeft + item.labelWidth).toBeLessThanOrEqual(560);
    expect(textWidth("AIDC 目标确认会")).toBeGreaterThan(textWidth("确认会"));
  });

  it("收起态：4 条泳道算大块（缩略卡），摘要写主线数、项数和截止", () => {
    expect(isLargeBlock(block)).toBe(true);
    expect(richSummary(block)).toBe("4 条主线 · 7 项 · 至 2027年2月6日");
    const small = parseRichBlock("roadmap", JSON.stringify({ lanes: ROADMAP.lanes.slice(0, 2) })) as RoadmapBlock;
    expect(isLargeBlock(small)).toBe(false);
  });
});

describe("roadmap：画法", () => {
  const block = parseRichBlock("roadmap", JSON.stringify(ROADMAP)) as RoadmapBlock;
  const html = renderToStaticMarkup(createElement(RoadmapBody, { block, layout: roadmapLayout(block, 560) }));

  it("每条泳道一个名称；条与圆点带状态；「现在」竖线；图例只列出现过的状态；无障碍名称带日期与状态", () => {
    for (const lane of ROADMAP.lanes) expect(html).toContain(lane.label.replace(">", "&gt;"));
    expect(html.match(/data-shape="bar"/g)).toHaveLength(3);
    expect(html.match(/data-shape="point"/g)).toHaveLength(4);
    expect(html).toMatch(/data-status="inferred"/);
    expect(html).toContain(">现在<");
    expect(html).toMatch(/aria-label="图例"/);
    expect(html).toContain("灯塔客户部署，10月10日–11月30日，计划");
    expect(html).toContain("持续经营验证，2026年12月–2027年2月6日，推断");
    expect(html).not.toContain("data-rich-scroll-hint");
  });

  it("推断用虚线描边、无底，不加新颜色；「现在」是现有的蓝；泳道名在横向滚动时贴住左边", () => {
    expect(css).toMatch(/\.rmItem\[data-status=inferred\] \.rmMark\{border:1px dashed var\(--ink-faint\);background:transparent\}/);
    expect(css).toMatch(/\.rmItem\[data-status=confirmed\] \.rmMark\{border:1px solid var\(--tianshu-blue-secondary\);background:var\(--tianshu-blue-secondary\)\}/);
    expect(css).toMatch(/\.rmNowLine\{[^}]*background:var\(--tianshu-blue-secondary\)/);
    expect(css).toMatch(/\.rmLaneLabel\{position:sticky;left:0/);
    const section = css.slice(css.indexOf("/* ── 路线图"), css.indexOf("/* ── 图示"));
    // 不加新颜色：路线图一段里不写色值，只用现有变量（深色下跟着换）。
    expect(section).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it("横向滚动时：提示行「左右滑动查看完整时间轴」", () => {
    const long = parseRichBlock("roadmap", JSON.stringify({ lanes: [{ label: "甲", items: [{ label: "起", date: "2026-01-05" }, { label: "止", date: "2028-12-20" }] }] })) as RoadmapBlock;
    expect(renderToStaticMarkup(createElement(RoadmapBody, { block: long, layout: roadmapLayout(long, 300) }))).toContain("左右滑动查看完整时间轴");
  });

  it("对话里：历史消息放大时完整画出；收起态是缩略卡", () => {
    const answer = `词元云集有四条主线同时推进。\n\n${fence("roadmap", ROADMAP)}\n\n持续经营验证的起止是按 9 月复盘推断的。`;
    expect(turn(answer)).toMatch(/data-rich="roadmap"/);
    expect(turn(answer)).not.toContain("&quot;lanes");
    const collapsed = turn(answer, { expanded: false });
    expect(collapsed).toContain("data-rich-thumb");
    expect(collapsed).toContain("4 条主线 · 7 项 · 至 2027年2月6日");
  });
});

/* ── visual ── */

const ORG = `<svg viewBox="0 0 480 196" aria-label="集团与三家子公司">
<rect class="box-accent" x="170" y="12" width="140" height="52" rx="10"/>
<text class="t-title" x="240" y="35" text-anchor="middle">集团</text>
<path class="edge arrow" d="M240 64V92H110V122"/>
<rect class="box inferred" x="40" y="128" width="140" height="52" rx="10" style="fill:url(#g)"/>
<text class="t-body" x="110" y="159" text-anchor="middle">词元云集</text>
</svg>`;

describe("visual：清洗（脚本、外链、事件、表单、导航一律去掉）", () => {
  it("脚本：<script>、SVG 里的 <script>、事件属性、javascript: 链接都被去掉", () => {
    const attack = `<div aria-label="x"><script>parent.document.cookie</script><svg viewBox="0 0 10 10" onload="alert(1)"><script>fetch('/api/me')</script><rect width="5" height="5" onclick="alert(2)" onmouseover="x()"/></svg>
<a href="javascript:alert(3)">点我</a><a href="&#106;avascript:alert(4)">再点</a><img src=x onerror="alert(5)"><body onload="alert(6)"><details ontoggle="alert(7)" open>文字</details></div>`;
    const { markup, removed } = sanitizeVisual(attack);
    expect(markup).not.toMatch(/<script|onload|onclick|onmouseover|onerror|ontoggle|javascript|alert|<img|<a\b|cookie|fetch/i);
    expect(markup).toContain("点我");
    expect(markup).toContain("<details open>文字</details>");
    expect(removed).toBeGreaterThan(8);
  });

  it("外链与外部资源：href / src / srcset / xlink:href、<link> <iframe> <object> <embed> <image> <use href=外部>、CSS 的 @import 与 url() 都去掉；url(#id) 与 #id 引用保留", () => {
    const attack = `<div><link rel="stylesheet" href="https://evil.example/a.css"><iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x">
<style>@import url(https://evil.example/b.css);.a{background:url(https://evil.example/t.gif)}.b{background:u\\72l(//evil.example/c)}.c{fill:url(#grad)}@font-face{font-family:x;src:url(https://evil.example/f.woff)}.d{background-image:image-set("https://evil.example/i.png" 1x)}</style>
<svg viewBox="0 0 10 10"><image href="https://evil.example/p.png"/><use href="https://evil.example/s.svg#a"/><use href="#local"/><use xlink:href="data:image/svg+xml,..."/><rect style="fill:url(https://evil.example/x)" width="2" height="2"/><rect fill="url(#grad)" width="3" height="3"/></svg>
<p style="background:url('http://evil.example/y')">文字</p></div>`;
    const { markup } = sanitizeVisual(attack);
    expect(markup).not.toMatch(/evil\.example|@import|@font-face|<link|<iframe|<object|<embed|<image|data:image|image-set/i);
    expect(markup).toContain('<use href="#local"/>');
    expect(markup).toContain('fill="url(#grad)"');
    expect(markup).toContain(".c{fill:url(#grad)}");
  });

  it("表单、meta 刷新、base、自动导航：<form> 只留文字，<meta>、<base>、<input>、<button> 去掉；<a> 只留文字", () => {
    const { markup } = sanitizeVisual(`<div><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><form action="https://evil.example"><input name="q"><button formaction="https://evil.example">提交</button>表单里的字</form><a href="https://evil.example" target="_top">链接文字</a></div>`);
    expect(markup).not.toMatch(/<meta|<base|<form|<input|<button|refresh|action|target|evil/i);
    expect(markup).toContain("表单里的字");
    expect(markup).toContain("链接文字");
    expect(markup).toContain("提交");
  });

  it("写出来的是规整标记：引号与尖括号转义，不认识的元素去掉标签留内容，样式里的 < 不能断出 </style>", () => {
    const { markup } = sanitizeVisual(`<div class='a"b' title="x>y">A < B 与 &lt;tag&gt;<blink>闪</blink><style>.x::after{content:"</style><script>alert(1)</script>"}</style></div>`);
    expect(markup).toContain('class="a&quot;b"');
    expect(markup).toContain('title="x&gt;y"');
    expect(markup).toContain("A &lt; B 与 &lt;tag&gt;");
    expect(markup).toContain("闪");
    expect(markup).not.toContain("<blink");
    expect(markup).not.toMatch(/<script/);
  });

  it("CSS 清洗单独验：expression、behavior、-moz-binding、javascript: 去掉", () => {
    const { css: cleaned, removed } = sanitizeCss(".a{width:expression(alert(1));behavior:url(x.htc);-moz-binding:url(x.xml#b);background:javascript:alert(1)}");
    expect(cleaned).not.toMatch(/expression\(|behavior:|-moz-binding|javascript:|x\.htc/);
    expect(removed).toBeGreaterThan(2);
  });
});

describe("visual：解析（收全、尺寸、标题）", () => {
  it("SVG：读出 viewBox 与 aria-label 标题；根上写死的 width / height 去掉（交给栏宽缩放）", () => {
    const block = parseVisual(ORG.replace("<svg ", '<svg width="960" height="392" '))!;
    expect(block).toMatchObject({ kind: "visual", format: "svg", title: "集团与三家子公司", viewBox: { width: 480, height: 196 } });
    expect(block.markup).not.toMatch(/<svg[^>]*\swidth=/);
    expect(block.markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 196"')).toBe(true);
  });

  it("HTML：一个 <div>（前面可带 <style>）按 HTML 排", () => {
    const block = parseVisual(`<style>.q{display:grid}</style><div class="grid" aria-label="机会与风险"><div class="card">甲</div></div>`)!;
    expect(block).toMatchObject({ format: "html", title: "机会与风险" });
    expect(block.viewBox).toBeUndefined();
  });

  it("没收全、空图、没有 viewBox 也没有宽高、长宽比超过 8 倍、太长：一律 null", () => {
    for (const source of [
      ORG.slice(0, ORG.length - 10), "<svg viewBox=\"0 0 480 196\"><rect", "<div><p>甲</p>", "<!-- 注释没写完", "<svg viewBox=\"0 0 480 196\"></svg>",
      "<svg><rect width=\"5\" height=\"5\"/></svg>", "<svg viewBox=\"0 0 4000 100\"><rect width=\"5\" height=\"5\"/></svg>", "只有文字", "",
      `<div>${"甲".repeat(60_001)}</div>`,
    ]) expect(parseVisual(source), source.slice(0, 40)).toBeNull();
  });

  it("流式中：从已到的根元素读出骨架标题", () => {
    expect(partialVisualTitle('<svg viewBox="0 0 480 196" aria-label="集团组织')).toBeNull();
    expect(partialVisualTitle('<svg viewBox="0 0 480 196" aria-label="集团组织关系"><rect')).toBe("集团组织关系");
    expect(skeletonTitle("visual", "<svg viewBox")).toBe("图示");
    expect(skeletonTitle("roadmap", '{"title":"词元云集路线图","lanes":[')).toBe("词元云集路线图");
  });

  it("SVG 按栏宽缩放：最多缩到 0.8 倍、放大到 1.25 倍；再窄横向滚动", () => {
    expect(svgFit({ width: 480, height: 200 }, 560)).toEqual({ width: 560, height: 234, scroll: false });
    expect(svgFit({ width: 480, height: 200 }, 828)).toEqual({ width: 600, height: 250, scroll: false });
    expect(svgFit({ width: 480, height: 200 }, 343).scroll).toBe(true);
    expect(svgFit({ width: 480, height: 200 }, 343, 0.7).scroll).toBe(false);
  });

  it("收起态：SVG 缩到 0.8 倍仍比内容区宽才显示缩略卡；HTML 直接显示", () => {
    const svg = parseVisual(ORG)!;
    expect(isLargeBlock(svg, { contentWidth: 402 })).toBe(false);
    expect(isLargeBlock(svg, { contentWidth: 360 })).toBe(true);
    const html = parseVisual(`<div class="card">甲</div>`)!;
    expect(isLargeBlock(html, { contentWidth: 200, areaHeight: 100 })).toBe(false);
  });
});

describe("visual：沙箱文档与 iframe", () => {
  const block = parseVisual(ORG)!;
  const nonce = "a".repeat(32), token = "b".repeat(32);
  const doc = visualDocument({ block, theme: "light", nonce, token });

  it("sandbox 只给 allow-scripts（宿主的量高脚本），不给同源、表单、弹窗、顶层导航", () => {
    expect(VISUAL_SANDBOX).toBe("allow-scripts");
    expect(VISUAL_SANDBOX).not.toMatch(/same-origin|forms|popups|top-navigation|modals/);
  });

  it("CSP 写在最前面：default-src 'none'，不能联网、不能加载外部资源、不能提交表单；脚本只放行带本次 nonce 的", () => {
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(doc)!;
    expect(meta.index).toBeLessThan(doc.indexOf("<style>"));
    expect(meta.index).toBeLessThan(doc.indexOf('<div id="root"'));
    const policy = meta[1];
    expect(policy).toBe(visualCsp(nonce));
    for (const directive of ["default-src 'none'", `script-src 'nonce-${nonce}'`, "connect-src 'none'", "img-src 'none'", "font-src 'none'", "form-action 'none'",
      "base-uri 'none'", "frame-src 'none'", "object-src 'none'"]) expect(policy).toContain(directive);
    expect(/script-src[^;]*/.exec(policy)![0]).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:|data:/);
    // 文档里只有一段脚本：宿主的量高脚本，带 nonce；模型的标记里没有脚本
    expect(doc.match(/<script/g)).toHaveLength(1);
    expect(doc).toContain(`<script nonce="${nonce}">`);
    expect(doc.indexOf(`<script nonce="${nonce}">`)).toBeGreaterThan(doc.indexOf("</svg></div>"));
  });

  it("即使模型的脚本混进了文档，也没有 nonce，CSP 不放行（这里直接拼一段带脚本的标记验证文档结构）", () => {
    const sneaky = visualDocument({ block: { ...block, markup: "<svg viewBox=\"0 0 10 10\"><script>parent.postMessage(1,'*')</script></svg>" }, theme: "light", nonce, token });
    const scripts = [...sneaky.matchAll(/<script([^>]*)>/g)].map((match) => match[1]);
    expect(scripts.filter((attributes) => attributes.includes(`nonce="${nonce}"`))).toHaveLength(1);
    expect(scripts.some((attributes) => !attributes.includes("nonce"))).toBe(true);
    expect(visualCsp(nonce)).not.toContain("'unsafe-inline' 'nonce");
  });

  it("nonce / token 不合格就不生成文档", () => {
    expect(() => visualDocument({ block, theme: "light", nonce: "short", token })).toThrow();
    expect(() => visualDocument({ block, theme: "light", nonce, token: '"><script>' })).toThrow();
  });

  it("设计规范：明暗两套 CSS 变量、字号 16/14/13/12、间距、圆角、现成 class 与箭头；SVG 的缩放范围写进根元素", () => {
    expect(doc).toContain('data-theme="light"');
    expect(visualDocument({ block, theme: "dark", nonce, token })).toContain('data-theme="dark"');
    expect(doc).toContain(":root[data-theme=dark]{");
    for (const name of Object.keys(VISUAL_TOKENS.light)) expect(Object.keys(VISUAL_TOKENS.dark)).toContain(name);
    for (const text of ["--fs-value:16px", "--fs-title:14px", "--fs-body:13px", "--fs-label:12px", "--space-5:24px", "--radius-lg:14px", ".box-accent{", ".inferred{stroke-dasharray:4 3}",
      ".card.inferred{border-style:dashed", '<marker id="tk-arrow"', "#root>svg{display:block;width:100%"]) expect(doc, text).toContain(text);
    expect(doc).toContain('style="--vbw:480;--min-scale:0.8;--max-scale:1.25"');
  });
});

describe("visual：postMessage 来源校验", () => {
  const frameWindow = { name: "frame" };
  const token = "c".repeat(32);
  const good = { origin: "null", source: frameWindow, data: { type: VISUAL_MESSAGE, token, height: 240, overflow: false } };

  it("来自这个 iframe、origin 为 null、token 对得上：收", () => {
    expect(readVisualMessage(good, frameWindow, token)).toEqual({ height: 240, overflow: false });
    expect(readVisualMessage({ ...good, data: { ...good.data, overflow: true } }, frameWindow, token)).toEqual({ height: 240, overflow: true });
  });

  it("别的窗口、同源或别的源、token 不对、类型不对、高度不是数字：都不收", () => {
    expect(readVisualMessage({ ...good, source: { name: "other" } }, frameWindow, token)).toBeNull();
    expect(readVisualMessage({ ...good, source: null }, frameWindow, token)).toBeNull();
    expect(readVisualMessage(good, undefined, token)).toBeNull();
    for (const origin of ["https://evil.example", "http://localhost:4320", "", "about:srcdoc"]) expect(readVisualMessage({ ...good, origin }, frameWindow, token), origin).toBeNull();
    expect(readVisualMessage({ ...good, data: { ...good.data, token: "d".repeat(32) } }, frameWindow, token)).toBeNull();
    expect(readVisualMessage({ ...good, data: { ...good.data, type: "resize" } }, frameWindow, token)).toBeNull();
    for (const height of ["240", Number.NaN, Number.POSITIVE_INFINITY, null]) expect(readVisualMessage({ ...good, data: { ...good.data, height } }, frameWindow, token)).toBeNull();
    expect(readVisualMessage({ ...good, data: "240" }, frameWindow, token)).toBeNull();
  });

  it("尺寸异常：太矮（空图）、超过上限都算异常", () => {
    expect(visualSizeOk(240)).toBe(true);
    expect(visualSizeOk(2)).toBe(false);
    expect(visualSizeOk(VISUAL_MAX_HEIGHT + 1)).toBe(false);
  });
});

describe("visual：在对话里", () => {
  it("流式中整块还没到齐（含已闭合但仍是最后一块）：只画骨架，不露出标记", () => {
    const partial = `组织关系如下。\n\n\`\`\`visual\n<svg viewBox="0 0 480 196" aria-label="集团与三家子公司">\n<rect class="box"`;
    const html = turn(partial, { streaming: true });
    expect(html).toContain("data-rich-skeleton");
    expect(html).toContain("集团与三家子公司");
    expect(html).not.toMatch(/&lt;rect|&lt;svg|<iframe/);
    const closedButLast = turn(`组织关系如下。\n\n${fence("visual", ORG)}`, { streaming: true });
    expect(closedButLast).toContain("data-rich-skeleton");
  });

  it("整块到齐（后面有了下一段，或是历史消息）：画图示外框，原文不进 DOM；服务端渲染先占位（iframe 挂载后才出现）", () => {
    const answer = `组织关系如下。\n\n${fence("visual", ORG)}\n\n丙子公司的归属是推断的。`;
    for (const html of [turn(answer), turn(answer, { streaming: true })]) {
      expect(html).toMatch(/data-rich="visual"/);
      expect(html).toContain("集团与三家子公司");
      expect(html).not.toContain("data-rich-skeleton");
      expect(html).not.toMatch(/&lt;rect|text-anchor/);
    }
  });

  it("收起态标题右侧有「放大」键；放大时没有", () => {
    const answer = `组织关系如下。\n\n${fence("visual", ORG)}`;
    expect(turn(answer, { expanded: false })).toContain("data-rich-zoom");
    expect(turn(answer, { expanded: true })).not.toContain("data-rich-zoom");
  });

  it("不合法或不完整：「图示无法显示」+ 可展开的原文（转义后的文字），不出现空白或乱码", () => {
    const broken = `<svg viewBox="0 0 480 196"><rect class="box"`;
    const html = turn(`组织关系如下。\n\n${fence("visual", broken)}`);
    expect(html).toContain("图示无法显示");
    expect(html).toContain("<summary>查看原文</summary>");
    expect(html).toContain("&lt;svg viewBox=&quot;0 0 480 196&quot;&gt;&lt;rect class=&quot;box&quot;");
    expect(html).not.toMatch(/<svg viewBox/);
    const fallback = renderToStaticMarkup(createElement(VisualFallback, { title: "集团", source: "<script>alert(1)</script>", reason: "size" }));
    expect(fallback).toContain('data-reason="size"');
    expect(fallback).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(fallback).not.toContain("<script>");
  });

  it("parseRichBlock 把 visual 交给清洗：解析结果里只有清洗后的标记", () => {
    const block = parseRichBlock("visual", `<div aria-label="甲"><script>alert(1)</script><p>乙</p></div>`) as VisualBlock;
    expect(block.markup).toBe('<div aria-label="甲"><p>乙</p></div>');
  });
});
