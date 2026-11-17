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
  it("流式：还可能被下一块改写的块留在 tail", () => {
    expect(splitReply("三件事：\n\n", true)).toEqual({ segments: [], tail: { kind: "bubble", markdown: "三件事：", title: "" } });
    expect(splitReply("```\nx\n```\n\n", true).segments).toEqual([]);
    expect(splitReply("- a\n- b\n\n", true).segments).toEqual([]);
    expect(splitReply("- a\n- b\n\n下一句\n", true).segments).toEqual([{ kind: "bubble", markdown: "- a\n- b" }]);
  });
  it("流式：清单、卡片后面的话一出第一个字就是自己的气泡，不在上一块里长", () => {
    expect(splitReply("- a\n- b\n\n下一句", true)).toEqual({ segments: [{ kind: "bubble", markdown: "- a\n- b" }], tail: { kind: "bubble", markdown: "下一句", title: "" } });
    expect(splitReply("```\nx\n```\n\n一整段解释", true)).toEqual({
      segments: [{ kind: "card", markdown: "```\nx\n```", title: "x", summary: "" }],
      tail: { kind: "bubble", markdown: "一整段解释", title: "" },
    });
    expect(splitReply("- a\n- b\n\n1", true).segments).toEqual([]);
  });
  it("围栏关上以后紧跟的话不算进代码卡", () => {
    expect(splitReply("```\nx\n```\n说完了。").segments).toEqual([
      { kind: "card", markdown: "```\nx\n```", title: "x", summary: "" },
      { kind: "bubble", markdown: "说完了。" },
    ]);
  });
  it("流式：每多一个字，segments 只往后长，最后和整段拆分一致", () => {
    const replies = [
      "先说结论：能交。\n\n## 验收\n\n- 标准一达到\n- 标准二达到\n\n### 风险\n\n没有。",
      "三件事：\n\n- 改首页\n- 换头像\n- 补测试\n\n就这些。",
      "两件事：\n\n- 一\n- 二\n- 三\n- 四\n- 五\n- 六\n\n完。",
      "```ts\nconst a = 1\n\nconst b = 2\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n说完了。",
      "公式：\n\n$$\na\n\nb\n$$\n\n- a\n\n1. b\n\n#a 不是标题\n说明\n## 是标题\n内容",
      "```\nx\n```\n说完了。\n\n- a\n- b\n\n下一句很长很长。\n\n- c\n\n12 个人\n\n1.5 倍\n\n- d\n\n> 引用",
    ];
    for (const reply of replies) {
      const chars = [...reply];
      let previous: ReturnType<typeof splitReply>["segments"] = [];
      for (let length = 1; length <= chars.length; length++) {
        const { segments } = splitReply(chars.slice(0, length).join(""), true);
        expect(segments.slice(0, previous.length), `${JSON.stringify(reply)} 第 ${length} 个字`).toEqual(previous);
        previous = segments;
      }
      expect(splitReply(reply).segments.slice(0, previous.length)).toEqual(previous);
    }
  });
  it("代码卡和公式卡的标题取块里第一行，不取围栏上的语言名", () => {
    expect(splitReply("```ts\n\nconst a = 1\nconst b = 2\n```").segments[0]).toMatchObject({ kind: "card", title: "const a = 1", summary: "const b = 2" });
    expect(splitReply("$$\nx^2\n$$").segments[0]).toMatchObject({ kind: "card", title: "x^2", summary: "" });
  });
  it("空的回复", () => {
    expect(splitReply("")).toEqual({ segments: [], tail: null });
    expect(splitReply("  \n")).toEqual({ segments: [], tail: null });
  });
});
