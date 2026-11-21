import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LEFT_MAX, LEFT_MIN, LeftResize, RIGHT_MAX, RIGHT_MIN, RightResize, clampLeft, clampRight } from "./LeftResize";

const control = (width: number, min: number, max: number) => ({ width, dragging: false, setDragging: vi.fn(), set: vi.fn(), reset: vi.fn(), min, max });

describe("左栏宽度能拖（24 条）", () => {
  it("拖到的宽度夹在 240–360，取整", () => {
    expect([100, 240, 287.6, 360, 900].map(clampLeft)).toEqual([LEFT_MIN, 240, 288, 360, LEFT_MAX]);
  });
  it("把手是能聚焦的竖分隔条，读屏读当前宽度和范围", () => {
    const html = renderToStaticMarkup(<LeftResize control={control(300, LEFT_MIN, LEFT_MAX)} />);
    expect(html).toMatch(/role="separator"[^>]*aria-orientation="vertical"[^>]*aria-label="左栏宽度"[^>]*tabindex="0"[^>]*aria-valuemin="240"[^>]*aria-valuemax="360"[^>]*aria-valuenow="300"/);
  });
});

describe("右栏宽度能拖（11/11）", () => {
  it("拖到的宽度夹在 260–560，取整", () => {
    expect([100, 260, 400.4, 560, 1200].map(clampRight)).toEqual([RIGHT_MIN, 260, 400, 560, RIGHT_MAX]);
  });
  it("把手在右栏左边缘，读屏读右栏的宽度和范围", () => {
    const html = renderToStaticMarkup(<RightResize control={control(420, RIGHT_MIN, RIGHT_MAX)} />);
    expect(html).toMatch(/aria-label="右栏宽度"[^>]*aria-valuemin="260"[^>]*aria-valuemax="560"[^>]*aria-valuenow="420"[^>]*data-testid="right-resize"/);
  });
});
