import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ReactMarkdown from "react-markdown";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { smoothStep, snapCut, splitStableBlocks } from "./smoothText";

/** 平滑出字：按字匀速放出（自适应速度）、切口不落在记号中间、只有最后一块重新解析且画出来与整段一致。 */
const md = (text: string) => renderToStaticMarkup(<ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>);

describe("出字速度", () => {
  it("一批 40 字按 120ms 一批到达：每帧放出几个字，不一帧放完，也不越积越多", () => {
    let shown = 0, target = 0, maxStep = 0, maxBacklog = 0;
    for (let ms = 0; ms < 3000; ms += 16) {
      if (ms % 128 === 0) target += 40;
      const next = smoothStep(shown, target, 16, false);
      maxStep = Math.max(maxStep, next - shown);
      shown = next;
      maxBacklog = Math.max(maxBacklog, target - shown);
    }
    expect(maxStep).toBeLessThan(12);
    expect(maxBacklog).toBeLessThan(160);
  });

  it("积压多就快；结束后尽快补齐（几百字在 0.4 秒内放完）", () => {
    expect(smoothStep(0, 400, 16, false) - 0).toBeGreaterThan(smoothStep(0, 40, 16, false));
    let shown = 0, frames = 0;
    while (shown < 500 && frames < 100) { shown = smoothStep(shown, 500, 16, true); frames++; }
    expect(frames * 16).toBeLessThanOrEqual(400);
    expect(smoothStep(10, 10, 16, false)).toBe(10);
  });
});

describe("切口", () => {
  it("不停在 ** 中间，行首的标题、列表记号连同第一个字一起放出", () => {
    const text = "先说结论：**保灯塔**\n## 下一步\n- 回款";
    expect(text.slice(0, snapCut(text, 6))).toBe("先说结论：**保");
    const heading = text.indexOf("##");
    expect(text.slice(heading, snapCut(text, heading + 1))).toBe("## 下");
    const item = text.indexOf("- ");
    expect(text.slice(item, snapCut(text, item + 1))).toBe("- 回");
    expect(snapCut(text, 3)).toBe(3);
  });
  it("不切开代理对", () => {
    const text = "好😀了";
    expect(snapCut(text, 2)).toBe(3);
  });
});

describe("顶层块", () => {
  const sample = [
    "先说结论：**保灯塔交付**。", "", "## 为什么", "", "1. 回款节奏", "", "2. 人手", "   续行说明", "",
    "> 引用一段", "", "```ts", "const a = 1;", "", "const b = 2;", "```", "", "| 项 | 值 |", "| --- | --- |", "| 回款 | 80% |", "", "最后一段。",
  ].join("\n");

  it("块拼回去就是原文；代码块、松散列表不被切开", () => {
    const blocks = splitStableBlocks(sample);
    expect(blocks.join("\n")).toBe(sample);
    expect(blocks.find((block) => block.includes("```ts"))).toContain("const b = 2;");
    expect(blocks.find((block) => block.includes("1. 回款"))).toContain("2. 人手");
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  it("各块分开解析画出来与整段解析一致", () => {
    const flat = (html: string) => html.replace(/>\n+</g, "><");
    expect(flat(splitStableBlocks(sample).map(md).join(""))).toBe(flat(md(sample)));
  });

  it("有链接定义（跨块引用）时不切", () => {
    expect(splitStableBlocks("见[排期][1]。\n\n[1]: https://example.com")).toHaveLength(1);
  });
});

describe("淡入", () => {
  it("新出现的字淡入不超过 160ms，并遵守减少动态效果", () => {
    const css = readFileSync(new URL("../styles/conversation-transcript.module.css", import.meta.url), "utf8");
    const duration = Number(/\.prose \[data-arrival\]\{animation:arrivalFade (\d+)ms/.exec(css)?.[1]);
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThanOrEqual(160);
    expect(css).toMatch(/prefers-reduced-motion:reduce\)\{\.prose \[data-arrival\]\{animation:none\}/);
  });
});
