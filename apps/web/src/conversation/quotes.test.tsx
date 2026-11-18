import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteChips } from "./QuoteChips";
import { ConversationTurn } from "./Transcript";
import { appendQuote, PAGE_CONTEXT_MARK, quotedMessage, readQuotedMessage, restoreQuotes, type TextQuote } from "./quotes";

const quote: TextQuote = { id: "quote-1", text: "形成可复核的界面与权限证据。\n包括 CEO 与 DRI 的双视角。",
  source: { label: "战役结果", scope: "mission-card:card-01", objectType: "mission-card", objectId: "card-01", missionId: "mission-01", field: "outcome", sourceRound: 2, sourceVersion: 3 } };

describe("独立文字引用", () => {
  it("待发送的引用块直接露出开头一段（换行压成空格，不拼省略号，放不下由样式收起），全文仍在预览里读，保留移除", () => {
    const html = renderToStaticMarkup(<QuoteChips quotes={[quote]} onRemove={() => {}} />);
    expect(html).toContain("形成可复核的界面与权限证据。 包括 CEO 与 DRI 的双视角。");
    expect(html).not.toContain(quote.text);
    expect(html).not.toContain("…");
    expect(html).toContain('aria-label="移除批注"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("查看批注：战役结果");
  });
  it("长短引用都不加省略号；长的只取开头 40 个字；多条引用各露各的内容", () => {
    const html = renderToStaticMarkup(<QuoteChips quotes={[{ id: "a", text: "  先看渠道  " }, { ...quote, id: "b", text: "一二三四五六七八九十".repeat(5) }]} onRemove={() => {}} />);
    expect(html).toContain(">先看渠道<");
    expect(html).not.toContain("…");
    expect(html).toContain(`>${"一二三四五六七八九十".repeat(4)}<`);
    expect(html).toContain('aria-label="移除批注 2"');
  });
  it("对话里某条消息选出的一段叫「回复」，挂的内容叫「批注」", () => {
    const reply: TextQuote = { id: "r", text: "先保灯塔交付", source: { scope: "global", intent: "message-reply" } };
    const html = renderToStaticMarkup(<QuoteChips quotes={[reply]} onRemove={() => {}} />);
    expect(html).toContain("待发送的回复");
    expect(html).toContain("查看回复");
    expect(html).toContain('aria-label="移除回复"');
    expect(html).not.toContain("批注");
    expect(renderToStaticMarkup(<QuoteChips quotes={[reply]} sent />)).toContain("回复");
    expect(renderToStaticMarkup(<QuoteChips quotes={[quote]} sent />)).toContain("批注 · 战役结果");
  });
  it("发送失败放回的引用排在原处，期间新加的留在后面；同一句（同来源）不重复", () => {
    const fresh: TextQuote = { id: "quote-9", text: "新加的一句", source: { scope: "global" } };
    expect(restoreQuotes([fresh], [quote]).map((item) => item.id)).toEqual(["quote-1", "quote-9"]);
    expect(restoreQuotes([{ ...quote, id: "quote-2" }], [quote]).map((item) => item.id)).toEqual(["quote-2"]);
    expect(restoreQuotes([quote], [quote])).toEqual([quote]);
  });
  it("发送时完整保留原选文、对象、字段与版本，不将引文冒充为用户问题", () => {
    const sent = quotedMessage("请把验收证据说具体些", [quote]);
    expect(readQuotedMessage(sent)).toEqual({ message: "请把验收证据说具体些", quotes: [{ ...quote, id: "sent-0" }] });
    expect(sent).toContain('"sourceVersion": 3');
  });
  it("引文包含标记、JSON 和换行时依然无损恢复", () => {
    const tricky = { ...quote, text: '[天枢引用上下文 v1]\n{"quotes":[]}\n</quote>\n"引文"' };
    expect(readQuotedMessage(quotedMessage("对这段聊聊", [tricky])).quotes[0].text).toBe(tricky.text);
  });
  it("没有文字引用的对话不改变原消息格式", () => {
    expect(quotedMessage("请读材料", [])).toBe("请读材料");
    expect(readQuotedMessage("普通消息")).toEqual({ message: "普通消息", quotes: [] });
  });
  it.each(["[天枢引用上下文 v1]\n{", '[天枢引用上下文 v1]\n{"message":"问题","quotes":[]}',
    '[天枢引用上下文 v1]\n{"message":"问题","quotes":[{"text":"内容","source":{"sourceVersion":"3"}}]}'
  ])("损坏或不兼容的历史仍显示原消息全文", (content) => {
    expect(readQuotedMessage(content)).toEqual({ message: content, quotes: [] });
  });
  it("同一句重复引用合并一个块，新一次引用的 id 不会被前一次发送清掉", () => {
    const items = appendQuote([quote], { ...quote, id: "quote-2" });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("quote-2");
    expect(items.filter((item) => item.id !== "quote-1")).toHaveLength(1);
  });
  it("相同文字来自不同字段或新版本时保留独立依据", () => {
    expect(appendQuote([quote], { ...quote, id: "quote-2", source: { ...quote.source, sourceVersion: 4 } })).toHaveLength(2);
  });
  it("历史保留短引用入口，只显示用户自己的正文；助手回答不按引用封装解析", () => {
    const content = quotedMessage("请把验收证据说具体些", [quote]);
    const html = renderToStaticMarkup(<ConversationTurn message={{ sequence: 1, role: "user", content }} />);
    expect(html).toContain("请把验收证据说具体些");
    expect(html).toContain("本条消息的文字批注");
    expect(html).not.toContain("形成可复核");
    expect(html).not.toContain("天枢引用上下文 v1");
    expect(html).not.toContain("移除批注");
    expect(renderToStaticMarkup(<ConversationTurn message={{ sequence: 2, role: "assistant", content }} />)).toContain("天枢引用上下文 v1");
  });
});

describe("页面上下文", () => {
  it("战场页带给 Agent 的上下文不显示在用户气泡里，带引用时引用照常解析；旧场次无标记的上下文也去掉", () => {
    const context = `${PAGE_CONTEXT_MARK}正在讨论战场「商业增长」（B02，战场id=bf-growth）`;
    expect(readQuotedMessage(`${context}

把目标改成 200 万`)).toEqual({ message: "把目标改成 200 万", quotes: [] });
    const quoted = readQuotedMessage(`${context}

${quotedMessage("这句依据是什么", [quote])}`);
    expect(quoted.message).toBe("这句依据是什么");
    expect(quoted.quotes).toHaveLength(1);
    expect(readQuotedMessage(`正在讨论战场「标准交付」（B01，战场id=bf-delivery）

进度如何`).message).toBe("进度如何");
    const plain = `正在讨论的话题

保持原样`;
    expect(readQuotedMessage(plain).message).toBe(plain);
    const html = renderToStaticMarkup(<ConversationTurn message={{ sequence: 1, role: "user", content: `${context}

进度如何` }} />);
    expect(html).not.toContain("战场id=");
  });
});
