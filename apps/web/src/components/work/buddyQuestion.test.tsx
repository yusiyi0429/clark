import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TConversationCard } from "@warmap/contracts";
import type { ConversationData } from "@/conversation/useConversation";
import { BuddyQuestionDecision, buddyAnswerText } from "./decisions";
import { WorkTimeline, buddyQuestionOpen } from "./WorkTimeline";

type Card = Extract<TConversationCard, { kind: "buddy_question" }>;
const deploy = { header: "部署方式", question: "这次怎么发？", options: [
  { label: "只发预发", detail: "先在预发看一天", recommended: true }, { label: "直接上生产", detail: "今晚就发" }] };
const when = { header: "时间", question: "哪天发？", multiSelect: true, options: [{ label: "周四", detail: "白天" }, { label: "周五", detail: "下班前" }] };
const card = (patch: Partial<Card> = {}): Card => ({ kind: "buddy_question", questionId: "00000000-0000-4000-8000-0000000000b1", questions: [deploy], status: "open", ...patch });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("伙伴的选项框（18.9 buddy_question）", () => {
  it("推荐的排第一、标「推荐」，最后固定一行「自己填」", () => {
    const html = renderToStaticMarkup(<BuddyQuestionDecision card={card()} busy={false} send={vi.fn()} />);
    expect(html).toContain('data-testid="buddy-question"');
    expect(text(html)).toMatch(/这次怎么发？.*只发预发.*推荐.*先在预发看一天.*直接上生产.*今晚就发/);
    expect(html).toMatch(/<textarea[^>]*placeholder="自己填…"/);
  });

  it("选了拼成本人的一句话：「题头：选的（推荐）」，多选用「、」连，自己填照原话，几题用「；」连", () => {
    expect(buddyAnswerText(card(), [{ options: [0] }])).toBe("部署方式：只发预发（推荐）");
    expect(buddyAnswerText(card({ questions: [deploy, when] }), [{ options: [1] }, { options: [0, 1] }])).toBe("部署方式：直接上生产；时间：周四、周五");
    expect(buddyAnswerText(card({ questions: [deploy, when] }), [{ text: "先问问晨星" }, { options: [1], note: "最好上午" }])).toBe("部署方式：先问问晨星；时间：周五、最好上午");
  });

  it("只有 open、而且挂着它的回答之后本人没再说过话的才画；本人发了别的话、答过、收起的都不画", () => {
    const messages = [{ role: "user" }, { role: "assistant" }];
    expect(buddyQuestionOpen(card(), messages, 1)).toBe(true);
    expect(buddyQuestionOpen(card(), [...messages, { role: "user" }], 1)).toBe(false);
    expect(buddyQuestionOpen(card({ status: "answered" }), messages, 1)).toBe(false);
    expect(buddyQuestionOpen(card({ status: "dismissed" }), messages, 1)).toBe(false);
  });

  it("对话时间线里跟着出它的那一轮画：open 的画成框，本人之后发了话就不画", () => {
    const data = (extra: object[] = []) => ({
      scope: "global", streaming: false, thinking: false, partial: "", messages: [
        { sequence: 1, role: "user", content: "要不要今晚发？" },
        { sequence: 2, role: "assistant", content: "先定一下怎么发。", cards: [card()] },
        ...extra,
      ], send: vi.fn(), rescope: vi.fn(), steps: [], stage: "answering",
    }) as unknown as ConversationData;
    expect(renderToStaticMarkup(<WorkTimeline data={data()} blocks={[]} />)).toContain('data-testid="buddy-question"');
    expect(renderToStaticMarkup(<WorkTimeline data={data([{ sequence: 3, role: "user", content: "先聊别的" }])} blocks={[]} />)).not.toContain('data-testid="buddy-question"');
  });
});
