"use client";

/**
 * 二级页右边那一列（clark `conversation/column.tsx`）：顶部页头写明这条线在跟谁说话，中间是当前频道的对话，
 * 底部让给输入条。输入条不在这里面 —— 宿主渲染（ColumnComposer），位置由这里给（`columnComposerClass`）。
 *
 * 左边的材料和右列是同一块面板，中间只隔一条线；收起钮是骑在这条线上的一个小把手。≥760 右列可以收起：
 * 右列缩到 0，阅读页铺满右边；把手和带未读数的频道钮留下来，浮在阅读页右边那一溜上。系统永远不自己展开右列。
 * ≤759 右列是浮层，入口是输入条底行左边那个开关。
 *
 * 群组频道（成员头像、成员名单）随议题群一起接（2b）；会议中的 Co-Agent 胶囊在第 5 步。
 */

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "ts-design/primitives";
import { ChevronLeft, ChevronRight, Users, X } from "lucide-react";
import { TianshuMark } from "@/components/TianshuMark";
import { formatUnread, unreadPhrase } from "./seen";
import { useNarrowColumn, type ColumnMode } from "./useColumnMode";
import c from "@/styles/conversation-column.module.css";

export interface ConversationChannel {
  id: string;
  /** 输入条里频道开关上的字：「我的 Agent」「事项群组 · 4」。 */
  label: string;
  kind: "agent" | "group";
  /** 当前频道永远不画；只画在收起后的频道钮和开关的非当前段上。 */
  unread: number;
  /** 右列页头上写的名字：「CEO Agent」「DRI Agent」；不给就用 label。 */
  title?: string;
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
}) {
  const narrow = useNarrowColumn();
  const strip = !narrow && mode === "strip";
  const overlayOpen = narrow && mobileOpen;
  const current = channels.find((item) => item.id === channel) ?? channels[0];
  const root = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // 焦点跟着这一列自己发起的变化走：从收起后的频道钮展开时落到把手上（展开不等于要打字）；关浮层回到开关。
  const pendingFocus = useRef<"handle" | "switch" | null>(null);

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
      data-channel={current?.kind ?? "agent"}
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
      {narrow ? null : (
        <Button
          ref={handle}
          isIconOnly
          variant="ghost"
          className={c.handle}
          aria-expanded={!strip}
          aria-label={strip ? "展开对话栏" : "收起对话栏"}
          onPress={() => onMode(strip ? "expanded" : "strip")}
        >
          {strip ? <ChevronLeft size={18} strokeWidth={2.2} aria-hidden /> : <ChevronRight size={18} strokeWidth={2.2} aria-hidden />}
        </Button>
      )}
      {/* 右列是浅色阅读面：`data-tone=light` 让对话记录换成浅色那一套。 */}
      <aside
        ref={aside}
        className={c.column}
        aria-label={ariaLabel}
        role={overlayOpen ? "dialog" : undefined}
        aria-modal={overlayOpen || undefined}
        data-tone="light"
      >
        {narrow ? (
          <Button ref={closeButton} isIconOnly variant="ghost" size="sm" className={c.close} aria-label="收起对话" onPress={closeOverlay}>
            <X size={18} aria-hidden />
          </Button>
        ) : null}
        <div className={c.panel} inert={strip || undefined} aria-hidden={strip || undefined}>
          {current ? (
            <header className={c.header} data-kind={current.kind}>
              <h2 className={c.headerTitle}>
                {current.kind === "agent" ? <TianshuMark className={c.headerMark} /> : <Users size={16} strokeWidth={1.8} aria-hidden />}
                <span className={current.kind === "agent" ? c.wordmark : undefined}>{current.title ?? current.label}</span>
              </h2>
              {headerAction}
            </header>
          ) : null}
          <div className={c.body}>{children}</div>
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
