"use client";

import { useEffect, useRef, useState } from "react";
import type { Card } from "@/lib/api/client";
import { HeroButton } from "@/components/HeroButton";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import { payloadOf, type SignalPayload } from "./payloads";
import f from "@/styles/radar-feed.module.css";

const published = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE }) : "日期未提供";

/**
 * 一条信号卡片（clark radar-feed `story`）：列表与阅读页底部的「继续浏览」共用同一个，往下刷时读前读后是同一种东西。
 * 原文抓到了配图时，第一张图做卡片顶部的大封面（经 API 代理加载；加载失败就收起，退回纯文字卡，不留空位）。
 * 封面下面依次是标题、摘要、一行来源信息（来源 · 日期 · 锚点，右侧是阅读状态）。
 */
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
  const href = `/radar/signals/${card.objectRef.id}`;
  const hasImage = (payload.source.images?.length ?? 0) > 0;
  const [image, setImage] = useState<"loading" | "ready" | "failed">("loading");
  const showImage = hasImage && image !== "failed";
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
              src={`/api/signals/${card.objectRef.id}/images/0`}
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
          <h2>{payload.source.title}</h2>
          <p>{payload.assessment.summary}</p>
        </div>
        <div className={f.meta}>
          <span>
            {card.badge ?? "Web"} · {published(payload.source.publishedAt)} · {anchorTitle ?? "公司监测"}
          </span>
          <span>{payload.state.saved ? "已收藏" : payload.state.read ? "已读" : "新信号"}</span>
        </div>
      </HeroButton>
    </div>
  );
}
