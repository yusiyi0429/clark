import { describe, expect, it } from "vitest";
import { diffLayout, foldSame, markInline, sortedChanges, type Part, type Section } from "./fileChanges";
import { edited } from "./fileChanges.fixture";


const changed = (sections: Section[] | null) => (sections ?? []).filter((section): section is Extract<Section, { kind: "change" }> => section.kind === "change");
const marks = (parts: Part[]) => parts.filter((part) => part.kind === "change").map((part) => part.kind === "change" ? [part.del, part.ins] : null);

const REPORT = [
  "# 十一月周报", "",
  "## 一、本周做了什么", "", "主循环这一批的契约交了，云端、本机、网页三边同时开工。", "",
  "## 二、卡在哪", "", "普通文件夹的兜底还在做，周日前合进来。", "",
  "## 三、上线安排", "", "新首页定在 11 月 13 日（周五）上线，Nexus 的切换跟着走。", "", "上线前一天在预发走一遍全链。", "",
  "## 四、要协调的", "", "溪南：预发全链的时间。", "", "晨星：一次运行的合同。", "",
  "## 五、各项评估", "", "| 项 | 评估 |", "| --- | --- |", "| 交付质量 | 良好 |", "| 进展评估 | 良好 |", "",
].join("\n");

describe("改动的画法：照本机给的位置摆，标不准就整块标（第 72 条）", () => {
  it("周报：一句话里改了几个字、表格里改了一格 → 两段，各自只标那几个字；没改的按块收着", () => {
    const data = edited(REPORT, [["11 月 13 日（周五）", "11 月 18 日（周三）"], ["良好", "优秀", 1]]);
    const sections = diffLayout(data, "markdown");
    const [first, second] = changed(sections);
    expect(changed(sections)).toHaveLength(2);
    expect(first).toMatchObject({ ids: ["c1"], inline: true, table: false });
    expect(marks(first!.parts)).toEqual([["11 月 13 日（周五）", "11 月 18 日（周三）"]]);
    expect(second).toMatchObject({ ids: ["c2"], inline: true, table: true });
    expect(marks(second!.parts)).toEqual([["良好", "优秀"]]);
    // 改了的那一段就是那一块（段落、整张表），没把别的块拖进来。
    expect(first!.parts.map((part) => part.kind === "same" ? part.text : "").join("")).toBe("新首页定在 上线，Nexus 的切换跟着走。\n\n");
    // 开头没改的那段：五块（标题、两个小节）收起来，留最后两块。
    const head = sections![0]!;
    expect(head.kind).toBe("same");
    const fold = foldSame(head.kind === "same" ? head.blocks : [], { first: true, last: false });
    expect(fold.head).toBe("");
    expect(fold.tail).toBe("普通文件夹的兜底还在做，周日前合进来。\n\n## 三、上线安排\n\n");
    expect(fold.hiddenLines).toBe(4);
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
    const removed = edited(base, [["第二段。\n\n", ""]]);
    const [remove] = changed(diffLayout(removed, "markdown"));
    expect(remove).toMatchObject({ inline: false });
    expect(marks(remove!.parts)).toEqual([["第二段。\n\n", ""]]);
  });

  it("新建的文件、删掉的文件 → 一整块，没有没改的", () => {
    const fresh = "# 新文件\n\n内容。\n";
    const created = diffLayout({ before: null, after: fresh, changes: [{ id: "n", before: { start: 0, end: 0 }, after: { start: 0, end: fresh.length } }] }, "markdown");
    expect(created).toHaveLength(1);
    expect(created![0]).toMatchObject({ kind: "change", inline: false });
    const deleted = diffLayout({ before: "旧文件。\n", after: null, changes: [{ id: "d", before: { start: 0, end: 5 }, after: { start: 0, end: 0 } }] }, "markdown");
    expect(deleted).toHaveLength(1);
    expect(deleted![0]).toMatchObject({ kind: "change", inline: false });
  });

  it("跨了结构的退成整块：删掉标题的井号、表格里并掉一格、改了链接地址、改动里夹着图片", () => {
    const heading = edited("前面。\n\n## 三、上线安排\n\n后面。\n", [["## ", ""]]);
    expect(changed(diffLayout(heading, "markdown"))[0]).toMatchObject({ inline: false });
    const cell = edited("| 项 | 评估 |\n| --- | --- |\n| 进展 | 良好 |\n", [[" | 良好", " 良好"]]);
    expect(changed(diffLayout(cell, "markdown"))[0]).toMatchObject({ inline: false });
    const link = edited("见[说明](https://a.example/x)。\n", [["a.example", "b.example"]]);
    expect(changed(diffLayout(link, "markdown"))[0]).toMatchObject({ inline: false });
    const image = edited("一张图 ![图](a.png) 在这。\n", [["一张图 ![图](a.png) 在", "这里"]]);
    expect(changed(diffLayout(image, "markdown"))[0]).toMatchObject({ inline: false });
  });

  it("加粗里改字、整段加粗换成不加粗：还能只标那几个字", () => {
    expect(changed(diffLayout(edited("评估：**良好**。\n", [["良好", "优秀"]]), "markdown"))[0]).toMatchObject({ inline: true });
    expect(changed(diffLayout(edited("评估：**良好**。\n", [["**良好**", "优秀"]]), "markdown"))[0]).toMatchObject({ inline: true });
  });

  it("文档里本来就有私用区的字：整块标，不冒险", () => {
    expect(markInline([{ kind: "same", text: "图标 " }, { kind: "change", id: "x", del: "旧", ins: "新" }]).inline).toBe(false);
  });

  it("纯文本、代码按行：只改的那几个字标出来，上下各留两行", () => {
    const code = Array.from({ length: 20 }, (_, index) => `const line${index} = ${index};`).join("\n");
    const sections = diffLayout(edited(code, [["= 10;", "= 99;"]]), "text")!;
    const [only] = changed(sections);
    expect(only).toMatchObject({ inline: true });
    expect(marks(only!.parts)).toEqual([["= 10;", "= 99;"]]);
    const head = sections[0]!;
    const fold = foldSame(head.kind === "same" ? head.blocks : [], { first: true, last: false });
    expect(fold.tail).toBe("const line8 = 8;\nconst line9 = 9;\n");
    expect(fold.hiddenLines).toBe(8);
  });

  it("CSV 一格改了按行标", () => {
    const [only] = changed(diffLayout(edited("项,评估\n交付质量,良好\n进展评估,良好\n", [["良好", "优秀", 1]]), "text"));
    expect(marks(only!.parts)).toEqual([["良好", "优秀"]]);
    expect(only!.parts[0]).toEqual({ kind: "same", text: "进展评估," });
  });

  it("位置对不上（没改的字两边不一样、区间出界、重叠）→ null，不画明细", () => {
    expect(sortedChanges("abc", "abd", [{ id: "x", before: { start: 0, end: 1 }, after: { start: 0, end: 1 } }])).toBeNull();
    expect(sortedChanges("abc", "abc", [{ id: "x", before: { start: 2, end: 9 }, after: { start: 2, end: 3 } }])).toBeNull();
    expect(sortedChanges("abcd", "xbyd", [
      { id: "x", before: { start: 0, end: 3 }, after: { start: 0, end: 1 } }, { id: "y", before: { start: 2, end: 3 }, after: { start: 2, end: 3 } },
    ])).toBeNull();
    expect(diffLayout({ before: "abc", after: "abd", changes: [] }, "text")).toBeNull();
  });

  it("没收的不到 2 块且不到 3 行时不收", () => {
    expect(foldSame(["a\n", "b\n", "c\n", "d\n", "e\n"], { first: false, last: false })).toMatchObject({ hidden: "", head: "a\nb\nc\nd\ne\n" });
    expect(foldSame(["a\n", "b\n", "c\n", "d\n", "e\n", "f\n"], { first: false, last: false })).toMatchObject({ hidden: "c\nd\n", hiddenLines: 2 });
  });
});
