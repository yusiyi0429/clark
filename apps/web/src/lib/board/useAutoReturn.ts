"use client";

/**
 * 验收没过的改法经网页送到执行方（V2 设计第 7.5 节）：网页开在跑这张卡的那台电脑上（本机有这张卡的会话），
 * 看到「验收未过」而且改法还没送到（returnedAt 为空），就自动对本机会话说一句（会话退了本机会 --resume 接上），
 * 送到以后告诉云端（.../returned）。不用本人点。同一次交回只送一次（跨页面也只一次）。
 */
import { useEffect } from "react";
import type { LocalRunner, TLocalSessionSummary } from "@/lib/local/runner";
import { markReturned } from "./cloud";
import type { CardItem } from "./cards";

const sent = new Set<string>();
/** 测试用：清掉「已送过」的记录。 */
export const resetAutoReturn = () => sent.clear();

export function returnsToSend(items: CardItem[], sessions: TLocalSessionSummary[]): { item: CardItem; handbackId: string; text: string; sessionId: string }[] {
  return items.flatMap((item) => {
    const handback = item.card?.handback;
    if (item.card?.wait !== "review_failed" || !handback?.returnText || handback.returnedAt || sent.has(handback.id)) return [];
    const session = sessions.find((entry) => entry.subject.kind === "card" && entry.subject.cardId === item.id);
    return session ? [{ item, handbackId: handback.id, text: handback.returnText, sessionId: session.id }] : [];
  });
}

export async function sendReturns(runner: LocalRunner, items: CardItem[], sessions: TLocalSessionSummary[], onSent?: () => void): Promise<number> {
  let count = 0;
  for (const job of returnsToSend(items, sessions)) {
    sent.add(job.handbackId);
    try {
      await runner.sendMessage(job.sessionId, job.text);
      await markReturned(job.item.id, job.handbackId).catch(() => undefined);
      count++;
    } catch {
      // 本机没接住：下次再送。
      sent.delete(job.handbackId);
    }
  }
  if (count) onSent?.();
  return count;
}

export function useAutoReturn(runner: LocalRunner, ready: boolean, items: CardItem[], sessions: TLocalSessionSummary[], onSent?: () => void) {
  const key = items.map((item) => `${item.id}:${item.card?.handback?.id ?? ""}:${item.card?.wait ?? ""}:${item.card?.handback?.returnedAt ?? ""}`).join("|");
  const sessionKey = sessions.map((session) => `${session.id}:${session.subject.cardId ?? ""}`).join("|");
  useEffect(() => {
    if (!ready) return;
    void sendReturns(runner, items, sessions, onSent);
    // 只在卡的标记或本机会话变了时看一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner, ready, key, sessionKey]);
}
