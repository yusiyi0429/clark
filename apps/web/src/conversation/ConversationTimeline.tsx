"use client";

import { useMemo } from "react";
import { ConversationStatusSlot, ConversationThinking, ConversationTurns } from "./Transcript";
import { AnswerOptions } from "./AnswerOptionRow";
import { EntryCards } from "./EntryCards";
import { parseAnswerOptions } from "./answerOptions";
import { RescopeContext } from "./ScopeChip";
import type { ConversationData, Message } from "./useConversation";

/** 同一份请求草稿、同一份复盘只在最近的那张卡上操作：后面的回答又出了它的卡（如按回答重写），前面那张不再显示。 */
export function withoutSupersededCards(messages: Message[]): (Message["cards"] | undefined)[] {
  const seen = new Set<string>();
  // 帮我问问的卡每张是一次单独的提问，都留着。
  const keyOf = (card: NonNullable<Message["cards"]>[number]) => card.kind === "review" ? `review:${card.personalReviewId}`
    : card.kind === "request_draft" ? `request:${card.requestId}` : null;
  return [...messages].reverse().map((message) => {
    if (message.role !== "assistant" || !message.cards?.length) return undefined;
    const kept = message.cards.filter((card) => {
      const key = keyOf(card);
      if (key === null) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return kept;
  }).reverse();
}

/**
 * 对话时间线（全局对话层与二级页右列共用）。
 *
 * 进行中这一轮的呈现顺序（所有档位都按这一条）：
 *   提问 → 开场说明 → 思考与进度 → 正文（就在思考原来的位置往下写）。
 * 思考与进度（状态区）紧贴在正在写的那条下面；正文第一个字出现时思考收起，正文接着从同一处往下长，视线不用跳。
 */
export function ConversationTimeline({ data }: { data: ConversationData }) {
  // 回答末尾的选项只挂在最新一条回答下；发出下一条（最后一条变成提问）或回答进行中都不显示。
  const lastIndex = data.messages.length - 1;
  const last = data.messages[lastIndex];
  const options = !data.streaming && last?.role === "assistant" ? parseAnswerOptions(last.content).options : [];
  const latestCards = useMemo(() => withoutSupersededCards(data.messages), [data.messages]);
  // 状态区：回答进行中一直占着位置。
  const status = data.streaming ? (
    <ConversationStatusSlot>
      {data.thinking ? <ConversationThinking stage={data.stage} startedAt={data.startedAt} onStop={data.stop} route={data.route} progress={data.progress} steps={data.steps} thought={data.thought} readScope={data.readScope} /> : null}
    </ConversationStatusSlot>
  ) : null;
  // 范围标签改范围后按新范围重读：回答进行中不能点。
  const rescope = useMemo(() => ({ rescope: (params: Parameters<typeof data.rescope>[0], label: string) => void data.rescope(params, label), busy: data.streaming }),
    [data.rescope, data.streaming]);
  return (
    <RescopeContext.Provider value={rescope}>
    <ConversationTurns messages={data.messages} partial={data.streaming ? data.partial : ""} status={status}
      thought={data.thought?.seconds != null ? { text: data.thought.text, seconds: data.thought.seconds } : null}
      steps={!data.thinking || data.stage === "answering" ? data.steps : null}
      footer={(index) => (index === lastIndex && options.length ? <AnswerOptions scope={data.scope} options={options} /> : null)}
      after={(index) => {
        const cards = latestCards[index];
        return cards?.length ? <EntryCards cards={cards} createdAt={data.messages[index].createdAt} /> : null;
      }} />
    </RescopeContext.Provider>
  );
}
