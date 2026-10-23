"use client";

/**
 * 二级页右边那一列（clark `conversation/column.tsx`）：顶部页头写明这条线在跟谁说话，中间是当前频道的对话，
 * 底部让给输入条。输入条不在这里面 —— 宿主渲染（ColumnComposer），位置由这里给（`columnComposerClass`）。
 *
 * 左边的材料和右列是同一块面板，中间只隔一条线。≥760 右列可以收起：开关在右列右上角（和 Codex / Claude 一样，
 * 用户 2026-09-29 定），收起后它原地不动，停在阅读页右上角；带未读数的频道钮留在阅读页右边那一溜上。
 * 系统永远不自己展开右列。
 * ≤759 右列是浮层，入口是输入条底行左边那个开关。
 *
 * 群组频道（成员头像、成员名单）随议题群一起接（2b）。
 *
 * Co-Agent 胶囊（components/coagent）浮在右列顶部居中，和左侧页头胶囊同一条上沿；中线按右列展开时的宽度算，
 * 收起右列时它原地不动。两种出现法：`lasting`（会议在录音）一直在，右列页头挪到它下面；`brief`（新人第一次进群、
 * Co-Agent 讲来龙去脉）只出现几秒，这几秒里暂时盖住右列页头，不挪版面。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "ts-design/primitives";
import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Users, X } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { TianshuMark } from "@/components/TianshuMark";
import { prefersReducedMotion } from "@/lib/viewTransition";
import { applyDeskWidth, DESK_SHIFT_MS } from "./desk/deskLayout";
import { captureReadingAnchor, holdReadingAnchor, materialScroller, restoreReadingAnchor } from "./desk/readingAnchor";
import { materialColumns, settledMaterialWidth, shiftMaterialColumns } from "./desk/materialFreeze";
import { CitationSurfaceProvider } from "./citations";
import { RichSurfaceProvider } from "./richBlocks/surface";
import { formatUnread, unreadPhrase } from "./seen";
import { useNarrowColumn, type ColumnMode } from "./useColumnMode";
import c from "@/styles/conversation-column.module.css";
import shell from "@/styles/app-shell.module.css";

export interface ConversationChannel {
  id: string;
  /** 输入条里频道开关上的字：「天枢」「事项群组 · 4」。 */
  label: string;
  kind: "agent" | "group";
  /** 当前频道永远不画；只画在收起后的频道钮和开关的非当前段上。 */
  unread: number;
  /** 右列页头上写的名字：CEO 和成员都是「天枢」；不给就用 label。 */
  title?: string;
  /** 页头标题下的一行弱色小字：当前对话对象（「围绕：<议题标题>」）；只有天枢频道用。 */
  subtitle?: string;
}

/** 宿主根节点加上它：右列的宽度、外沿和收起态都在这一层算，左侧内容据此让位。 */
export const columnHostClass = c.host;
/** 宿主把自己的输入条挂上它：位置由右列给，收起时隐藏（先展开再打字）。 */
export const columnComposerClass = c.composer;
/** 对话正文的几块共用样式。 */
export const conversationStyles = c;

/**
 * 输入条里的频道开关按下去：换频道；窄屏浮层关着时顺手把浮层打开到那个频道 —— 小屏上开关就是对话的入口，
 * 按当前那颗也一样打开。
 */
export function pressChannel(
  id: string,
  { channel, onChannel, narrow, mobileOpen, onMobileOpen }: {
    channel: string;
    onChannel: (id: string) => void;
    narrow: boolean;
    mobileOpen: boolean;
    onMobileOpen: (open: boolean) => void;
  },
) {
  if (id !== channel) onChannel(id);
  if (narrow && !mobileOpen) onMobileOpen(true);
}

const FOCUSABLE = 'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]';

/** 左侧材料在滚的那一层：DetailFrame 的 `.ts-detail`，或老页面的 `.expandedScroll`。 */
const MATERIAL_SCROLLERS = [".ts-detail", `.${shell.expandedScroll}`];

export function ConversationColumn({
  channels,
  channel,
  onChannel,
  mode,
  onMode,
  mobileOpen,
  onMobileOpen,
  composerHeight,
  ariaLabel,
  testId,
  children,
  headerAction,
  coagent,
  coagentBrief = false,
  deskWidth = null,
  onDesk,
}: {
  channels: ConversationChannel[];
  channel: string;
  onChannel: (id: string) => void;
  /** 只对 ≥760 有意义；≤759 恒展开，浮层另算。 */
  mode: ColumnMode;
  /** 用户动作：收起、展开。调用方负责写偏好。 */
  onMode: (mode: ColumnMode) => void;
  /** ≤759 的浮层开没开。 */
  mobileOpen: boolean;
  onMobileOpen: (open: boolean) => void;
  /** 输入条此刻多高（含附件条）。正文底部据此让位。 */
  composerHeight: number;
  ariaLabel: string;
  testId: string;
  /** 当前频道的正文：日志、空态、说明。自己滚动。 */
  children: ReactNode;
  headerAction?: ReactNode;
  /** Co-Agent 胶囊（components/coagent/PresenceCapsule）；没有就不画。 */
  coagent?: ReactNode;
  /** 胶囊只出现几秒：不挪右列页头，暂时盖住它。 */
  coagentBrief?: boolean;
  /**
   * 深度讨论（并排）：给了就是展开态，值是对话列的宽度（宿主按断点算好：600 / 680）。右列原地加宽，左侧材料让位，
   * 不覆盖、不 inert；正文那一棵子树不重挂。窄屏一律当没给。
   */
  deskWidth?: number | null;
  /** 给了才画 ⤢ 键（宿主只在 ≥1280、右列展开时给）。 */
  onDesk?: (open: boolean) => void;
}) {
  const narrow = useNarrowColumn();
  const strip = !narrow && mode === "strip";
  const overlayOpen = narrow && mobileOpen;
  const activeDeskWidth = !narrow && typeof deskWidth === "number" ? deskWidth : null;
  const deskOn = activeDeskWidth !== null;
  // 出处标记平时点「打开原文」：能放大就先放大（依据面板只在放大时出现）。
  const deskOpener = useRef(onDesk);
  deskOpener.current = onDesk;
  const openDesk = useCallback(() => deskOpener.current?.(true), []);
  const current = channels.find((item) => item.id === channel) ?? channels[0];
  const root = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const hasCoagent = Boolean(coagent);
  // 焦点跟着这一列自己发起的变化走：从收起后的频道钮展开时落到把手上（展开不等于要打字）；关浮层回到开关。
  const pendingFocus = useRef<"handle" | "switch" | null>(null);
  // 深度讨论：上一态（切换时才动左侧阅读位置）、宿主（卸载时清变量）、过渡标记的计时、左侧锚定的停止函数。
  const lastDesk = useRef(false);
  const hostRef = useRef<HTMLElement | null>(null);
  const shiftTimer = useRef<number | undefined>(undefined);
  const stopAnchor = useRef<(() => void) | null>(null);
  const stopFreeze = useRef<(() => void) | null>(null);

  // 页头在阅读容器内，胶囊固定在视口上。扣除阅读区实际占用的滚动条，收起后两者才准确留 12px。
  useLayoutEffect(() => {
    if (!hasCoagent) return;
    const host = root.current?.closest<HTMLElement>(`.${c.host}`);
    const reader = host?.querySelector<HTMLElement>(".ts-detail");
    if (!host || !reader) return;
    const measure = () => {
      const style = getComputedStyle(reader);
      const scrollbar = reader.offsetWidth - reader.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      host.style.setProperty("--reading-scrollbar", `${Math.max(0, scrollbar)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(reader);
    return () => { observer.disconnect(); host.style.removeProperty("--reading-scrollbar"); };
  }, [hasCoagent]);

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const element =
      target === "handle"
        ? handle.current
        : root.current
            ?.closest(`.${c.host}`)
            ?.querySelector<HTMLButtonElement>('[data-channel-switch] [aria-pressed="true"],[data-channel-switch] [data-selected="true"]');
    element?.focus({ preventScroll: true });
  }, [mode, channel, overlayOpen]);

  // 深度讨论展开 / 收起：宿主的 --conversation-open-width 换成 desk/deskLayout 算出的宽（右列与左侧让位同一条 240ms 曲线），
  // 左侧材料按视口顶上那一段锚定；收起后焦点掉到 body 上就回到 ⤢。右列正文的阅读位置由滚动控制器按宽度变化重校正。
  // 左侧阅读列（desk/materialFreeze）：够宽时宽度不变、只平移；不够宽时在开始那一帧就定到结束后的宽，过渡结束后不再有任何变化。
  useLayoutEffect(() => {
    const element = root.current;
    const host = element?.closest<HTMLElement>(`.${c.host}`) ?? null;
    hostRef.current = host;
    const toggled = lastDesk.current !== deskOn;
    lastDesk.current = deskOn;
    if (!toggled || !host || !element) {
      applyDeskWidth(host?.style, activeDeskWidth);
      return;
    }
    const panel = host.querySelector<HTMLElement>('[data-testid="expanded-panel"]');
    const main = panel?.parentElement ?? null;
    const scroller = materialScroller(panel, MATERIAL_SCROLLERS);
    const anchor = scroller ? captureReadingAnchor(scroller) : null;
    const reduced = prefersReducedMotion();
    // 量在改宽之前：主区此刻的宽与右边距（过渡中途就是动画里的值）。
    const mainWidth = main?.getBoundingClientRect().width ?? 0;
    const mainMargin = main ? parseFloat(getComputedStyle(main).marginRight) || 0 : 0;
    element.dataset.deskShift = "true";
    window.clearTimeout(shiftTimer.current);
    shiftTimer.current = window.setTimeout(() => { delete element.dataset.deskShift; }, DESK_SHIFT_MS + 80);
    applyDeskWidth(host.style, activeDeskWidth);
    stopFreeze.current?.();
    stopFreeze.current = null;
    stopAnchor.current?.();
    if (panel && main) {
      const nextMargin = parseFloat(getComputedStyle(main).getPropertyValue("--conversation-width"));
      if (Number.isFinite(nextMargin)) {
        // 阅读位置在开始那一帧（重排之后、绘制之前）就放回，不等到过渡结束。
        stopFreeze.current = shiftMaterialColumns(panel, materialColumns(panel, scroller) as HTMLElement[], settledMaterialWidth(mainWidth, mainMargin, nextMargin), DESK_SHIFT_MS + 20, {
          reducedMotion: reduced,
          onReflow: () => { if (anchor) restoreReadingAnchor(anchor); },
          scroller,
          fadeTarget: scroller ?? panel,
        });
      }
    }
    // 过渡期间每一帧守住阅读位置（平移不改折行，守住的是滚动区高度的细小变化）；减少动效时只放一次。
    stopAnchor.current = anchor ? holdReadingAnchor(anchor, reduced ? 0 : DESK_SHIFT_MS + 60) : null;
    if (!deskOn) {
      const active = document.activeElement;
      if (!active || active === document.body) element.querySelector<HTMLElement>("[data-desk-key]")?.focus({ preventScroll: true });
    }
  }, [deskOn, activeDeskWidth]);
  useLayoutEffect(() => () => {
    applyDeskWidth(hostRef.current?.style, null);
    window.clearTimeout(shiftTimer.current);
    stopAnchor.current?.();
    stopFreeze.current?.();
  }, []);

  useEffect(() => {
    if (overlayOpen) closeButton.current?.focus({ preventScroll: true });
  }, [overlayOpen]);

  // 浮层开着时，Tab 只在浮层与输入条之间转。
  useEffect(() => {
    if (!overlayOpen) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      // 会话列表之类开在浮层上面时，让它自己管焦点。
      if ([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some((dialog) => dialog !== aside.current && dialog.getClientRects().length)) return;
      const host = root.current?.closest(`.${c.host}`) ?? document;
      const candidates = [
        ...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
        ...host.querySelectorAll<HTMLElement>(`.${c.composer} :is(${FOCUSABLE})`),
      ].filter((element) => element.getClientRects().length && !element.closest('[inert],[aria-hidden="true"]'));
      const first = candidates[0];
      const last = candidates.at(-1);
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !candidates.includes(active as HTMLElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !candidates.includes(active as HTMLElement))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [overlayOpen]);

  const expandTo = (id: string) => {
    pendingFocus.current = "handle";
    if (id !== channel) onChannel(id);
    onMode("expanded");
  };
  const closeOverlay = () => {
    pendingFocus.current = "switch";
    onMobileOpen(false);
  };

  return (
    <div
      ref={root}
      className={c.root}
      data-testid={testId}
      data-mode={strip ? "strip" : "expanded"}
      data-narrow={narrow || undefined}
      data-mobile-open={overlayOpen || undefined}
      data-desk={deskOn || undefined}
      data-channel={current?.kind ?? "agent"}
      data-coagent={coagent ? (coagentBrief ? "brief" : "lasting") : undefined}
      style={{ "--conversation-composer-height": `${composerHeight}px` } as CSSProperties}
      onKeyDown={(event) => {
        // Escape 的顺序（C-06）：输入框 → 这层浮层 → 工作区。
        if (event.key !== "Escape" || !overlayOpen || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        event.stopPropagation();
        closeOverlay();
      }}
    >
      {overlayOpen ? <Button className={c.veil} variant="ghost" onPress={closeOverlay} aria-label="收起对话" /> : null}
      {/* 深度讨论开着时不画收起开关：要收先 ⤡。 */}
      {narrow || deskOn ? null : (
        <Button
          ref={handle}
          isIconOnly
          variant="ghost"
          className={c.handle}
          aria-expanded={!strip}
          aria-label={strip ? "展开对话栏" : "收起对话栏"}
          onPress={() => onMode(strip ? "expanded" : "strip")}
        >
          {strip ? <PanelRightOpen size={18} strokeWidth={1.8} aria-hidden /> : <PanelRightClose size={18} strokeWidth={1.8} aria-hidden />}
        </Button>
      )}
      {coagent ? <div className={c.jelly}>{coagent}</div> : null}
      {/* 右列是浅色阅读面：`data-tone=light` 让对话记录换成浅色那一套。 */}
      <aside
        ref={aside}
        className={c.column}
        aria-label={ariaLabel}
        role={overlayOpen ? "dialog" : undefined}
        aria-modal={overlayOpen || undefined}
        data-conversation-overlay={overlayOpen || undefined}
        data-tone="light"
      >
        {narrow ? (
          <Button ref={closeButton} isIconOnly variant="ghost" size="sm" className={c.close} aria-label="收起对话" onPress={closeOverlay}>
            <X size={18} aria-hidden />
          </Button>
        ) : null}
        <div className={c.panel} inert={strip || undefined} aria-hidden={strip || undefined}>
          {current ? (
            <header className={c.header} data-kind={current.kind} data-has-desk-key={onDesk ? true : undefined}>
              {current.kind === "agent" && current.subtitle ? (
                <div className={c.headerStack}>
                  <h2 className={c.headerTitle}>
                    <TianshuMark className={c.headerMark} />
                    <span className={c.wordmark}>{current.title ?? current.label}</span>
                  </h2>
                  <p className={c.headerSub} title={current.subtitle}>{current.subtitle}</p>
                </div>
              ) : (
                <h2 className={c.headerTitle}>
                  {current.kind === "agent" ? <TianshuMark className={c.headerMark} /> : <Users size={16} strokeWidth={1.8} aria-hidden />}
                  <span className={current.kind === "agent" ? c.wordmark : undefined}>{current.title ?? current.label}</span>
                </h2>
              )}
              {headerAction}
              {onDesk ? (
                <HeroButton
                  isIconOnly
                  variant="ghost"
                  size="sm"
                  className={c.deskKey}
                  data-desk-key
                  title={deskOn ? "收起" : "深度讨论"}
                  aria-label={deskOn ? "收起" : "深度讨论"}
                  aria-expanded={deskOn}
                  onPress={() => onDesk(!deskOn)}
                >
                  {deskOn ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
                </HeroButton>
              ) : null}
            </header>
          ) : null}
          {/* 深度讨论时回答里的来源可点：在左侧定位到那一段或打开依据面板（conversation/citations）。平时只是文字。 */}
          {/* 富内容块（richBlocks）：深度讨论时完整铺开；收起态的大块是缩略卡，点了经 onDesk 进深度讨论（不能进时底部 sheet）。 */}
          <CitationSurfaceProvider linked={deskOn} surface="rail" expand={!narrow && onDesk && !deskOn ? openDesk : undefined}>
            <RichSurfaceProvider expanded={deskOn} expand={onDesk && !deskOn ? () => onDesk(true) : undefined}>
              <div className={c.body}>{children}</div>
            </RichSurfaceProvider>
          </CitationSurfaceProvider>
          <div className={c.footer} aria-hidden />
        </div>
      </aside>
      {/* 收起后右边那一溜悬浮的钮：右列收起时缩到 0，它们浮在阅读页上。 */}
      <nav className={c.strip} aria-label="对话栏，已收起" inert={!strip || undefined} aria-hidden={!strip || undefined}>
        {channels.map((item) => {
          const badge = formatUnread(item.unread);
          return (
            <Button
              key={item.id}
              isIconOnly
              variant="ghost"
              className={c.stripButton}
              data-kind={item.kind}
              data-current={item.id === current?.id || undefined}
              aria-label={`展开对话栏：${item.label}${unreadPhrase(item.unread)}`}
              onPress={() => expandTo(item.id)}
            >
              {item.kind === "agent" ? <TianshuMark className={c.stripMark} /> : <Users size={18} strokeWidth={1.7} aria-hidden />}
              {badge ? (
                <span className={c.badge} data-kind={item.kind} aria-hidden>
                  {badge}
                </span>
              ) : null}
            </Button>
          );
        })}
      </nav>
    </div>
  );
}
