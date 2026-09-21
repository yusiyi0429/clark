"use client";

import { Fragment, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { CardRenderProps } from "./registry";
import { payloadOf, type SignalPayload } from "./payloads";
import { ConversationDock } from "@/conversation/ConversationDock";
import s from "@/styles/radar-feed.module.css";

type SignalState = { read?: boolean; saved?: boolean; dismissed?: boolean };

/** 来源类型标签：与 Radar 监测范围的 SOURCE_LABEL 同一口径。 */
export function signalSourceLabel(type: string): string {
  return type === "wechat-account" ? "微信公众号" : type === "outlet" ? "发布方级媒体来源" : "Web";
}

/** Signal 阅读器：来源、影响、锚点、原文摘录与独立 read/saved/dismissed 状态。 */
export function SignalCard({ card, collection, onCard, onNavigate }: CardRenderProps) {
  const payload = payloadOf<SignalPayload>(card);
  // 发布方级来源才带真实媒体名（outletName）；Web 搜索没有可核验的发布方，不编造。
  const sourceLabel = signalSourceLabel(payload.source.type);
  const publisher = payload.source.type === "outlet" ? card.badge : null;
  const [state, setState] = useState(payload.state);
  const [pending, setPending] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<SignalState | null>(null);

  async function update(next: SignalState) {
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
      return;
    }
    const updated = data?.cards[0];
    if (response.ok && updated) {
      setState((updated.payload as SignalPayload).state);
      onCard(updated);
      return;
    }
    setError((error as { message?: string } | undefined)?.message ?? "状态更新失败，请重试。");
  }

  return (
    <div className={s.reader}>
    <article className={s.article} data-testid="signal-reader" aria-labelledby="signal-title">
      <button type="button" className={s.back} onClick={() => onNavigate("/radar")}>
        <ChevronLeft size={15} aria-hidden="true" />
        返回 Radar
      </button>
      <p className={s.meta}>
        {sourceLabel}{publisher ? ` · ${publisher}` : ""} · 发布 {payload.source.publishedAt.slice(0, 10)}
      </p>
      <h2 id="signal-title">{card.title}</h2>
      <p className={`${s.lead} ${s.signalLead}`}>{payload.assessment.strategicImpact}</p>
      {payload.assessment.unknowns.length ? (
        <section className={s.clarify}>
          <strong>尚未弄清</strong>
          <ul>
            {payload.assessment.unknowns.map((unknown) => (
              <li key={unknown}>{unknown}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 原文默认折叠：CEO 先看研判，需要时再展开自行核验。 */}
      {payload.source.excerpt ? (() => {
        const paragraphs = payload.source.excerpt.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
        const images = payload.source.images ?? [];
        const quote = payload.assessment.evidenceQuote;
        const highlighted = (paragraph: string) => paragraph.length >= 20 && (quote.includes(paragraph) || paragraph.includes(quote));
        return (
          <section className={s.original} aria-label="原文">
            <div className={s.originalHeader}>
              <button type="button" aria-expanded={originalOpen} onClick={() => setOriginalOpen((open) => !open)}>
                <ChevronRight className={originalOpen ? s.originalChevronOpen : s.originalChevron} size={15} aria-hidden="true" />
                原文 · {payload.source.excerpt.length.toLocaleString()} 字
              </button>
              <a href={payload.source.url} target="_blank" rel="noreferrer noopener" aria-label={`打开原文：${payload.source.title}`}>
                {payload.source.title}
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            </div>
            {originalOpen ? (
              <div className={s.originalBody}>
                {paragraphs.map((paragraph, index) => (
                  <Fragment key={`${index}:${paragraph.slice(0, 24)}`}>
                    <p data-highlight={highlighted(paragraph) || undefined}>{paragraph}</p>
                    {images.map((image, imageIndex) => ({ image, imageIndex }))
                      .filter(({ image }) => image.after === index || (index === paragraphs.length - 1 && image.after >= index))
                      .map(({ image, imageIndex }) => (
                        <img key={image.src} className={s.originalImage} src={`/api/signals/${card.objectRef.id}/images/${imageIndex}`} alt="原文配图" loading="lazy" />
                      ))}
                  </Fragment>
                ))}
              </div>
            ) : null}
          </section>
        );
      })() : null}

      <div className={s.signalStates}>
        <button type="button" data-state={state.read ? "read" : "unread"} disabled={pending} onClick={() => void update({ read: !state.read })}>
          {state.read ? "标记未读" : "标记已读"}
        </button>
        <button type="button" disabled={pending} onClick={() => void update({ saved: !state.saved })}>
          {state.saved ? "取消收藏" : "收藏"}
        </button>
        <button type="button" disabled={pending} onClick={() => void update({ dismissed: !state.dismissed })}>
          {state.dismissed ? "取消隐藏" : "隐藏"}
        </button>
      </div>
      {error ? (
        <p className={s.error} role="alert">
          {error}
          <button type="button" onClick={() => last && void update(last)}>
            重试
          </button>
        </p>
      ) : null}
    </article>
    <ConversationDock
      scope={card.conversation?.scope ?? `signal:${card.objectRef.id}`}
      label={card.title}
      availableCards={collection}
      variant="sidebar"
      sidebar={{ title: "对话 · 本条信号", tone: "light", open: true, placeholder: "问天枢：本条信号…" }}
    />
    </div>
  );
}
