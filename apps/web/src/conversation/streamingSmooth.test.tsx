import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import type { ReactElement } from "react";
import { createArrivalLog, rehypeArrival } from "./arrival";
import { ConversationTurn, ConversationTurns, sameTurn } from "./Transcript";
import type { Message } from "./useConversation";

/**
 * B2 流式更顺：未闭合 Markdown 容错、按到达批次分段淡入、流式那条与最终消息同一节点、历史消息 memo。
 * 没有 jsdom：按到达批次分段靠同一份记录连续渲染两次来验；节点是否复用看 React 元素的 key。
 */
const md = (text: string, log = createArrivalLog()) =>
  renderToStaticMarkup(<ReactMarkdown rehypePlugins={[rehypeArrival(log)]}>{text}</ReactMarkdown>);

describe("按到达批次分段（柔和输出）", () => {
  it("新到的几个字单独成一段，先到的段原样保留，段落之间的空白不包成 span", () => {
    const log = createArrivalLog();
    const first = md("先说结论", log);
    expect(first).toBe('<p><span data-arrival="">先说结论</span></p>');
    const second = md("先说结论：保灯塔", log);
    expect(second).toBe('<p><span data-arrival="">先说结论</span><span data-arrival="">：保灯塔</span></p>');
    const list = md("先说结论：保灯塔\n\n1. 回款\n2. 人手", log);
    expect(list).toMatch(/^<p><span data-arrival="">先说结论<\/span><span data-arrival="">：保灯塔<\/span><\/p>/);
    // ol 里只能放 li：块之间的换行不包。
    expect(list).not.toMatch(/<ol>\s*<span/);
    expect(list).toContain('<li><span data-arrival="">回款</span></li>');
  });
});

describe("流式中的未闭合 Markdown", () => {
  it("未闭合的加粗、行内代码先按闭合画，不在 ** 与粗体之间来回跳", () => {
    const html = renderToStaticMarkup(<ConversationTurn message={{ sequence: -1, role: "assistant", content: "本月先保 **灯塔交" }} streaming />);
    expect(html).toMatch(/<strong>[\s\S]*灯塔交[\s\S]*<\/strong>/);
    expect(html).not.toContain("**");
  });

  it("没写完的链接只显示文字，不出现可点的空链接", () => {
    const html = renderToStaticMarkup(<ConversationTurn message={{ sequence: -1, role: "assistant", content: "详见 [交付排期](https://exam" }} streaming />);
    expect(html).toContain("交付排期");
    expect(html).not.toMatch(/<a[\s>]/);
  });

  it("流式那条预留「用时」一行的位置，结束后写上用时也不把正文往下推", () => {
    const streaming = renderToStaticMarkup(<ConversationTurn message={{ sequence: -1, role: "assistant", content: "先说结论" }} streaming />);
    expect(streaming).toMatch(/data-meta-placeholder="true"/);
    const done = renderToStaticMarkup(<ConversationTurn message={{ sequence: 2, role: "assistant", content: "先说结论" }} ms={9000} />);
    expect(done).toContain("用时 9 秒");
  });
});

describe("流式那条与最终消息是同一个节点", () => {
  const keys = (element: ReactElement) => {
    const children = (element.props as { children: unknown[] }).children.flat().filter(Boolean) as ReactElement[];
    return children.map((child) => child.key);
  };

  it("完成后最终回答沿用流式那条的 key，前面的消息 key 不变", () => {
    const question: Message = { sequence: 1, role: "user", content: "本月交付力量先给谁？" };
    const during = keys(ConversationTurns({ messages: [question], partial: "先说结论" }) as ReactElement);
    const after = keys(ConversationTurns({ messages: [{ ...question, sequence: 7 }, { sequence: 8, role: "assistant", content: "先说结论：保灯塔。" }] }) as ReactElement);
    expect(after).toEqual(during);
  });

  it("已完成的历史消息 memo：内容相同的新对象不重画，内容变了才重画", () => {
    expect((ConversationTurn as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
    const message: Message = { sequence: 2, role: "assistant", content: "先说结论", createdAt: "2026-10-10T10:00:00Z" };
    expect(sameTurn({ message, ms: 9000 }, { message: { ...message }, ms: 9000 })).toBe(true);
    expect(sameTurn({ message, ms: 9000 }, { message: { ...message, content: "先说结论：保灯塔" }, ms: 9000 })).toBe(false);
    expect(sameTurn({ message }, { message, streaming: true })).toBe(false);
  });
});
