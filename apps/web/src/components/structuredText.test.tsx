import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StructuredText, structuredBlocks } from "./StructuredText";

describe("结论先行的结构化展示", () => {
  it("要点行排成列表，**加粗** 的核心结论变粗体，后面接解释", () => {
    const html = renderToStaticMarkup(<StructuredText text={"- **先定验收口径**：否则签约后无法回款\n- **暂缓追加预算**：现金流只够两个月"} />);
    expect(html).toBe("<ul><li><strong>先定验收口径</strong>：否则签约后无法回款</li><li><strong>暂缓追加预算</strong>：现金流只够两个月</li></ul>");
  });
  it("短文字保持一段话，星号记号换成粗体；空值什么都不画", () => {
    expect(renderToStaticMarkup(<StructuredText text="先按 **方案 B** 推进。" />)).toBe("<p>先按 <strong>方案 B</strong> 推进。</p>");
    expect(renderToStaticMarkup(<StructuredText text="直接回答。" />)).toBe("<p>直接回答。</p>");
    expect(renderToStaticMarkup(<StructuredText text={null} />)).toBe("");
    expect(structuredBlocks("  \n ")).toEqual([]);
  });
  it("段落与列表混排按顺序分块；1. 和 • 也认", () => {
    expect(structuredBlocks("结论如下：\n1. 甲\n• 乙\n补充说明")).toEqual([
      { kind: "para", items: ["结论如下："] }, { kind: "list", items: ["甲", "乙"] }, { kind: "para", items: ["补充说明"] },
    ]);
  });
});
