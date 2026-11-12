import { describe, expect, it } from "vitest";
import { diffLayout, markInline, sortedChanges, type Part, type Section } from "./fileChanges";
import { edited, REPORT } from "./fileChanges.fixture";

const changed = (sections: Section[] | null) => (sections ?? []).filter((section): section is Extract<Section, { kind: "change" }> => section.kind === "change");
const marks = (parts: Part[]) => parts.filter((part) => part.kind === "change").map((part) => part.kind === "change" ? [part.del, part.ins] : null);
const sameText = (parts: Part[]) => parts.map((part) => part.kind === "same" ? part.text : "|").join("");

describe("改动的画法：照本机给的位置摆，标不准就整块标（第 72 条）", () => {
  it("周报：一句话里改了几个字、表格里改了一格 → 两段，各自只标那几个字；没改的照原文接上", () => {
    const data = edited(REPORT, [["11 月 13 日（周五）", "11 月 18 日（周三）"], ["良好", "优秀", 1]]);
    const sections = diffLayout(data, "markdown")!;
    const [first, second] = changed(sections);
    expect(changed(sections)).toHaveLength(2);
    expect(first).toMatchObject({ ids: ["c1"], inline: true });
    expect(marks(first!.parts)).toEqual([["11 月 13 日（周五）", "11 月 18 日（周三）"]]);
    // 改了的那一段就是那一块（段落），没把别的块拖进来。
    expect(sameText(first!.parts)).toBe("新首页定在 |上线，Nexus 的切换跟着走。\n\n");
    expect(second).toMatchObject({ ids: ["c2"], inline: true });
    expect(marks(second!.parts)).toEqual([["良好", "优秀"]]);
    // 各段拼回去就是改后那份全文。
    expect(sections.map((section) => section.kind === "same" ? section.text : section.parts.map((part) => part.kind === "same" ? part.text : part.ins).join("")).join("")).toBe(data.after);
  });

  it("同一段里两处 → 并成一段，两处各标各的", () => {
    const data = edited("开头一段。\n\n新首页定在周五上线，切换跟着走。\n\n结尾一段。\n", [["定在", "计划于"], ["跟着走", "同步进行"]]);
    const [only, ...rest] = changed(diffLayout(data, "markdown"));
    expect(rest).toHaveLength(0);
    expect(only).toMatchObject({ ids: ["c1", "c2"], inline: true });
    expect(marks(only!.parts)).toEqual([["定在", "计划于"], ["跟着走", "同步进行"]]);
  });

  it("纯新增一整段、纯删除一整段 → 整块标", () => {
    const base = "第一段。\n\n第二段。\n\n第三段。\n";
    const added = { before: base, after: "第一段。\n\n新加的一段。\n\n第二段。\n\n第三段。\n", changes: [{ id: "a", before: { start: 6, end: 6 }, after: { start: 6, end: 14 } }] };
    const [insert] = changed(diffLayout(added, "markdown"));
    expect(insert).toMatchObject({ inline: false });
    expect(marks(insert!.parts)).toEqual([["", "新加的一段。\n\n"]]);
    const [remove] = changed(diffLayout(edited(base, [["第二段。\n\n", ""]]), "markdown"));
    expect(remove).toMatchObject({ inline: false });
    expect(marks(remove!.parts)).toEqual([["第二段。\n\n", ""]]);
  });

  it("新建的文件、删掉的文件 → 一整块", () => {
    const fresh = "# 新文件\n\n内容。\n";
    const created = diffLayout({ before: null, after: fresh, changes: [{ id: "n", before: { start: 0, end: 0 }, after: { start: 0, end: fresh.length } }] }, "markdown");
    expect(created).toEqual([{ kind: "change", ids: ["n"], inline: false, parts: [{ kind: "change", id: "n", del: "", ins: fresh }] }]);
    const deleted = diffLayout({ before: "旧文件。\n", after: null, changes: [{ id: "d", before: { start: 0, end: 5 }, after: { start: 0, end: 0 } }] }, "markdown");
    expect(deleted).toEqual([{ kind: "change", ids: ["d"], inline: false, parts: [{ kind: "change", id: "d", del: "旧文件。\n", ins: "" }] }]);
  });

  it("跨了结构的退成整块：删掉标题的井号、表格里并掉一格、改了链接地址、改动里夹着图片、一处跨两段", () => {
    const cases: [string, [string, string][]][] = [
      ["前面。\n\n## 三、上线安排\n\n后面。\n", [["## ", ""]]],
      ["| 项 | 评估 |\n| --- | --- |\n| 进展 | 良好 |\n", [[" | 良好", " 良好"]]],
      ["见[说明](https://a.example/x)。\n", [["a.example", "b.example"]]],
      ["一张图 ![图](a.png) 在这。\n", [["一张图 ![图](a.png) 在", "这里"]]],
      ["甲段末尾。\n\n乙段开头。\n", [["末尾。\n\n乙段", "和乙段并成一段，"]]],
    ];
    for (const [text, edits] of cases) expect(changed(diffLayout(edited(text, edits), "markdown"))[0], text).toMatchObject({ inline: false });
  });

  it("加粗里改字、整段加粗换成不加粗、Excel 转出来的表格里改公式：还能只标那几个字", () => {
    expect(changed(diffLayout(edited("评估：**良好**。\n", [["良好", "优秀"]]), "markdown"))[0]).toMatchObject({ inline: true });
    expect(changed(diffLayout(edited("评估：**良好**。\n", [["**良好**", "优秀"]]), "markdown"))[0]).toMatchObject({ inline: true });
    const sheet = "## Sheet1\n\n| 项 | 金额 |\n| --- | --- |\n| 合计 | =SUM(B2:B9) |\n";
    const [formula] = changed(diffLayout(edited(sheet, [["B9", "B10"]]), "markdown"));
    expect(formula).toMatchObject({ inline: true });
    expect(marks(formula!.parts)).toEqual([["B9", "B10"]]);
  });

  it("文档里本来就有私用区的字：整块标，不冒险", () => {
    expect(markInline([{ kind: "same", text: "图标 " }, { kind: "change", id: "x", del: "旧", ins: "新" }])).toBe(false);
  });

  it("纯文本、代码、CSV 按行：只标改了的字", () => {
    const code = Array.from({ length: 20 }, (_, index) => `const line${index} = ${index};`).join("\n");
    const [only] = changed(diffLayout(edited(code, [["= 10;", "= 99;"]]), "text"));
    expect(only).toMatchObject({ inline: true });
    expect(sameText(only!.parts)).toBe("const line10 |\n");
    const [cell] = changed(diffLayout(edited("项,评估\n交付质量,良好\n进展评估,良好\n", [["良好", "优秀", 1]]), "text"));
    expect(marks(cell!.parts)).toEqual([["良好", "优秀"]]);
    expect(cell!.parts[0]).toEqual({ kind: "same", text: "进展评估," });
  });

  it("位置对不上（没改的字两边不一样、区间出界、重叠）→ null，不画明细", () => {
    expect(sortedChanges("abc", "abd", [{ id: "x", before: { start: 0, end: 1 }, after: { start: 0, end: 1 } }])).toBeNull();
    expect(sortedChanges("abc", "abc", [{ id: "x", before: { start: 2, end: 9 }, after: { start: 2, end: 3 } }])).toBeNull();
    expect(sortedChanges("abcd", "xbyd", [
      { id: "x", before: { start: 0, end: 3 }, after: { start: 0, end: 1 } }, { id: "y", before: { start: 2, end: 3 }, after: { start: 2, end: 3 } },
    ])).toBeNull();
    expect(diffLayout({ before: "abc", after: "abd", changes: [] }, "text")).toBeNull();
  });
});
