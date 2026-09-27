"use client";

import { useEffect, useRef, useState } from "react";
import type { Card } from "@/lib/api/client";
import { HeroButton } from "@/components/HeroButton";
import { publishedDate } from "@/lib/companyTime";
import { payloadOf, type SignalPayload } from "./payloads";
import f from "@/styles/radar-feed.module.css";

/**
 * 一条信号卡片（clark radar-feed `story`）的纯展示层：公司雷达、个人雷达、列表与阅读页底部的「继续浏览」共用同一个，
 * 往下刷时读前读后是同一种东西。有配图时第一张图做封面（加载失败就收起，退回纯文字卡，不留空位）。
 * 封面下面依次是标题、摘要、一行来源信息（meta），右侧是阅读状态。
 */
export function SignalStoryView({
  href,
  imageSrc,
  title,
  summary,
  meta,
  status,
  onOpen,
}: {
  href: string;
  imageSrc?: string;
  title: string;
  summary: string;
  meta: string;
  status: string;
  onOpen: (href: string, origin?: Element | null) => void;
}) {
  const [image, setImage] = useState<"loading" | "ready" | "failed">("loading");
  const showImage = Boolean(imageSrc) && image !== "failed";
  const cover = useRef<HTMLImageElement>(null);
  // 服务端渲染的封面可能在页面脚本接管前就已加载完（缓存命中时很常见），onLoad 不会再触发：接管时补查一次。
  useEffect(() => {
    const node = cover.current;
    if (node?.complete) setImage(node.naturalWidth > 0 ? "ready" : "failed");
  }, []);
  return (
    <div className={f.storyWrapper}>
      <HeroButton
        variant="ghost"
        size="sm"
        className={f.story}
        data-origin={href}
        data-has-image={showImage || undefined}
        onPress={(event) => onOpen(href, event.target as Element)}
      >
        {showImage ? (
          <span className={f.storyCover} data-state={image} aria-hidden="true">
            <img
              ref={cover}
              src={imageSrc}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onLoad={() => setImage("ready")}
              onError={() => setImage("failed")}
            />
          </span>
        ) : null}
        <div className={f.storyText}>
          <h2>{title}</h2>
          <p>{summary}</p>
        </div>
        <div className={f.meta}>
          <span>{meta}</span>
          <span>{status}</span>
        </div>
      </HeroButton>
    </div>
  );
}

/** 公司雷达的信号卡：配图经 API 代理加载，来源一行写媒体 · 日期 · 战略锚点。 */
export function SignalStory({
  card,
  anchorTitle,
  onOpen,
}: {
  card: Card;
  anchorTitle?: string;
  onOpen: (href: string, origin?: Element | null) => void;
}) {
  const payload = payloadOf<SignalPayload>(card);
  const id = card.objectRef.id;
  return (
    <SignalStoryView
      href={`/radar/signals/${id}`}
      imageSrc={payload.source.images?.length ? `/api/signals/${id}/images/0` : undefined}
      title={payload.source.title}
      summary={payload.assessment.summary}
      meta={`${card.badge ?? "Web"} · ${publishedDate(payload.source.publishedAt)} · ${anchorTitle ?? "公司监测"}`}
      status={payload.state.saved ? "已收藏" : payload.state.read ? "已读" : "新信号"}
      onOpen={onOpen}
    />
  );
}
