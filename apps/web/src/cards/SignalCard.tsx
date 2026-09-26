"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button, ToggleButton } from "@heroui/react";
import { ArrowUpRight, Bookmark } from "lucide-react";
import { browserApi, type Card } from "@/lib/api/client";
import type { CardRenderProps } from "./registry";
import { payloadOf, type RadarPayload, type SignalPayload } from "./payloads";
import { SignalStory } from "./SignalStory";
import { DetailHeader } from "@/components/shell/DetailHeader";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import w from "@/styles/app-shell.module.css";
import s from "@/styles/radar-feed.module.css";

type SignalState = { read?: boolean; saved?: boolean; dismissed?: boolean };

/** 来源类型标签：与 Radar 监测范围的 SOURCE_LABEL 同一口径。 */
export function signalSourceLabel(type: string): string {
  return type === "wechat-account" ? "微信公众号" : type === "outlet" ? "发布方级媒体来源" : "Web";
}

/** 多条「尚未确定」连成一段：每条自带句号时直接相连，不再补分号（避免「。；」）。 */
export const joinSentences = (items: string[]) => items.map((item) => (/[。！？.!?]$/.test(item.trim()) ? item.trim() : `${item.trim()}。`)).join("");

const signalTime = (card: Card) => {
  const payload = payloadOf<SignalPayload>(card);
  return Date.parse(payload.source.publishedAt || payload.collectedAt) || 0;
};

/**
 * 「继续浏览」的顺序（clark radar-feed upNext）：未隐藏的信号按时间倒序，从当前这条往后排，排到底再回到头上，
 * 所以永远有下一条可看；当前这条不在其中。
 */
export function upNextSignals(current: Card, collection: Card[]): Card[] {
  const sorted = collection
    .filter((card) => card.kind === "signal" && !payloadOf<SignalPayload>(card).state.dismissed)
    .sort((a, b) => signalTime(b) - signalTime(a));
  const at = sorted.findIndex((card) => card.id === current.id);
  const others = sorted.filter((card) => card.id !== current.id);
  if (at < 0) return others;
  return [...sorted.slice(at + 1), ...sorted.slice(0, at)];
}

const published = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE }) : "日期未提供";

/**
 * 信号阅读（clark `radar-feed.tsx` 阅读态）：一个标题，三块内容——总结 / 对我们的影响 / 原文。
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
  // 数据本来就在手上，不一次铺完：看见底了再多铺四条（clark stream）。
  const upNext = useMemo(() => upNextSignals(card, collection), [card, collection]);
  const [stream, setStream] = useState(4);
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = tail.current;
    if (!mark) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setStream((count) => count + 4);
    }, { rootMargin: "420px" });
    observer.observe(mark);
    return () => observer.disconnect();
  }, [stream, upNext.length]);

  const radar = homeCards.find((item) => item.kind === "radar");
  const anchors = radar ? payloadOf<RadarPayload>(radar).anchors : [];
  const anchorTitleOf = (id: string) => anchors.find((item) => item.id === id)?.title;
  const anchor = anchors.find((item) => item.id === payload.assessment.anchorId);
  const paragraphs = payload.source.excerpt.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const images = payload.source.images ?? [];
  const quote = payload.assessment.evidenceQuote;
  const highlighted = (paragraph: string) => Boolean(quote) && paragraph.length >= 20 && (quote.includes(paragraph) || paragraph.includes(quote));

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
      <div className={w.expandedScroll} data-radar-reader-layout="true">
        <div className={s.reader} data-radar-reader>
          <article className={s.article} data-testid="signal-reader" aria-labelledby="signal-title">
            <div className={s.meta}>
              <span>
                {sourceLabel} · {published(payload.source.publishedAt)}
              </span>
              <ToggleButton
                isIconOnly
                size="sm"
                aria-label={state.saved ? "取消收藏" : "收藏信号"}
                isSelected={Boolean(state.saved)}
                onChange={() => void update({ saved: !state.saved })}
                isDisabled={pending}
              >
                <Bookmark size={17} fill={state.saved ? "currentColor" : "none"} aria-hidden="true" />
              </ToggleButton>
            </div>
            <h2 id="signal-title">{payload.source.title}</h2>
            <div className={s.blocks}>
              <section className={s.block}>
                <h3>总结</h3>
                <div className={s.blockBody}>
                  <p className={s.lead}>{payload.assessment.summary}</p>
                  {payload.assessment.unknowns.length ? (
                    <p className={s.note}>
                      <span>尚未确定</span>
                      {joinSentences(payload.assessment.unknowns)}
                    </p>
                  ) : null}
                </div>
              </section>
              <section className={s.block}>
                <h3>对我们的影响</h3>
                <div className={s.blockBody}>
                  <p>{payload.assessment.strategicImpact}</p>
                  {anchor ? (
                    <div className={s.anchor}>
                      <span>战略锚点 · {anchor.title}</span>
                      <p>{anchor.query}</p>
                    </div>
                  ) : null}
                </div>
              </section>
              {payload.source.excerpt ? (
                <section className={s.block} aria-label="原文">
                  <h3>原文</h3>
                  <div className={s.blockBody}>
                    <blockquote className={s.excerpt}>
                      {paragraphs.map((paragraph, index) => (
                        <Fragment key={`${index}:${paragraph.slice(0, 24)}`}>
                          <p data-highlight={highlighted(paragraph) || undefined}>{paragraph}</p>
                          {images
                            .map((image, imageIndex) => ({ image, imageIndex }))
                            .filter(({ image }) => image.after === index || (index === paragraphs.length - 1 && image.after >= index))
                            .map(({ image, imageIndex }) => (
                              <img key={image.src} src={`/api/signals/${card.objectRef.id}/images/${imageIndex}`} alt="原文配图" loading="lazy" />
                            ))}
                        </Fragment>
                      ))}
                    </blockquote>
                    {/* 点进来就是为了读：摘录直接全文显示。原文链接只作查证用，放在出处行末、做成低调的文字链接，不引导跳走。 */}
                    <small className={s.provenance}>
                      {payload.source.fullText ? "发布方原文（自动抓取）" : "检索服务返回的摘录，未宣称阅读全文"} · 共 {payload.source.excerpt.length.toLocaleString()} 字 · 采集于{" "}
                      {new Date(payload.collectedAt).toLocaleString("zh-CN", { timeZone: COMPANY_TIMEZONE })} ·{" "}
                      <a className={s.sourceLink} href={payload.source.url} target="_blank" rel="noopener noreferrer" aria-label={`原文链接：${payload.source.title}`}>
                        原文链接
                        <ArrowUpRight size={12} aria-hidden="true" />
                      </a>
                    </small>
                  </div>
                </section>
              ) : null}
            </div>
            <div className={s.quietRow}>
              <Button
                size="sm"
                variant="tertiary"
                className={s.quiet}
                isDisabled={pending}
                onPress={() => {
                  void (async () => {
                    const hiding = !state.dismissed;
                    if ((await update({ dismissed: hiding })) && hiding) onNavigate("/radar");
                  })();
                }}
              >
                {state.dismissed ? "恢复到阅读列表" : "不再出现在阅读列表"}
              </Button>
              <Button size="sm" variant="tertiary" className={s.quiet} isDisabled={pending} onPress={() => void update({ read: !state.read })}>
                {state.read ? "标记为未读" : "标记为已读"}
              </Button>
            </div>
            {error ? (
              <p className={s.error} role="alert">
                {error}
                <Button size="sm" variant="tertiary" onPress={() => last && void update(last)}>
                  重试
                </Button>
              </p>
            ) : null}
          </article>
          {upNext.length ? (
            <section className={s.upNext} aria-label="继续浏览">
              <h3>继续浏览</h3>
              <div className={s.stories}>
                {upNext.slice(0, stream).map((item) => (
                  <SignalStory key={item.id} card={item} anchorTitle={anchorTitleOf(payloadOf<SignalPayload>(item).assessment.anchorId)} onOpen={onNavigate} />
                ))}
              </div>
              {stream < upNext.length ? (
                <div ref={tail} className={s.more}>
                  <span>还有 {upNext.length - stream} 条</span>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
