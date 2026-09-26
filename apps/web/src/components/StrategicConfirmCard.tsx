"use client";

/**
 * CEO 通知栏最上面「需要你确认」：会后抽取判定为战略议题的那几条（kind = strategic、还没处理）。CEO 默认不接收会后的任何
 * 东西，只有这一种会推到这里。一个标题加一两句话把事情说全，不必点进去；「确认」交给 Co-Agent 更新本体，「不同意」不更新，
 * 并告诉主持人。按钮就是会议卡片上那条条目的签名动作（meeting.confirm_item / meeting.dismiss_item）。
 */

import { useCallback, useRef } from "react";
import { browserApi, type Card, type CardAction } from "@/lib/api/client";
import { interpretActionResponse } from "@/lib/actionResponse";
import { payloadOf, type MeetingPayload } from "@/cards/payloads";
import { ActionNoticeCard, type ActionNotice } from "./ActionNoticeCard";
import type { NoticeOutcome } from "./NoticeActions";

type StrategicItem = NonNullable<MeetingPayload["outcome"]>["items"][number];

/** 首页 Card 里还等 CEO 表态的战略议题，连同它所在的会议卡片和两颗动作。 */
export function pendingStrategicItems(cards: Card[]): { card: Card; item: StrategicItem; confirm?: CardAction; dismiss?: CardAction }[] {
  return cards.flatMap((card) => {
    if (card.kind !== "meeting") return [];
    const outcome = payloadOf<MeetingPayload>(card).outcome;
    return (outcome?.items ?? [])
      .filter((item) => item.kind === "strategic" && item.review?.status === "pending")
      .map((item) => ({
        card,
        item,
        confirm: card.actions.find((action) => action.actionType === "meeting.confirm_item" && action.itemId === item.id),
        dismiss: card.actions.find((action) => action.actionType === "meeting.dismiss_item" && action.itemId === item.id),
      }));
  });
}

export function StrategicConfirmCard({ cards, onCard, onNavigate }: { cards: Card[]; onCard: (card: Card) => void; onNavigate: (href: string, from?: Element | null) => void }) {
  // 办成之后先在卡上写回执，淡出之后才把新 Card 交出去 —— 否则这一条立刻从列表里消失，回执也跟着没了。
  const settledCards = useRef(new Map<string, Card>());

  const execute = useCallback(async (noticeId: string, action: CardAction | undefined, settled: string): Promise<NoticeOutcome> => {
    if (!action) return { ok: false, error: "这一条现在不能在这里处理，点开会议看看。" };
    const { data, error, response } = await browserApi.POST("/api/actions/execute", { body: { actionId: action.actionId, input: {} } });
    const outcome = interpretActionResponse(response.status, data as { cards?: Card[] } | undefined, error);
    if (outcome.kind === "unauthorized") {
      window.location.assign("/access");
      return { ok: false, error: "登录已过期，请重新进入。" };
    }
    if (outcome.kind === "ok") {
      settledCards.current.set(noticeId, outcome.card);
      return { ok: true, settled };
    }
    if (outcome.kind === "conflict" && outcome.latestCard) onCard(outcome.latestCard);
    return { ok: false, error: outcome.message };
  }, [onCard]);

  const onSettled = useCallback(
    (noticeId: string) => {
      const card = settledCards.current.get(noticeId);
      settledCards.current.delete(noticeId);
      if (card) onCard(card);
    },
    [onCard],
  );

  const notices: ActionNotice[] = pendingStrategicItems(cards).map(({ card, item, confirm, dismiss }) => {
    const id = `${card.id}:${item.id}`;
    return {
      id,
      title: item.title ?? item.text,
      detail: [item.brief, `来自会议「${card.title}」`].filter(Boolean).join(" · "),
      tone: "amber",
      onOpen: (from) => onNavigate(`/meetings/${card.objectRef.id}`, from),
      buttons: [
        { label: "确认", emphasis: true, run: () => execute(id, confirm, "已确认，交给 Co-Agent 更新本体") },
        { label: "不同意", run: () => execute(id, dismiss, "已记下不同意，已告诉主持人") },
      ],
    };
  });

  return <ActionNoticeCard id="strategic" title="需要你确认" subtitle="会议里的战略议题" mark="meeting" notices={notices} onSettled={onSettled} />;
}
