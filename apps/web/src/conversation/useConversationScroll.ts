"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createScrollController, type ScrollAnchor, type ScrollController } from "./scrollController";

/**
 * 对话区的滚动（B1），全局对话层与二级页右列共用，行为对齐 Claude 网页版 / ChatGPT（细节见 scrollController）：
 * - 打开时落在底部并跟随；用户往上滚就停，不再拉回；不在真实末尾时调用方画 ↓（`atBottom` 为假）；
 * - 发送（回答开始）时把刚发的那条短促地推到顶部，下面留出空白，回答进行中视图不动、不跟随；
 *   回答超过一屏时出 ↓，点 ↓ 跳到最新并跟随到这轮结束；回答结束、下一次发送时留白缩到刚好够用；
 * - 换频道（`resetKey`）回到底部；`anchor="reply"`（从首页气泡打开）停在最后一条回答的开头，不跟随。
 * 调用方在滚动区里、内容（contentRef）之后放一个空的 `<div ref={reserveRef} aria-hidden />` 当留白。
 * 系统要求减少动态效果时，所有程序滚动都是瞬时的。
 */
export type { ScrollAnchor };

type ElementRef = ((element: HTMLDivElement | null) => void) & { current: HTMLDivElement | null };

function elementRef(attach: (element: HTMLDivElement | null) => void): ElementRef {
  const ref = ((element: HTMLDivElement | null) => {
    ref.current = element;
    attach(element);
  }) as ElementRef;
  ref.current = null;
  return ref;
}

export function useConversationScroll({ streaming, resetKey, anchor = "end" }: { streaming: boolean; resetKey?: string; anchor?: ScrollAnchor }) {
  const [atBottom, setAtBottom] = useState(true);
  const controllerRef = useRef<ScrollController | null>(null);
  controllerRef.current ??= createScrollController({ anchor, onAtBottom: setAtBottom });
  const controller = controllerRef.current;
  const refs = useRef<{ scrollRef: ElementRef; contentRef: ElementRef; reserveRef: ElementRef } | null>(null);
  refs.current ??= {
    scrollRef: elementRef((element) => controller.attachScroller(element)),
    contentRef: elementRef((element) => controller.attachContent(element)),
    reserveRef: elementRef((element) => controller.attachReserve(element)),
  };

  // 回答开始的那一刻置顶一次（刚发的那条与 streaming 同一次提交进来）；进行中的重绘、乐观消息被服务端版本替换都不再触发。
  // 回答结束：留白缩到刚好够用。用 layout effect，在浏览器画出新消息之前就定好位置。
  const wasStreaming = useRef(streaming);
  useLayoutEffect(() => {
    if (streaming && !wasStreaming.current) controller.send();
    else if (!streaming && wasStreaming.current) controller.streamEnd();
    wasStreaming.current = streaming;
  }, [streaming, controller]);

  // 换频道等整块换内容：直接落到底部。
  const lastReset = useRef(resetKey);
  useLayoutEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    controller.reset();
  }, [resetKey, controller]);

  // 从气泡打开：定位到最后一条回答的开头。只在打开时做一次。
  useLayoutEffect(() => {
    if (anchor === "reply") controller.anchorReply();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时定位一次
  }, []);

  useEffect(() => () => controller.stop(), [controller]);

  const jumpToLatest = useCallback(() => controller.jump(), [controller]);
  /** 把对话里的某一块（「待确认 N」对应的提案卡）滚到顶部留白之下。 */
  const reveal = useCallback((element: HTMLElement) => controller.reveal(element), [controller]);

  return { ...refs.current, atBottom, jumpToLatest, reveal };
}
