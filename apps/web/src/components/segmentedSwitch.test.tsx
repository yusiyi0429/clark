import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SegmentedSwitch, segmentKeyTarget } from "./SegmentedSwitch";

type Props = { children?: ReactNode; onClick?: () => void; onKeyDown?: (event: unknown) => void; [key: string]: unknown };
const buttons = (node: ReactNode): ReactElement<Props>[] => {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<Props>(node)) return [];
  return [...(node.type === "button" ? [node] : []), ...buttons(node.props.children)];
};
const segments = [{ id: "a", label: "会议" }, { id: "b", label: "议题" }, { id: "c", label: "其他" }];

describe("SegmentedSwitch（二级页类型切换）", () => {
  it("单选组语义：radiogroup 带中文名，每段 radio + aria-checked，只有选中那段在 Tab 顺序里", () => {
    const html = renderToStaticMarkup(<SegmentedSwitch label="已处理" segments={segments} selected="b" onSelect={() => undefined} />);
    expect(html).toContain('role="radiogroup" aria-label="已处理"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>会议</);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>议题</);
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>其他</);
  });

  it("一段都不选时（会议页正在看材料）第一段可 Tab 进入，全部 aria-checked=false", () => {
    const html = renderToStaticMarkup(<SegmentedSwitch label="会议视图" segments={segments} selected={null} onSelect={() => undefined} />);
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toMatch(/tabindex="0"[^>]*>会议</);
  });

  it("带图标的段可另给读屏名称", () => {
    const html = renderToStaticMarkup(<SegmentedSwitch label="战场视角" selected="x" onSelect={() => undefined}
      segments={[{ id: "x", label: "决策" }, { id: "y", label: "战况", ariaLabel: "战况（一号位为本战场负责人）" }]} />);
    expect(html).toContain('aria-label="战况（一号位为本战场负责人）"');
  });

  it("方向键左右上下循环、Home / End 到头尾，其他键不动", () => {
    expect(segmentKeyTarget("ArrowRight", 0, 3)).toBe(1);
    expect(segmentKeyTarget("ArrowDown", 2, 3)).toBe(0);
    expect(segmentKeyTarget("ArrowLeft", 0, 3)).toBe(2);
    expect(segmentKeyTarget("ArrowUp", 1, 3)).toBe(0);
    expect(segmentKeyTarget("Home", 2, 3)).toBe(0);
    expect(segmentKeyTarget("End", 0, 3)).toBe(2);
    expect(segmentKeyTarget("Enter", 0, 3)).toBeNull();
    expect(segmentKeyTarget("a", 0, 3)).toBeNull();
  });

  it("按方向键：选中下一段并把焦点移过去；点已选中的那段不重复触发", () => {
    const onSelect = vi.fn();
    const tree = SegmentedSwitch({ label: "已处理", segments, selected: "a", onSelect });
    const [first] = buttons(tree);
    const focus = vi.fn();
    const preventDefault = vi.fn();
    first.props.onKeyDown!({ key: "ArrowRight", preventDefault, currentTarget: { parentElement: { children: [{}, { focus }, {}] } } });
    expect(preventDefault).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("b");
    onSelect.mockClear();
    first.props.onClick!();
    expect(onSelect).not.toHaveBeenCalled();
    buttons(tree)[2].props.onClick!();
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("样式：选中段浅蓝底深蓝字的胶囊，未选中无外框；过渡不超过 180ms，减少动效时不过渡；字号不小于 13px", () => {
    const css = readFileSync(new URL("../styles/segmented-switch.module.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.segment \{[^}]*border: 0;[^}]*border-radius: 999px;[^}]*background: transparent;[^}]*font-size: 14px;/);
    // 浅蓝底深蓝字读强调色变量（深色时跟着换）。
    expect(css).toMatch(/\[aria-checked='true'\][^{]*\{[^}]*background: var\(--accent-soft\);[^}]*color: var\(--accent-soft-foreground\);/);
    const durations = [...css.matchAll(/(\d+)ms/g)].map((match) => Number(match[1]));
    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...durations)).toBeLessThanOrEqual(180);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.segment \{ transition: none; \}/);
    for (const size of css.matchAll(/font-size: ([\d.]+)px/g)) expect(Number(size[1])).toBeGreaterThanOrEqual(13);
  });
});
