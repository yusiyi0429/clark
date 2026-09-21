"use client";

import { useState } from "react";
import { ChevronLeft, ExternalLink } from "lucide-react";
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
        {sourceLabel}
        {publisher ? ` · ${publisher}` : ""} · 采集于 {payload.collectedAt.slice(0, 16).replace("T", " ")}
        {state.read ? " · 已读" : " · 未读"}
        {state.saved ? " · 已收藏" : ""}
        {state.dismissed ? " · 已隐藏" : ""}
      </p>
      <h2 id="signal-title">{payload.assessment.summary}</h2>
      <p className={`${s.lead} ${s.signalLead}`}>{payload.assessment.strategicImpact}</p>

      <blockquote className={s.signalQuote}>
        <p>{payload.assessment.evidenceQuote}</p>
        <footer>
          <a href={payload.source.url} target="_blank" rel="noreferrer noopener">
            {payload.source.title}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
          <span>
            {sourceLabel} · 发布 {payload.source.publishedAt.slice(0, 10)}
          </span>
          {payload.source.excerpt ? <span>已内嵌原文</span> : null}
        </footer>
      </blockquote>

      {/* 只渲染真实抓到的来源文本；抓取失败时如实退回摘要，不编造原文。CEO 2026-09-21：Signal 存完整原文。 */}
      {payload.source.excerpt ? (
        <section className={s.sourceText} aria-label="原文">
          <header>
            <strong>原文</strong>
            <span>
              {publisher ? `${publisher} · ` : ""}
              {payload.source.publishedAt.slice(0, 10)}
            </span>
          </header>
          <p>{payload.source.excerpt}</p>
        </section>
      ) : null}

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
