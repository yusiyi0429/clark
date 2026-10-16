/**
 * 深度讨论展开 / 收起时，左侧材料的阅读位置不跳：切换前记下视口顶上（页头之下）那一段，宽度过渡期间每一帧把它放回原来的偏移。
 * 左侧滚动的是 DetailFrame 的 `.ts-detail`（议题、会议、任务……），或者老页面的 `.expandedScroll`（战场、Mission……）。
 * 用户在这期间自己滚了（滚轮、触摸、按键、按下指针）就放手。
 */
import { readingTopInset } from "@/components/meeting/readingScroll";

/** 记位置时按这些块找「视口顶上那一段」：取最深的一块。 */
export const READING_BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,tr,blockquote,pre,figure,dt,dd,summary,[data-reading-anchor]";

export type ReadingAnchor = { scroller: HTMLElement; element: HTMLElement; offset: number };

type Box = { top: number; bottom: number; height: number };
const boxOf = (element: Element): Box => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height };
};

/** 左侧材料区里真正在滚的那一个（按 selectors 的文档顺序，第一个能滚的）。 */
export function materialScroller(panel: ParentNode | null | undefined, selectors: readonly string[]): HTMLElement | null {
  if (!panel || !selectors.length) return null;
  for (const element of panel.querySelectorAll<HTMLElement>(selectors.join(","))) {
    if (element.scrollHeight - element.clientHeight <= 1) continue;
    const overflow = typeof getComputedStyle === "function" ? getComputedStyle(element).overflowY : "auto";
    if (overflow === "auto" || overflow === "scroll") return element;
  }
  return null;
}

/** 顶部被吸顶页头遮住的高度：`.ts-detail` 里有页头，`.expandedScroll` 没有。 */
function topInset(scroller: HTMLElement): number {
  return scroller.querySelector(".ts-detail-header") ? readingTopInset(scroller) : 0;
}

/** 吸顶 / 固定层里的块（会议页的议题目录）不随内容走，不能当锚。 */
function pinned(element: HTMLElement, scroller: HTMLElement): boolean {
  if (typeof getComputedStyle !== "function") return false;
  for (let node: HTMLElement | null = element; node && node !== scroller; node = node.parentElement) {
    const position = getComputedStyle(node).position;
    if (position === "sticky" || position === "fixed") return true;
  }
  return false;
}

/** 记下视口顶上那一段，以及它离滚动区上沿多远；还在顶部（没滚过）不用记。 */
export function captureReadingAnchor(scroller: HTMLElement, inset = topInset(scroller)): ReadingAnchor | null {
  if (scroller.scrollTop <= 0) return null;
  const top = boxOf(scroller).top;
  const line = top + inset;
  let found: HTMLElement | null = null;
  for (const element of scroller.querySelectorAll<HTMLElement>(READING_BLOCKS)) {
    if (found && !found.contains(element)) break;
    const box = boxOf(element);
    if (box.height > 0 && box.bottom > line && !pinned(element, scroller)) found = element;
  }
  return found ? { scroller, element: found, offset: boxOf(found).top - top } : null;
}

function setScrollTop(scroller: HTMLElement, top: number) {
  // .expandedScroll 带 scroll-behavior:smooth：这里要瞬时，不然每一帧都在追。
  if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior: "instant" as ScrollBehavior });
  else scroller.scrollTop = top;
}

/** 把记下的那一段放回原来的偏移；元素已不在页面上就不动。 */
export function restoreReadingAnchor(anchor: ReadingAnchor): void {
  const { scroller, element, offset } = anchor;
  if (element.isConnected === false) return;
  const delta = boxOf(element).top - boxOf(scroller).top - offset;
  if (Math.abs(delta) >= 1) setScrollTop(scroller, scroller.scrollTop + delta);
}

const USER_SCROLL = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** 宽度过渡期间（durationMs）每一帧放回；减少动效时只放一次。返回提前停下的函数。 */
export function holdReadingAnchor(anchor: ReadingAnchor, durationMs: number): () => void {
  const { scroller } = anchor;
  let frame = 0;
  let stopped = false;
  const start = performance.now();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    USER_SCROLL.forEach((type) => scroller.removeEventListener(type, stop));
  };
  USER_SCROLL.forEach((type) => scroller.addEventListener(type, stop, { passive: true }));
  const step = () => {
    if (stopped) return;
    restoreReadingAnchor(anchor);
    if (performance.now() - start >= durationMs) stop();
    else frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return stop;
}
