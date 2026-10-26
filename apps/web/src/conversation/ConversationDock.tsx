"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { TextArea as HeroTextArea } from "@heroui/react";
import { ArrowUp, ArrowUpRight, Keyboard, MessageCircle, Mic, Square, X } from "lucide-react";
import clsx from "clsx";
import type { Card } from "@/lib/api/client";
import { HeroButton } from "@/components/HeroButton";
import { ReferenceTray } from "./references";
import { AttachButton } from "./ConversationAttachments";
import { DictationControls } from "./DictationControls";
import { DictationMirror } from "./DictationMirror";
import { useDictation } from "./useDictation";
import type { ConversationData } from "./useConversation";
import { QuoteChips } from "./QuoteChips";
import { useAnswerOptionFill } from "./answerOptions";
import { VoiceKeysDialog, voiceIntroDue } from "./VoiceKeysDialog";
import { quotedMessage, storedDraft, type QuotePrefill, type TextQuote } from "./quotes";
import { useExitPresence } from "@/lib/motion";
import d from "@/styles/conversation-dock.module.css";

/** 收起打字面时附件键收窄淡出的时长：与输入条宽度过渡（conversation-dock.module.css .dock width 340ms）一致。 */
const ATTACH_EXIT_MS = 340;

/**
 * 全局输入条（clark `workspace.tsx` 614–640）：收起时只有一颗白色胶囊「对话天枢」（没有外面那层灰底），展开后是附件、小麦克风、输入框、发送。
 * 没有历史键、没有输入条上方的气泡（D2 / D6）：点「对话天枢」（或按唤醒键，见 wakeKey.ts）就是展开输入框、打开对话层，
 * 所有消息、出错说明都在对话层里；宿主把 keyboard 与对话层开合绑在一起。
 * 语音主要交给微信输入法；小麦克风是天枢自己的听写（useDictation），和附件键一样不起眼：文字边说边进输入框（带下划线，
 * 可改字），右边 [● 0:12 声波] ■ ↑；■ 停下、文字留在输入框，↑ 等整理后直接发出；听写中小麦克风变 ✕，✕ / Esc 恢复听写前的原文。
 * 听写出错交给对话层显示（onDictationError）。麦克风只在点这一下时请求。
 * 小麦克风右边的小键盘图标打开语音快捷键面板（VoiceKeysDialog）；第一次点「对话天枢」时也弹一次（触屏不弹、不出这颗键）。
 * 宽屏上输入条右边缘固定、只向左伸缩（不再横移到正中）。回答进行中发送键变「停止本次回答」。
 * 待发送的卡片引用、文字引用、附件都在输入框里文字行上方那一行（D4）。
 * memo（sameDockProps）：流式中对话数据每帧在变，输入条只看自己用到的那几项，没变就不重画。
 */
export const ConversationDock = memo(function ConversationDock({
  data,
  label,
  global,
  detail,
  keyboard,
  onKeyboardChange,
  historyOpen,
  references,
  onRemoveReference,
  onClearReferences,
  onRestoreReferences,
  pendingGlobalReferences = 0,
  onDiscussGlobal,
  onHeightChange,
  prefill,
  onPrefillUsed,
  textQuotes = [],
  onRemoveQuotes,
  onRestoreQuotes,
  onDictationError,
  dockRef,
  wide = false,
  onWideExit,
}: DockProps) {
  const draftKey = `tianshu-conversation-draft-v1:${data.scope}`;
  const [input, setInput] = useState("");
  const [composerHeight, setComposerHeight] = useState(36);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [voiceKeys, setVoiceKeys] = useState(false);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const entryButton = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const inputVersion = useRef(0);
  const sending = useRef(false);
  const wasKeyboard = useRef(keyboard);
  /** 键盘面收起时输入框的单行宽度：展开后输入框变宽，仍按它判断，避免展开 ⇄ 收起来回跳。 */
  const lineWidth = useRef(0);
  const activeReferences = global ? references : [];
  /** 卡片引用或附件：输入条按整宽画。 */
  const hasReferences = activeReferences.length > 0 || data.attachments.length > 0;
  /** 输入框里文字行上方那一行（卡片引用、附件、文字引用，D4）。 */
  const hasTray = hasReferences || textQuotes.length > 0;
  const busy = data.streaming;
  /** 收起打字面：附件键、小麦克风先留着、随输入条一起收窄淡出，输入条宽度连续地缩回主按钮（不在一帧里跳）。 */
  const attach = useExitPresence(keyboard, ATTACH_EXIT_MS);
  const dictation = useDictation({ field: inputElement, value: input, onValue: (value) => updateInput(value) });

  // 草稿按对话范围保存（C-03：切换对象或频道后不串草稿），关闭和改变宽度不丢。
  useEffect(() => {
    try {
      setInput(localStorage.getItem(draftKey) ?? "");
    } catch {
      /* 存储不可用时只在本页保留草稿 */
    }
  }, [draftKey]);
  const updateInput = (value: string) => {
    inputVersion.current++;
    setInput(value);
    dictation.clearError();
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch {
      /* 同上 */
    }
  };

  // 听写出错（没授权、没听清）说在对话层里（D6）。
  useEffect(() => {
    onDictationError?.(dictation.error);
  }, [dictation.error, onDictationError]);

  useEffect(() => {
    if (!prefill) return;
    // 用过即清（清掉会让本 effect 再跑一次，所以聚焦这一帧不能在清理里取消）。
    onPrefillUsed?.(prefill.nonce);
    // 输入条里已有草稿就不覆盖（刚换到这个频道时，存着的草稿可能还没渲染进 input）。
    if (prefill.draft && !input.trim() && !storedDraft(draftKey)) updateInput(prefill.draft);
    requestAnimationFrame(() => {
      const element = inputElement.current;
      element?.focus({ preventScroll: true });
      if (element) element.setSelectionRange(element.value.length, element.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只响应新的引用
  }, [prefill?.nonce]);

  // 回答末尾的选项：把「选择：{方案名}」填进输入框并聚焦，不发送，由 CEO 自己补充后发出。
  useAnswerOptionFill(data.scope, (text) => {
    updateInput(text);
    requestAnimationFrame(() => {
      const element = inputElement.current;
      element?.focus({ preventScroll: true });
      if (element) element.setSelectionRange(element.value.length, element.value.length);
    });
  });

  // 进入键盘面聚焦输入；离开时焦点回到主按钮。
  useEffect(() => {
    if (keyboard === wasKeyboard.current) return;
    wasKeyboard.current = keyboard;
    const frame = requestAnimationFrame(() => {
      if (keyboard) inputElement.current?.focus({ preventScroll: true });
      else entryButton.current?.focus({ preventScroll: true });
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
    const dockWidth = hasReferences ? layerWidth : window.innerWidth >= 1800 ? Math.min(600, layerWidth) : window.innerWidth <= 1000 ? layerWidth : Math.min(560, layerWidth);
    const canvas = document.createElement("canvas");
    const context2d = canvas.getContext("2d");
    const style = getComputedStyle(element);
    // 带 font-feature-settings 时计算样式的 font 简写是空串，canvas 会退回 10px 默认字体；逐项拼出来才量得准。
    if (context2d) context2d.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    // 听写时输入框照样随文字长高（单行时右边是 [● 0:12 声波] ■ ↑，输入框窄一些，lineWidth 按当时的宽度量）。
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
  }, [input, keyboard, composerExpanded, hasReferences, dictation.active]);

  /**
   * ■：停下，文字留在输入框（光标在这次说的末尾），整理在后台进行、好了原地替换。
   * 没听清：留在打字面，说明在对话层里（D6）；不缩回，免得说明跟着对话层一起收走。
   */
  async function confirmDictation() {
    await dictation.stop();
  }

  /** ↑：等整理（最多 1.2 秒，超时发原文），整段直接发出（对话层开着，回答就在里面）。发不出去时文字留在输入框里。 */
  async function sendDictation() {
    const next = await dictation.finish();
    if (next === null) return;
    await submit(next);
  }

  /**
   * 发送；返回服务端是否接下了。按下的这一刻文字、卡片引用、文字引用一起清空（D5）；
   * 服务端没接下时都放回去（C-04）：不覆盖期间新写的草稿，引用由宿主合并、不覆盖期间新加的。
   */
  async function submit(raw = input): Promise<boolean> {
    if (!raw.trim() || busy || sending.current) return false;
    sending.current = true;
    // ■ 之后整理还没完就按了发送：等整理（最多 1.2 秒），发整理后的版本。
    const value = dictation.polishing ? await dictation.settle() : raw;
    const text = value.trim();
    if (!text) {
      sending.current = false;
      return false;
    }
    const sentReferences = activeReferences.map((card) => ({ cardId: card.id, version: card.version, kind: card.kind, title: card.title }));
    const keptInput = value;
    const keptReferences = activeReferences;
    const sentQuotes = textQuotes;
    updateInput("");
    const clearedVersion = inputVersion.current;
    if (keptReferences.length) onClearReferences();
    if (sentQuotes.length) onRemoveQuotes?.(sentQuotes.map((quote) => quote.id));
    try {
      const accepted = await data.send(quotedMessage(text, sentQuotes), sentReferences);
      if (!accepted) {
        if (inputVersion.current === clearedVersion) updateInput(keptInput);
        if (keptReferences.length) onRestoreReferences(keptReferences);
        if (sentQuotes.length) onRestoreQuotes?.(sentQuotes);
      }
      return accepted;
    } finally { sending.current = false; }
  }

  useEffect(() => {
    onHeightChange?.(keyboard && composerExpanded ? composerHeight + 12 : 56);
  }, [onHeightChange, keyboard, composerExpanded, composerHeight]);

  const placeholder =
    dictation.phase === "finishing" ? "正在收尾…" : dictation.active ? (dictation.live ? "正在听…" : "正在录音，结束后转写…") : activeReferences.length ? "围绕批注的内容输入问题或判断…" : detail ? "继续讨论…" : "输入问题或指令…";
  const dockHeight = keyboard ? (composerExpanded ? composerHeight + (hasTray ? 48 : 12) : hasTray ? 84 : 48) : undefined;

  return (
    <div
      className={d.layer}
      data-testid="global-controls"
      data-conversation-context={data.scope}
      data-detail-context={detail}
      data-has-references={hasReferences}
      data-has-tray={hasTray}
      data-history-open={historyOpen}
      data-wide={wide || undefined}
      data-history-status={data.historyStatus}
      data-composer={keyboard ? "keyboard" : "entry"}
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
            aria-label={`在全局讨论已批注的 ${pendingGlobalReferences} 项`}
            title={references.map((card) => card.title).join("\n")}
          >
            在全局讨论 · {pendingGlobalReferences}
            <ArrowUpRight size={12} />
          </HeroButton>
        </div>
      ) : null}
      <div
        ref={dockRef}
        className={clsx(d.dock, keyboard && d.typing, keyboard && composerExpanded && d.composerExpanded, busy && d.thinking)}
        data-testid="conversation-dock"
        data-mode={keyboard ? "keyboard" : "entry"}
        data-composer-expanded={composerExpanded}
        style={dockHeight ? { height: dockHeight } : undefined}
      >
        <ReferenceTray
          items={activeReferences}
          onRemove={onRemoveReference}
          onClear={onClearReferences}
          attachments={data.attachments}
          onRemoveAttachment={data.removeAttachment}
          quotes={textQuotes.length ? <QuoteChips quotes={textQuotes} onRemove={onRemoveQuotes} /> : null}
        />
        {/* 打字面左边是 [附件] [小麦克风]（D2），跟着打字面淡入；小麦克风是天枢自己的听写，听写中变 ✕ 取消。 */}
        {attach.mounted ? <AttachButton data={data} className={clsx(d.iconButton, d.attachButton, attach.leaving && d.attachLeaving)} /> : null}
        {attach.mounted ? (
          <HeroButton
            variant="ghost"
            size="sm"
            isIconOnly
            className={clsx(d.iconButton, d.micButton, attach.leaving && d.attachLeaving)}
            onPress={() => (dictation.active ? dictation.cancel() : void dictation.start())}
            aria-label={dictation.active ? "取消听写" : "语音输入"}
            title={dictation.active ? "取消听写" : "语音输入"}
            data-dictating={dictation.active}
          >
            {dictation.active ? <X size={18} strokeWidth={1.9} /> : <Mic size={18} strokeWidth={1.7} />}
          </HeroButton>
        ) : null}
        {attach.mounted ? (
          <HeroButton
            variant="ghost"
            size="sm"
            isIconOnly
            className={clsx(d.iconButton, d.keysButton, attach.leaving && d.attachLeaving)}
            onPress={() => setVoiceKeys(true)}
            aria-label="语音快捷键"
            title="语音快捷键"
          >
            <Keyboard size={18} strokeWidth={1.7} />
          </HeroButton>
        ) : null}
        <div className={d.content} style={{ height: keyboard ? (composerExpanded ? composerHeight : 36) : 48 }}>
          <div className={d.entryLayer} aria-hidden={keyboard} inert={keyboard}>
            <button type="button" ref={entryButton} className={d.entryButton} onClick={() => {
              onKeyboardChange(true);
              if (voiceIntroDue()) setVoiceKeys(true);
            }} aria-expanded={false}>
              <MessageCircle size={18} strokeWidth={1.8} aria-hidden />
              <span>对话天枢</span>
            </button>
          </div>
          <div className={d.textLayer} aria-hidden={!keyboard} inert={!keyboard}>
            <form
              className={d.inputForm}
              data-dictating={dictation.active}
              onSubmit={(event) => {
                event.preventDefault();
                // 听写中回车 = ↑（等整理后发出）。
                if (dictation.phase === "listening") void sendDictation();
                else if (!dictation.active) void submit();
              }}
            >
              {/* 这次听写、还没整理的文字带下划线（镜像层叠在输入框上，只画下划线）。 */}
              <DictationMirror field={inputElement} value={input} marks={dictation.marks} polishing={dictation.polishing} fresh={dictation.fresh} />
              <HeroTextArea
                ref={inputElement}
                rows={1}
                value={input}
                onChange={(event) => {
                  if (!dictation.change(event.target.value)) updateInput(event.target.value);
                }}
                onCompositionStart={() => {
                  composing.current = true;
                  dictation.composition(true);
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                  dictation.composition(false);
                }}
                onKeyDown={(event) => {
                  // 整理替换后 Ctrl+Z：还原成整理前。
                  if (dictation.keyDown(event)) return;
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) {
                    // 组词中的 Escape 只取消组词，不向外冒泡（C-06）。
                    if (event.key === "Escape") event.stopPropagation();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    // 一层一层退：放大着先退出放大，下一次才收起对话层。
                    if (wide && onWideExit) onWideExit();
                    else onKeyboardChange(false);
                    return;
                  }
                  if (event.key !== "Enter" || event.shiftKey) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
                placeholder={placeholder}
                aria-label={global ? "全局对话输入" : `${label}对话输入`}
              />
              {dictation.active ? (
                <span className={d.dictation}>
                  <DictationControls dictation={dictation} onToInput={confirmDictation} onSend={sendDictation} canSend={!busy} showCancel={false} />
                </span>
              ) : busy ? (
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
      {voiceKeys ? <VoiceKeysDialog onClose={() => setVoiceKeys(false)} /> : null}
    </div>
  );
}, sameDockProps);

type DockProps = {
  data: ConversationData;
  label: string;
  /** 全局对话：引用只属于它（clark：引用为全局对话准备草稿）。 */
  global: boolean;
  /** 在二级页里（外壳把输入条移进右侧对话列）。 */
  detail: boolean;
  keyboard: boolean;
  onKeyboardChange: (keyboard: boolean) => void;
  /** 对话层开着（和键盘面一起开合，D6）。 */
  historyOpen: boolean;
  references: Card[];
  onRemoveReference: (id: string) => void;
  onClearReferences: () => void;
  onRestoreReferences: (cards: Card[]) => void;
  /** 二级页上已引用、待在全局讨论的卡片数。 */
  pendingGlobalReferences?: number;
  onDiscussGlobal?: () => void;
  /** 输入条占用的高度（对话列据此给日志留出底部空间）。 */
  onHeightChange?: (height: number) => void;
  /** New references remain outside the editable text. */
  prefill?: QuotePrefill | null;
  onPrefillUsed?: (nonce?: number) => void;
  textQuotes?: TextQuote[];
  onRemoveQuotes?: (ids: string[]) => void;
  /** 发送失败放回引用（D5）：由宿主合并，不覆盖期间新加的引用。 */
  onRestoreQuotes?: (quotes: TextQuote[]) => void;
  /** 听写出错（没授权、没听清）：交给对话层显示（D6）。 */
  onDictationError?: (error: string | null) => void;
  /** 对话层处于放大（深度讨论）：输入框里的 Esc 先退出放大，回到普通对话层；再按一次才收起对话层。 */
  wide?: boolean;
  onWideExit?: () => void;
  /** 输入框那一块（含引用行）：对话层的 ↓ 贴着它的上沿（D3）。 */
  dockRef?: RefObject<HTMLDivElement | null>;
};

/** 输入条（以及它里面的附件键）从对话数据里用到的几项：其余（正文、思考、进度）每帧在变，与输入条无关。 */
const DOCK_DATA_KEYS = ["scope", "attachments", "historyStatus", "streaming", "uploading", "send", "stop", "uploadFiles", "removeAttachment"] as const satisfies readonly (keyof ConversationData)[];

/** 输入条的 memo 比较：别的属性逐个比身份，data 只比 DOCK_DATA_KEYS（宿主把回调稳定住，见 ConversationHost）。 */
export function sameDockProps(previous: DockProps, next: DockProps): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)] as (keyof DockProps)[]);
  for (const key of keys) {
    if (key !== "data" && !Object.is(previous[key], next[key])) return false;
  }
  return DOCK_DATA_KEYS.every((key) => Object.is(previous.data[key], next.data[key]));
}
