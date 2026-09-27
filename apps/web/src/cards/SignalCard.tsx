"use client";

import { useMemo, useState } from "react";
import { browserApi, type Card } from "@/lib/api/client";
import type { CardRenderProps } from "./registry";
import { payloadOf, type RadarPayload, type SignalPayload } from "./payloads";
import { SignalStory } from "./SignalStory";
import { SignalArticle, type SignalState } from "./SignalArticle";
import { DetailHeader } from "@/components/shell/DetailHeader";
import { useWorkspace } from "@/components/shell/WorkspaceContext";

export { joinSentences } from "./SignalArticle";

/** 来源类型标签：与 Radar 监测范围的 SOURCE_LABEL 同一口径。 */
export function signalSourceLabel(type: string): string {
  return type === "wechat-account" ? "微信公众号" : type === "outlet" ? "发布方级媒体来源" : "Web";
}

const signalTime = (card: Card) => {
  const payload = payloadOf<SignalPayload>(card);
  return Date.parse(payload.source.publishedAt || payload.collectedAt) || 0;
};

/** 「继续浏览」怎么认一条信号：公司信号是 Card，个人信号是自己的投影，排序逻辑只有一份。 */
export type SignalOrder<T> = { id: (item: T) => string; time: (item: T) => number; visible: (item: T) => boolean };

const CARD_ORDER: SignalOrder<Card> = {
  id: (card) => card.id,
  time: signalTime,
  visible: (card) => card.kind === "signal" && !payloadOf<SignalPayload>(card).state.dismissed,
};

/**
 * 「继续浏览」的顺序（clark radar-feed upNext）：未隐藏的信号按时间倒序，从当前这条往后排，排到底再回到头上，
 * 所以永远有下一条可看；当前这条不在其中。
 */
export function upNextSignals(current: Card, collection: Card[]): Card[];
export function upNextSignals<T>(current: T, collection: T[], order: SignalOrder<T>): T[];
export function upNextSignals<T>(current: T, collection: T[], order?: SignalOrder<T>): T[] {
  const by = order ?? (CARD_ORDER as unknown as SignalOrder<T>);
  const sorted = collection.filter(by.visible).sort((a, b) => by.time(b) - by.time(a));
  const at = sorted.findIndex((item) => by.id(item) === by.id(current));
  const others = sorted.filter((item) => by.id(item) !== by.id(current));
  if (at < 0) return others;
  return [...sorted.slice(at + 1), ...sorted.slice(0, at)];
}

/**
 * 公司信号阅读：一个标题，三块内容——总结 / 对我们的影响 / 原文。
 * 战略锚点读首页已载入的雷达卡；已读/未读是天枢的手动切换（打开不自动标记）。
 */
export function SignalCard({ card, collection, onCard, onNavigate }: CardRenderProps) {
  const payload = payloadOf<SignalPayload>(card);
  const { homeCards } = useWorkspace();
  // 发布方级来源才带真实媒体名（outletName）；Web 搜索没有可核验的发布方，不编造。
  const sourceLabel = payload.source.type === "outlet" && card.badge ? card.badge : signalSourceLabel(payload.source.type);
  const [state, setState] = useState(payload.state);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<SignalState | null>(null);
  const upNext = useMemo(() => upNextSignals(card, collection), [card, collection]);

  const radar = homeCards.find((item) => item.kind === "radar");
  const anchors = radar ? payloadOf<RadarPayload>(radar).anchors : [];
  const anchorTitleOf = (id: string) => anchors.find((item) => item.id === id)?.title;
  const anchor = anchors.find((item) => item.id === payload.assessment.anchorId);

  async function update(next: SignalState): Promise<boolean> {
    setLast(next);
    setPending(true);
    setError(null);
    const { data, error, response } = await browserApi.PATCH("/api/signals/{id}/state", {
      params: { path: { id: card.objectRef.id } },
      body: next,
    });
    setPending(false);
    if (response.status === 401) {
      onNavigate("/access");
      return false;
    }
    const updated = data?.cards[0];
    if (response.ok && updated) {
      setState((updated.payload as SignalPayload).state);
      onCard(updated);
      return true;
    }
    setError((error as { message?: string } | undefined)?.message ?? "状态更新失败，请重试。");
    return false;
  }

  return (
    <>
      <DetailHeader
        mark="signal"
        eyebrow="信号详情 · 雷达"
        back={{ label: "返回信号列表", onPress: () => onNavigate("/radar") }}
        closeLabel="关闭雷达"
        onClose={() => onNavigate("/")}
      />
      <SignalArticle
        reading={{
          title: payload.source.title,
          sourceLabel,
          publishedAt: payload.source.publishedAt,
          summary: payload.assessment.summary,
          unknowns: payload.assessment.unknowns,
          relation: {
            heading: "对我们的影响",
            text: payload.assessment.strategicImpact,
            tag: anchor ? { label: `战略锚点 · ${anchor.title}`, detail: anchor.query } : undefined,
          },
          excerpt: payload.source.excerpt,
          images: (payload.source.images ?? []).map((image, index) => ({ src: `/api/signals/${card.objectRef.id}/images/${index}`, after: image.after })),
          evidenceQuote: payload.assessment.evidenceQuote,
          fullText: Boolean(payload.source.fullText),
          collectedAt: payload.collectedAt,
          url: payload.source.url,
        }}
        state={state}
        pending={pending}
        error={error}
        onUpdate={update}
        onRetry={() => {
          if (last) void update(last);
        }}
        onHidden={() => onNavigate("/radar")}
        upNext={upNext.map((item) => (
          <SignalStory key={item.id} card={item} anchorTitle={anchorTitleOf(payloadOf<SignalPayload>(item).assessment.anchorId)} onOpen={onNavigate} />
        ))}
      />
    </>
  );
}
