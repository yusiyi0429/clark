"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ToggleButton } from "@heroui/react";
import { ArrowUpRight, Bookmark } from "lucide-react";
import { COMPANY_TIMEZONE, publishedDate } from "@/lib/companyTime";
import w from "@/styles/app-shell.module.css";
import s from "@/styles/radar-feed.module.css";

export type SignalState = { read?: boolean; saved?: boolean; dismissed?: boolean };

/** 阅读页要显示的一条信号：公司信号与个人信号各自映射成它，正文排版只有一份。 */
export type SignalReading = {
  title: string;
  sourceLabel: string;
  publishedAt?: string | null;
  /** 取代「来源 · 发布日期」里的日期（榜单条目写「上榜于…」，没有发布日期）。 */
  dateText?: string;
  summary: string;
  /** 尚未确定的事；个人信号没有。 */
  unknowns: string[];
  /** 第二块：公司是「对我们的影响」+ 战略锚点；个人是「和你的方向」+ 你的方向。 */
  relation: { heading: string; text: string; tag?: { label: string; detail?: string } };
  excerpt: string;
  /** 已换成可直接加载的地址（公司信号经 API 代理）；个人信号没有配图。 */
  images: { src: string; after: number }[];
  evidenceQuote: string;
  fullText: boolean;
  /** 原文出处的说明；不传时按 fullText 写「发布方原文」或「检索服务返回的摘录」。 */
  excerptNote?: string;
  collectedAt: string;
  url: string;
};

/** 标题下的头图：图没加载出来（防盗链、原站下线）就整块收起，不留空框。 */
function SignalHero({ src }: { src: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const node = useRef<HTMLImageElement>(null);
  // 服务端渲染的图可能在脚本接管前就已加载完（或已失败），onLoad/onError 不会再触发：接管时补查一次。
  useEffect(() => {
    const image = node.current;
    if (image?.complete) setState(image.naturalWidth > 0 ? "ready" : "failed");
  }, []);
  if (state === "failed") return null;
  return (
    <figure className={s.hero} data-state={state}>
      <img
        ref={node}
        src={src}
        alt="原文配图"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
      />
    </figure>
  );
}

/** 原文里的配图：加载失败就不显示，不留破图标。 */
function InlineImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt="原文配图" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

/** 多条「尚未确定」连成一段：每条自带句号时直接相连，不再补分号（避免「。；」）。 */
export const joinSentences = (items: string[]) => items.map((item) => (/[。！？.!?]$/.test(item.trim()) ? item.trim() : `${item.trim()}。`)).join("");

/**
 * 信号阅读：读起来像头条 / 公众号文章——来源行、标题、两行简报（总结 · 和我们的关系），然后直接是正文和配图，底下是「继续浏览」。
 * 已读/未读是手动切换（打开不自动标记）；隐藏成功后由 onHidden 决定去向（不传就留在原地，可以当场恢复）。
 */
export function SignalArticle({
  reading,
  state,
  pending,
  error,
  onUpdate,
  onRetry,
  onHidden,
  upNext,
}: {
  reading: SignalReading;
  state: SignalState;
  pending: boolean;
  error: string | null;
  onUpdate: (next: SignalState) => Promise<boolean>;
  onRetry: () => void;
  onHidden?: () => void;
  /** 「继续浏览」的信号卡，已按顺序排好。 */
  upNext: ReactNode[];
}) {
  // 数据本来就在手上，不一次铺完：看见底了再多铺四条（clark stream）。
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

  const paragraphs = reading.excerpt.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  // 首图放到标题下（像公众号文章的头图），原文里就不再重复这一张。
  const [hero, ...inline] = reading.images;
  const quote = reading.evidenceQuote;
  const highlighted = (paragraph: string) => Boolean(quote) && paragraph.length >= 20 && (quote.includes(paragraph) || paragraph.includes(quote));

  return (
    <div className={w.expandedScroll} data-radar-reader-layout="true">
      <div className={s.reader} data-radar-reader>
        <article className={s.article} data-testid="signal-reader" aria-labelledby="signal-title">
          <div className={s.meta}>
            <span>
              {reading.sourceLabel} · {reading.dateText ?? publishedDate(reading.publishedAt)}
            </span>
            <ToggleButton
              isIconOnly
              size="sm"
              aria-label={state.saved ? "取消收藏" : "收藏信号"}
              isSelected={Boolean(state.saved)}
              onChange={() => void onUpdate({ saved: !state.saved })}
              isDisabled={pending}
            >
              <Bookmark size={17} fill={state.saved ? "currentColor" : "none"} aria-hidden="true" />
            </ToggleButton>
          </div>
          <h2 id="signal-title">{reading.title}</h2>
          {/* 打开先看一眼「讲了什么、和我们什么关系」，两三行就够；下面直接是正文，像读头条 / 公众号文章。 */}
          <div className={s.brief}>
            <p>
              <span className={s.briefLabel}>总结</span>
              {reading.summary}
              {reading.unknowns.length ? <span className={s.briefNote}>尚未确定：{joinSentences(reading.unknowns)}</span> : null}
            </p>
            <p>
              <span className={s.briefLabel}>{reading.relation.heading}</span>
              {reading.relation.text}
              {reading.relation.tag ? (
                <span className={s.briefTag} title={reading.relation.tag.detail}>{reading.relation.tag.label}</span>
              ) : null}
            </p>
          </div>
          {reading.excerpt || hero ? (
            <section className={s.body} aria-label="原文">
              {hero ? <SignalHero key={hero.src} src={hero.src} /> : null}
              {paragraphs.map((paragraph, index) => (
                <Fragment key={`${index}:${paragraph.slice(0, 24)}`}>
                  <p data-highlight={highlighted(paragraph) || undefined}>{paragraph}</p>
                  {inline
                    .filter((image) => image.after === index || (index === paragraphs.length - 1 && image.after >= index))
                    .map((image) => (
                      <InlineImage key={image.src} src={image.src} />
                    ))}
                </Fragment>
              ))}
              {reading.excerpt && !reading.fullText && !reading.excerptNote ? (
                <p className={s.partial}>
                  仅摘要 ·
                  <a href={reading.url} target="_blank" rel="noopener noreferrer">去原网页读全文</a>
                </p>
              ) : null}
              {/* 原文链接只作查证用，放在出处行末、做成低调的文字链接，不引导跳走。 */}
              <small className={s.provenance}>
                {reading.excerptNote ?? (reading.fullText ? "发布方原文（自动抓取）" : "原文摘录")} · 共 {reading.excerpt.length.toLocaleString()} 字 · 采集于{" "}
                {new Date(reading.collectedAt).toLocaleString("zh-CN", { timeZone: COMPANY_TIMEZONE })} ·{" "}
                <a className={s.sourceLink} href={reading.url} target="_blank" rel="noopener noreferrer" aria-label={`原文链接：${reading.title}`}>
                  原文链接
                  <ArrowUpRight size={12} aria-hidden="true" />
                </a>
              </small>
            </section>
          ) : null}
          <div className={s.quietRow}>
            <Button
              size="sm"
              variant="tertiary"
              className={s.quiet}
              isDisabled={pending}
              onPress={() => {
                void (async () => {
                  const hiding = !state.dismissed;
                  if ((await onUpdate({ dismissed: hiding })) && hiding) onHidden?.();
                })();
              }}
            >
              {state.dismissed ? "恢复到阅读列表" : "不再出现在阅读列表"}
            </Button>
            <Button size="sm" variant="tertiary" className={s.quiet} isDisabled={pending} onPress={() => void onUpdate({ read: !state.read })}>
              {state.read ? "标记为未读" : "标记为已读"}
            </Button>
          </div>
          {state.dismissed ? (
            <p className={s.hiddenNote} role="status">
              已隐藏
            </p>
          ) : null}
          {error ? (
            <p className={s.error} role="alert">
              {error}
              <Button size="sm" variant="tertiary" onPress={onRetry}>
                重试
              </Button>
            </p>
          ) : null}
        </article>
        {upNext.length ? (
          <section className={s.upNext} aria-label="继续浏览">
            <h3>继续浏览</h3>
            <div className={s.stories}>{upNext.slice(0, stream)}</div>
            {stream < upNext.length ? (
              <div ref={tail} className={s.more}>
                <span>还有 {upNext.length - stream} 条</span>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
