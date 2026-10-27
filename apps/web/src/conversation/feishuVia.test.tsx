import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationTurns } from "./Transcript";
import { feishuWaiting, historySignature, type Message } from "./useConversation";

const asked: Message = { sequence: 1, role: "user", content: "这周怎么样", via: "feishu" };
const answered: Message = { sequence: 2, role: "assistant", content: "推进中", via: "feishu" };

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
