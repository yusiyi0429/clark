"use client";

import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { MorningCanvas } from "@/components/onboarding/MorningCanvas";
import { useHomeArrival } from "@/components/onboarding/useHomeArrival";
import type { Account } from "@/components/AccountMenu";
import { columnHostClass } from "@/conversation/ConversationColumn";
import { ConversationHost, type ConversationUiState } from "@/conversation/ConversationHost";
import { CitationPanel } from "@/conversation/CitationPanel";
import { ReferenceProvider } from "@/conversation/references";
import { appendQuote, restoreQuotes, type QuotePrefill, type QuoteSource, type TextQuote } from "@/conversation/quotes";
import { NARROW_COLUMN_QUERY, saveColumnMode } from "@/conversation/useColumnMode";
import { prefersReducedMotion, runRouteTransition, supportsViewTransition, type TransitionDirection } from "@/lib/viewTransition";
import { WhatsNewCard } from "@/components/whatsNew/WhatsNewCard";
import { MeetingBookingSheet } from "@/components/meeting/MeetingBookingSheet";
import { ESCAPE_BACK_ATTR, ESCAPE_BACK_EVENT, escapeStep } from "./escapeChain";
import { popReturn, trimReturns } from "./returnStack";
import { LoadingMask } from "./LoadingMask";
import { NoticeStrip } from "./NoticeStrip";
import { WorkspaceContext, type DetailInfo, type WorkspaceApi } from "./WorkspaceContext";
// clark 的 CEO 工作面经 MissionCardWorkspace 引入 ts-design 样式表，它的主题层排在 globals 之后生效
// （字号尺、font-weight-medium 500、圆角档位以它为准）。这里照同样顺序引入，渲染结果才与 clark 一致。
import "ts-design/styles.css";
import { REFRESH_EVENT, TOAST_EVENT, toastDuration, type ToastDetail } from "@/lib/toast";
import s from "@/styles/app-shell.module.css";

const EMPTY_CARDS: Card[] = [];

type Rect = { left: number; top: number; width: number; height: number };

/** 同一类对象（雷达列表 ↔ 信号、Mission 总览 ↔ Mission）属于同一个视图，切换不记返回。 */
const family = (path: string, homeHref: string) => path.slice(homeHref === "/" ? 1 : homeHref.length + 1).split("/")[0] ?? "";
/** 视图内的下一级页面：Escape 先回到这一级（clark：信号阅读 Escape 回信号列表）。 */
function parentWithinView(path: string, homeHref: string): string | null {
  if (homeHref === "/me" && /^\/me\/radar\/signals\/[^/]+$/.test(path)) return "/me/radar";
  if (/^\/radar\/signals\/[^/]+$/.test(path)) return "/radar";
  if (/^\/missions\/[^/]+$/.test(path)) return "/missions";
  return null;
}
const isEditable = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
/** 来源比对只看路径：带筛选参数的入口（/missions?capabilityId=…）关闭时仍回到它自己。 */
const pathOf = (href: string) => href.split("?")[0];
/** 能接回焦点的键。 */
const FOCUSABLE = 'button:not(:disabled), a[href], [role="button"], [tabindex]:not([tabindex="-1"])';
/** 打开转场最多等服务端这么久；再慢就先打开二级页并盖上加载蒙版，转场不再冻住首页。 */
const OPEN_WAIT_MS = 100;
const rectOf = (el: Element): Rect => {
  const box = el.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
};

/** 两个身份共用同一套展开、关闭、返回栈与焦点还原；首页和通知内容由各自工作台提供。 */
export function WorkspaceFrame({ homeHref, viewerId, account, homeCards = EMPTY_CARDS, home, notifications, agentTitle, children }: {
  homeHref: "/" | "/me";
  viewerId: string | null;
  account: Account;
  homeCards?: Card[];
  home: ReactNode;
  notifications: (api: WorkspaceApi, currentHref: string) => ReactNode;
  agentTitle: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  /** 已发起、新路由还没提交的目标：二级页先打开，右侧盖加载蒙版。路由提交（包括被重定向到别处）就清掉。 */
  const [pending, setPending] = useState<string | null>(null);
  const [m2Available, setM2Available] = useState(false);
  /** 建会抽屉：CEO 从顶栏「约会议」打开，成员从首页操作区打开（经 WorkspaceContext 的 bookMeeting）。 */
  const [booking, setBooking] = useState(false);
  const bookMeeting = useCallback(() => setBooking(true), []);
  useEffect(() => {
    const controller = new AbortController();
    setM2Available(false);
    void fetch("/m2/api/session", { signal: controller.signal }).then(async (response) => {
      if (response.ok) setM2Available((await response.json()).authenticated === true);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [viewerId]);
  const routeOpen = pathname !== homeHref;
  const detailOpen = routeOpen || pending !== null;
  /** 从首页打开、页面还没到：面板是空的，透明着让蒙版磨砂后面的首页。 */
  const openingEmpty = !routeOpen && pending !== null;
  // 雷达列表与成员战场是浏览面；成员战场尚未开放独立 Agent scope，个人信号不挂对话（成员只有全局对话）。
  const railAllowed = routeOpen && pathname !== `${homeHref === "/" ? "" : homeHref}/radar` && !(homeHref === "/me" && (pathname.startsWith("/me/battlefields/") || pathname.startsWith("/me/radar/")));

  const [detail, setDetail] = useState<DetailInfo | null>(null);
  // 战场页共用全局对话，右列页头标题下写「围绕：<战场名>战场」。
  const battlefieldSubject = detail?.scope === "global" && detail.label && /\/battlefields\/[^/]+/.test(pathname) ? (detail.label.endsWith("战场") ? detail.label : `${detail.label}战场`) : null;
  const registerDetail = useCallback((info: DetailInfo | null) => setDetail(info), []);

  const [noticeTransition, setNoticeTransition] = useState<TransitionDirection | null>(null);
  const [closing, setClosing] = useState(false);
  const [peek, setPeek] = useState(false);
  /** 兜底（无 View Transition）的入场动画进行中：首页还要露在面板后面。 */
  const [entering, setEntering] = useState(false);
  const [toast, setToast] = useState<ToastDetail | null>(null);
  const arriving = useHomeArrival();
  // 对话界面状态（clark：键盘面跨对象保留；历史层、全局视图与窄屏对话列随对象复位）。
  const [keyboard, setKeyboard] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [globalView, setGlobalView] = useState(false);
  const [railMobileOpen, setRailMobileOpen] = useState(false);
  // 深度讨论（并排）：只在当前这一页有效、不记住。记的是打开时那一页；换页、打开对话层就收起（这一帧就收，不等 effect）。
  const deskKey = `${viewerId ?? ""}:${homeHref}:${pathname}`;
  const [deskFor, setDeskFor] = useState<string | null>(null);
  const deskOpen = deskFor === deskKey && railAllowed && !historyOpen;
  const setDeskOpen = useCallback((open: boolean) => setDeskFor(open ? deskKey : null), [deskKey]);
  // 对话层（首页全局对话、二级页的「在全局讨论」）的放大：同样只在这一页、对话层开着时有效；收起对话层、换页就收。
  const [sheetWideFor, setSheetWideFor] = useState<string | null>(null);
  const sheetWide = sheetWideFor === deskKey && historyOpen;
  const setSheetWide = useCallback((wide: boolean) => setSheetWideFor(wide ? deskKey : null), [deskKey]);
  const quoteKey = `${viewerId ?? ""}:${homeHref}:${pathname}:${detail?.scope ?? "global"}`;
  const [quoteDraft, setQuoteDraft] = useState<{ key: string; items: TextQuote[]; prefill: QuotePrefill | null } | null>(null);
  const quoteNonce = useRef(0);
  // Hide old selections in the same render as an object/identity switch, before the reset effect runs.
  const quotes = quoteDraft?.key === quoteKey ? quoteDraft.items : [];
  const prefill = quoteDraft?.key === quoteKey ? quoteDraft.prefill : null;
  useEffect(() => {
    setHistoryOpen(false);
    setGlobalView(false);
    setRailMobileOpen(false);
    setDeskFor(null);
    setSheetWideFor(null);
  }, [pathname, viewerId, homeHref]);
  useEffect(() => {
    if (historyOpen) setDeskFor(null);
    else setSheetWideFor(null);
  }, [historyOpen]);
  useEffect(() => setQuoteDraft(null), [quoteKey]);
  // 引用只进入当前对象的私聊，正文保持在小引用块里，输入条留给用户自己的话。
  const quote = useCallback((text: string, source?: QuoteSource, options?: { listen?: boolean }) => {
    if (!text.trim()) return;
    setHistoryOpen(false);
    setGlobalView(false);
    setKeyboard(true);
    if (window.matchMedia(NARROW_COLUMN_QUERY).matches) setRailMobileOpen(true);
    else saveColumnMode("expanded");
    const nonce = ++quoteNonce.current;
    const resolvedSource = { label: detail?.label, ...source, scope: detail?.scope ?? "global" };
    setQuoteDraft((current) => ({ key: quoteKey,
      items: appendQuote(current?.key === quoteKey ? current.items : [], { id: `quote-${nonce}`, text, source: resolvedSource }),
      prefill: { text, nonce, source: resolvedSource, ...(options?.listen ? { listen: true } : {}) } }));
  }, [detail?.label, detail?.scope, quoteKey]);
  // 代一号位发出一句（月度计划「按意见重写」）：只带这一句自己的引用，输入条里的草稿和已挂的引用块原样留着。
  const ask = useCallback((message: string, item: Omit<TextQuote, "id">, onResult?: (accepted: boolean) => void) => {
    if (!message.trim()) return;
    setHistoryOpen(false);
    setGlobalView(false);
    setKeyboard(true);
    if (window.matchMedia(NARROW_COLUMN_QUERY).matches) setRailMobileOpen(true);
    else saveColumnMode("expanded");
    const nonce = ++quoteNonce.current;
    const resolvedSource = { label: detail?.label, ...item.source, scope: detail?.scope ?? "global" };
    setQuoteDraft((current) => ({ key: quoteKey, items: current?.key === quoteKey ? current.items : [],
      prefill: { text: "", nonce, source: resolvedSource, send: { message, quotes: [{ id: `ask-${nonce}`, text: item.text, source: resolvedSource }], onResult } } }));
  }, [detail?.label, detail?.scope, quoteKey]);
  // 对话正文里划词「引用」（B4）：进这条对话自己的引用条，聚焦它的输入框；全局对话层不关、不跳到右列私聊。
  const quoteInConversation = useCallback((text: string, source: QuoteSource & { scope: string }) => {
    if (!text.trim()) return;
    setKeyboard(true);
    const nonce = ++quoteNonce.current;
    setQuoteDraft((current) => ({ key: quoteKey,
      items: appendQuote(current?.key === quoteKey ? current.items : [], { id: `quote-${nonce}`, text, source }),
      prefill: { text, nonce, source } }));
  }, [quoteKey]);
  const compose = useCallback((draft: string) => {
    setHistoryOpen(false);
    setGlobalView(false);
    setKeyboard(true);
    if (window.matchMedia(NARROW_COLUMN_QUERY).matches) setRailMobileOpen(true);
    else saveColumnMode("expanded");
    const nonce = ++quoteNonce.current;
    setQuoteDraft((current) => ({ key: quoteKey, items: current?.key === quoteKey ? current.items : [],
      prefill: { text: "", draft, nonce, source: { label: detail?.label, scope: detail?.scope ?? "global" } } }));
  }, [detail?.label, detail?.scope, quoteKey]);
  const consumePrefill = useCallback((nonce?: number) => setQuoteDraft((current) =>
    current && (nonce === undefined || current.prefill?.nonce === nonce) ? { ...current, prefill: null } : current), []);
  const removeQuotes = useCallback((ids: string[]) => setQuoteDraft((current) => current
    ? { ...current, items: current.items.filter((item) => !ids.includes(item.id)) } : current), []);
  // 发送失败放回引用（D5）：只放回发出时那个对象 / 身份下；期间新加的引用不被覆盖。
  const restoreSentQuotes = useCallback((sent: TextQuote[]) => setQuoteDraft((current) => current?.key === quoteKey
    ? { ...current, items: restoreQuotes(current.items, sent) } : current), [quoteKey]);
  useEffect(() => {
    if (historyOpen) setPeek(false);
  }, [historyOpen]);

  const main = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<{ el: Element; at: number } | null>(null);
  /**
   * 打开当前详情的来源：el 是开合转场的来源节点（可能是整张通知卡），trigger 是按下的那个键，
   * 关闭后焦点回到 trigger（clark focusOrigin）。href 用于来源节点重挂载后按稳定标识重新定位。
   */
  const origin = useRef<{ href: string; el: Element | null; trigger: HTMLElement | null; rect: Rect | null } | null>(null);
  /** 跨视图打开的返回栈（例如从会议打开议题，关闭回到会议）。 */
  const returns = useRef<string[]>([]);
  const settle = useRef<(() => void) | null>(null);
  const fallbackEnter = useRef<Rect | null>(null);

  const resolveOrigin = useCallback((explicit?: Element | null): Element | null => {
    const recent = lastPointer.current && performance.now() - lastPointer.current.at < 1000 ? lastPointer.current.el : null;
    const base = explicit ?? recent ?? document.activeElement;
    if (!base || base === document.body) return null;
    return base.closest("[data-origin]") ?? base.closest("button, a, [role=button]") ?? base;
  }, []);

  const findOrigin = useCallback((href: string): Element | null => {
    const saved = origin.current;
    if (saved && pathOf(saved.href) === pathOf(href) && saved.el?.isConnected) return saved.el;
    return main.current?.ownerDocument.querySelector(`[data-origin="${CSS.escape(href)}"]`) ?? null;
  }, []);

  /** 关闭后接回焦点的键：优先当初按下的键；它已重挂载时，找同一来源里的可聚焦键。 */
  const findTrigger = useCallback((href: string, fallback: Element | null): HTMLElement | null => {
    const saved = origin.current;
    if (saved && pathOf(saved.href) === pathOf(href) && saved.trigger?.isConnected) return saved.trigger;
    const node = main.current?.ownerDocument.querySelector(`[data-origin="${CSS.escape(href)}"]`) ?? fallback;
    if (!node) return null;
    return node.matches(FOCUSABLE) ? (node as HTMLElement) : node.querySelector<HTMLElement>(FOCUSABLE);
  }, []);

  const focusCloseButton = useCallback(() => {
    const target = panel.current?.querySelector<HTMLElement>("[data-close-view]");
    const active = document.activeElement;
    // 深链已把焦点交给详情里的具体对象（tabindex=-1 的待处理意见、更正申请）时，入场结束后不再抢回。
    if (active instanceof HTMLElement && active.tabIndex === -1 && active !== document.body && panel.current?.contains(active)) return;
    if (target && !active?.closest('[data-testid="global-controls"]')) target.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    setPending(null);
    // 浏览器后退 / 前进回到了栈里的一页：栈跟着地址栏回退（巡检 P1-4）。
    returns.current = trimReturns(returns.current, pathname);
  }, [pathname]);

  // 新路由提交后：先让等待中的转场截新快照，再做焦点与兜底动画。
  useLayoutEffect(() => {
    if (settle.current) {
      const done = settle.current;
      settle.current = null;
      done();
    }
    if (!detailOpen) return;
    const from = fallbackEnter.current;
    fallbackEnter.current = null;
    const el = panel.current;
    const box = main.current?.getBoundingClientRect();
    if (from && el && box && box.width && !prefersReducedMotion()) {
      setEntering(true);
      const animation = el.animate(
        [
          { transform: `translate(${from.left - box.left}px,${from.top - box.top}px) scale(${from.width / box.width},${from.height / box.height})`, opacity: 0.6, borderRadius: "25px" },
          { transform: "translate(0,0) scale(1)", opacity: 1, borderRadius: "25px" },
        ],
        { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
      const done = () => setEntering(false);
      void animation.finished.then(done, done);
    }
  }, [pathname, detailOpen]);

  // 进入详情后聚焦关闭钮（焦点已在全局输入条里时不抢）。
  useEffect(() => {
    if (!detailOpen || noticeTransition) return;
    const frame = requestAnimationFrame(focusCloseButton);
    return () => cancelAnimationFrame(frame);
  }, [detailOpen, pathname, noticeTransition, focusCloseButton]);

  // peek 只在工作区打开时存在。
  useEffect(() => {
    if (detailOpen) return;
    const frame = requestAnimationFrame(() => setPeek(false));
    return () => cancelAnimationFrame(frame);
  }, [detailOpen]);

  const open = useCallback(
    (href: string, from?: Element | null) => {
      const source = resolveOrigin(from);
      const recent = lastPointer.current && performance.now() - lastPointer.current.at < 1000 ? lastPointer.current.el : null;
      const pressed = (recent ?? document.activeElement)?.closest<HTMLElement>(FOCUSABLE) ?? null;
      const trigger = pressed && source?.contains(pressed) ? pressed : source?.matches(FOCUSABLE) ? (source as HTMLElement) : (source?.querySelector<HTMLElement>(FOCUSABLE) ?? pressed);
      origin.current = { href, el: source, trigger, rect: source ? rectOf(source) : null };
      returns.current = [];
      setPeek(false);
      if (!source || !supportsViewTransition()) {
        fallbackEnter.current = origin.current.rect;
        setPending(href);
        startTransition(() => router.push(href));
        return;
      }
      const card = source as HTMLElement;
      card.style.viewTransitionName = "notice-card";
      flushSync(() => setNoticeTransition("open"));
      void runRouteTransition("open", (done) => {
        let early = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(early);
          card.style.removeProperty("view-transition-name");
          done();
        };
        settle.current = finish;
        early = window.setTimeout(() => {
          settle.current = null;
          flushSync(() => setPending(href));
          finish();
        }, OPEN_WAIT_MS);
        startTransition(() => router.push(href));
      }).then(() => {
        card.style.removeProperty("view-transition-name");
        setNoticeTransition(null);
        focusCloseButton();
      });
    },
    [focusCloseButton, resolveOrigin, router],
  );

  const goHome = useCallback(() => {
    // 二级页还没真正打开：撤掉这次打开（新导航会顶替还在路上的那次）。
    if (!routeOpen && pending) {
      setPending(null);
      startTransition(() => router.push(homeHref));
      return;
    }
    if (!detailOpen || closing) return;
    setPending(null);
    const leaving = pathname;
    const target = findOrigin(leaving) as HTMLElement | null;
    const trigger = findTrigger(leaving, target);
    returns.current = [];
    const finish = () => {
      setClosing(false);
      setPeek(false);
      target?.style.removeProperty("view-transition-name");
      if (!document.activeElement?.closest('[data-testid="global-controls"]')) {
        const focusTarget = trigger?.isConnected ? trigger : document.querySelector<HTMLElement>('[data-testid="notification-only"] button[aria-label="天枢，返回首页"]');
        focusTarget?.focus({ preventScroll: true });
      }
      origin.current = null;
      router.refresh();
    };
    setClosing(true);
    if (supportsViewTransition() && !peek) {
      flushSync(() => setNoticeTransition("close"));
      void runRouteTransition("close", (done) => {
        settle.current = () => {
          if (target) target.style.viewTransitionName = "notice-card";
          done();
        };
        startTransition(() => router.push(homeHref));
      }).then(() => {
        setNoticeTransition(null);
        finish();
      });
      return;
    }
    const el = panel.current;
    const box = main.current?.getBoundingClientRect();
    const to = target ? rectOf(target) : null;
    if (el && box && box.width && !prefersReducedMotion()) {
      const animation = el.animate(
        [
          { transform: "translate(0,0) scale(1)", opacity: 1 },
          {
            transform: to ? `translate(${to.left - box.left}px,${to.top - box.top}px) scale(${to.width / box.width},${to.height / box.height})` : "translateY(18px) scale(.97)",
            opacity: 0.1,
          },
        ],
        { duration: 260, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
      );
      void animation.finished.then(() => {
        startTransition(() => router.push(homeHref));
        finish();
      }, () => {});
      return;
    }
    startTransition(() => router.push(homeHref));
    finish();
  }, [closing, detailOpen, findOrigin, findTrigger, pathname, peek, pending, routeOpen, router, homeHref]);

  const close = useCallback(() => {
    const { back, rest } = popReturn(returns.current, pathname);
    returns.current = rest;
    if (back) {
      setPending(back);
      startTransition(() => router.push(back));
      return;
    }
    goHome();
  }, [goHome, pathname, router]);

  const navigate = useCallback(
    (href: string, from?: Element | null) => {
      if (href === homeHref) return goHome();
      if (!href.startsWith("/") || href.startsWith("/access") || href.startsWith("/config")) {
        if (href.startsWith("/access")) window.location.assign(href);
        else startTransition(() => router.push(href));
        return;
      }
      if (!detailOpen) return open(href, from);
      if (href === pathname) return;
      // 在对象之间切换：同一视图内替换，跨视图记下返回点（C-01：关闭详情回到原工作面）。
      if (routeOpen && family(href, homeHref) !== family(pathname, homeHref)) returns.current.push(pathname);
      setPeek(false);
      if (pathOf(href) !== pathname) setPending(href);
      startTransition(() => router.push(href));
    },
    [detailOpen, goHome, open, pathname, routeOpen, router, homeHref],
  );

  const showToast = useCallback((text: string) => setToast({ text }), []);
  useEffect(() => {
    const shown = (event: Event) => {
      const detail = (event as CustomEvent<ToastDetail>).detail;
      if (detail?.text) setToast(detail);
    };
    const refresh = () => router.refresh();
    window.addEventListener(TOAST_EVENT, shown);
    window.addEventListener(REFRESH_EVENT, refresh);
    return () => {
      window.removeEventListener(TOAST_EVENT, shown);
      window.removeEventListener(REFRESH_EVENT, refresh);
    };
  }, [router]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toastDuration(toast));
    return () => clearTimeout(timer);
  }, [toast]);

  // 键盘：⌘\ / Ctrl+\ 切换 peek（仅工作区打开时）；Escape 按 C-06 顺序逐层处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "\\" || event.code === "Backslash")) {
        if (!detailOpen) return;
        event.preventDefault();
        setPeek((value) => !value);
        return;
      }
      if (event.key !== "Escape" || event.isComposing) return;
      // C-06：输入 → 浮层 → 深度讨论 → 对话 → 工作区（escapeChain）。模态对话框自己处理 Escape。
      const active = document.activeElement;
      // 宽屏上残留的浮层开关（演示提案也会置它）看不见：顺手清掉，不占这一次 Esc。
      const mobileVisible = railMobileOpen && window.matchMedia(NARROW_COLUMN_QUERY).matches;
      if (railMobileOpen && !mobileVisible) setRailMobileOpen(false);
      const step = escapeStep({
        modalOpen: Boolean(document.querySelector("dialog[open]")),
        editableFocused: isEditable(active) && !active?.closest('[data-testid="global-controls"]'),
        peek,
        railMobileOpen: mobileVisible,
        // 放大（右列深度讨论、对话层放大）在对话层之前收；依据面板开着时它自己先接住 Esc。
        deskOpen: deskOpen || sheetWide,
        // 全局输入条的打字面和对话层一起开合（D6）：一次 Esc 收起对话层，输入条回到胶囊。
        // 二级页右列底下的输入条没有键盘/语音两面（一直是文字框），不在这里收。
        conversationLayer: historyOpen || (keyboard && !railAllowed),
        detailOpen,
        innerBack: Boolean(panel.current?.querySelector(`[${ESCAPE_BACK_ATTR}="true"]`)),
        parent: parentWithinView(pathname, homeHref),
      });
      switch (step.kind) {
        case "ignore": return;
        case "blur": (active as HTMLElement).blur(); return;
        case "peek": setPeek(false); return;
        case "railMobile": setRailMobileOpen(false); return;
        case "desk": setDeskFor(null); setSheetWideFor(null); return;
        case "conversation":
          setHistoryOpen(false);
          setGlobalView(false);
          setKeyboard(false);
          return;
        case "inner": window.dispatchEvent(new Event(ESCAPE_BACK_EVENT)); return;
        case "parent": navigate(step.href); return;
        case "close": close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, deskOpen, detailOpen, historyOpen, keyboard, navigate, pathname, peek, railAllowed, railMobileOpen, homeHref, sheetWide]);

  // 触屏：按住按钮滑动页面，松手不算点按。React Aria 只在浏览器发 pointercancel 时取消点按，iOS 在内层滚动容器里
  // 滚动时不一定发；这里自己判断：手指移动超过 10px、或按住期间有任何滚动，就在它收到 pointerup 之前补发一次 pointercancel。
  const tap = useRef<{ id: number; x: number; y: number; scrolled: boolean } | null>(null);
  useEffect(() => {
    const onScroll = () => {
      if (tap.current) tap.current.scrolled = true;
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // 触屏：左缘滑入展开 peek，在 peek 上反向滑动收起（Safari 可能占用边缘手势，尽力而为）。
  const swipe = useRef<{ x: number; y: number; peek: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.target instanceof Element) lastPointer.current = { el: event.target, at: performance.now() };
    tap.current = event.pointerType === "touch" ? { id: event.pointerId, x: event.clientX, y: event.clientY, scrolled: false } : null;
    if (event.pointerType !== "touch" || !detailOpen) {
      swipe.current = null;
      return;
    }
    const edge = event.clientX <= 28;
    if (!peek && !edge) {
      swipe.current = null;
      return;
    }
    swipe.current = { x: event.clientX, y: event.clientY, peek };
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    const touch = tap.current;
    tap.current = null;
    if (touch && event.pointerId === touch.id && (touch.scrolled || Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10)) {
      event.target.dispatchEvent(new PointerEvent("pointercancel", { pointerId: event.pointerId, pointerType: "touch", bubbles: true }));
    }
    if (!start || event.pointerType !== "touch") return;
    const dx = event.clientX - start.x;
    const dy = Math.abs(event.clientY - start.y);
    if (dy > Math.abs(dx)) return;
    if (!start.peek && dx > 48) setPeek(true);
    else if (start.peek && dx < -48) setPeek(false);
  };

  const urgent = useMemo(
    () => homeCards.filter((card) => card.kind === "issue" && card.urgency === "red").length,
    [homeCards],
  );

  const api: WorkspaceApi = useMemo(
    () => ({ navigate, close, detailOpen, closing, registerDetail, showToast, homeCards, quote, ask, compose, viewerId, bookMeeting: viewerId ? bookMeeting : undefined, m2Available }),
    [homeCards, ask, bookMeeting, close, closing, compose, detailOpen, m2Available, navigate, quote, registerDetail, showToast, viewerId],
  );

  const conversationUi: ConversationUiState = {
    keyboard,
    setKeyboard,
    historyOpen,
    setHistoryOpen,
    globalView,
    setGlobalView,
    railMobileOpen,
    setRailMobileOpen,
    deskOpen,
    setDeskOpen,
    sheetWide,
    setSheetWide,
    prefill,
    consumePrefill,
    quotes,
    removeQuotes,
    restoreQuotes: restoreSentQuotes,
    quoteInConversation,
  };

  return (
    <WorkspaceContext.Provider value={api}>
      <ReferenceProvider onLimit={showToast}>
      <div
        className={`${s.shell} ${columnHostClass}`}
        data-testid={homeHref === "/" ? "ceo-workspace" : "member-workspace"}
        data-detail-open={detailOpen}
        data-arriving={arriving}
        data-notices-peek={peek}
        data-topic-rail={railAllowed && !historyOpen}
        data-topic-channel="agent"
        data-topic-mobile-open={railMobileOpen}
        onPointerDownCapture={onPointerDown}
        onPointerUpCapture={onPointerUp}
        onPointerCancelCapture={() => {
          swipe.current = null;
          tap.current = null;
        }}
      >
        {arriving ? <div className={s.entryCarry} aria-hidden="true"><MorningCanvas /></div> : null}
        <div className={s.mainArea} ref={main}>
          <div
            className={s.homeSurface}
            aria-hidden={detailOpen}
            inert={detailOpen}
            data-covered={(detailOpen && !noticeTransition && !closing && !entering && !peek) || undefined}
            style={noticeTransition && !openingEmpty ? { viewTransitionName: "home-board" } : undefined}
          >
            {/* 成员首页的约会议、复盘在首页左上的操作区里（HomeActions）。 */}
            {homeHref === "/" ? (
              <div className={s.m2Entry}>
                {viewerId ? <button type="button" onClick={bookMeeting}>约会议</button> : null}
                {m2Available ? <a href="/m2/">目标拆解与协作 <span aria-hidden="true">→</span></a> : null}
              </div>
            ) : null}
            {home}
          </div>
          {detailOpen ? (
            <div
              className={s.expanded}
              ref={panel}
              data-testid="expanded-panel"
              data-loading={openingEmpty || undefined}
              aria-label={detail?.label}
              style={noticeTransition ? { viewTransitionName: "notice-card" } : undefined}
            >
              {children}
            </div>
          ) : (
            children
          )}
        </div>
        <LoadingMask active={pending !== null} />
        {detailOpen ? (
          <NoticeStrip
            current={detail?.mark ?? null}
            currentLabel={detail?.label}
            urgent={urgent}
            peekOpen={peek}
            transitioning={!!noticeTransition}
            onHome={goHome}
            onTogglePeek={() => setPeek((value) => !value)}
            account={account}
            onNavigate={navigate}
          />
        ) : null}
        {detailOpen && peek ? <button type="button" className={s.noticePeekBackdrop} aria-label="收起通知栏" onClick={() => setPeek(false)} /> : null}
        <div className={s.notificationArea} data-testid="notification-only" style={noticeTransition ? { viewTransitionName: "notice-rail" } : undefined}>
          {notifications(api, pathname)}
        </div>
        <ConversationHost page={detail} detailOpen={detailOpen} rail={railAllowed} agentTitle={agentTitle} pageSubject={battlefieldSubject} ui={conversationUi} />
        <CitationPanel active={deskOpen || sheetWide} />
        {toast ? (
          <div className={s.noticeToast} role="status">
            <Check size={15} />
            <span>{toast.text}</span>
            {toast.action ? (
              <button type="button" className={s.toastAction} onClick={() => {
                const action = toast.action;
                setToast(null);
                void action?.run();
              }}>{toast.action.label}</button>
            ) : null}
          </div>
        ) : null}
        <WhatsNewCard />
        {booking && viewerId ? <MeetingBookingSheet open onClose={() => setBooking(false)} viewer={{ personId: viewerId, role: account.role, displayName: account.displayName }} /> : null}
      </div>
      </ReferenceProvider>
    </WorkspaceContext.Provider>
  );
}
