import { describe, expect, it } from "vitest";
import { diffMaterialBlocks, splitMaterialBlocks } from "../src/materialDiff.js";

describe("material block diff", () => {
  it("splits headings, list items, tables, code and paragraphs", () => {
    expect(splitMaterialBlocks("# 标题\n\n一段\n续行\n\n- 一\n- 二\n\n|甲|乙|\n|--|--|\n\n```ts\na\n```"))
      .toEqual(["# 标题", "一段\n续行", "- 一", "- 二", "|甲|乙|\n|--|--|", "```ts\na\n```"]);
  });
  it("marks changed characters and keeps the previous text", () => {
    const blocks = diffMaterialBlocks("今天开会。", "明天开会。");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].change).toMatchObject({ kind: "modified", before: "今天开会。" });
    expect(blocks[0].change?.kind === "modified" && blocks[0].change.spans.some((span) => span.changed && span.text.includes("明"))).toBe(true);
  });
  it("shows additions, removals and reordered blocks", () => {
    expect(diffMaterialBlocks("甲\n\n乙", "甲\n\n乙\n\n丙").at(-1)).toEqual({ text: "丙", change: { kind: "added" } });
    expect(diffMaterialBlocks("甲\n\n乙", "甲").at(-1)).toEqual({ text: "", change: { kind: "removed", before: "乙" } });
    expect(diffMaterialBlocks("甲\n\n乙", "乙\n\n甲").map((block) => block.change?.kind)).toEqual(["removed", undefined, "added"]);
  });
  it("does not run character LCS for a long block", () => {
    const before = "x".repeat(20) + "a".repeat(2001), after = "x".repeat(20) + "b".repeat(2001);
    const result = diffMaterialBlocks(before, after);
    expect(result[0].change).toEqual({ kind: "modified", before, spans: [{ text: after, changed: true }] });
  });
  it("does not pair an unrelated removed block with an added one", () => {
    const result = diffMaterialBlocks("开头\n\n- 异常由谁接回", "开头\n\n## 场景三：跨战场交接\n\n涉及两个战场时共同确认。");
    expect(result.map((block) => block.change?.kind ?? null)).toEqual([null, "removed", "added", "added"]);
  });
});
