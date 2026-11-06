import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DictationControls } from "./DictationControls";
import { DictationMirror, markSegments } from "./DictationMirror";
import { DICTATION_BARS, type Dictation } from "./useDictation";

const css = (name: string) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");

const dictation = (patch: Partial<Dictation> = {}) =>
  ({ phase: "listening", active: true, polishing: false, live: true, levels: Array(DICTATION_BARS).fill(0.5), elapsed: 12, marks: [], error: null, cancel: vi.fn(), ...patch }) as unknown as Dictation;

describe("听写控件：红点 + 计时 + 弱化声波，三样同时可见", () => {
  it("首页输入条：[● 0:12 声波] ■ ↑（✕ 在左边那颗键里）", () => {
    const html = renderToStaticMarkup(<DictationControls dictation={dictation()} onToInput={async () => {}} onSend={async () => {}} showCancel={false} />);
    expect(html).toContain(">0:12<");
    expect(html.match(/<i style="height:\d+px"/g)).toHaveLength(DICTATION_BARS);
    expect(html).toContain("height:6px");
    expect(html).not.toContain("取消听写");
    expect(html.indexOf("0:12")).toBeLessThan(html.indexOf("停止听写"));
    expect(html.indexOf("停止听写")).toBeLessThan(html.indexOf("直接发送"));
    expect(html).toContain("正在听");
  });

  it("二级页：指示 + 声波在左，✕ ■ ↑ 在右；说完再转时读屏说清楚", () => {
    const html = renderToStaticMarkup(<DictationControls dictation={dictation({ live: false })} onToInput={async () => {}} onSend={async () => {}} />);
    expect(html.indexOf("0:12")).toBeLessThan(html.indexOf("取消听写"));
    expect(html.indexOf("取消听写")).toBeLessThan(html.indexOf("停止听写"));
    expect(html).toContain("正在录音，结束后转写");
  });

  it("样式：8px 红点（--counter）呼吸 1.2 秒、减少动效时不动；声波 2–10px 灰、透明度 0.45", () => {
    const rules = css("dictation.module.css");
    expect(rules).toMatch(/\.dot\s*\{[^}]*width:\s*8px[^}]*background:\s*var\(--counter\)[^}]*animation:\s*breathe 1200ms/);
    expect(rules).toMatch(/\.wave\s*\{[^}]*opacity:\s*0\.45/);
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.dot\s*\{\s*animation:\s*none/);
    expect(rules).toMatch(/\.marked\s*\{[^}]*text-decoration-line:\s*underline/);
  });

  it("首页输入条听写时输入框不再藏起来；多行时控件贴底", () => {
    const rules = css("conversation-dock.module.css");
    expect(rules).not.toMatch(/data-dictating=true\] textarea\s*\{\s*display:\s*none/);
    expect(rules).toMatch(/\.dock\.composerExpanded \.dictation\s*\{[^}]*position:absolute;[^}]*bottom:5px/);
  });
});

describe("下划线镜像层", () => {
  it("按下划线范围切段", () => {
    expect(markSegments("问：下午三点开会。带上材料", [{ start: 2, end: 9 }])).toEqual([
      { text: "问：", marked: false },
      { text: "下午三点开会。", marked: true },
      { text: "带上材料", marked: false },
    ]);
    expect(markSegments("abc", [])).toEqual([{ text: "abc", marked: false }]);
    expect(markSegments("abc", [{ start: 0, end: 9 }])).toEqual([{ text: "abc", marked: true }]);
  });

  it("没有下划线时什么都不画；有时只画这次听写的那段", () => {
    const field = { current: null };
    expect(renderToStaticMarkup(<DictationMirror field={field} value="草稿" marks={[]} />)).toBe("");
    const html = renderToStaticMarkup(<DictationMirror field={field} value="草稿说的话" marks={[{ start: 2, end: 5 }]} polishing />);
    expect(html).toContain("data-polishing");
    expect(html).toMatch(/草稿<span class="[^"]*">说的话<\/span>/);
  });

  it("刚整理替换进来的那段：没有下划线也画一层淡入（160ms 内、减少动效时不画），文字里的换行照排", () => {
    const field = { current: null };
    expect(markSegments("问：下午开会。带上", [{ start: 7, end: 9 }], { start: 2, end: 7 })).toEqual([
      { text: "问：", marked: false },
      { text: "下午开会。", marked: false, fresh: true },
      { text: "带上", marked: true },
    ]);
    const html = renderToStaticMarkup(<DictationMirror field={field} value={"清单：\n1. 签合同。"} marks={[]} fresh={{ start: 0, end: 11, id: 3 }} />);
    expect(html).toContain("data-dictation-fresh");
    expect(html).toContain("清单：\n1. 签合同。");
    const styles = css("dictation.module.css");
    expect(styles).toMatch(/\.fresh \{[^}]*animation: veil 160ms/);
    expect(styles).toMatch(/prefers-reduced-motion: reduce\)[^@]*\.fresh \{ animation: none; \}/);
    expect(styles).toMatch(/\.mirror \{[^}]*white-space: pre-wrap/);
  });
});
