import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteChips } from "./QuoteChips";
import { ConversationTurn } from "./Transcript";
import { appendQuote, quotedMessage, readQuotedMessage, type TextQuote } from "./quotes";

const quote: TextQuote = { id: "quote-1", text: "形成可复核的界面与权限证据。\n包括 CEO 与 DRI 的双视角。",
  source: { label: "战役结果", scope: "mission-card:card-01", objectType: "mission-card", objectId: "card-01", missionId: "mission-01", field: "outcome", sourceRound: 2, sourceVersion: 3 } };

describe("独立文字引用", () => {
  it("输入引用块只显示短标签，完整句子在预览中读取", () => {
    const html = renderToStaticMarkup(<QuoteChips quotes={[quote]} onRemove={() => {}} />);
    expect(html).toContain("引用 · 战役结果");
    expect(html).toContain('aria-label="移除引用"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(quote.text);
    expect(html).not.toContain("形成可复核");
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
    expect(html).toContain("本条消息的文字引用");
    expect(html).not.toContain("形成可复核");
    expect(html).not.toContain("天枢引用上下文 v1");
    expect(html).not.toContain("移除引用");
    expect(renderToStaticMarkup(<ConversationTurn message={{ sequence: 2, role: "assistant", content }} />)).toContain("天枢引用上下文 v1");
  });
});
