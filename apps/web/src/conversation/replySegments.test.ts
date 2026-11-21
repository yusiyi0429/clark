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
    expect(splitReply(six).segments).toEqual([{ kind: "card", markdown: six, title: "", summary: "第1项" }]);
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
  it("流式：以粗体、行内代码、数字开头的话也当场是自己的气泡", () => {
    const list = { kind: "bubble", markdown: "- a\n- b" };
    expect(splitReply("- a\n- b\n\n**注意**：后面一整段", true)).toEqual({ segments: [list], tail: { kind: "bubble", markdown: "**注意**：后面一整段", title: "" } });
    expect(splitReply("```\nx\n```\n\n`npm`命令要先装", true)).toEqual({
      segments: [{ kind: "card", markdown: "```\nx\n```", title: "x", summary: "" }],
      tail: { kind: "bubble", markdown: "`npm`命令要先装", title: "" },
    });
    expect(splitReply("- a\n- b\n\n12个人参加", true)).toEqual({ segments: [list], tail: { kind: "bubble", markdown: "12个人参加", title: "" } });
    expect(splitReply("- a\n- b\n\n1.5倍", true)).toEqual({ segments: [list], tail: { kind: "bubble", markdown: "1.5倍", title: "" } });
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
      "- a\n- b\n\n**注意**：后面一整段\n\n- c",
      "```\nx\n```\n\n`npm`命令要先装\n\n| a |\n|---|\n| 1 |",
      "- a\n- b\n\n12个人参加\n\n- c\n- d",
      "- a\n- b\n\n1.5倍\n\n1. 一\n2. 二\n\n~~删掉~~的话\n\n$a$ 和 #号 *星",
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
  it("单独一行的加粗当小标题：后面有长清单的整节成卡，卡片标题是小标题", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}项`).join("\n");
    expect(splitReply(`先说一句。\n\n**要做的事**：\n\n${six}\n\n**风险:**\n\n| a | b |\n|---|---|\n| 1 | 2 |`).segments).toEqual([
      { kind: "bubble", markdown: "先说一句。" },
      { kind: "card", markdown: `**要做的事**：\n\n${six}`, title: "要做的事", summary: "第1项" },
      { kind: "card", markdown: "**风险:**\n\n| a | b |\n|---|---|\n| 1 | 2 |", title: "风险", summary: "a · b" },
    ]);
  });
  it("加粗小标题后面只有短段落：合成一个气泡，第一行是小标题", () => {
    expect(splitReply("**打新要算的账**\n\n利息和手续费都要算。\n\n冻结资金也有成本。\n\n## 下一步\n\n先看招股书。").segments).toEqual([
      { kind: "bubble", markdown: "**打新要算的账**\n\n利息和手续费都要算。\n\n冻结资金也有成本。" },
      { kind: "card", markdown: "## 下一步\n\n先看招股书。", title: "下一步", summary: "先看招股书。" },
    ]);
    // 前后空白不算（含 Windows 换行留下的 \r）。
    expect(splitReply("  **打新要算的账**：\r\n\r\n利息要算。").segments).toEqual([{ kind: "bubble", markdown: "  **打新要算的账**：\r\n\r\n利息要算。" }]);
    // 整条回答最后一段是一行加粗、后面没有内容：照普通段落出气泡。
    expect(splitReply("说完了。\n\n**就这些**").segments).toEqual([{ kind: "bubble", markdown: "说完了。" }, { kind: "bubble", markdown: "**就这些**" }]);
  });
  it("行内加粗加正文不算小标题", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}项`).join("\n");
    const { segments } = splitReply(`**结论**：今天先不买\n\n${six}`);
    expect(segments.map((s) => s.kind)).toEqual(["bubble", "card"]);
    expect(segments[1]).toMatchObject({ title: "", summary: "第1项" });
    expect(splitReply("**甲** 和 **乙**\n\n说明。").segments).toEqual([{ kind: "bubble", markdown: "**甲** 和 **乙**" }, { kind: "bubble", markdown: "说明。" }]);
    expect(splitReply("**两行**\n第二行\n\n说明。").segments).toEqual([{ kind: "bubble", markdown: "**两行**\n第二行" }, { kind: "bubble", markdown: "说明。" }]);
  });
  it("ant-answer 原文拆成 说明气泡 / 卡 / 卡 / 气泡 / 气泡", () => {
    const { segments } = splitReply(ANT_ANSWER);
    // 最后一节的清单只有 3 项、不到 150 个字，是短清单，整节一个气泡（本人 11/19）。
    expect(segments.map((s) => s.kind)).toEqual(["bubble", "card", "card", "bubble", "bubble"]);
    expect(segments[0].markdown).toMatch(/^这次没调查成/);
    expect(segments[1]).toMatchObject({ title: "先确认 ANT 指的是哪家", summary: expect.stringMatching(/^蚂蚁集团：2020 年/) });
    expect(segments[2]).toMatchObject({ title: "判断一只新股适不适合打新，主要看这几项", summary: expect.stringMatching(/^在哪里上市、散户怎么参与。/) });
    expect(segments[3].markdown).toMatch(/^\*\*打新本身要算清的账\*\*\n\n用孖展加大申购/);
    expect(segments[4].markdown).toMatch(/^\*\*接下来可以这样做\*\*\n\n- 招股书/);
    // 不再有单独的粗体小气泡。
    expect(segments.filter((s) => /^\*\*[^*]+\*\*$/.test(s.markdown.trim()))).toEqual([]);
  });
  it("流式逐字到达时已经出过的块不变", () => {
    // 第二条：「**结论**」写完一整行时像小标题，接着写出「：」就成了普通段落，前一节要等它定下来才出。
    // longItem 一项就超过 150 个字，是卡片料。
    const longItem = `- ${"很长的一项".repeat(31)}`;
    for (const reply of [ANT_ANSWER, `**甲**\n\n${longItem}\n\n**结论**：今天先不买\n\n**乙**\n\n说明。`]) {
      const chars = [...reply];
      let previous: ReturnType<typeof splitReply>["segments"] = [];
      for (let length = 1; length <= chars.length; length++) {
        const { segments } = splitReply(chars.slice(0, length).join(""), true);
        expect(segments.slice(0, previous.length), `第 ${length} 个字`).toEqual(previous);
        previous = segments;
      }
      expect(previous).toEqual(splitReply(reply).segments.slice(0, previous.length));
    }
    expect(splitReply(ANT_ANSWER, true).segments).toEqual(splitReply(ANT_ANSWER).segments.slice(0, -1));
    // 加粗行还没确定后面跟什么之前不出成块：写到第二个小标题，第一节还在 tail。
    const head = ANT_ANSWER.slice(0, ANT_ANSWER.indexOf("**判断"));
    expect(splitReply(head, true).segments.map((s) => s.kind)).toEqual(["bubble"]);
    expect(splitReply(head, true).tail).toMatchObject({ kind: "card", title: "先确认 ANT 指的是哪家" });
  });
  it("流式时加粗小标题一节的尾巴是卡片壳子，写长了不会从气泡变成卡", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}项`).join("\n");
    const reply = `**要做的事**\n\n先说一句。\n\n${six}\n\n**风险**\n\n没有。`;
    // 清单还没写到：尾巴已经是卡片壳子，标题是小标题。
    expect(splitReply("**要做的事**\n\n先说一句。", true)).toEqual({ segments: [], tail: { kind: "card", markdown: "**要做的事**\n\n先说一句。", title: "要做的事" } });
    expect(splitReply("**要做的事：**\n\n先", true).tail).toMatchObject({ kind: "card", title: "要做的事" });
    expectNoBubbleTurnsCard(reply);
    // 写完：照规则定，有长清单的一节成卡，只有一句话的一节成气泡（壳子展开成全文）。
    expect(splitReply(reply).segments.map((s) => s.kind)).toEqual(["card", "bubble"]);
  });
  it("加粗小标题后先有一段铺垫再接表格：流式全程不出现气泡变卡", () => {
    const reply = "开头一句。\n\n**数据**\n\n先看一下这张表，再说结论。\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**下一步**\n\n说明。";
    expectNoBubbleTurnsCard(reply);
    expect(splitReply(reply).segments).toMatchObject([{ kind: "bubble" }, { kind: "card", title: "数据", summary: "先看一下这张表，再说结论。" }, { kind: "bubble" }]);
  });
  it("两行加粗只隔空行时并成一节，不出单独的粗体小气泡", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}项`).join("\n");
    expect(splitReply(`**甲**\n\n**乙**\n\n${six}\n\n**丙**\n\n说明。`).segments).toEqual([
      { kind: "card", markdown: `**甲**\n\n**乙**\n\n${six}`, title: "甲", summary: "乙" },
      { kind: "bubble", markdown: "**丙**\n\n说明。" },
    ]);
    expect(splitReply("**甲**\n\n**乙**\n\n说明。").segments).toEqual([{ kind: "bubble", markdown: "**甲**\n\n**乙**\n\n说明。" }]);
    expectNoBubbleTurnsCard(`**甲**\n\n**乙**\n\n${six}\n\n**丙**\n\n说明。`);
  });
  it("加粗小标题一节里只有一项的短清单：整节一个气泡", () => {
    const item = `- ${"很长的一项".repeat(6)}`;
    expect(splitReply(`**甲**\n\n**乙**\n\n${item}\n\n**丙**\n\n说明。`).segments).toEqual([
      { kind: "bubble", markdown: `**甲**\n\n**乙**\n\n${item}` },
      { kind: "bubble", markdown: "**丙**\n\n说明。" },
    ]);
    expectNoBubbleTurnsCard(`**甲**\n\n**乙**\n\n${item}\n\n**丙**\n\n说明。`);
  });
  it("清单项的续行也算进这一项的字数", () => {
    const note = "这一行是改首页这一项的说明，写在清单项下面的续行里，字数要算进这一项。".repeat(5);
    expect([...note].length).toBeGreaterThan(150);
    // 缩进续行。
    const indented = `- **改首页**\n  ${note}\n- **补测试**`;
    expect(splitReply(indented).segments).toMatchObject([{ kind: "card", title: "", summary: "改首页" }]);
    // 不隔空行、不缩进接着写的续行。
    const lazy = `- **改首页**\n${note}\n- **补测试**`;
    expect(splitReply(lazy).segments).toMatchObject([{ kind: "card", title: "", summary: "改首页" }]);
    // 续行短，合计不到 150：照旧是气泡。
    const short = "- **改首页**\n  今天先做完\n- **补测试**";
    expect(splitReply(short).segments).toEqual([{ kind: "bubble", markdown: short }]);
  });
  it("卡片标题完整显示，摘要不拼省略号", () => {
    const title = "这是一个很长很长的标题，用来确认卡片标题放不下时完整显示交给样式去换行，而不是在后面截断再拼省略号";
    const summary = "摘要也很长：".repeat(30);
    const six = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}项`).join("\n");
    // describeCard：# 标题一节。
    const heading = splitReply(`## ${title}\n\n${summary}`).segments[0] as { title: string; summary: string };
    expect(heading.title).toBe(title);
    expect(heading.summary).not.toContain("…");
    expect(summary.startsWith(heading.summary)).toBe(true);
    expect(heading.summary.length).toBeGreaterThan(0);
    // describeGroup：加粗小标题一节，去掉末尾冒号，其余完整。
    const bold = splitReply(`**${title}**：\n\n${six}`).segments[0] as { title: string; summary: string };
    expect(bold.title).toBe(title);
    // 流式时卡片壳子的标题也完整。
    expect(splitReply(`## ${title}\n\n- 先做`, true).tail).toMatchObject({ kind: "card", title });
    // 表格卡：第一行拼成标题，也不截。
    const cells = Array.from({ length: 12 }, (_, i) => `第${i + 1}列标题`);
    const table = splitReply(`| ${cells.join(" | ")} |\n|${"---|".repeat(12)}\n| ${cells.map(() => "x").join(" | ")} |`).segments[0] as { title: string };
    expect(table.title).toBe(cells.join(" · "));
  });
  it("列表项开头的加粗不算小标题，不拆成卡", () => {
    // 本人 11/19 在 3700 上看到的两段（第二项写全，超过 24 个字）：短清单一律气泡，不按「有一项超过 24 个字」成卡。
    const sessions = "你可以在天枢里看一眼这两个会话：\n\n- **写并运行 hello.py**（在「随手」里）\n- **清点项目 .md 文件**（在「新版天枢应用」里，就是刚才新开的那一个）";
    expect(splitReply(sessions).segments).toEqual([{ kind: "bubble", markdown: sessions }]);
    const why = "- **为什么挂这件**：你没指定挂哪件 Task，我挂在你最近在做的那件上。\n- **交给拆卡的内容**：需求原文和完成标准一起交过去。";
    expect(splitReply(why).segments).toEqual([{ kind: "bubble", markdown: why }]);
    for (const reply of [sessions, why]) expectNoBubbleTurnsCard(reply);
  });
  it("清单超过 5 项、有嵌套或整张很长才成卡", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- **第${i + 1}项**`).join("\n");
    expect(splitReply(six).segments).toEqual([{ kind: "card", markdown: six, title: "", summary: "第1项" }]);
    const nested = "- **甲**\n  - 甲的细节\n- **乙**";
    expect(splitReply(nested).segments).toEqual([{ kind: "card", markdown: nested, title: "", summary: "甲" }]);
    // 整张很长：去掉清单记号后各项字数加起来超过 150。
    const item = "这一项写得很长，用来把整张清单的字数撑过一百五十个字的那条线。";
    const long = Array.from({ length: 5 }, () => `- ${item}`).join("\n");
    expect([...item].length * 5).toBeGreaterThan(150);
    expect(splitReply(long).segments).toMatchObject([{ kind: "card", title: "", summary: item }]);
    const justUnder = Array.from({ length: 5 }, () => `- ${"字".repeat(30)}`).join("\n");
    expect(splitReply(justUnder).segments).toEqual([{ kind: "bubble", markdown: justUnder }]);
  });
  it("单独一行的加粗照旧当小标题", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}项`).join("\n");
    expect(splitReply(`**要做的事**：\n\n${six}`).segments).toEqual([{ kind: "card", markdown: `**要做的事**：\n\n${six}`, title: "要做的事", summary: "第1项" }]);
    // 小标题下面是加粗开头的短清单：整节一个气泡，清单项不另起小标题。
    const short = "**要做的事**\n\n- **改首页**：把等你那一栏换成新的样子，今天先做完\n- **补测试**：两段原文都要覆盖";
    expect(splitReply(short).segments).toEqual([{ kind: "bubble", markdown: short }]);
  });
  it("清单成卡时，前面的冒号引子当卡标题，不再拿第一项当标题", () => {
    expect(listChars(TWO_ITEMS)).toBeGreaterThan(150);
    const reply = `核过了。\n\n${INTRO}\n\n${TWO_ITEMS}`;
    expect(splitReply(reply).segments).toEqual([
      { kind: "bubble", markdown: "核过了。" },
      { kind: "card", markdown: `${INTRO}\n\n${TWO_ITEMS}`, title: "下午有两件事可以留意", summary: expect.stringMatching(/^三点的评审会：会上要定/) },
    ]);
    // 半角冒号一样。
    expect(splitReply(`Two things:\n\n${TWO_ITEMS}`).segments).toMatchObject([{ kind: "card", title: "Two things" }]);
  });
  it("没有冒号引子的长清单成卡，不画标题", () => {
    expect(splitReply(TWO_ITEMS).segments).toEqual([{ kind: "card", markdown: TWO_ITEMS, title: "", summary: expect.stringMatching(/^三点的评审会：会上要定/) }]);
    // 前面的话不以冒号结尾：照旧是自己的气泡，卡没有标题。
    expect(splitReply(`下午还有两件事。\n\n${TWO_ITEMS}`).segments).toEqual([
      { kind: "bubble", markdown: "下午还有两件事。" },
      { kind: "card", markdown: TWO_ITEMS, title: "", summary: expect.stringMatching(/^三点的评审会/) },
    ]);
  });
  it("冒号引子紧跟清单、中间没空行，照样成卡并当标题", () => {
    const reply = `${INTRO}\n${TWO_ITEMS}`;
    expect(splitReply(reply).segments).toEqual([{ kind: "card", markdown: reply, title: "下午有两件事可以留意", summary: expect.stringMatching(/^三点的评审会/) }]);
    // 短清单照旧和引子是一个气泡。
    expect(splitReply("三件事：\n- 改首页\n- 换头像\n- 补测试").segments).toEqual([{ kind: "bubble", markdown: "三件事：\n- 改首页\n- 换头像\n- 补测试" }]);
  });
  it("流式逐字写出：卡画出来后不会再变回气泡", () => {
    for (const reply of [
      `核过了。\n\n${INTRO}\n\n${TWO_ITEMS}\n\n就这些。`,
      `${INTRO}\n${TWO_ITEMS}\n\n就这些。`,
      `下午还有两件事。\n\n${TWO_ITEMS}\n\n就这些。`,
      // 字数刚好卡在 150：写到加粗收尾的「**」时不能先多算一个字成卡、再少算回去变回气泡。
      `- ${"字".repeat(149)}\n- **a**\n\n就这些。`,
      `三件事：\n\n- ${"字".repeat(149)}\n- **a**\n\n就这些。`,
      // 写到下一项的「2」时还看不出是编号：不先算成字成卡、写出「.」再变回气泡。
      `1. ${"字".repeat(150)}\n2. a\n\n就这些。`,
    ]) expectNoCardTurnsBubble(reply);
    // 写完：前三条清单成卡，后两条正好 150 个字，是短清单。
    expect(splitReply(`- ${"字".repeat(149)}\n- **a**`).segments).toMatchObject([{ kind: "bubble" }]);
  });
  it("冒号引子只取最后一句当标题，前面的句子照旧是气泡", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}项`).join("\n");
    const before = "我看了一下你这周的安排，整体没什么冲突，只是评审会挪到了三点。溪南那边也在等你回话。";
    for (const gap of ["\n\n", "\n"]) {
      expect(splitReply(`${before}下面是要留意的：${gap}${six}`).segments).toEqual([
        { kind: "bubble", markdown: before },
        { kind: "card", markdown: `下面是要留意的：${gap}${six}`, title: "下面是要留意的", summary: "第1项" },
      ]);
    }
    // 句号在行尾：前面几行是气泡，最后一行是标题。
    expect(splitReply(`先说一句。\n下面是要留意的：\n\n${six}`).segments).toEqual([
      { kind: "bubble", markdown: "先说一句。" },
      { kind: "card", markdown: `下面是要留意的：\n\n${six}`, title: "下面是要留意的", summary: "第1项" },
    ]);
    expectNoCardTurnsBubble(`${before}下面是要留意的：\n\n${six}\n\n就这些。`);
  });
  it("单独一行的加粗冒号段落后紧跟清单：照旧不拆，逐字流式不出现卡变回气泡", () => {
    const short = "**结论**：\n- 改首页\n- 换头像";
    expectNoCardTurnsBubble(`${short}\n\n就这些。`);
    expectNoCardTurnsBubble(`**结论**：\n${TWO_ITEMS}\n\n就这些。`);
    expect(splitReply(short).segments).toEqual([{ kind: "bubble", markdown: short }]);
    expect(splitReply(`**结论**：\n${TWO_ITEMS}`).segments).toEqual([{ kind: "bubble", markdown: `**结论**：\n${TWO_ITEMS}` }]);
  });
  it("引用块开头的冒号段落不当引子", () => {
    expect(splitReply(`> 下午有两件事可以留意：\n\n${TWO_ITEMS}`).segments).toEqual([
      { kind: "bubble", markdown: "> 下午有两件事可以留意：" },
      { kind: "card", markdown: TWO_ITEMS, title: "", summary: expect.stringMatching(/^三点的评审会/) },
    ]);
    expect(splitReply(`> 下午有两件事可以留意：\n${TWO_ITEMS}`).segments).toEqual([{ kind: "bubble", markdown: `> 下午有两件事可以留意：\n${TWO_ITEMS}` }]);
  });
  it("空的回复", () => {
    expect(splitReply("")).toEqual({ segments: [], tail: null });
    expect(splitReply("  \n")).toEqual({ segments: [], tail: null });
  });
});

/**
 * 按字喂进流式：已经出过的块不变；同一个位置（segments 加上尾巴）出现过气泡，之后（含写完）就不能变成卡。
 * 尾巴第一行还没写完时不算（「*」「**要做」这几个字还看不出是清单、加粗行还是一句话；尾巴开头 2 秒本来就不露）。
 */
function expectNoBubbleTurnsCard(reply: string) {
  const chars = [...reply];
  let previous: ReturnType<typeof splitReply>["segments"] = [];
  const bubbleAt = new Set<number>();
  const check = ({ segments, tail }: ReturnType<typeof splitReply>, step: string) => {
    const kinds = [...segments.map((s) => s.kind), ...(tail?.markdown.includes("\n") ? [tail.kind] : [])];
    kinds.forEach((kind, index) => {
      if (kind === "card") expect(bubbleAt.has(index), `${step}：第 ${index + 1} 块从气泡变成了卡`).toBe(false);
      else bubbleAt.add(index);
    });
  };
  for (let length = 1; length <= chars.length; length++) {
    const result = splitReply(chars.slice(0, length).join(""), true);
    expect(result.segments.slice(0, previous.length), `第 ${length} 个字`).toEqual(previous);
    previous = result.segments;
    check(result, `第 ${length} 个字`);
  }
  const final = splitReply(reply);
  expect(final.segments.slice(0, previous.length)).toEqual(previous);
  check(final, "写完");
}

/**
 * 按字喂进流式：已经出过的块不变；同一个位置（segments 加上尾巴）出现过卡，之后（含写完）就不能变回气泡。
 * 尾巴第一行还没写完时不算，同 expectNoBubbleTurnsCard。
 */
function expectNoCardTurnsBubble(reply: string) {
  const chars = [...reply];
  let previous: ReturnType<typeof splitReply>["segments"] = [];
  const cardAt = new Set<number>();
  const check = ({ segments, tail }: ReturnType<typeof splitReply>, step: string) => {
    const kinds = [...segments.map((s) => s.kind), ...(tail?.markdown.includes("\n") ? [tail.kind] : [])];
    kinds.forEach((kind, index) => {
      if (kind === "bubble") expect(cardAt.has(index), `${JSON.stringify(reply)} ${step}：第 ${index + 1} 块从卡变回了气泡`).toBe(false);
      else cardAt.add(index);
    });
  };
  for (let length = 1; length <= chars.length; length++) {
    const result = splitReply(chars.slice(0, length).join(""), true);
    expect(result.segments.slice(0, previous.length), `第 ${length} 个字`).toEqual(previous);
    previous = result.segments;
    check(result, `第 ${length} 个字`);
  }
  const final = splitReply(reply);
  expect(final.segments.slice(0, previous.length)).toEqual(previous);
  check(final, "写完");
}

/** 清单去掉记号和加粗后的字数。 */
const listChars = (list: string) => [...list.replace(/^- /gm, "").replace(/\*\*|\n/g, "")].length;

/** 本人 11/18 伙伴主线 16:37 那条的形状：冒号引子加两项加粗开头的清单，合计超过 150 个字。 */
const INTRO = "下午有两件事可以留意：";
const TWO_ITEMS = [
  "- **三点的评审会**：会上要定首页改版的方向，你上周提的两个方案都会摆出来对比，建议提前把更倾向的那个和理由写成两三句话，到时候直接说，免得会上临时组织语言耽误大家时间。",
  "- **五点前回复溪南**：她在等你确认月底复盘放在周四下午还是周五上午，你回一句定哪个就行，她那边好去约其他几位负责人，晚了的话可能就要排到下下周去了。",
].join("\n");

/** 本人 11/18 截图里那一轮的原文：Chat 还没接伙伴人设，用单独一行的加粗当小标题。 */
const ANT_ANSWER = `这次没调查成：联网搜索还没配置好（缺少搜索接口的密钥），我查不到 ANT 现在的上市进度、招股时间、定价和认购情况。所以我给不出“这一只适不适合打新”的结论。下面先说清楚有哪几件事会决定答案，等信息拿到了，可以逐项对照。

**先确认 ANT 指的是哪家**

- **蚂蚁集团**：2020 年它在上交所和港交所的同步上市被叫停。之后有没有重新启动、走到哪一步，我现在查不到。重启的话，最可能走港股或 A 股，散户都能参与公开认购。
- **Anthropic**：这是开发我的公司，我和它有利益关联，所以不评价它值不值得买、估值高不高，只能讲一般的打新机制。另外，就算它在美股上市，散户通常只能通过少数券商的新股通道拿到很少的配售，“申购一手”的玩法和港股不太一样。

**判断一只新股适不适合打新，主要看这几项**

1. **在哪里上市、散户怎么参与。** 港股公开认购有回拨机制：超额认购倍数越高，划给散户的份额越多，一手中签的机会也相对好一些。A 股按市值配售加摇号，中签率通常很低。美股散户基本靠券商配售，拿不拿得到要看券商给多少额度。
2. **发行价和同类公司比贵不贵。** 招股书里的估值要和已上市的同类公司比，比如市盈率、市销率。发行价定得太满，是首日破发最常见的原因。
3. **基石投资者和锚定投资者的占比与名单。** 基石认购占比高，而且是长线资金，说明定价有人托底，实际流通的筹码也更少。但基石有锁定期，到期时会有卖压。
4. **认购热度。** 港股的孖展（融资申购）倍数和最终超额认购倍数，是判断首日表现最直接的参考，招股期间每天都有数据。
5. **暗盘表现。** 港股上市前一天的暗盘交易，常被用来决定首日卖不卖。
6. **稳价机制。** 有绿鞋（超额配售权）的新股，上市后头 30 天有稳价人托底，破发风险相对小一些。
7. **市场情绪。** 同期新股首日的表现、恒指或纳指的走势，都会明显影响首日涨跌。

**打新本身要算清的账**

用孖展加大申购，中签概率会高一些，但中不中都要付利息和手续费。热门大盘股超额认购几百倍时，一手中签率可能很低，资金冻结几天的机会成本也要算进去。打新最好定好纪律：中签了按暗盘或首日表现决定卖不卖，不要因为中签就变成被动长期持有。

**接下来可以这样做**

- 招股书或券商的新股资料是 PDF 的话，直接传给我，我按上面几项帮你逐条分析，比如估值、基石名单、发行结构。
- 联网搜索配置好以后，再让我查一次，我把当前进度和认购数据补上。
- 真要下单，以招股书和券商公布的信息为准。上面讲的都是一般机制，不针对这家公司当下的情况，也不构成投资建议。
`;
