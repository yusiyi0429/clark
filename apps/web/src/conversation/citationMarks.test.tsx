import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTurn } from "./Transcript";
import { CitationSurfaceProvider, canOpenMark, citationLocator, markClickAction, markTarget, openMark, plainText, popPosition } from "./citations";
import { holdOpenLink } from "./citationMarks";
import { registerCitationPanel, resetCitationBridge, takePendingCitation } from "./citationBridge";

// 出处标记（10/14）：句末的出处链接画成一个浅灰小圆点，悬停 / 点一下看资料名称、段落或版本与「打开原文」；句子成分里的照旧显示名称。
const render = (content: string, linked = false) => renderToStaticMarkup(
  createElement(CitationSurfaceProvider, { linked, surface: "rail", children: null }, createElement(ConversationTurn, { message: { sequence: 1, role: "assistant", content } })));
const marks = (html: string) => html.match(/data-cite-mark="[a-z]+"/g) ?? [];
/** 去掉标签后的可见文字（读屏名称在 aria-label 里，不算）。 */
const visible = (html: string) => html.replace(/<[^>]+>/g, "");

afterEach(() => resetCitationBridge());

describe("新写法：正文直接说观点，出处是句末的小标记", () => {
  it("句末的内部依据：一个圆点，资料名不进正文，读屏读「出处：名称」，带 ref", () => {
    const html = render("灯塔客户侧部署受外部因素和内部准备不足影响，预计中旬可启动[《词元云集 · 9 月复盘》第 2 节](cite:memory:kd-tk-september-review.md#s2)。");
    expect(marks(html)).toEqual(['data-cite-mark="ref"']);
    expect(html).toContain('aria-label="出处：《词元云集 · 9 月复盘》第 2 节"');
    expect(html).toContain('data-cite-ref="memory:kd-tk-september-review.md#s2"');
    expect(visible(html)).toBe("灯塔客户侧部署受外部因素和内部准备不足影响，预计中旬可启动。");
    expect(html).not.toContain("cite:");
  });

  it("带网址的出处（外部检索、附链接的复盘）在句末也是标记；没有引用标记也没有网址的 cite:source 是只显示名称的标记", () => {
    const html = render("对手本月完成 3 亿元融资[路透：某公司完成融资](https://example.com/a)。成本经济性尚未形成完整结果[《词元云集 · 9 月复盘》](cite:source)。");
    expect(marks(html)).toEqual(['data-cite-mark="url"', 'data-cite-mark="named"']);
    expect(visible(html)).toBe("对手本月完成 3 亿元融资。成本经济性尚未形成完整结果。");
  });

  it("一句用到几份资料：几个标记连着，中间的分隔符去掉", () => {
    const html = render("两个项目都延期到下旬[《交付周报》](cite:memory:a.md#s1)、[《9 月复盘》](cite:memory:b.md#s2)。");
    expect(marks(html)).toHaveLength(2);
    expect(visible(html)).toBe("两个项目都延期到下旬。");
    const adjacent = render("采集器装好了一半[10/16 Codex 记录](cite:collector:c1)[10/16 进展 · 采集器安装](cite:progress:p1)[Mission M2](cite:mission:m2)。");
    expect(marks(adjacent)).toHaveLength(3);
    expect(visible(adjacent)).toBe("采集器装好了一半。");
  });

  it("最新数据、各方意见这类词后面照样是标记（「据」「见」只在单独成词时才算引出语）", () => {
    expect(marks(render("最新数据[《经营周报》](cite:memory:w.md#s1)。"))).toHaveLength(1);
    expect(marks(render("各方意见[《群讨论》](cite:discussion:12)。"))).toHaveLength(1);
  });
});

describe("句子成分里的出处照旧显示名称", () => {
  it("「《X》写明」开头、「来源：」「据」后面、段首：名称留在正文里", () => {
    for (const text of ["[《经营原则》第 2 节](cite:memory:kd-principles.md#s2)写明交付先于扩张。", "来源：[《经营原则》第 2 节](cite:memory:kd-principles.md#s2)。",
      "据 [《经营原则》第 2 节](cite:memory:kd-principles.md#s2)，交付先于扩张。", "- [《经营原则》第 2 节](cite:memory:kd-principles.md#s2)"]) {
      const html = render(text);
      expect(marks(html), text).toEqual([]);
      expect(html, text).toContain("《经营原则》第 2 节");
    }
  });

  it("正文中间的普通外部链接照旧是链接", () => {
    const html = render("可参考 [路透报道](https://example.com/a) 的口径。");
    expect(marks(html)).toEqual([]);
    expect(html).toContain('href="https://example.com/a"');
  });
});

describe("历史消息里的旧写法尽量显示自然", () => {
  it("括号里只有出处链接的：去掉括号，显示成标记", () => {
    const html = render("同一份复盘也列出灯塔项目成本经济性尚未形成完整结果（[《词元云集 · 9 月复盘》](cite:memory:kd-tk-september-review.md#s2)）。");
    expect(marks(html)).toHaveLength(1);
    expect(visible(html)).toBe("同一份复盘也列出灯塔项目成本经济性尚未形成完整结果。");
  });

  it("括号里只有书名号资料名的（没有链接）：同样去掉括号，显示成只有名称的标记；正文开头的「《X》写明」不回改", () => {
    const html = render("《词元云集 · 9 月复盘》写明，灯塔客户侧部署预计中旬可启动；同一份复盘也列出灯塔项目成本经济性尚未形成完整结果（《词元云集 · 9 月复盘》）。");
    expect(marks(html)).toEqual(['data-cite-mark="named"']);
    expect(html).toContain('aria-label="出处：《词元云集 · 9 月复盘》"');
    expect(visible(html)).toBe("《词元云集 · 9 月复盘》写明，灯塔客户侧部署预计中旬可启动；同一份复盘也列出灯塔项目成本经济性尚未形成完整结果。");
  });

  it("括号里还有别的话、括号后面还接着话的，不动", () => {
    for (const text of ["这条按原则处理（《经营原则》里的那条说明）。", "交付优先（《经营原则》）里也这么写。"]) {
      const html = render(text);
      expect(marks(html), text).toEqual([]);
      expect(visible(html), text).toBe(text);
    }
  });
});

describe("流式中没写完的出处链接先不显示", () => {
  it("末尾的 [名称、[名称]、[名称](cite:… 都先收起；写完的链接、太长的方括号照常", () => {
    expect(holdOpenLink("预计中旬可启动[《词元云集")).toBe("预计中旬可启动");
    expect(holdOpenLink("预计中旬可启动[《词元云集 · 9 月复盘》]")).toBe("预计中旬可启动");
    expect(holdOpenLink("预计中旬可启动[《词元云集 · 9 月复盘》](cite:memory:kd-tk")).toBe("预计中旬可启动");
    expect(holdOpenLink("预计中旬可启动[《X》](cite:memory:a.md#s1)。")).toBe("预计中旬可启动[《X》](cite:memory:a.md#s1)。");
    const long = `前文[《${"字".repeat(90)}`;
    expect(holdOpenLink(long)).toBe(long);
    // 看不出是出处的普通链接（名称不带书名号、地址不是 cite:）照旧交给 remend 只显示文字。
    expect(holdOpenLink("详见 [交付排期](https://exam")).toBe("详见 [交付排期](https://exam");
    expect(holdOpenLink("详见 [交付排期")).toBe("详见 [交付排期");
    expect(holdOpenLink("预计中旬启动[路透](cite:memory:a")).toBe("预计中旬启动");
  });
});

describe("标记的浮层与打开原文", () => {
  it("浮层第二行：群材料写版本与段落，企业知识写第几节，其余写类别", () => {
    expect(citationLocator("material:9b1c3b1e-7c55-4c4c-9a8e-2f1d4b7a6c10@v2#p3")).toBe("群材料 · 第 2 版 · 第 3 段");
    expect(citationLocator("memory:kd-principles.md#s2")).toBe("企业知识 · 第 2 节");
    expect(citationLocator("research:i-1")).toBe("议题研究");
    expect(citationLocator("bogus:1")).toBeNull();
    expect(markTarget("https://www.example.com/a")).toEqual({ kind: "url", url: "https://www.example.com/a" });
    expect(markTarget("cite:source")).toEqual({ kind: "named" });
    expect(markTarget("cite:bogus:1")).toEqual({ kind: "named" });
    expect(markTarget("cite:memory:a.md#s1")).toEqual({ kind: "ref", ref: "memory:a.md#s1" });
  });

  it("打开原文：放大时交给依据面板；平时能放大就先放大、放大后接着打开；只有名称的没有「打开原文」", () => {
    const panel = vi.fn();
    registerCitationPanel(panel);
    const ref = markTarget("cite:memory:a.md#s1");
    openMark(ref, { linked: true, surface: "rail" }, null);
    expect(panel).toHaveBeenCalledWith("memory:a.md#s1", { surface: "rail", trigger: null });

    const expand = vi.fn();
    expect(canOpenMark(ref, { linked: false, surface: "sheet", expand })).toBe(true);
    openMark(ref, { linked: false, surface: "sheet", expand }, null);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(panel).toHaveBeenCalledTimes(1);
    expect(takePendingCitation()).toEqual({ ref: "memory:a.md#s1", options: { surface: "sheet", trigger: null } });
    expect(takePendingCitation()).toBeNull();

    expect(canOpenMark(ref, { linked: false, surface: "sheet" })).toBe(false);
    expect(canOpenMark({ kind: "named" }, { linked: true, surface: "rail" })).toBe(false);
    expect(canOpenMark({ kind: "url", url: "https://example.com" }, { linked: false, surface: "rail" })).toBe(true);
  });

  it("原话（cite:chat:）、个人记忆（cite:pmem:）认得：句末是标记，浮层写类别；没有原文页可开，放大时也不交给依据面板", () => {
    const panel = vi.fn();
    registerCitationPanel(panel);
    const html = render("你上个月说过渠道下沉先做县城样板[原话](cite:chat:7d1c0f7e-3c1b-4f4e-9b1e-1c2d3e4f5a6b#12)。", true);
    expect(marks(html)).toEqual(['data-cite-mark="ref"']);
    expect(html).toContain('data-cite-ref="chat:7d1c0f7e-3c1b-4f4e-9b1e-1c2d3e4f5a6b#12"');
    expect(citationLocator("chat:7d1c0f7e-3c1b-4f4e-9b1e-1c2d3e4f5a6b#12")).toBe("原话");
    expect(citationLocator("pmem:5f0e8c1a-2b3c-4d5e-8f90-a1b2c3d4e5f6")).toBe("个人记忆");
    for (const href of ["cite:chat:7d1c0f7e-3c1b-4f4e-9b1e-1c2d3e4f5a6b#12", "cite:pmem:5f0e8c1a-2b3c-4d5e-8f90-a1b2c3d4e5f6"]) {
      const target = markTarget(href);
      expect(target.kind).toBe("ref");
      expect(canOpenMark(target, { linked: true, surface: "rail", expand: vi.fn() })).toBe(false);
      openMark(target, { linked: true, surface: "rail" }, null);
    }
    expect(panel).not.toHaveBeenCalled();
    // 企业知识章节仍是 memory:，不受影响。
    expect(citationLocator("memory:kd-principles.md#s2")).toBe("企业知识 · 第 2 节");
    // 句子成分里的原话出处放大时也只是文字，不是点了没反应的按钮。
    expect(render("据[你 9 月 3 日的原话](cite:chat:c1#3)，先做样板。", true)).toContain('data-cite="plain"');
  });

  it("排着的那一条 2 秒内没放大成就作废", () => {
    openMark(markTarget("cite:memory:a.md#s1"), { linked: false, surface: "sheet", expand: vi.fn() }, null);
    expect(takePendingCitation(Date.now() + 2_500)).toBeNull();
  });

  it("点标记：手指、触控笔从底部升起；鼠标、键盘直接打开原文，打不开就浮出来源", () => {
    expect(markClickAction("touch", 1, true)).toBe("sheet");
    expect(markClickAction("pen", 1, false)).toBe("sheet");
    expect(markClickAction("mouse", 1, true)).toBe("open");
    expect(markClickAction("touch", 0, true)).toBe("open");
    expect(markClickAction("mouse", 1, false)).toBe("pop");
  });

  it("浮层在标记下方，下方放不下就放上方；左右不出窗口", () => {
    expect(popPosition({ left: 300, right: 312, top: 200, bottom: 212 }, { width: 1280, height: 800 })).toEqual({ left: 306 - 144, top: 218, width: 288 });
    expect(popPosition({ left: 300, right: 312, top: 740, bottom: 752 }, { width: 1280, height: 800 })).toEqual({ left: 306 - 144, bottom: 66, width: 288 });
    expect(popPosition({ left: 2, right: 14, top: 200, bottom: 212 }, { width: 375, height: 800 }).left).toBe(8);
    expect(popPosition({ left: 360, right: 372, top: 200, bottom: 212 }, { width: 375, height: 800 })).toMatchObject({ left: 375 - 288 - 8 });
  });

  it("链接文字被到达淡入切成好几段也能拼回名称", () => {
    expect(plainText(["《词元", createElement("span", null, "云集》"), null])).toBe("《词元云集》");
  });
});
