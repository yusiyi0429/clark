/**
 * 首页点击 → 对象页的全屏展开过渡。
 * 来源矩形只存在模块变量里：同一次客户端导航有效，直接打开 URL 时自然为 null（只渲染终态）。
 */
type Origin = { rect: DOMRect; at: number };
let origin: Origin | null = null;

/** 超过这个时长的来源矩形一律作废：回退/前进不能复用很久以前那次点击的位置。 */
const MAX_AGE_MS = 1500;

export function rememberOrigin(element: Element | null) {
  origin = element ? { rect: element.getBoundingClientRect(), at: Date.now() } : null;
}

/** 以触发点击的控件为来源：点击后焦点/激活元素仍指向它。 */
export function rememberOriginFromFocus() {
  rememberOrigin(document.activeElement instanceof Element ? document.activeElement : null);
}

/** 非对象页（首页、Radar 列表）也必须清空，否则陈旧矩形会留给下一次进入对象页的导航。 */
export function clearOrigin() {
  origin = null;
}

export function takeOrigin(): DOMRect | null {
  const pending = origin;
  origin = null;
  if (!pending || Date.now() - pending.at > MAX_AGE_MS) return null;
  return pending.rect;
}

export function playObjectEnter(element: HTMLElement, from: DOMRect | null) {
  if (!from) return;
  const to = element.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.animate(
    [
      {
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        opacity: 0.6,
      },
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
    ],
    { duration: reduced ? 0 : 380, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
}
