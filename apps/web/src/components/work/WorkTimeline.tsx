"use client";

/**
 * 新首页中间的对话时间线（总管线、Task 管线）：「在做什么」和思考摘要不在这里，在页头的状态胶囊（Presence）下面；和 ConversationTimeline 一样画对话（同一套零件，不改它们），另外把网页插入的块
 * （开工的选项框、开了哪几个子会话、验收结果和全部完成）按时间插在对话之间：插在它之前最近的一条消息后面，比第一条消息还早的放在最前；有消息不带时间时放最后。
 * 伙伴的提问卡画成就地答的选项框（AskDecision），不再是「开始回答」弹窗。
 */
import { useMemo, type ReactNode } from "react";
import type { TBuddyPlan } from "@warmap/contracts";
import { ConversationStatusSlot, ConversationThinking, ConversationTurns, LocalTurnRow, STAGE_COPY } from "@/conversation/Transcript";
import { QuickReplyContext } from "@/conversation/AnswerOptionRow";
import { EntryCards } from "@/conversation/EntryCards";
import { PlanChecklist } from "@/components/cards/PlanChecklist";
import { planDoing } from "@/components/cards/ActivityLine";
import type { Step } from "@/components/steps/StepList";
import { AskContext, askAnswers } from "@/conversation/AskPanel";
import { parseAnswerOptions } from "@/conversation/answerOptions";
import { RescopeContext } from "@/conversation/ScopeChip";
import { withoutSupersededCards } from "@/conversation/ConversationTimeline";
import { BubbleContext, RevealContext, TypingBubble, revealTurn } from "@/conversation/ReplyBubbles";
import type { ConversationData, ThinkingStage, TurnProgress } from "@/conversation/useConversation";
import { AskDecision, BuddyQuestionDecision } from "./decisions";

/**
 * 「在做什么」写哪句（页头的状态胶囊，Presence；照 Claude Code 的先后：系统状态 > 正在跑的那一步 > 等着的阶段词）：连不上、等网络 > 在跑的那一步 >
 * 在查什么（工具开始时报的）> 计划里在做的那条 > 阶段词（正在查资料、正在整理回答）；都没有就只有动画和用时，不写笼统的「正在思考」。
 */
export function conversationDoing({ stage, steps, progress, plan }: { stage: ThinkingStage; steps: readonly Step[]; progress?: TurnProgress; plan?: TBuddyPlan | null }): string | null {
  if (stage === "connecting" || stage === "offline") return STAGE_COPY[stage];
  return [...steps].reverse().find((step) => step.status === "active")?.label
    ?? (stage === "researching" ? progress?.label ?? null : null)
    ?? planDoing(plan?.entries)
    ?? STAGE_COPY[stage];
}

/** afterSequence：按消息序号排的块（转交卡）——插在序号不超过它的最后一条后面，null 排最后；不带这个字段的按时间排。 */
export type TimedBlock = { key: string; at: string; node: ReactNode; afterSequence?: number | null };

/**
 * 每个块插在哪条消息后面（-1 是最前面）。按时间排的：时间不早于那条消息、早于下一条；
 * 对话里有消息不带时间（Chat 读回来的历史）就排不了，全放到最后一条后面，块和块之间仍按时间先后（29 条 C）。
 * 按序号排的见 TimedBlock.afterSequence。
 */
export function placeBlocks(messages: { createdAt?: string; sequence: number }[], blocks: TimedBlock[]): Map<number, TimedBlock[]> {
  const untimed = messages.some((message) => !message.createdAt);
  const times = messages.map((message) => Date.parse(message.createdAt ?? ""));
  const placed = new Map<number, TimedBlock[]>();
  // ISO offsets can differ across meeting providers; compare instants, not their text.
  const chronological = blocks.map(block => ({ block, time: Date.parse(block.at) })).sort((a, b) => {
    const aValid = Number.isFinite(a.time), bValid = Number.isFinite(b.time);
    if (aValid && bValid) return a.time - b.time;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return a.block.at.localeCompare(b.block.at);
  });
  for (const { block } of chronological) {
    let index = -1;
    if (block.afterSequence === null || (block.afterSequence === undefined && untimed)) index = messages.length - 1;
    else if (block.afterSequence !== undefined) messages.forEach((message, i) => { if (message.sequence <= block.afterSequence!) index = i; });
    else {
      const at = Date.parse(block.at);
      for (let i = 0; i < times.length; i += 1) if (times[i]! <= at) index = i;
    }
    placed.set(index, [...(placed.get(index) ?? []), block]);
  }
  return placed;
}

/** 伙伴的选项框还能答：卡是 open，而且挂着它的那条回答之后本人没再发过话。 */
export function buddyQuestionOpen(card: { status: string }, messages: readonly { role: string }[], index: number): boolean {
  return card.status === "open" && !messages.slice(index + 1).some((message) => message.role === "user");
}

export function WorkTimeline({ data, blocks, modelRule }: { data: ConversationData; blocks: TimedBlock[]; modelRule?: (label: string) => ReactNode }) {
  const lastIndex = data.messages.length - 1;
  const last = data.messages[lastIndex];
  // 最新一条回答的选项画成它最后一个气泡下面的一排小胶囊，点了直接发出（设计 6.4）。
  const latest = !data.streaming && last?.role === "assistant" ? last.sequence : null;
  const quick = useMemo(() => (latest === null ? null : { sequence: latest, send: (text: string) => void data.send(text, []) }), [latest, data.send]);
  const latestCards = useMemo(() => withoutSupersededCards(data.messages), [data.messages]);
  // 第一次读这条对话、消息还没到：先不插块（含开工小条），不然它们全排在最前、消息到了再被挤下去。
  const unread = data.historyStatus === "loading" && !data.messages.length;
  const placed = useMemo(() => placeBlocks(data.messages, unread ? [] : blocks), [data.messages, blocks, unread]);
  // 新首页的对话：答过的提问卡原处收成一行（inline），不另画本人那条问答记录。
  const ask = useMemo(() => ({ send: data.send, streaming: data.streaming, ...askAnswers(data.messages), inline: true }), [data.send, data.streaming, data.messages]);
  // 回复成气泡（设计 6.1–6.3）；第一个块出来时报给页头（Presence）。
  const reveal = useMemo(() => () => revealTurn(data.scope, data.startedAt), [data.scope, data.startedAt]);
  const status = data.streaming ? (
    <ConversationStatusSlot>
      {/* 一轮开始、还没有任何正文（只写了选项块也算没有）：马上露「•••」；有了正文以后由气泡那边在等下一块时露。 */}
      {parseAnswerOptions(data.partial, true).body.trim() ? null : <TypingBubble />}
      {data.thinking ? <ConversationThinking stage={data.stage} startedAt={data.startedAt} onStop={data.stop} route={data.route} progress={data.progress} steps={data.steps} thought={null} readScope={data.readScope} row={false} /> : null}
      {/* 伙伴这一轮的计划清单和出的卡（17.4，同 ConversationTimeline）：写完读回历史后挂在那条回答上。 */}
      {data.plan ? <PlanChecklist entries={data.plan.entries} collapsed={data.plan.collapsed} /> : null}
      {data.turnCards?.length ? <EntryCards cards={data.turnCards} /> : null}
    </ConversationStatusSlot>
  ) : null;
  const rescope = useMemo(() => ({ rescope: (params: Parameters<typeof data.rescope>[0], label: string) => void data.rescope(params, label), busy: data.streaming }),
    [data.rescope, data.streaming]);
  const blocksAt = (index: number) => (placed.get(index) ?? []).map((block) => <div key={block.key} data-block={block.key}>{block.node}</div>);
  return (
    <BubbleContext.Provider value={true}>
    <RevealContext.Provider value={reveal}>
    <QuickReplyContext.Provider value={quick}>
    <RescopeContext.Provider value={rescope}>
    <AskContext.Provider value={ask}>
    <ConversationTurns messages={data.messages} partial={data.streaming ? data.partial : ""} status={status} modelRule={modelRule}
      insertions={blocksAt} lastReply={data.lastReply}
      trailing={!data.streaming && data.localTurn ? <LocalTurnRow turn={data.localTurn} /> : undefined}
      steps={!data.thinking || data.stage === "answering" ? data.steps : null}
      after={(index) => {
        const cards = latestCards[index] ?? [];
        // 伙伴的提问卡在对话里就地答（选项框），别的卡照旧。
        const asks = cards.filter((card): card is Extract<typeof card, { kind: "questions" }> => card.kind === "questions");
        // 伙伴的选项框（buddy_question）：只画还 open、而且本人之后没再说过话的；答了、发了别的话就收起（云端随后标 answered / dismissed）。
        const buddyAsks = cards.filter((card): card is Extract<typeof card, { kind: "buddy_question" }> => card.kind === "buddy_question")
          .filter((card) => buddyQuestionOpen(card, data.messages, index));
        const rest = cards.filter((card) => card.kind !== "questions" && card.kind !== "buddy_question");
        const plan = data.messages[index].plan;
        if (!rest.length && !asks.length && !buddyAsks.length && !plan) return null;
        return <>{plan ? <PlanChecklist entries={plan.entries} collapsed={plan.collapsed} finished /> : null}{rest.length ? <EntryCards cards={rest} createdAt={data.messages[index].createdAt} /> : null}{asks.map((card) => <AskDecision key={card.askId} card={card} />)}
          {buddyAsks.map((card) => <BuddyQuestionDecision key={card.questionId} card={card} busy={data.streaming} send={(text, questionId) => data.send(text, [], { buddyQuestionId: questionId })} />)}</>;
      }} />
    </AskContext.Provider>
    </RescopeContext.Provider>
    </QuickReplyContext.Provider>
    </RevealContext.Provider>
    </BubbleContext.Provider>
  );
}
