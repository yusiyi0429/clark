/**
 * 对话层放大 / 收起的过渡窗口（约 240ms，ConversationHistorySheet 打开和关上）。
 *
 * 过渡期间对话层的外框在变宽变高，正文栏已经按终态尺寸排好、不再逐帧重排（app-shell.module.css 的 [data-resizing]）。
 * 这一段里别的地方也别往画面上加活：
 * - 流式上屏（useConversation 的合帧、useSmoothText 的出字）只累积、不渲染，思考区不追加；
 * - 滚动控制器、富内容块、↓ 定位的 ResizeObserver 不做事；
 * 过渡结束时（endResize）排着的回调各跑一次，一次性补齐、统一校正。
 *
 * 只有一个对话层，所以是模块级的一个开关；没有在过渡中时 afterResize 立即执行。
 */
type Listener = () => void;

let active = false;
let deferred: Listener[] = [];
const starts = new Set<Listener>();
const ends = new Set<Listener>();

/** 此刻是否在放大 / 收起的过渡里。 */
export function resizing(): boolean {
  return active;
}

/** 过渡开始（或过渡中又切了一次，按新的终态重来）：通知 onResize 的 start（如滚动按终态校正一次）。 */
export function beginResize(): void {
  active = true;
  for (const listener of [...starts]) listener();
}

/** 过渡结束：排着的回调各跑一次，再通知 onResize 的 end。不在过渡中时什么也不做。 */
export function endResize(): void {
  if (!active) return;
  active = false;
  const list = deferred;
  deferred = [];
  for (const callback of list) callback();
  for (const listener of [...ends]) listener();
}

/** 过渡中排到结束时执行（同一个函数只排一次）；不在过渡中立即执行。 */
export function afterResize(callback: Listener): void {
  if (!active) {
    callback();
    return;
  }
  if (!deferred.includes(callback)) deferred.push(callback);
}

/** 订阅过渡的开始与结束，返回退订。 */
export function onResize({ start, end }: { start?: Listener; end?: Listener }): () => void {
  if (start) starts.add(start);
  if (end) ends.add(end);
  return () => {
    if (start) starts.delete(start);
    if (end) ends.delete(end);
  };
}

/** 过渡时长（与 app-shell.module.css .historySheet 的 width / height 过渡一致），和兜底多等的一点。 */
export const SHEET_RESIZE_MS = 240;
export const SHEET_RESIZE_SETTLE_MS = SHEET_RESIZE_MS + 40;

/**
 * 放大 / 收起的过渡窗口：打上 data-resizing（CSS 把滚动区定在终态尺寸、毛玻璃与遮罩换实底），通知 resizeGate；
 * 外框宽高过渡结束（transitionend），或兜底 SHEET_RESIZE_SETTLE_MS 之后撤掉。返回的函数提前收尾（过渡中又切了一次、卸载）。
 */
export function resizeWindow(element: HTMLElement): () => void {
  element.setAttribute("data-resizing", "true");
  beginResize();
  let done = false;
  const onEnd = (event: TransitionEvent) => {
    if (event.target === element && (event.propertyName === "width" || event.propertyName === "height")) finish();
  };
  const timer = setTimeout(finish, SHEET_RESIZE_SETTLE_MS);
  element.addEventListener("transitionend", onEnd);
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    element.removeEventListener("transitionend", onEnd);
    element.removeAttribute("data-resizing");
    endResize();
  }
  return finish;
}
