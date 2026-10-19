import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TConversationCard } from "@warmap/contracts";
import { withPendingTurn, type ConversationData, type Message } from "./useConversation";

/** Agent 的提问：提问卡与「开始回答」；回答过的只剩「已回答」，作答那一句画成问答记录、不露原文。 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ConversationTimeline } from "./ConversationTimeline";
import { answersOf } from "./AskPanel";

const card: Extract<TConversationCard, { kind: "questions" }> = { kind: "questions", askId: "ask-1", questions: [
  { id: "q1", question: "重点放在哪？", options: [{ label: "交付进度", recommended: true }, { label: "客户反馈", detail: "要补访谈记录" }] },
  { id: "q2", question: "计划外的事写不写？", options: [{ label: "写" }, { label: "不写" }] },
  { id: "q3", question: "下个月还做不做？", options: [{ label: "继续" }, { label: "停" }] },
] };
const data = (messages: Message[]) =>
  ({ scope: "global", messages, status: "complete", streaming: false, partial: "", send: vi.fn() }) as unknown as ConversationData;
const asked: Message[] = [
  { sequence: 1, role: "user", content: "帮我过一遍复盘" },
  { sequence: 2, role: "assistant", content: "先定三件事。", cards: [card] },
];

describe("作答", () => {
  it("选的、自己写的、没答的（算跳过）：交给服务端的只有前两种，问答记录三题都有", () => {
    const { input, record } = answersOf(card, { q1: { option: 0 }, q2: { text: "  只写客户相关的 " } });
    expect(input).toEqual({ askId: "ask-1", items: [{ questionId: "q1", option: 0 }, { questionId: "q2", text: "只写客户相关的" }] });
    expect(record.items).toEqual([
      { questionId: "q1", question: "重点放在哪？", kind: "option", answer: "交付进度", recommended: true },
      { questionId: "q2", question: "计划外的事写不写？", kind: "other", answer: "只写客户相关的" },
      { questionId: "q3", question: "下个月还做不做？", kind: "skipped" },
    ]);
  });

  it("刚发出的作答：读回的历史里按提问认出同一句，不重复（原文已被服务端重写）", () => {
    const { record } = answersOf(card, { q1: { option: 0 } });
    const pending: Message = { sequence: 0, role: "user", content: "本地那句", answers: record };
    const loaded: Message[] = [...asked, { sequence: 3, role: "user", content: "（回答你上一轮的提问）…", answers: record }];
    expect(withPendingTurn(loaded, pending)).toBe(loaded);
    expect(withPendingTurn(asked, pending)).toHaveLength(3);
  });
});

describe("对话里的提问卡", () => {
  it("没回答：题目列表和「开始回答」", () => {
    const html = renderToStaticMarkup(<ConversationTimeline data={data(asked)} />);
    expect(html).toContain('data-testid="ask-card"');
    for (const question of card.questions) expect(html).toContain(question.question);
    expect(html).toContain("开始回答");
  });

  it("回答过：卡只剩「已回答」；作答那一句是问答记录，采纳推荐的带「推荐」，跳过的写「跳过」，不显示原文", () => {
    const { record } = answersOf(card, { q1: { option: 0 }, q2: { text: "只写客户相关的" } });
    const html = renderToStaticMarkup(<ConversationTimeline data={data([...asked,
      { sequence: 3, role: "user", content: "（回答你上一轮的提问）原文", answers: record },
      { sequence: 4, role: "assistant", content: "好" }])} />);
    expect(html).not.toContain("开始回答");
    expect(html).toContain("已回答");
    const recordHtml = html.match(/data-testid="ask-record"[\s\S]*?<\/dl>/)?.[0] ?? "";
    expect(recordHtml).toContain("交付进度<span");
    expect(recordHtml).toContain(">推荐<");
    expect(recordHtml).toContain("只写客户相关的");
    expect(recordHtml).toContain('data-kind="skipped">跳过');
    expect(html).not.toContain("（回答你上一轮的提问）");
  });
});
