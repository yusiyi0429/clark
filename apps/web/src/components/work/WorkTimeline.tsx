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
import { AskContext } from "@/conversation/AskPanel";
import { parseAnswerOptions } from "@/conversation/answerOptions";
import { RescopeContext } from "@/conversation/ScopeChip";
import { withoutSupersededCards } from "@/conversation/ConversationTimeline";
import type { ConversationData } from "@/conversation/useConversation";
import { AskDecision } from "./decisions";

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

export function WorkTimeline({ data, blocks }: { data: ConversationData; blocks: TimedBlock[] }) {
  const lastIndex = data.messages.length - 1;
  const last = data.messages[lastIndex];
  const options = !data.streaming && last?.role === "assistant" ? parseAnswerOptions(last.content).options : [];
  const latestCards = useMemo(() => withoutSupersededCards(data.messages), [data.messages]);
  const placed = useMemo(() => placeBlocks(data.messages.map((message) => message.createdAt), blocks), [data.messages, blocks]);
  const ask = useMemo(() => ({ send: data.send, streaming: data.streaming,
    answered: new Set(data.messages.flatMap((message) => (message.answers ? [message.answers.askId] : []))) }), [data.send, data.streaming, data.messages]);
  const status = data.streaming ? (
    <ConversationStatusSlot>
      {data.thinking ? <ConversationThinking stage={data.stage} startedAt={data.startedAt} onStop={data.stop} route={data.route} progress={data.progress} steps={data.steps} thought={data.thought} readScope={data.readScope} /> : null}
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
        const rest = cards.filter((card) => card.kind !== "questions");
        const inserted = blocksAt(index);
        if (!cards.length && !inserted.length) return null;
        return <>{rest.length ? <EntryCards cards={rest} createdAt={data.messages[index].createdAt} /> : null}{asks.map((card) => <AskDecision key={card.askId} card={card} />)}{inserted}</>;
      }} />
    </AskContext.Provider>
    </RescopeContext.Provider>
  );
}
