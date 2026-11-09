import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LEFT_MAX, LEFT_MIN, LeftResize, clampLeft } from "./LeftResize";

describe("左栏宽度能拖（24 条）", () => {
  it("拖到的宽度夹在 240–360，取整", () => {
    expect([100, 240, 287.6, 360, 900].map(clampLeft)).toEqual([LEFT_MIN, 240, 288, 360, LEFT_MAX]);
  });
  it("把手是能聚焦的竖分隔条，读屏读当前宽度和范围", () => {
    const control = { width: 300, dragging: false, setDragging: vi.fn(), set: vi.fn(), reset: vi.fn() };
    const html = renderToStaticMarkup(<LeftResize control={control} />);
    expect(html).toMatch(/role="separator"[^>]*aria-orientation="vertical"[^>]*aria-label="左栏宽度"[^>]*tabindex="0"[^>]*aria-valuemin="240"[^>]*aria-valuemax="360"[^>]*aria-valuenow="300"/);
  });
});
