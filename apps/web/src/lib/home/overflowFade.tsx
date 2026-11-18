"use client";

import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from "react";

type Box = { scrollHeight: number; clientHeight: number; toggleAttribute: (name: string, force: boolean) => boolean };

/** 内容比限高的那一格高：挂上 data-over，样式只在这时往下渐隐；放得下就摘掉（同 ReplyBubbles 里 TextBubble 的量法）。 */
export function markOverflow(element: Box) {
  element.toggleAttribute("data-over", element.scrollHeight > element.clientHeight + 1);
}

/** 限高的预览（摘要、引用）：挂上以后、尺寸变了、内容变了都量一次。 */
export function useOverflowFade(ref: RefObject<HTMLElement | null>, content: unknown) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    markOverflow(element);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => markOverflow(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, content]);
}

/** 一段限高的预览字：放得下照常，放不下才往下渐隐（列表里一行一个，用不了 hook 的地方用它）。 */
export function FadeText({ as: Tag = "span", children, ...rest }: { as?: "span" | "div" | "p" } & HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  useOverflowFade(ref, children);
  return <Tag ref={ref as never} {...rest}>{children}</Tag>;
}
