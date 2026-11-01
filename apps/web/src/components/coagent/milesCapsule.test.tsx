import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PresenceCapsule } from "./PresenceCapsule";
import { MILES_SVG } from "./milesArt";
import { milesCapsuleWidth } from "./milesRig";

describe("伙伴形象 Miles", () => {
  it("选了 Miles 的胶囊换成 Miles 那一块，姿势、退场和读屏那句照旧", () => {
    const html = renderToStaticMarkup(<PresenceCapsule skin="miles" pose="listening" leaving />);
    expect(html).toMatch(/data-skin="miles"[^>]*data-pose="listening"[^>]*data-leaving="true"/);
    expect(html).toContain("<svg");
    expect(html).toContain("Co-Agent 在录这场会");
    expect(html).not.toContain("<canvas");
  });

  it("选形象时的预览不念读屏那句", () => {
    const html = renderToStaticMarkup(<PresenceCapsule skin="miles" pose="speaking" level={0.4} />);
    expect(html).toMatch(/data-skin="miles"[^>]*data-pose="speaking"/);
    expect(html).not.toContain("role=\"status\"");
  });

  it("胶囊跟着名字的字形变宽：放得下就是 70，放不下两侧各留 10 往外长，最宽 96", () => {
    expect(milesCapsuleWidth(25.8)).toBe(70); // 「Miles」
    expect(milesCapsuleWidth(50)).toBe(70);
    expect(milesCapsuleWidth(62)).toBe(82); // 六个汉字
    expect(milesCapsuleWidth(77)).toBe(96); // 十二个 o，最宽的窄字
    expect(milesCapsuleWidth(124)).toBe(96);
  });

  it("画里动画要用的部件都在，渐变 id 都留了占位，同一页上两颗不会撞 id", () => {
    for (const part of ["head", "body", "arm-peace", "eye-l", "eye-r", "eye-l-closed", "eye-r-closed", "mouth", "mouth-open", "airpod-r"]) {
      expect(MILES_SVG).toContain(`data-part="${part}"`);
    }
    expect(MILES_SVG).not.toMatch(/\sid="(?!\{id\}-)/);
    expect(MILES_SVG).not.toMatch(/url\(#(?!\{id\}-)/);
  });
});
