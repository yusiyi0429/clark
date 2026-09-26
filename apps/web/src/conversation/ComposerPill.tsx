"use client";

/**
 * 二级页的输入条（clark `conversation/composer-pill.tsx`），一直是两行：
 * - 上面一行是文字；写多了往上长，最多 7 行，再多在框里滚。有附件时附件条在最上面。
 * - 下面一行是操作区：左边频道开关（当前那颗实心频道色、白字，整张卡的底色和占位文字跟着换 ——「这句话发给谁」
 *   一眼看得到）；右边一颗钮三态：空时麦克风（语音未接入，置灰），有字时发送，回答中是停止。
 * - 点卡片上的空白处就是点文字框。
 *
 * 这里只管样子和排布；文字框、发送、停止由调用方给（ColumnComposer）。颜色读 conversation-column.module.css
 * 顶部那组 --pill-*。
 */

import { forwardRef, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, ToggleButton, ToggleButtonGroup } from "ts-design/primitives";
import { ArrowUp, Mic, Square, Users } from "lucide-react";
import { TianshuMark } from "@/components/TianshuMark";
import { formatUnread, unreadPhrase } from "./seen";
import type { ConversationChannel } from "./ConversationColumn";
import p from "@/styles/composer-pill.module.css";

export type PillTone = "agent" | "group";

export { p as pillStyles };

/** 输入条本身：一个 form（回车、点发送都走 onSubmit）。 */
export const ComposerPill = forwardRef<
  HTMLFormElement,
  {
    tone: PillTone;
    references?: ReactNode;
    leading?: ReactNode;
    field: ReactNode;
    action: ReactNode;
    onSubmit: () => void;
    /** 输入条此刻多高：宿主据此给右列正文让位。 */
    onHeight?: (height: number) => void;
  }
>(function ComposerPill({ tone, references, leading, field, action, onSubmit, onHeight }, ref) {
  const form = useRef<HTMLFormElement | null>(null);
  // 每次渲染后量一次（附件条出现、行数变化都在渲染里发生），再加一个 ResizeObserver 接住宽度变化。
  useLayoutEffect(() => {
    if (form.current && onHeight) onHeight(Math.round(form.current.offsetHeight));
  });
  useLayoutEffect(() => {
    const element = form.current;
    if (!element || !onHeight) return;
    const observer = new ResizeObserver(() => onHeight(Math.round(element.offsetHeight)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeight]);
  return (
    <form
      ref={(element) => {
        form.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
      className={p.pill}
      data-tone={tone}
      data-references={references ? true : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      // 点空白处（卡片边上、两行之间、底行中间那一段）落到文字框里；点开关、钮照常是它们自己。
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target !== event.currentTarget && !target.classList.contains(p.field)) return;
        const textarea = event.currentTarget.querySelector("textarea");
        if (!textarea || textarea.disabled) return;
        event.preventDefault();
        textarea.focus();
      }}
    >
      {references ? <div className={p.references}>{references}</div> : null}
      {leading ? <div className={p.leading}>{leading}</div> : null}
      <div className={p.field}>{field}</div>
      <div className={p.action}>{action}</div>
    </form>
  );
});

/**
 * 文字折几行（最多 7 行，再多在框里滚）。一份看不见的文字副本，照文字框的字体和折行规则排一遍再数行 ——
 * 按字宽估会估少（中文标点不上行首这类规则估不出来）。量的是输入条内宽，不量文字框本身。
 */
export function usePillRows(value: string, pill: RefObject<HTMLFormElement | null>, field: RefObject<HTMLTextAreaElement | null>): number {
  const [rows, setRows] = useState(1);
  useLayoutEffect(() => {
    const element = pill.current;
    const textarea = field.current;
    if (!element || !textarea) return;
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    document.body.append(mirror);
    const measure = () => {
      const style = getComputedStyle(textarea);
      const lineHeight = parseFloat(style.lineHeight) || 20;
      Object.assign(mirror.style, {
        position: "fixed",
        top: "0",
        left: "-10000px",
        visibility: "hidden",
        pointerEvents: "none",
        boxSizing: "content-box",
        padding: "0",
        border: "0",
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        letterSpacing: style.letterSpacing,
        wordSpacing: style.wordSpacing,
        lineHeight: `${lineHeight}px`,
        whiteSpace: "pre-wrap",
        wordBreak: style.wordBreak,
        overflowWrap: style.overflowWrap,
        lineBreak: style.lineBreak,
      });
      // 末尾补一个零宽字符：最后是换行时，那个空行也要算上。
      mirror.textContent = `${value}​`;
      // 文字占满一整行：输入条内宽 − 左右内边距（8 + 8）− 文字左右再让的 8 + 8。
      mirror.style.width = `${Math.max(40, element.clientWidth - 32)}px`;
      const next = Math.min(7, Math.max(1, Math.round(mirror.offsetHeight / lineHeight)));
      setRows((previous) => (previous === next ? previous : next));
    };
    measure();
    let size = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === size) return;
      size = element.clientWidth;
      measure();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      mirror.remove();
    };
  }, [value, pill, field]);
  return rows;
}

/**
 * 频道开关（底行左边）：一条浅色轨道里几颗钮，图标 + 名字、整颗都能点；当前那颗是实心的频道色、白字。
 * 另一颗右上角挂那个频道的未读数。`onPress` 不管按的是不是当前那颗都会调：窄屏浮层关着时，按当前那颗也要
 * 把浮层打开（C-06）。
 */
export function ChannelSwitch({ channels, channel, onPress }: { channels: ConversationChannel[]; channel: string; onPress: (id: string) => void }) {
  const current = channels.find((item) => item.id === channel) ?? channels[0];
  return (
    <ToggleButtonGroup
      className={p.switch}
      data-channel-switch
      aria-label="这句话发给谁"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[current?.id ?? channel]}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (typeof next === "string") onPress(next);
      }}
    >
      {channels.map((item) => {
        const isCurrent = item.id === current?.id;
        const badge = isCurrent ? "" : formatUnread(item.unread);
        return (
          <ToggleButton
            key={item.id}
            id={item.id}
            className={p.segment}
            data-kind={item.kind}
            aria-label={`${item.label}${isCurrent ? "" : unreadPhrase(item.unread)}`}
            onPress={() => {
              if (isCurrent) onPress(item.id);
            }}
          >
            {item.kind === "agent" ? <TianshuMark className={p.mark} /> : <Users size={16} strokeWidth={1.8} aria-hidden />}
            <span className={p.name} aria-hidden>
              {item.label}
            </span>
            {badge ? (
              <span className={p.badge} data-kind={item.kind} aria-hidden>
                {badge}
              </span>
            ) : null}
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}

export type ActionState = "mic" | "send" | "stop";

/** 右端那颗钮里的三个图标一直都在，按状态交叉淡入 —— 钮是同一个元素，底色也跟着过渡。 */
function ActionIcons() {
  return (
    <>
      <span className={p.icon} data-icon="mic" aria-hidden>
        <Mic size={18} strokeWidth={1.8} />
      </span>
      <span className={p.icon} data-icon="send" aria-hidden>
        <ArrowUp size={18} strokeWidth={2.2} />
      </span>
      <span className={p.icon} data-icon="stop" aria-hidden>
        <Square size={13} strokeWidth={2.4} fill="currentColor" />
      </span>
    </>
  );
}

/**
 * 右端那颗钮：语音没接入，所以麦克风态是灰的、按不下去，悬停写「语音对话尚未接入」（禁用的钮收不到悬停，
 * 提示挂在外面那一层）。有字时是发送，回答中是停止。
 */
export function ComposerAction({ state, onStop, isDisabled = false, sendLabel = "发送", unavailable = "语音对话尚未接入" }: { state: ActionState; onStop?: () => void; isDisabled?: boolean; sendLabel?: string; unavailable?: string }) {
  const label = state === "stop" ? "停止本次回答" : state === "send" ? sendLabel : unavailable;
  return (
    <span className={p.actionSlot} title={state === "mic" ? unavailable : undefined}>
      <Button
        isIconOnly
        className={p.actionButton}
        data-state={state}
        type={state === "send" ? "submit" : "button"}
        isDisabled={state === "mic" || (state === "send" && isDisabled) || (state === "stop" && !onStop)}
        onPress={state === "stop" ? onStop : undefined}
        aria-label={label}
      >
        <ActionIcons />
      </Button>
    </span>
  );
}
