import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { REMARK_PLUGINS } from "./markdown";
import { ConversationTurn } from "@/conversation/Transcript";

const render = (text: string) => renderToStaticMarkup(<ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>);

describe("共享 remark 插件：中日韩加粗", () => {
  it.each([
    ["是**《标准验收清单》**，因为", "<strong>《标准验收清单》</strong>"],
    ["**10 月 11 日**前", "<strong>10 月 11 日</strong>"],
    ["结论：**不签**。", "<strong>不签</strong>"],
    ["**ARR 153 万**元", "<strong>ARR 153 万</strong>"],
    ["最大风险是**《标准验收清单》未在 10 月 11 日前定为合同附件**，因为……", "<strong>《标准验收清单》未在 10 月 11 日前定为合同附件</strong>"],
  ])("%s 渲染为 <strong>", (text, strong) => {
    const html = render(text);
    expect(html).toContain(strong);
    expect(html).not.toContain("**");
  });

  it("中文删除线也能识别", () => {
    expect(render("放弃~~《旧方案》~~改用新方案")).toContain("<del>《旧方案》</del>");
  });

  it("英文 Markdown、列表、表格、代码不受影响", () => {
    expect(render("This is **bold** and *em* and ~~gone~~.")).toBe("<p>This is <strong>bold</strong> and <em>em</em> and <del>gone</del>.</p>");
    expect(render("- one\n- **two**\n\n1. first")).toBe("<ul>\n<li>one</li>\n<li><strong>two</strong></li>\n</ul>\n<ol>\n<li>first</li>\n</ol>");
    const table = render("| 项 | 值 |\n| --- | --- |\n| **ARR** | 153 万 |");
    expect(table).toContain("<table>");
    expect(table).toContain("<td><strong>ARR</strong></td>");
    expect(render("用 `a**b**c` 和\n\n```ts\nconst x = **1**;\n```")).toContain("<code>a**b**c</code>");
    expect(render("```ts\nconst x = **1**;\n```")).toContain("const x = **1**;");
    expect(render("snake_case_word and 2*3*4")).toBe("<p>snake_case_word and 2<em>3</em>4</p>");
  });
});

describe("对话正文用共享插件", () => {
  it("回复完成后中文加粗不再原样显示 **", () => {
    const html = renderToStaticMarkup(<ConversationTurn message={{ sequence: 2, role: "assistant", content: "最大风险是**《标准验收清单》未在 10 月 11 日前定为合同附件**，因为……" }} ms={9000} />);
    expect(html).toContain("<strong>《标准验收清单》未在 10 月 11 日前定为合同附件</strong>");
    expect(html).not.toContain("**");
  });

  it("流式中 remend 补齐的未闭合中文加粗也是 <strong>", () => {
    const html = renderToStaticMarkup(<ConversationTurn message={{ sequence: -1, role: "assistant", content: "最大风险是**《标准验收清单》未在" }} streaming />);
    expect(html).toMatch(/<strong>.*《标准验收清单》未在.*<\/strong>/);
    expect(html).not.toContain("**");
  });

  it("流式中闭合在全角标点前的中文加粗也是 <strong>", () => {
    const html = renderToStaticMarkup(<ConversationTurn message={{ sequence: -1, role: "assistant", content: "结论：**不签**。理由是" }} streaming />);
    expect(html).toMatch(/<strong>.*不签.*<\/strong>/);
    expect(html).not.toContain("**");
  });
});
