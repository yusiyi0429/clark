import { describe, expect, it, vi } from "vitest";
import type { Message } from "./useConversation";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { withoutSupersededCards } from "./ConversationTimeline";

const reply = (sequence: number, cards: Message["cards"]): Message => ({ sequence, role: "assistant", content: "好", cards });
const draft = (requestId: string) => ({ kind: "request_draft" as const, requestId, href: `/me/requests/${requestId}` });
const ask = (requestId: string) => ({ kind: "todo_ask" as const, requestId, question: "截图怎么放", href: `/me/requests/${requestId}` });

describe("回答后面的卡", () => {
  it("同一份请求草稿按回答重写后只留最新那张；帮我问问的卡每次提问都留着", () => {
    const messages: Message[] = [
      { sequence: 1, role: "user", content: "让人豪补周报" }, reply(2, [draft("r1")]),
      { sequence: 3, role: "user", content: "问问巨杰" }, reply(4, [ask("t1")]),
      { sequence: 5, role: "user", content: "直接更新原表" }, reply(6, [draft("r1")]),
      { sequence: 7, role: "user", content: "再问问巨杰" }, reply(8, [ask("t1")]),
    ];
    expect(withoutSupersededCards(messages)).toEqual([undefined, [], undefined, [ask("t1")], undefined, [draft("r1")], undefined, [ask("t1")]]);
  });

  it("同一份周复盘再生成后只在最新那张卡上操作", () => {
    const weekly = { kind: "weekly_review" as const, weeklyReviewId: "w1", href: "/me/weekly-reviews/w1" };
    const messages: Message[] = [{ sequence: 1, role: "user", content: "帮我写这周复盘" }, reply(2, [weekly]),
      { sequence: 3, role: "user", content: "再生成一次" }, reply(4, [weekly])];
    expect(withoutSupersededCards(messages)).toEqual([undefined, [], undefined, [weekly]]);
  });
});
