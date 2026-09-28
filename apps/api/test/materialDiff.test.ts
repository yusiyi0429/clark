import { describe, expect, it } from "vitest";
import { diffHtmlMaterialLines, diffMaterialBlocks, splitMaterialBlocks } from "../src/materialDiff.js";

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
  it("compares nonempty HTML lines and pairs only related changes", () => {
    const result = diffHtmlMaterialLines("<h1>标题</h1>\n\n<p>旧方案</p>\n<div>无关内容</div>",
      "<h1>标题</h1>\n<p>新方案</p>\n<section>另一件事</section>\n<p>新增</p>");
    expect(result.map((block) => block.change?.kind ?? null)).toEqual([null, "modified", "removed", "added", "added"]);
    expect(result[1].change).toMatchObject({ before: "<p>旧方案</p>" });
  });
  it("handles many HTML lines without a quadratic allocation", () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => `<p>第 ${index} 行</p>`);
    const changed = [...lines];
    changed[2_000] = "<p>第 2000 行：已更新</p>";
    const result = diffHtmlMaterialLines(lines.join("\n"), changed.join("\n"));
    expect(result.filter((block) => block.change)).toEqual([{ text: changed[2_000],
      change: expect.objectContaining({ kind: "modified", before: lines[2_000] }) }]);
  });
  it("bounds a completely replaced 3,100-line document", () => {
    const before = Array.from({ length: 3_100 }, (_, i) => `旧${String(i).padStart(4, "0")}${"甲".repeat(14)}`).join("\n");
    const after = Array.from({ length: 3_100 }, (_, i) => `新${String(i).padStart(4, "0")}${"乙".repeat(14)}`).join("\n");
    const started = performance.now();
    const result = diffHtmlMaterialLines(before, after);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.filter((block) => block.change?.kind === "removed")).toHaveLength(3_100);
    expect(result.filter((block) => block.change?.kind === "added")).toHaveLength(3_100);
  });
  it("bounds long-line replacement and character spans", () => {
    const before = Array.from({ length: 30 }, (_, i) => `<p>${i} ${"甲".repeat(1980)}</p>`).join("\n");
    const after = Array.from({ length: 30 }, (_, i) => `<p>${i} ${"乙".repeat(1980)}</p>`).join("\n");
    const started = performance.now();
    const result = diffHtmlMaterialLines(before, after);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.filter((block) => block.change?.kind === "removed")).toHaveLength(30);
    expect(result.filter((block) => block.change?.kind === "added")).toHaveLength(30);
  });
  it("changes one line in a 2 MB HTML document", () => {
    const before = `<body>${"甲".repeat(1_999_980)}旧</body>`;
    const after = before.replace("旧</body>", "新</body>");
    const started = performance.now();
    const result = diffHtmlMaterialLines(before, after);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(result.filter((block) => block.change)).toHaveLength(1);
    expect(result[0].change?.kind).toBe("modified");
  });
  it("tracks a first-line move in 19,000 lines as one removal and one addition", () => {
    const lines = Array.from({ length: 19_000 }, (_, i) => `<p>${i}</p>`);
    const result = diffHtmlMaterialLines(lines.join("\n"), [...lines.slice(1), lines[0]].join("\n"));
    expect(result.filter((block) => block.change?.kind === "removed")).toHaveLength(1);
    expect(result.filter((block) => block.change?.kind === "added")).toHaveLength(1);
  });
});
