import { describe, expect, it } from "vitest";
import { splitReply } from "./replySegments";

/** 伙伴的一条回复拆成气泡和卡片（设计稿 6.2）。 */
describe("splitReply", () => {
  it("两段普通的话拆成两个气泡", () => {
    expect(splitReply("核过了。\n\n最近的是明天。")).toEqual({ segments: [{ kind: "bubble", markdown: "核过了。" }, { kind: "bubble", markdown: "最近的是明天。" }], tail: null });
  });
  it("冒号结尾的话和后面的短清单是一个气泡", () => {
    expect(splitReply("三件事：\n\n- 改首页\n- 换头像\n- 补测试").segments).toEqual([{ kind: "bubble", markdown: "三件事：\n\n- 改首页\n- 换头像\n- 补测试" }]);
  });
  it("长段落还是气泡", () => {
    const long = "字".repeat(400);
    expect(splitReply(long).segments).toEqual([{ kind: "bubble", markdown: long }]);
  });
  it("长清单做成卡片；相邻的代码块和表格并成一张", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}项`).join("\n");
    expect(splitReply(six).segments).toEqual([{ kind: "card", markdown: six, title: "第1项", summary: "第2项" }]);
    expect(splitReply("```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |").segments).toHaveLength(1);
    expect(splitReply("| a | b |\n|---|---|\n| 1 | 2 |").segments[0]).toMatchObject({ kind: "card", title: "a · b", summary: "1 · 2" });
  });
  it("标题带着下面的内容成一张卡，标题前的话还是气泡", () => {
    const { segments } = splitReply("先说结论：能交。\n\n## 验收\n\n- 标准一达到\n- 标准二达到\n\n### 风险\n\n没有。");
    expect(segments.map((s) => s.kind)).toEqual(["bubble", "card", "card"]);
    expect(segments[1]).toMatchObject({ title: "验收", markdown: "## 验收\n\n- 标准一达到\n- 标准二达到" });
    expect(segments[2]).toMatchObject({ title: "风险", summary: "没有。" });
  });
  it("代码块里的空行不拆", () => {
    const { segments } = splitReply("```\na\n\nb\n```");
    expect(segments).toHaveLength(1);
    expect(segments[0].markdown).toContain("a\n\nb");
  });
  it("流式：写完的进 segments，没写完的放 tail", () => {
    expect(splitReply("第一段。\n\n第二段写到一半", true)).toEqual({ segments: [{ kind: "bubble", markdown: "第一段。" }], tail: { kind: "bubble", markdown: "第二段写到一半", title: "" } });
    expect(splitReply("第一段。\n\n", true)).toEqual({ segments: [{ kind: "bubble", markdown: "第一段。" }], tail: null });
    expect(splitReply("说明：\n\n```ts\nconst a", true).tail).toMatchObject({ kind: "card" });
    expect(splitReply("## 计划\n\n- 先做", true).tail).toMatchObject({ kind: "card", title: "计划" });
  });
  it("空的回复", () => {
    expect(splitReply("")).toEqual({ segments: [], tail: null });
    expect(splitReply("  \n")).toEqual({ segments: [], tail: null });
  });
});
