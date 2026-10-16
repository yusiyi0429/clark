/**
 * 阅读页的滚动：会议页和议题页的正文都由 DetailFrame 的 `.ts-detail` 统一滚动（0b063c5 起不再有内层滚动框）。
 * 定位要让出吸顶的页头（以及窄屏浮在正文右上角的「目录」钮），不能把章节标题藏在页头下面。
 */

export function readingScroller(from: Element | null | undefined): HTMLElement | null {
  return from?.closest<HTMLElement>(".ts-detail") ?? null;
}

/** 正文顶部被遮住的高度：吸顶页头 + 窄屏「目录」钮那一条 + 一点呼吸。 */
export function readingTopInset(scroller: HTMLElement): number {
  const header = scroller.querySelector<HTMLElement>(".ts-detail-header");
  const headerHeight = header ? header.getBoundingClientRect().height : 48;
  const bar = scroller.querySelector<HTMLElement>("[data-toc-bar]");
  const barVisible = bar ? window.getComputedStyle(bar).display !== "none" : false;
  return headerHeight + (barVisible ? 44 : 14);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 把元素滚到页头下面；返回滚动前的位置，用于「回到刚才的位置」。 */
export function scrollToElement(element: HTMLElement, behavior?: ScrollBehavior): number | null {
  const scroller = readingScroller(element);
  if (!scroller) {
    element.scrollIntoView({ block: "start", behavior: behavior ?? (prefersReducedMotion() ? "auto" : "smooth") });
    return null;
  }
  const before = scroller.scrollTop;
  const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - readingTopInset(scroller);
  scroller.scrollTo({ top: Math.max(0, top), behavior: behavior ?? (prefersReducedMotion() ? "auto" : "smooth") });
  return before;
}

/** 折叠着的「已被替代或撤回」等区块：定位前先展开，不然滚到一个看不见的元素上。 */
export function revealElement(element: HTMLElement): void {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) (node as HTMLDetailsElement).open = true;
  }
}

/** 定位后闪一下，让眼睛知道停在了哪一条。 */
export function flashElement(element: HTMLElement): void {
  element.dataset.flash = "true";
  window.setTimeout(() => {
    if (element.dataset.flash === "true") delete element.dataset.flash;
  }, 1800);
}

/** 深度讨论里从对话点过来：短暂高亮约 1.2s（globals.css 的 data-cite-flash），比页内依据的闪一下更轻更短。 */
export const BRIEF_FLASH_MS = 1200;
export function briefFlash(element: HTMLElement): void {
  element.dataset.citeFlash = "true";
  window.setTimeout(() => {
    if (element.dataset.citeFlash === "true") delete element.dataset.citeFlash;
  }, BRIEF_FLASH_MS);
}
