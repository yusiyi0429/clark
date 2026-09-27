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
import { ReferenceProvider } from "@/conversation/references";
import { saveColumnMode } from "@/conversation/useColumnMode";
import { prefersReducedMotion, runRouteTransition, supportsViewTransition, type TransitionDirection } from "@/lib/viewTransition";
import { NoticeStrip } from "./NoticeStrip";
import { WorkspaceContext, type DetailInfo, type WorkspaceApi } from "./WorkspaceContext";
// clark 的 CEO 工作面经 MissionCardWorkspace 引入 ts-design 样式表，它的主题层排在 globals 之后生效
// （字号尺、font-weight-medium 500、圆角档位以它为准）。这里照同样顺序引入，渲染结果才与 clark 一致。
import "ts-design/styles.css";
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
  const detailOpen = pathname !== homeHref;
  // 雷达列表与成员战场是浏览面；成员战场尚未开放独立 Agent scope，个人信号不挂对话（成员只有全局对话）。
  const railAllowed = detailOpen && pathname !== `${homeHref === "/" ? "" : homeHref}/radar` && !(homeHref === "/me" && (pathname.startsWith("/me/battlefields/") || pathname.startsWith("/me/radar/")));

  const [detail, setDetail] = useState<DetailInfo | null>(null);
  const registerDetail = useCallback((info: DetailInfo | null) => setDetail(info), []);

  const [noticeTransition, setNoticeTransition] = useState<TransitionDirection | null>(null);
  const [closing, setClosing] = useState(false);
  const [peek, setPeek] = useState(false);
  const [toast, setToast] = useState("");
  const arriving = useHomeArrival();
  // 对话界面状态（clark：键盘面跨对象保留；历史层、全局视图与窄屏对话列随对象复位）。
  const [keyboard, setKeyboard] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [globalView, setGlobalView] = useState(false);
  const [railMobileOpen, setRailMobileOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  useEffect(() => {
    setHistoryOpen(false);
    setGlobalView(false);
    setRailMobileOpen(false);
    setPrefill(null);
  }, [pathname]);
  // clark onQuote：切到当前对象的对话（右列收着就展开并记成偏好，窄屏打开浮层），输入条写入「关于“…”，」。
  const quote = useCallback((text: string) => {
    setHistoryOpen(false);
    setGlobalView(false);
    setKeyboard(true);
    if (window.matchMedia("(max-width:759px)").matches) setRailMobileOpen(true);
    else saveColumnMode("expanded");
    setPrefill({ text: `关于“${text}”，`, nonce: Date.now() });
  }, []);
  const consumePrefill = useCallback(() => setPrefill(null), []);
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
      el.animate(
        [
          { transform: `translate(${from.left - box.left}px,${from.top - box.top}px) scale(${from.width / box.width},${from.height / box.height})`, opacity: 0.6, borderRadius: "25px" },
          { transform: "translate(0,0) scale(1)", opacity: 1, borderRadius: "25px" },
        ],
        { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
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
        startTransition(() => router.push(href));
        return;
      }
      const card = source as HTMLElement;
      card.style.viewTransitionName = "notice-card";
      flushSync(() => setNoticeTransition("open"));
      void runRouteTransition("open", (done) => {
        settle.current = () => {
          card.style.removeProperty("view-transition-name");
          done();
        };
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
    if (!detailOpen || closing) return;
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
  }, [closing, detailOpen, findOrigin, findTrigger, pathname, peek, router, homeHref]);

  const close = useCallback(() => {
    const back = returns.current.pop();
    if (back) {
      startTransition(() => router.push(back));
      return;
    }
    goHome();
  }, [goHome, router]);

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
      if (family(href, homeHref) !== family(pathname, homeHref)) returns.current.push(pathname);
      setPeek(false);
      startTransition(() => router.push(href));
    },
    [detailOpen, goHome, open, pathname, router, homeHref],
  );

  const showToast = useCallback((text: string) => setToast(text), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
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
      // C-06：输入 → 浮层 → 对话 → 工作区。模态对话框自己处理 Escape。
      if (document.querySelector('dialog[open]')) return;
      const active = document.activeElement;
      if (isEditable(active) && !active?.closest('[data-testid="global-controls"]')) {
        (active as HTMLElement).blur();
        return;
      }
      if (peek) return setPeek(false);
      if (railMobileOpen) return setRailMobileOpen(false);
      // 二级页的输入条没有键盘/语音两面（右列底下那条一直是文字框）。
      if (keyboard && !railAllowed) return setKeyboard(false);
      if (historyOpen) {
        setHistoryOpen(false);
        setGlobalView(false);
        return;
      }
      if (!detailOpen) return;
      const parent = parentWithinView(pathname, homeHref);
      if (parent) navigate(parent);
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, detailOpen, historyOpen, keyboard, navigate, pathname, peek, railAllowed, railMobileOpen, homeHref]);

  // 触屏：左缘滑入展开 peek，在 peek 上反向滑动收起（Safari 可能占用边缘手势，尽力而为）。
  const swipe = useRef<{ x: number; y: number; peek: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.target instanceof Element) lastPointer.current = { el: event.target, at: performance.now() };
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
    () => ({ navigate, close, detailOpen, closing, registerDetail, showToast, homeCards, quote, viewerId }),
    [homeCards, close, closing, detailOpen, navigate, quote, registerDetail, showToast, viewerId],
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
    prefill,
    consumePrefill,
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
        }}
      >
        {arriving ? <div className={s.entryCarry} aria-hidden="true"><MorningCanvas /></div> : null}
        <div className={s.mainArea} ref={main}>
          <div
            className={s.homeSurface}
            aria-hidden={detailOpen}
            inert={detailOpen}
            style={noticeTransition ? { viewTransitionName: "home-board" } : undefined}
          >
            {home}
          </div>
          {detailOpen ? (
            <div
              className={s.expanded}
              ref={panel}
              data-testid="expanded-panel"
              aria-label={detail?.label}
              style={noticeTransition ? { viewTransitionName: "notice-card" } : undefined}
            >
              {children}
            </div>
          ) : (
            children
          )}
        </div>
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
        <ConversationHost page={detail} detailOpen={detailOpen} rail={railAllowed} agentTitle={agentTitle} ui={conversationUi} />
        {toast ? (
          <div className={s.noticeToast} role="status">
            <Check size={15} />
            {toast}
          </div>
        ) : null}
      </div>
      </ReferenceProvider>
    </WorkspaceContext.Provider>
  );
}
