/**
 * 对话区的滚动控制（全局对话层与二级页右列共用），行为对齐 Claude 网页版 / ChatGPT：
 * - 打开时落在底部并跟随（历史后到也跟到底）；用户往上滚就停，自己滚回真实末尾再跟随；
 * - 跟随时一次长高超过半屏（一整段话到了）：约 240ms 的短促缓动滑过去，不瞬间跳；逐字的小增长照旧贴底；
 *   刚打开、换内容后的一小会儿（历史一次到）和一次长高超过三屏时照旧瞬间到底；滑动途中本人一动手就停；
 * - 发送：约 240ms 的短促缓动把刚发的那条（最后一个 `[data-chat-role="user"]`）推到滚动区顶部留白之下，
 *   下面留出刚好够它上去的空白（留白元素在内容之后，不被内容的 ResizeObserver 看到）；
 * - 回答进行中视图不动、不跟随；超过一屏时 ↓ 出现（`atBottom` 只看真实内容的末尾，不算留白），点 ↓ 跳到最新并跟随；
 * - 留白只在发送那一刻按真实内容重算（不跨轮叠加），之后只缩不涨，并且缩完当前位置仍然可达，视图不跳；
 * - 找不到刚发的那条（群聊：消息等服务端回来才出现）就照旧滚到底并跟随；
 * - onSend="bottom"（新首页伙伴主线、项目对话，像微信）：发送时不置顶、不留白，滚到底并跟随，往上翻就停、点 ↓ 回到底部接着跟；
 * - 换频道直接落到底部；从气泡打开（anchor="reply"）停在最后一条回答的开头，不跟随。
 * - 宽度变了（讨论台展开 / 收起，正文重排）：置顶中按刚发那条的新位置重新置顶、留白重算；自由浏览时视口顶上那条留在原处；跟随照旧追到底。
 * - 滚动区正被整体缩放（展开动画的 transform）时，元素之间的距离按缩放比换回布局距离。
 * - reveal：把指定的一块（「待确认 N」对应的提案卡）滚到顶部留白之下，之后不跟随。
 * - 对话层放大 / 收起的过渡里（resizeGate）：滚动区已是终态尺寸，开始时按终值校正一次；过渡中 ResizeObserver 不做事，结束再校正一次。
 * 系统要求减少动态效果时，所有程序滚动都是瞬时的。
 */
import { onResize, resizing } from "./resizeGate";

export type ScrollAnchor = "end" | "reply";
/** 发送那一刻：pin 把刚发的那条推到顶部（默认）；bottom 滚到底并跟随。 */
export type ScrollOnSend = "pin" | "bottom";
export type ScrollMode = "follow" | "pinned" | "free";
export type ScrollEvent =
  | { type: "open"; anchor: ScrollAnchor }
  | { type: "send"; found: boolean }
  | { type: "streamEnd" }
  | { type: "userUp" }
  | { type: "userReachedEnd" }
  | { type: "jump" }
  | { type: "reset" }
  | { type: "interrupt" }
  | { type: "reveal" };

/** 发送置顶、点 ↓ 的动画时长。 */
export const SEND_PIN_MS = 240;
/** 离真实末尾多近算「在底部」（与 use-stick-to-bottom 的默认一致）。 */
export const END_THRESHOLD = 70;
/** 用户手势（滚轮、触摸、按键、按下滚动条）之后多久内的 scroll 算用户滚动。 */
const INTENT_MS = 400;
/** 打开、换内容之后多久以内的长高算「历史一次到」，照旧瞬间到底。 */
export const OPEN_SETTLE_MS = 1000;

/** 跟随时这一下要不要滑过去：打开一会儿以后、一次长高超过半屏、不超过三屏（再多就是整块换了内容）。 */
export function followGlides({ jump, viewport, sinceOpen }: { jump: number; viewport: number; sinceOpen: number }): boolean {
  return sinceOpen >= OPEN_SETTLE_MS && jump > viewport / 2 && jump <= viewport * 3;
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** 刚发的那条要滚到的 scrollTop：它的上沿对齐滚动区上方留白（inset）之下。 */
export function pinTarget({ elementTop, scrollerTop, scrollTop, inset }: { elementTop: number; scrollerTop: number; scrollTop: number; inset: number }): number {
  return Math.max(0, Math.round(elementTop - scrollerTop + scrollTop - inset));
}

/** 让 keepTop 可达所需的留白：真实内容（naturalEnd，不含留白）不够一屏的部分。 */
export function reserveNeeded({ keepTop, viewport, naturalEnd }: { keepTop: number; viewport: number; naturalEnd: number }): number {
  return Math.max(0, Math.ceil(keepTop + viewport - naturalEnd));
}

/** 置顶中按需（可增可减，保证置顶不被夹回）；其他时候只缩不涨，缩完 keepTop 仍可达（不跳）。 */
export function nextReserve({ mode, current, keepTop, viewport, naturalEnd }: { mode: ScrollMode; current: number; keepTop: number; viewport: number; naturalEnd: number }): number {
  const needed = reserveNeeded({ keepTop, viewport, naturalEnd });
  return mode === "pinned" ? needed : Math.min(current, needed);
}

/** 真实内容的末尾是否在视口里（留白不算）。 */
export function isAtEnd({ scrollTop, viewport, naturalEnd, threshold = END_THRESHOLD }: { scrollTop: number; viewport: number; naturalEnd: number; threshold?: number }): boolean {
  return naturalEnd - (scrollTop + viewport) <= threshold;
}

/** 跟随：只往下追到真实末尾，不把看得到的留白拉回来。 */
export function followTop({ scrollTop, viewport, naturalEnd }: { scrollTop: number; viewport: number; naturalEnd: number }): number {
  return Math.max(scrollTop, naturalEnd - viewport);
}

export function nextMode(mode: ScrollMode, event: ScrollEvent): ScrollMode {
  switch (event.type) {
    case "open": return event.anchor === "reply" ? "free" : "follow";
    case "send": return event.found ? "pinned" : "follow";
    case "streamEnd": return mode === "pinned" ? "free" : mode;
    case "userUp": case "interrupt": case "reveal": return "free";
    case "userReachedEnd": case "jump": case "reset": return "follow";
  }
}

type ResizeObserverCtor = new (callback: () => void) => { observe(target: Element): void; disconnect(): void };
/** 对话层放大 / 收起的过渡窗口（resizeGate）。 */
export type ResizeGate = { resizing(): boolean; onResize(listeners: { start?: () => void; end?: () => void }): () => void };
const RESIZE_GATE: ResizeGate = { resizing, onResize };

export type ScrollControllerOptions = {
  anchor?: ScrollAnchor;
  onSend?: ScrollOnSend;
  onAtBottom?: (atBottom: boolean) => void;
  reduced?: () => boolean;
  /** 滚动区上方留白（默认读 padding-top）。 */
  inset?: (scroller: HTMLElement) => number;
  now?: () => number;
  raf?: (callback: () => void) => number;
  caf?: (id: number) => void;
  /** 测试里传 null 关掉。 */
  resizeObserver?: ResizeObserverCtor | null;
  /** 过渡窗口；默认 resizeGate，测试可替换或传 null 关掉。 */
  resizeGate?: ResizeGate | null;
};

export type ScrollController = ReturnType<typeof createScrollController>;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function createScrollController(options: ScrollControllerOptions = {}) {
  const reduced = options.reduced ?? prefersReducedMotion;
  const inset = options.inset ?? ((element: HTMLElement) => parseFloat(getComputedStyle(element).paddingTop) || 0);
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const raf = options.raf ?? ((callback: () => void) => requestAnimationFrame(callback));
  const caf = options.caf ?? ((id: number) => cancelAnimationFrame(id));
  const Observer = options.resizeObserver === undefined ? (typeof ResizeObserver === "undefined" ? null : ResizeObserver) : options.resizeObserver;
  const gate = options.resizeGate === undefined ? RESIZE_GATE : options.resizeGate;

  let mode = nextMode("follow", { type: "open", anchor: options.anchor ?? "end" });
  let scroller: HTMLElement | null = null, content: HTMLElement | null = null, reserveEl: HTMLElement | null = null;
  let reserve = 0, pinTop = 0, lastSet = -1, lastTop = 0, intentAt = -Infinity, pointerDown = false, bottom = true;
  let lastWidth: number | undefined;
  /** 打开（接上滚动区）或换内容的时刻：之后 OPEN_SETTLE_MS 以内跟随照旧瞬间。 */
  let openedAt = -Infinity;
  /** 置顶的那条（宽度变了按它重算 pinTop）；自由浏览时视口顶上那条和它离留白线多远（宽度变了放回原处）。 */
  let pinEl: HTMLElement | null = null, anchorEl: HTMLElement | null = null, anchorOffset = 0;
  let animation: { id: number; target: () => number } | null = null;
  let observer: { observe(target: Element): void; disconnect(): void } | null = null;
  let unsubscribeGate: (() => void) | null = null;

  const metrics = (element: HTMLElement) => ({ scrollTop: element.scrollTop, viewport: element.clientHeight, naturalEnd: element.scrollHeight - reserve });

  /** 滚动区被整体缩放（讨论台展开 / 收起的 FLIP 动画）时的比例；没有缩放、或量不到（测试桩）时为 1。 */
  function scaleOf(element: HTMLElement, visualHeight: number | undefined): number {
    const layoutHeight = element.offsetHeight;
    return layoutHeight > 0 && typeof visualHeight === "number" && visualHeight > 0 ? visualHeight / layoutHeight : 1;
  }
  /** element 的上沿离滚动区上沿多远（布局距离，不受缩放影响）。 */
  function offsetIn(element: HTMLElement): number {
    const box = scroller!.getBoundingClientRect();
    return (element.getBoundingClientRect().top - box.top) / scaleOf(scroller!, box.height);
  }
  /** 让 element 的上沿对齐上方留白之下要滚到的 scrollTop。 */
  function targetOf(element: HTMLElement): number {
    return pinTarget({ elementTop: offsetIn(element), scrollerTop: 0, scrollTop: scroller!.scrollTop, inset: inset(scroller!) });
  }

  function setTop(value: number) {
    if (!scroller) return;
    scroller.scrollTop = value;
    lastSet = lastTop = scroller.scrollTop;
  }
  function setReserve(px: number) {
    if (px === reserve) return;
    reserve = px;
    if (reserveEl) reserveEl.style.height = px ? `${px}px` : "";
  }
  function report() {
    if (!scroller) return;
    const next = isAtEnd(metrics(scroller));
    if (next === bottom) return;
    bottom = next;
    options.onAtBottom?.(next);
  }
  function cancel() {
    if (!animation) return;
    caf(animation.id);
    animation = null;
  }
  function animateTo(target: () => number) {
    cancel();
    if (!scroller) return;
    if (reduced()) { setTop(target()); layout(); return; }
    const from = scroller.scrollTop, start = now();
    const step = () => {
      const t = Math.min(1, (now() - start) / SEND_PIN_MS);
      setTop(from + (target() - from) * easeOutCubic(t));
      if (t < 1 && animation) { animation.id = raf(step); return; }
      animation = null;
      layout();
    };
    animation = { id: raf(step), target };
  }

  /** 自由浏览时记下视口顶上那条消息，以及它离留白线多远。 */
  function captureAnchor() {
    anchorEl = null;
    if (!scroller || !content || mode !== "free") return;
    const line = inset(scroller);
    const box = scroller.getBoundingClientRect();
    const k = scaleOf(scroller, box.height);
    for (const item of content.querySelectorAll<HTMLElement>("[data-chat-role]")) {
      const rect = item.getBoundingClientRect();
      if ((rect.bottom - box.top) / k > line) { anchorEl = item; anchorOffset = (rect.top - box.top) / k - line; return; }
    }
  }
  /** 宽度变了：置顶中按那条的新位置重算 pinTop；自由浏览把记下的那条放回原来的偏移。跟随交给下面的追到底。 */
  function realign() {
    if (!scroller) return;
    if (mode === "pinned" && pinEl && pinEl.isConnected !== false) { pinTop = targetOf(pinEl); return; }
    if (mode === "free" && anchorEl && anchorEl.isConnected !== false) {
      const delta = offsetIn(anchorEl) - inset(scroller) - anchorOffset;
      if (Math.abs(delta) >= 1) setTop(scroller.scrollTop + delta);
    }
  }

  /** 内容或视口变了：按模式调整留白，跟随时追到真实末尾；宽度变了先重新校正。 */
  function layout() {
    if (!scroller) return;
    const width = scroller.clientWidth;
    const reflowed = lastWidth !== undefined && width !== lastWidth;
    lastWidth = width;
    if (reflowed) realign();
    const m = metrics(scroller);
    const keepTop = mode === "pinned" ? pinTop : animation ? Math.max(m.scrollTop, animation.target()) : m.scrollTop;
    setReserve(nextReserve({ mode, current: reserve, keepTop, viewport: m.viewport, naturalEnd: m.naturalEnd }));
    if (reflowed && mode === "pinned" && !animation) setTop(pinTop);
    if (mode === "follow" && !animation) {
      const now2 = metrics(scroller);
      const target = followTop(now2);
      const jump = target - scroller.scrollTop;
      if (followGlides({ jump, viewport: now2.viewport, sinceOpen: now() - openedAt })) {
        // 一整段话到了：滑过去（目标每帧重算，期间还在长也追得上）；减少动效时 animateTo 自己瞬间到。
        const element = scroller;
        animateTo(() => Math.max(0, element.scrollHeight - reserve - element.clientHeight));
      } else if (jump > 0.5) setTop(target);
    }
    captureAnchor();
    report();
  }

  function onScroll() {
    if (!scroller) return;
    const top = scroller.scrollTop, delta = top - lastTop;
    lastTop = top;
    const programmatic = Math.abs(top - lastSet) < 2;
    const user = !programmatic && (pointerDown || now() - intentAt < INTENT_MS);
    if (user) {
      cancel();
      if (delta < -1) mode = nextMode(mode, { type: "userUp" });
      else if (delta > 1 && reserve === 0 && isAtEnd(metrics(scroller))) mode = nextMode(mode, { type: "userReachedEnd" });
    }
    captureAnchor();
    report();
  }
  function onIntent() {
    intentAt = now();
    if (animation) { cancel(); mode = nextMode(mode, { type: "interrupt" }); }
  }
  const onPointerDown = () => { pointerDown = true; onIntent(); };
  const onPointerUp = () => { pointerDown = false; intentAt = now(); };
  const intentEvents = ["wheel", "touchstart", "touchmove", "keydown"] as const;

  /** 尺寸变了：过渡窗口里不做事（结束时统一校正），平时照常。 */
  function onObservedResize() {
    if (gate?.resizing()) return;
    layout();
  }
  function ensureObserver() {
    if (!observer && Observer) observer = new Observer(onObservedResize);
    return observer;
  }

  return {
    mode: () => mode,
    atBottom: () => bottom,
    layout,
    attachScroller(element: HTMLElement | null) {
      if (scroller === element) return;
      if (scroller) {
        scroller.removeEventListener("scroll", onScroll);
        intentEvents.forEach((type) => scroller!.removeEventListener(type, onIntent));
        scroller.removeEventListener("pointerdown", onPointerDown);
        if (typeof window !== "undefined") window.removeEventListener?.("pointerup", onPointerUp);
        cancel();
      }
      scroller = element;
      observer?.disconnect();
      observer = null;
      unsubscribeGate?.();
      unsubscribeGate = null;
      if (!element) return;
      // 过渡开始：滚动区已是终态尺寸，先按终值校正一次（第一帧就落到对的位置）；过渡结束再校正一次。
      unsubscribeGate = gate?.onResize({ start: layout, end: layout }) ?? null;
      lastTop = element.scrollTop;
      lastWidth = element.clientWidth;
      openedAt = now();
      element.addEventListener("scroll", onScroll, { passive: true });
      intentEvents.forEach((type) => element.addEventListener(type, onIntent, { passive: true }));
      element.addEventListener("pointerdown", onPointerDown);
      if (typeof window !== "undefined") window.addEventListener?.("pointerup", onPointerUp);
      const resize = ensureObserver();
      resize?.observe(element);
      if (content) resize?.observe(content);
      layout();
    },
    attachContent(element: HTMLElement | null) {
      content = element;
      if (element && scroller) { ensureObserver()?.observe(element); layout(); }
    },
    attachReserve(element: HTMLElement | null) {
      reserveEl = element;
      if (element) element.style.height = reserve ? `${reserve}px` : "";
    },
    /** 发送：刚发的那条置顶；找不到、或 onSend="bottom" 就滚到底并跟随。只在回答开始的那一刻调用一次。 */
    send() {
      if (!scroller) return;
      cancel();
      const users = options.onSend === "bottom" ? undefined : content?.querySelectorAll<HTMLElement>('[data-chat-role="user"]');
      const sent = users?.[users.length - 1];
      mode = nextMode(mode, { type: "send", found: Boolean(sent) });
      if (!sent) {
        pinEl = null;
        setReserve(0);
        const element = scroller;
        animateTo(() => element.scrollHeight - reserve - element.clientHeight);
        return;
      }
      pinEl = sent;
      pinTop = targetOf(sent);
      const m = metrics(scroller);
      setReserve(nextReserve({ mode, current: reserve, keepTop: pinTop, viewport: m.viewport, naturalEnd: m.naturalEnd }));
      animateTo(() => pinTop);
      report();
    },
    /** 回答结束：不再保证置顶位置，留白缩到刚好够用（视图不动）。 */
    streamEnd() {
      mode = nextMode(mode, { type: "streamEnd" });
      layout();
    },
    /** 点 ↓：跳到真实末尾并跟随。 */
    jump() {
      if (!scroller) return;
      mode = nextMode(mode, { type: "jump" });
      const element = scroller;
      animateTo(() => Math.max(0, element.scrollHeight - reserve - element.clientHeight));
    },
    /** 换频道等整块换内容：清掉留白，直接落到底部并跟随。 */
    reset() {
      cancel();
      openedAt = now();
      mode = nextMode(mode, { type: "reset" });
      setReserve(0);
      if (scroller) setTop(scroller.scrollHeight);
      report();
    },
    /** 从气泡打开：停在最后一条回答的开头（让出上方留白），不跟随。 */
    anchorReply() {
      if (!scroller) return;
      const replies = content?.querySelectorAll<HTMLElement>('[data-chat-role="assistant"]');
      const reply = replies?.[replies.length - 1];
      if (!reply) return;
      mode = "free";
      setTop(targetOf(reply));
      report();
    },
    /** 「待确认 N」：把那张提案卡滚到顶部留白之下，之后不跟随。 */
    reveal(element: HTMLElement) {
      if (!scroller) return;
      cancel();
      mode = nextMode(mode, { type: "reveal" });
      const target = targetOf(element);
      animateTo(() => target);
    },
    stop: cancel,
  };
}
