import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationTurns } from "./Transcript";
import { feishuWaiting, historySignature, type Message } from "./useConversation";

const asked: Message = { sequence: 1, role: "user", content: "这周怎么样", via: "feishu" };
const answered: Message = { sequence: 2, role: "assistant", content: "推进中", via: "feishu" };

describe("子会话回报那句（18.10，via = report）", () => {
  it("不画成本人的气泡；项目主管线还没回时一行「正在看子会话的回报」", () => {
    const prompt: Message = { sequence: 3, role: "user", content: "B 停了", via: "report" };
    const html = renderToStaticMarkup(<ConversationTurns messages={[prompt]} />);
    expect(html).not.toContain("B 停了");
    expect(html).toContain("正在看子会话的回报");
    expect(renderToStaticMarkup(<ConversationTurns messages={[prompt, { sequence: 4, role: "assistant", content: "B 做完了第一轮" }]} />)).not.toContain("正在看");
  });
});

describe("飞书里问的", () => {
  it("提问标「飞书」；还没答完时下面一行「正在回答飞书里的提问」，答完就没有", () => {
    const waiting = renderToStaticMarkup(<ConversationTurns messages={[asked]} />);
    expect(waiting).toContain('data-testid="conversation-via-feishu"');
    expect(waiting).toContain("正在回答飞书里的提问");
    const done = renderToStaticMarkup(<ConversationTurns messages={[asked, answered]} />);
    expect(done).not.toContain("正在回答飞书里的提问");
    expect(done.match(/conversation-via-feishu/g)).toHaveLength(1);
  });

  it("读回的历史有没有变：条数、最后一条和它的来源", () => {
    expect(feishuWaiting([asked])).toBe(true);
    expect(feishuWaiting([asked, answered])).toBe(false);
    expect(historySignature([asked])).not.toBe(historySignature([asked, answered]));
    expect(historySignature([{ ...asked, via: undefined }])).not.toBe(historySignature([asked]));
  });
});
