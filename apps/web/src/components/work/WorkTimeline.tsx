"use client";

/**
 * 新首页中间的对话时间线（总管线、Task 管线）：和 ConversationTimeline 一样画对话（同一套零件，不改它们），另外把网页插入的块
 * （开工的选项框、开了哪几个子会话、验收结果和全部完成）按时间插在对话之间：插在它之前最近的一条消息后面，比第一条消息还早的放在最前。
 * 伙伴的提问卡画成就地答的选项框（AskDecision），不再是「开始回答」弹窗。
 */
import { useMemo, type ReactNode } from "react";
import { ConversationStatusSlot, ConversationThinking, ConversationTurns } from "@/conversation/Transcript";
import { AnswerOptions } from "@/conversation/AnswerOptionRow";
import { EntryCards } from "@/conversation/EntryCards";
import { PlanChecklist } from "@/components/cards/PlanChecklist";
import { AskContext, askAnswers } from "@/conversation/AskPanel";
import { parseAnswerOptions } from "@/conversation/answerOptions";
import { RescopeContext } from "@/conversation/ScopeChip";
import { withoutSupersededCards } from "@/conversation/ConversationTimeline";
import type { ConversationData } from "@/conversation/useConversation";
import { AskDecision, BuddyQuestionDecision } from "./decisions";

export type TimedBlock = { key: string; at: string; node: ReactNode };

/** 每个块插在哪条消息后面（-1 是最前面）：时间不早于那条消息、早于下一条。没有时间的消息当作现在。 */
export function placeBlocks(messageTimes: (string | undefined)[], blocks: TimedBlock[]): Map<number, TimedBlock[]> {
  const now = Date.now();
  const times = messageTimes.map((at) => (at ? Date.parse(at) : now));
  const placed = new Map<number, TimedBlock[]>();
  for (const block of [...blocks].sort((a, b) => a.at.localeCompare(b.at))) {
    const at = Date.parse(block.at);
    let index = -1;
    for (let i = 0; i < times.length; i += 1) if (times[i]! <= at) index = i;
    placed.set(index, [...(placed.get(index) ?? []), block]);
  }
  return placed;
}

/** 伙伴的选项框还能答：卡是 open，而且挂着它的那条回答之后本人没再发过话。 */
export function buddyQuestionOpen(card: { status: string }, messages: readonly { role: string }[], index: number): boolean {
  return card.status === "open" && !messages.slice(index + 1).some((message) => message.role === "user");
}

export function WorkTimeline({ data, blocks }: { data: ConversationData; blocks: TimedBlock[] }) {
  const lastIndex = data.messages.length - 1;
  const last = data.messages[lastIndex];
  const options = !data.streaming && last?.role === "assistant" ? parseAnswerOptions(last.content).options : [];
  const latestCards = useMemo(() => withoutSupersededCards(data.messages), [data.messages]);
  const placed = useMemo(() => placeBlocks(data.messages.map((message) => message.createdAt), blocks), [data.messages, blocks]);
  // 新首页的对话：答过的提问卡原处收成一行（inline），不另画本人那条问答记录。
  const ask = useMemo(() => ({ send: data.send, streaming: data.streaming, ...askAnswers(data.messages), inline: true }), [data.send, data.streaming, data.messages]);
  const status = data.streaming ? (
    <ConversationStatusSlot>
      {data.thinking ? <ConversationThinking stage={data.stage} startedAt={data.startedAt} onStop={data.stop} route={data.route} progress={data.progress} steps={data.steps} thought={data.thought} readScope={data.readScope} /> : null}
      {/* 伙伴这一轮的计划清单和出的卡（17.4，同 ConversationTimeline）：写完读回历史后挂在那条回答上。 */}
      {data.plan ? <PlanChecklist entries={data.plan.entries} collapsed={data.plan.collapsed} /> : null}
      {data.turnCards?.length ? <EntryCards cards={data.turnCards} /> : null}
    </ConversationStatusSlot>
  ) : null;
  const rescope = useMemo(() => ({ rescope: (params: Parameters<typeof data.rescope>[0], label: string) => void data.rescope(params, label), busy: data.streaming }),
    [data.rescope, data.streaming]);
  const blocksAt = (index: number) => (placed.get(index) ?? []).map((block) => <div key={block.key} data-block={block.key}>{block.node}</div>);
  return (
    <RescopeContext.Provider value={rescope}>
    <AskContext.Provider value={ask}>
    {blocksAt(-1)}
    <ConversationTurns messages={data.messages} partial={data.streaming ? data.partial : ""} status={status}
      thought={data.thought?.seconds != null ? { text: data.thought.text, seconds: data.thought.seconds } : null}
      steps={!data.thinking || data.stage === "answering" ? data.steps : null}
      footer={(index) => (index === lastIndex && options.length ? <AnswerOptions scope={data.scope} options={options} /> : null)}
      after={(index) => {
        const cards = latestCards[index] ?? [];
        // 伙伴的提问卡在对话里就地答（选项框），别的卡照旧。
        const asks = cards.filter((card): card is Extract<typeof card, { kind: "questions" }> => card.kind === "questions");
        // 伙伴的选项框（buddy_question）：只画还 open、而且本人之后没再说过话的；答了、发了别的话就收起（云端随后标 answered / dismissed）。
        const buddyAsks = cards.filter((card): card is Extract<typeof card, { kind: "buddy_question" }> => card.kind === "buddy_question")
          .filter((card) => buddyQuestionOpen(card, data.messages, index));
        const rest = cards.filter((card) => card.kind !== "questions" && card.kind !== "buddy_question");
        const inserted = blocksAt(index);
        const plan = data.messages[index].plan;
        if (!rest.length && !asks.length && !buddyAsks.length && !inserted.length && !plan) return null;
        return <>{plan ? <PlanChecklist entries={plan.entries} collapsed={plan.collapsed} /> : null}{rest.length ? <EntryCards cards={rest} createdAt={data.messages[index].createdAt} /> : null}{asks.map((card) => <AskDecision key={card.askId} card={card} />)}
          {buddyAsks.map((card) => <BuddyQuestionDecision key={card.questionId} card={card} busy={data.streaming} send={(text, questionId) => data.send(text, [], { buddyQuestionId: questionId })} />)}{inserted}</>;
      }} />
    </AskContext.Provider>
    </RescopeContext.Provider>
  );
}
