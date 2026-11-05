import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PresenceCapsule } from "./PresenceCapsule";
import { CMEI_ART, CMEI_SVG } from "./cmeiArt";
import { MILES_ART, MILES_SVG } from "./milesArt";
import { milesBoxHeight, milesCapsuleWidth } from "./milesRig";

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

  it("对话层页头那颗：名字和对话正文一样大（15px），胶囊跟着大一号：最窄 64，两侧各留 13，最宽 124", () => {
    expect(milesCapsuleWidth(32, "header")).toBe(64); // 「miles」
    expect(milesCapsuleWidth(90, "header")).toBe(116); // 六个汉字
    expect(milesCapsuleWidth(140, "header")).toBe(124);
  });

  it("画里动画要用的部件都在，渐变 id 都留了占位，同一页上两颗不会撞 id", () => {
    for (const part of ["head", "body", "arm-peace", "eye-l", "eye-r", "eye-l-closed", "eye-r-closed", "mouth", "mouth-open", "airpod-r"]) {
      expect(MILES_SVG).toContain(`data-part="${part}"`);
    }
    expect(MILES_SVG).not.toMatch(/\sid="(?!\{id\}-)/);
    expect(MILES_SVG).not.toMatch(/url\(#(?!\{id\}-)/);
  });
});

describe("伙伴形象 C妹", () => {
  it("选了 C妹 的胶囊换成她那一块，和 Miles 一样大（小号 70×66，页头那颗 72 高），姿势、退场和读屏那句照旧", () => {
    const html = renderToStaticMarkup(<PresenceCapsule skin="cmei" pose="listening" leaving />);
    expect(html).toMatch(/style="width:70px;height:66px" data-skin="cmei"[^>]*data-pose="listening"[^>]*data-leaving="true"/);
    expect(html).toContain("<svg");
    expect(html).toContain("Co-Agent 在录这场会");
    expect(milesBoxHeight("header", CMEI_ART)).toBe(72);
  });

  it("摆位常量和 Miles 一样（胶囊里一样大、一样的位置），只有转眼的一格小一些：她的眼珠小", () => {
    expect({ ...CMEI_ART, gazeUnit: MILES_ART.gazeUnit }).toEqual(MILES_ART);
    expect(CMEI_ART.gazeUnit).toBe(8);
  });

  it("画里动画要用的部件都在，眼珠裁在眼眶里，转轴对，变体默认藏着，id 都留了占位", () => {
    for (const part of ["head", "body", "arm-peace", "eye-l", "eye-r", "eye-l-closed", "eye-r-closed", "mouth", "mouth-open", "airpod-r", "iris-l", "iris-r"]) {
      expect(CMEI_SVG).toContain(`data-part="${part}"`);
    }
    for (const side of ["l", "r"]) {
      expect(CMEI_SVG).toMatch(new RegExp(`<g data-part="eye-${side}">.*?<g clip-path="url\\(#\\{id\\}-[^"]+\\)"><g data-part="iris-${side}">`));
      expect(CMEI_SVG).toContain(`data-part="eye-${side}-closed" display="none"`);
    }
    for (const [part, pivot] of [["head", "444 806"], ["body", "388 1182"], ["arm-peace", "447 860"]]) {
      expect(CMEI_SVG).toContain(`data-part="${part}" data-pivot="${pivot}"`);
    }
    expect(CMEI_SVG).toContain('data-part="mouth-open" display="none"');
    expect(CMEI_SVG).not.toMatch(/\sid="(?!\{id\}-)/);
    expect(CMEI_SVG).not.toMatch(/url\(#(?!\{id\}-)/);
  });
});
