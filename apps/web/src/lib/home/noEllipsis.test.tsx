import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichSkeleton } from "@/conversation/richBlocks/RichBlocks";
import { NoEllipsis } from "./noEllipsis";

describe("新旧共用的组件：只在新首页去掉省略号（本人 11/18）", () => {
  it("新首页的外壳里进行中文案不带「…」，旧界面照旧", () => {
    const home = renderToStaticMarkup(<NoEllipsis.Provider value><RichSkeleton title="计划" /></NoEllipsis.Provider>);
    expect(home).toContain("正在生成");
    expect(home).not.toContain("…");
    expect(renderToStaticMarkup(<RichSkeleton title="计划" />)).toContain("正在生成…");
  });
});
