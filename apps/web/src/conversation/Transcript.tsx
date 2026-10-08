"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Paperclip, Quote } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import type { Message, ThinkingStage } from "./useConversation";
import { QuoteChips } from "./QuoteChips";
import { readQuotedMessage } from "./quotes";
import s from "@/styles/conversation-transcript.module.css";
import c from "@/styles/card-references.module.css";

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} 秒`;

/** 助手这一轮的实际用时：与前一条用户消息的创建时间差（历史里没有单独记录）。 */
function turnMs(messages: Message[], index: number): number | undefined {
  const reply = messages[index];
  const question = [...messages.slice(0, index)].reverse().find((message) => message.role === "user");
  if (!reply?.createdAt || !question?.createdAt) return undefined;
  const ms = Date.parse(reply.createdAt) - Date.parse(question.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** 一条消息（clark `ConversationTurn`）：不显示角色名，读屏读「你 / 天枢」。 */
export function ConversationTurn({ message, ms }: { message: Message; ms?: number }) {
  const user = message.role === "user";
  const attachments = message.attachments ?? [];
  const quoted = user ? readQuotedMessage(message.content) : { message: message.content, quotes: [] };
  return (
    <article className={user ? s.user : s.assistant} data-chat-role={message.role} aria-label={user ? "你" : "天枢"}>
      {!user && ms !== undefined ? (
        <div className={s.meta}>
          <span title="本轮处理的实际用时，包含模型生成、检索与服务等待">用时 {seconds(ms)}</span>
        </div>
      ) : null}
      {user && message.referencesSnapshot?.length ? (
        <details className={c.sentReferences}>
          <summary>
            <Quote size={12} />
            引用了 {message.referencesSnapshot.length} 张卡片
          </summary>
          {message.referencesSnapshot.map((reference) => (
            <details key={reference.cardId}>
              <summary>{reference.title}</summary>
              <small>v{reference.version} · 发送时快照</small>
            </details>
          ))}
        </details>
      ) : null}
      {user && attachments.length ? (
        <details className={c.sentReferences}>
          <summary>
            <Paperclip size={12} />
            附了 {attachments.length} 份材料
          </summary>
          {attachments.map((attachment) => (
            <small key={attachment.id}>{attachment.fileName}</small>
          ))}
        </details>
      ) : null}
      {quoted.quotes.length ? <QuoteChips quotes={quoted.quotes} sent /> : null}
      <div className={s.prose}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{quoted.message}</ReactMarkdown>
      </div>
    </article>
  );
}

export function ConversationTurns({ messages }: { messages: Message[] }) {
  return (
    <>
      {messages.map((message, index) => (
        <ConversationTurn key={`${message.sequence}-${message.role}`} message={message} ms={message.role === "assistant" ? turnMs(messages, index) : undefined} />
      ))}
    </>
  );
}

export const STAGE_COPY: Record<ThinkingStage, string> = { thinking: "正在思考", researching: "正在快速查证", answering: "正在整理回答" };

/** 回答进行中的一行（clark `ConversationThinking`）：脉冲点、阶段、秒数、停止。 */
export function ConversationThinking({ stage, startedAt, onStop }: { stage: ThinkingStage; startedAt: number; onStop: () => void }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const update = () => setElapsed(Date.now() - startedAt);
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <div className={s.thinking} data-testid="conversation-thinking">
      <span className={s.pulse} aria-hidden />
      <span role="status">{STAGE_COPY[stage]}</span>
      <span className={s.elapsed}>{seconds(elapsed)}</span>
      <HeroButton variant="ghost" size="sm" onPress={onStop} aria-label="停止本次回答">
        停止
      </HeroButton>
    </div>
  );
}

/** 本地产生、没有进入历史的失败或停止说明，按一条助手消息的样式显示。 */
export function ConversationNotice({ text }: { text: string }) {
  return (
    <article className={s.assistant} data-chat-role="assistant" aria-label="天枢">
      <div className={s.prose}>
        <p>{text}</p>
      </div>
    </article>
  );
}
