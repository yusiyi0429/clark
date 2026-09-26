"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TextArea as HeroTextArea } from "@heroui/react";
import { ArrowUp, ArrowUpRight, History, Keyboard, Mic, Square, X } from "lucide-react";
import clsx from "clsx";
import type { Card } from "@/lib/api/client";
import { HeroButton } from "@/components/HeroButton";
import { ReferenceTray } from "./references";
import { STAGE_COPY } from "./Transcript";
import type { ConversationData } from "./useConversation";
import d from "@/styles/conversation-dock.module.css";

/**
 * 全局输入条（clark `workspace.tsx` 614–640）：历史、键盘/语音切换、两个常驻输入面、发送。
 * 语音未接入：主按钮显示「语音未接入」，点它改用键盘；从不请求麦克风（SSOT C-07）。
 * 回答进行中主按钮变「停止回答」。
 */
export function ConversationDock({
  data,
  label,
  global,
  detail,
  keyboard,
  onKeyboardChange,
  historyOpen,
  onToggleHistory,
  references,
  onRemoveReference,
  onClearReferences,
  onRestoreReferences,
  pendingGlobalReferences = 0,
  onDiscussGlobal,
  onHeightChange,
  prefill,
  onPrefillUsed,
}: {
  data: ConversationData;
  label: string;
  /** 全局对话：引用只属于它（clark：引用为全局对话准备草稿）。 */
  global: boolean;
  /** 在二级页里（外壳把输入条移进右侧对话列）。 */
  detail: boolean;
  keyboard: boolean;
  onKeyboardChange: (keyboard: boolean) => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  references: Card[];
  onRemoveReference: (id: string) => void;
  onClearReferences: () => void;
  onRestoreReferences: (cards: Card[]) => void;
  /** 二级页上已引用、待在全局讨论的卡片数。 */
  pendingGlobalReferences?: number;
  onDiscussGlobal?: () => void;
  /** 输入条占用的高度（对话列据此给日志留出底部空间）。 */
  onHeightChange?: (height: number) => void;
  /** 引用追问（clark onQuote → setInput(`关于“…”，`)）：替换输入并聚焦。 */
  prefill?: { text: string; nonce: number } | null;
  onPrefillUsed?: () => void;
}) {
  const draftKey = `tianshu-conversation-draft-v1:${data.scope}`;
  const [input, setInput] = useState("");
  const [composerHeight, setComposerHeight] = useState(36);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [caption, setCaption] = useState("");
  const [captionDismissed, setCaptionDismissed] = useState(false);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const wasKeyboard = useRef(keyboard);
  /** 键盘面收起时输入框的单行宽度：展开后输入框变宽，仍按它判断，避免展开 ⇄ 收起来回跳。 */
  const lineWidth = useRef(0);
  const activeReferences = global ? references : [];
  const hasTray = activeReferences.length > 0 || data.attachments.length > 0;
  const busy = data.streaming;

  // 草稿按对话范围保存（C-03：切换对象或频道后不串草稿），关闭和改变宽度不丢。
  useEffect(() => {
    try {
      setInput(localStorage.getItem(draftKey) ?? "");
    } catch {
      /* 存储不可用时只在本页保留草稿 */
    }
  }, [draftKey]);
  const updateInput = (value: string) => {
    setInput(value);
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch {
      /* 同上 */
    }
  };

  // 一次回答或一次失败说明占据气泡（clark：caption 显示最近一轮）。
  useEffect(() => {
    if (!data.lastReply) return;
    setCaption(data.lastReply.text);
    setCaptionDismissed(false);
  }, [data.lastReply]);
  useEffect(() => {
    if (!data.error) return;
    setCaption(data.error);
    setCaptionDismissed(false);
  }, [data.error]);

  useEffect(() => {
    if (!prefill) return;
    updateInput(prefill.text);
    // 用过即清（清掉会让本 effect 再跑一次，所以聚焦这一帧不能在清理里取消）。
    onPrefillUsed?.();
    requestAnimationFrame(() => {
      const element = inputElement.current;
      element?.focus({ preventScroll: true });
      element?.setSelectionRange(prefill.text.length, prefill.text.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只响应新的引用
  }, [prefill?.nonce]);

  // 进入键盘面聚焦输入；离开时焦点回到切换键。
  useEffect(() => {
    if (keyboard === wasKeyboard.current) return;
    wasKeyboard.current = keyboard;
    const frame = requestAnimationFrame(() => {
      if (keyboard) inputElement.current?.focus({ preventScroll: true });
      else modeButton.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboard]);

  // 多行形变：按字宽判断是否展开，展开后高度随内容 76–196（clark workspace.tsx:452）。
  useLayoutEffect(() => {
    const element = inputElement.current;
    if (!element) return;
    if (keyboard && !composerExpanded && element.clientWidth) lineWidth.current = element.clientWidth;
    const layer = element.closest<HTMLElement>('[data-testid="global-controls"]');
    const layerWidth = layer?.clientWidth || 560;
    const dockWidth = hasTray ? layerWidth : window.innerWidth >= 1800 ? Math.min(600, layerWidth) : window.innerWidth <= 1000 ? layerWidth : Math.min(560, layerWidth);
    const canvas = document.createElement("canvas");
    const context2d = canvas.getContext("2d");
    const style = getComputedStyle(element);
    // 带 font-feature-settings 时计算样式的 font 简写是空串，canvas 会退回 10px 默认字体；逐项拼出来才量得准。
    if (context2d) context2d.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const shouldExpand =
      input.includes("\n") || (!!input && (context2d?.measureText(input).width || 0) > Math.max(80, lineWidth.current ? lineWidth.current - 24 : dockWidth - 132));
    setComposerExpanded((previous) => (previous === shouldExpand ? previous : shouldExpand));
    if (!shouldExpand) {
      setComposerHeight(36);
      return;
    }
    element.style.height = "0px";
    const next = Math.min(196, Math.max(76, element.scrollHeight));
    element.style.height = "";
    setComposerHeight((previous) => (previous === next ? previous : next));
  }, [input, keyboard, composerExpanded, hasTray]);

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    const sentReferences = activeReferences.map((card) => ({ cardId: card.id, version: card.version }));
    const keptInput = input;
    const keptReferences = activeReferences;
    setCaption(text);
    setCaptionDismissed(false);
    updateInput("");
    if (keptReferences.length) onClearReferences();
    const accepted = await data.send(text, sentReferences);
    // C-04：服务端还没接收就失败时，把输入与引用放回去，不先清空后提示失败。
    if (!accepted) {
      updateInput(keptInput);
      if (keptReferences.length) onRestoreReferences(keptReferences);
    }
  }

  useEffect(() => {
    onHeightChange?.(keyboard && composerExpanded ? composerHeight + 12 : 56);
  }, [onHeightChange, keyboard, composerExpanded, composerHeight]);

  const placeholder = activeReferences.length ? "围绕引用的卡片，聊聊你的判断…" : detail ? "继续聊聊…" : "输入你的想法…";
  const captionText = caption || (busy ? `${STAGE_COPY[data.stage]}…` : "");
  const dockHeight = keyboard ? (composerExpanded ? composerHeight + (hasTray ? 48 : 12) : hasTray ? 84 : 48) : undefined;

  return (
    <div
      className={d.layer}
      data-testid="global-controls"
      data-conversation-context={data.scope}
      data-detail-context={detail}
      data-has-references={hasTray}
      data-history-open={historyOpen}
      data-composer={keyboard ? "keyboard" : "voice"}
      data-scoped-context={!global || pendingGlobalReferences > 0}
    >
      {pendingGlobalReferences > 0 && onDiscussGlobal ? (
        <div className={clsx(d.contextLabel, d.referenceContext)}>
          <HeroButton
            variant="ghost"
            size="sm"
            type="button"
            onPress={onDiscussGlobal}
            data-testid="discuss-global-references"
            aria-label={`在全局讨论已引用的 ${pendingGlobalReferences} 张卡片`}
            title={references.map((card) => card.title).join("\n")}
          >
            在全局讨论 · {pendingGlobalReferences}
            <ArrowUpRight size={12} />
          </HeroButton>
        </div>
      ) : null}
      {!captionDismissed && !historyOpen && captionText ? (
        <div className={d.caption}>
          <HeroButton variant="ghost" size="sm" data-ts-layout="true" type="button" className={d.captionBody} onPress={onToggleHistory} aria-label={`查看“${label}”的完整对话记录`}>
            <span aria-live="polite">{captionText}</span>
          </HeroButton>
          <HeroButton variant="ghost" size="sm" isIconOnly type="button" className={d.captionClose} onPress={() => setCaptionDismissed(true)} aria-label="关闭本次对话气泡">
            <X size={15} />
          </HeroButton>
        </div>
      ) : null}
      <div
        className={clsx(d.dock, keyboard && d.typing, keyboard && composerExpanded && d.composerExpanded, busy && d.thinking)}
        data-testid="conversation-dock"
        data-mode={keyboard ? "keyboard" : "voice"}
        data-composer-expanded={composerExpanded}
        style={dockHeight ? { height: dockHeight } : undefined}
      >
        <ReferenceTray
          items={activeReferences}
          onRemove={onRemoveReference}
          onClear={onClearReferences}
          attachments={data.attachments}
          onRemoveAttachment={data.removeAttachment}
        />
        <HeroButton
          variant="ghost"
          size="sm"
          isIconOnly
          className={clsx(d.iconButton, d.leadingButton)}
          onPress={onToggleHistory}
          aria-label={historyOpen ? "收起当前对话记录" : `查看“${label}”的对话记录`}
          aria-expanded={historyOpen}
          title={historyOpen ? "收起当前对话记录" : `查看“${label}”的对话记录`}
        >
          <span className={clsx(d.leadingIcon, d.historyIcon)} aria-hidden>
            <History size={20} strokeWidth={1.7} />
          </span>
        </HeroButton>
        <HeroButton
          variant="ghost"
          size="sm"
          isIconOnly
          className={clsx(d.iconButton, d.modeButton)}
          onPress={() => onKeyboardChange(!keyboard)}
          ref={modeButton}
          aria-label={keyboard ? "切换到按住说话" : "切换键盘输入"}
          aria-expanded={keyboard}
          title={keyboard ? "切换到按住说话" : "语音暂不可用，使用键盘继续"}
        >
          <span className={clsx(d.modeIcon, d.keyboardIcon)} aria-hidden>
            <Keyboard size={20} strokeWidth={1.7} />
          </span>
          <span className={clsx(d.modeIcon, d.microphoneIcon)} aria-hidden>
            <Mic size={20} strokeWidth={1.7} />
          </span>
        </HeroButton>
        <div className={d.content} style={{ height: keyboard && composerExpanded ? composerHeight : 36 }}>
          <div className={d.voiceLayer} aria-hidden={keyboard} inert={keyboard}>
            <button
              type="button"
              className={d.holdButton}
              data-failed={!busy}
              data-busy={busy}
              onClick={() => (busy ? data.stop() : onKeyboardChange(true))}
              aria-label={busy ? "停止本次回答" : "语音未接入，改用键盘"}
            >
              {busy ? <Square size={16} strokeWidth={2.2} aria-hidden /> : <Mic size={20} strokeWidth={1.8} aria-hidden />}
              <span>{busy ? "停止回答" : "语音未接入"}</span>
            </button>
          </div>
          <div className={d.textLayer} aria-hidden={!keyboard} inert={!keyboard}>
            <form
              className={d.inputForm}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <HeroTextArea
                ref={inputElement}
                rows={1}
                value={input}
                onChange={(event) => updateInput(event.target.value)}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) {
                    // 组词中的 Escape 只取消组词，不向外冒泡（C-06）。
                    if (event.key === "Escape") event.stopPropagation();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    onKeyboardChange(false);
                    return;
                  }
                  if (event.key !== "Enter" || event.shiftKey) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
                placeholder={placeholder}
                aria-label={global ? "全局对话输入" : `${label}对话输入`}
              />
              {busy ? (
                <HeroButton variant="ghost" size="sm" isIconOnly className={d.sendButton} type="button" onPress={data.stop} aria-label="停止本次回答" data-ready="true">
                  <Square size={16} />
                </HeroButton>
              ) : (
                <HeroButton
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  className={d.sendButton}
                  type="submit"
                  aria-label={input.trim() ? "发送" : "输入内容后发送"}
                  data-ready={Boolean(input.trim())}
                  isDisabled={!input.trim()}
                >
                  <ArrowUp size={19} strokeWidth={2} />
                </HeroButton>
              )}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
