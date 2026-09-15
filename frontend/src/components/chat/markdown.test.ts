/**
 * 参谋那段话的排版验收。
 *
 * 这是仓库里第二个渲染测试（口子和理由同 `advisor/blocks/render.test.ts`：**这种坏法
 * 没有症状**）。模型交回来的一直是 Markdown，而这一栏在 2026-08-31 之前按纯文本渲染 ——
 * 屏幕上那些 `**` 和 `##` 原样印在脸上，看起来只是「它今天话说得有点怪」，没有任何一处
 * 会报错、也没有任何一条测试会红。反过来同样没有症状：哪天渲染链断了、或者「反问」那一
 * 段被 Markdown 吃掉，屏幕上少的是版面，不是内容。
 *
 * 所以这一份只盯三件事：**记号真的变成了结构**、**反问那一块还在**、**正在说的时候末尾
 * 有那枚光标**。长相不测。
 *
 * 用 `react-dom/server` 出静态 markup，所以 `environment` 照旧是 `node`。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentText } from "@/components/advisor/chat-pane";

const html = (text: string, typing = false): string =>
  renderToStaticMarkup(createElement(AgentText, { text, typing }));

describe("记号变成结构", () => {
  it("加重、层级、分点、表格、行内代码、引用各成各的", () => {
    const out = html(
      [
        "## 支撑这条判断的三层机制",
        "",
        "1. **需求端** —— 渗透率约 55–60%。",
        "2. **供给端** —— 更可能是 `结构性紧`。",
        "",
        "| 出口 | 代价 |",
        "| --- | --- |",
        "| 降价换渗透 | 毛利被折旧吃掉 |",
        "",
        "> 坦率说：这几个数本轮都没核过。",
      ].join("\n"),
    );

    // 结构在
    expect(out).toContain("<strong");
    expect(out).toContain("<ol");
    expect(out).toContain("<table");
    expect(out).toContain("<code");
    expect(out).toContain("<blockquote");
    // 标题降到 h3 起（一段回复里不该出现 h1，理由在 `markdown.tsx` 的 `heading`）
    expect(out).toContain("<h3");
    expect(out).not.toContain("<h1");

    /*
     * **记号本身不许留在屏幕上。** 上面几条只说「结构画出来了」——`**需求端**` 完全可能
     * 既产出一个 `<strong>`、又把星号原样印在旁边（自己写解析器时最常见的那种半对）。
     */
    expect(out).not.toContain("**");
    expect(out).not.toContain("## ");
  });

  it("相邻的段落合成同一份，所以编号是连着的", () => {
    /*
     * 逐段各渲染一次 Markdown 的写法会让空行分开的 `1.` `2.` `3.` 变成三个独立列表、
     * 每个都从 1 开始 —— 屏幕上是三条「1.」。理由整段写在 `chat-pane.tsx` 的 `segment`。
     */
    const out = html("1. 第一条\n\n2. 第二条\n\n3. 第三条");
    expect(out.match(/<ol/g) ?? []).toHaveLength(1);
    expect(out.match(/<li/g) ?? []).toHaveLength(3);
  });
});

describe("反问那一块", () => {
  it("单独成块，而且「反问：」两个字不上屏", () => {
    const out = html("先说结论。\n\n反问：这三层里有一层不成立呢？");
    // 版面上那道红杠 —— 它是 Challenge 唯一看得出来的地方。
    expect(out).toContain("border-counter");
    expect(out).toContain("这三层里有一层不成立呢？");
    expect(out).not.toContain("反问：");
  });

  it("普通段落被反问隔开时，前后各自还是完整的 Markdown", () => {
    const out = html("**上半**在这儿。\n\n反问：真的吗？\n\n**下半**在这儿。");
    expect(out.match(/<strong/g) ?? []).toHaveLength(2);
    expect(out).not.toContain("**");
  });
});

describe("正在说的时候", () => {
  it("最后那一段自己在发光", () => {
    /*
     * 发光是「还有话」的意思，所以它停下的那一刻就是「说完了」——没有它，一段写到一半的
     * 回答和一段说完的回答在屏幕上完全一样，他会一直等一段不会再来的话。
     *
     * 上一版这里挂的是末尾一枚呼吸的竖条。换成光落在字上的理由写在 globals.css 的
     * `.streaming-flow` 那一段；这条测试盯的仍然是同一件事：**这两种状态在屏幕上必须
     * 分得开**。
     */
    expect(html("写到一半的一句", true)).toContain("streaming-flow-tail");
    expect(html("写完的一句", false)).not.toContain("streaming-flow");
  });

  it("最后一段是反问时，光落在那一段自己身上", () => {
    const out = html("先说结论。\n\n反问：这一条呢？", true);
    // 反问那一块是页面自己写的一个 `<p>`，光直接落在它身上（`.streaming-flow`），
    // 不走 Markdown 那条 `:last-child` 的路 —— 两条路都要发得出光。
    expect(out).toContain("streaming-flow\"");
  });

  it("只有最后一段发光，不是每段都发", () => {
    const out = html("第一段。\n\n反问：中间这一问？\n\n最后一段。", true);
    expect(out.match(/streaming-flow-tail/g) ?? []).toHaveLength(1);
    // 中间那一问已经写完了，它不许再发光。
    expect(out).not.toContain("streaming-flow\"");
  });
});
