"use client";

/**
 * 对话层收着时，伙伴有没有没看过的新话（回答写完了，或者它主动来了一句）：右下角那颗「对话…」据此带一圈淡淡的流光，打开对话层就消。
 * 只看最后一句伙伴的话；飞书、微信里说的（本人在那边已经看过）和留痕行不算。
 */

import { useEffect, useState } from "react";
import type { ConversationData, Message } from "./useConversation";

/** 最后一句伙伴的话：哪一轮、写到多长。没有就是 null。 */
export function lastReplyKey(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.via || message.kind) continue;
    return `${message.sequence}:${message.content.length}`;
  }
  return null;
}

/** undefined：历史还没读好，还没记下看过哪一句。 */
export type ReplySeen = string | null | undefined;
type ReplyState = { open: boolean; streaming: boolean; ready: boolean };

/** 看过的那一句：历史读好时先记下当时最后一句（打开页面不算新话）；之后只有对话层开着、回答写完时才更新。 */
export function seenAfter(seen: ReplySeen, key: string | null, { open, streaming, ready }: ReplyState): ReplySeen {
  return ready && !streaming && (seen === undefined || open) ? key : seen;
}

export function hasUnseenReply(seen: ReplySeen, key: string | null, { open, streaming, ready }: ReplyState): boolean {
  return !open && ready && !streaming && seen !== undefined && key !== seen;
}

export function useUnseenReply({ messages, streaming, historyStatus }: Pick<ConversationData, "messages" | "streaming" | "historyStatus">, open: boolean): boolean {
  const key = lastReplyKey(messages);
  const state = { open, streaming, ready: historyStatus === "ready" };
  const [seen, setSeen] = useState<ReplySeen>(undefined);
  const next = seenAfter(seen, key, state);
  useEffect(() => { if (next !== seen) setSeen(next); }, [next, seen]);
  return hasUnseenReply(seen, key, state);
}
