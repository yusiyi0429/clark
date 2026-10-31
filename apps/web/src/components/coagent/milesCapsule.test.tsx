import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PresenceCapsule } from "./PresenceCapsule";
import { MILES_SVG } from "./milesArt";

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

  it("画里动画要用的部件都在，渐变 id 都留了占位，同一页上两颗不会撞 id", () => {
    for (const part of ["head", "body", "arm-peace", "eye-l", "eye-r", "eye-l-closed", "eye-r-closed", "mouth", "mouth-open", "airpod-r"]) {
      expect(MILES_SVG).toContain(`data-part="${part}"`);
    }
    expect(MILES_SVG).not.toMatch(/\sid="(?!\{id\}-)/);
    expect(MILES_SVG).not.toMatch(/url\(#(?!\{id\}-)/);
  });
});
