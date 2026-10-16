"use client";

import { useEffect, useRef, useState } from "react";
import { TextArea as HeroTextArea } from "@heroui/react";
import { ArrowUpRight, Paperclip, X } from "lucide-react";
import clsx from "clsx";
import type { Card } from "@/lib/api/client";
import { HeroButton } from "@/components/HeroButton";
import { ChannelSwitch, ComposerAction, ComposerPill, pillStyles, usePillRows } from "./ComposerPill";
import { columnComposerClass, pressChannel, type ConversationChannel } from "./ConversationColumn";
import { AttachButton } from "./ConversationAttachments";
import { DictationControls } from "./DictationControls";
import { DictationMirror } from "./DictationMirror";
import { useDictation } from "./useDictation";
import type { ConversationData } from "./useConversation";
import { QuoteChips } from "./QuoteChips";
import { useAnswerOptionFill } from "./answerOptions";
import { quotedMessage, storedDraft, type QuotePrefill, type TextQuote } from "./quotes";
import d from "@/styles/conversation-dock.module.css";
import ds from "@/styles/dictation.module.css";

/**
 * 二级页右列底下的输入条（clark CEO dock 的 `data-form=pill` 形态）：两行，底行左边是频道开关，右边一颗三态钮。
 * 草稿、引用预填、发送失败放回与首页输入条（ConversationDock）同一套规则、同一个草稿键。
 * 没有群组的页面只有「天枢」一个频道：宽屏不画开关；窄屏画这一颗，它是打开对话浮层的入口。
 */
export function ColumnComposer({
  data,
  label,
  channels,
  channel,
  onChannel,
  narrow,
  mobileOpen,
  onMobileOpen,
  references,
  onDiscussGlobal,
  onHeightChange,
  prefill,
  onPrefillUsed,
  textQuotes = [],
  onRemoveQuotes,
  onRestoreQuotes,
  draftOwnerId,
  allowAttachments = true,
}: {
  data: ConversationData;
  label: string;
  channels: ConversationChannel[];
  channel: string;
  onChannel: (id: string) => void;
  narrow: boolean;
  mobileOpen: boolean;
  onMobileOpen: (open: boolean) => void;
  /** 二级页上已引用、待在全局讨论的卡片（引用只属于全局对话）。 */
  references: Card[];
  onDiscussGlobal?: () => void;
  onHeightChange: (height: number) => void;
  /** A new reference focuses the field without replacing its draft. */
  prefill?: QuotePrefill | null;
  onPrefillUsed?: (nonce?: number) => void;
  textQuotes?: TextQuote[];
  onRemoveQuotes?: (ids: string[]) => void;
  /** 发送失败放回引用（D5）。 */
  onRestoreQuotes?: (quotes: TextQuote[]) => void;
  draftOwnerId?: string;
  allowAttachments?: boolean;
}) {
  const draftKey = `tianshu-conversation-draft-v1:${draftOwnerId ? `${draftOwnerId}:` : ""}${data.scope}`;
  const [input, setInput] = useState("");
  const pill = useRef<HTMLFormElement>(null);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const rows = usePillRows(input, pill, inputElement);
  const busy = data.streaming;
  const inputVersion = useRef(0);
  const sending = useRef(false);
  const handledNonce = useRef<number | null>(null);
  const dictation = useDictation({ field: inputElement, value: input, onValue: (value) => updateInput(value) });

  // 草稿按对话范围保存（C-03：切换对象后不串草稿），关闭和改变宽度不丢。
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

  useEffect(() => {
    if (!prefill) return;
    onPrefillUsed?.(prefill.nonce);
    // 同一个预填只处理一次（开发模式下 effect 会重跑；代发与听写都不能来两次）。
    if (handledNonce.current === prefill.nonce) return;
    handledNonce.current = prefill.nonce;
    // 代一号位发出的一句（「按意见重写」）：直接发，输入框里的草稿和已挂的引用块不动；回答进行中就不发，回报没接下。
    if (prefill.send) {
      const { message, quotes, onResult } = prefill.send;
      if (busy || sending.current) {
        onResult?.(false);
        return;
      }
      void data.send(quotedMessage(message, quotes), []).then((accepted) => onResult?.(accepted), () => onResult?.(false));
      return;
    }
    // 输入条里已有草稿就不覆盖（刚换到这个频道时，存着的草稿可能还没渲染进 input）。
    if (prefill.draft && !input.trim() && !storedDraft(draftKey)) updateInput(prefill.draft);
    requestAnimationFrame(() => {
      const element = inputElement.current;
      element?.focus({ preventScroll: true });
      if (element) element.setSelectionRange(element.value.length, element.value.length);
      // 「对这一段提意见」：引用挂上后直接进入听写（首次会弹麦克风授权）；回答进行中也可以先说，说完再发。
      if (prefill.listen && !dictation.active) void dictation.start();
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

  /** ■：停下，文字留在输入框（光标在这次说的末尾），整理在后台进行。 */
  async function confirmDictation() {
    await dictation.stop();
  }

  /** ↑：等整理（最多 1.2 秒，超时发原文），整段直接发出；发不出去（回答中）时留在输入框里。 */
  async function sendDictation() {
    const next = await dictation.finish();
    if (next === null) return;
    await submit(next);
  }

  /**
   * 按下发送的这一刻文字与引用一起清空（D5）。C-04：服务端没接下时都放回去 ——
   * 不覆盖期间新写的草稿；引用交给宿主合并，不覆盖期间新加的引用。
   */
  async function submit(raw = input) {
    if (!raw.trim() || busy || sending.current) return;
    sending.current = true;
    // ■ 之后整理还没完就按了发送：等整理（最多 1.2 秒），发整理后的版本。
    const value = dictation.polishing ? await dictation.settle() : raw;
    const text = value.trim();
    if (!text) {
      sending.current = false;
      return;
    }
    const kept = value;
    const sentQuotes = textQuotes;
    updateInput("");
    const clearedVersion = inputVersion.current;
    if (sentQuotes.length) onRemoveQuotes?.(sentQuotes.map((quote) => quote.id));
    try {
      const accepted = await data.send(quotedMessage(text, sentQuotes), []);
      if (!accepted) {
        if (inputVersion.current === clearedVersion) updateInput(kept);
        if (sentQuotes.length) onRestoreQuotes?.(sentQuotes);
      }
    } finally { sending.current = false; }
  }

  const showSwitch = channels.length > 1 || narrow;
  const attachments = textQuotes.length || data.attachments.length || dictation.error ? (
    <>
      {textQuotes.length ? <QuoteChips quotes={textQuotes} onRemove={onRemoveQuotes} /> : null}
      {dictation.error ? <p role="alert" className={ds.error}>{dictation.error}</p> : null}
      {data.attachments.map((attachment) => (
        <span key={attachment.id} className={pillStyles.reference}>
          <Paperclip size={12} aria-hidden="true" />
          <span>{attachment.fileName}</span>
          <HeroButton variant="ghost" size="sm" isIconOnly type="button" onPress={() => data.removeAttachment(attachment.id)} aria-label={`移除附件 ${attachment.fileName}`}>
            <X size={13} />
          </HeroButton>
        </span>
      ))}
    </>
  ) : undefined;

  return (
    <div
      className={clsx(d.layer, columnComposerClass)}
      data-testid="global-controls"
      data-conversation-context={data.scope}
      data-detail-context="true"
      data-composer="pill"
      data-channel={channels.find((item) => item.id === channel)?.kind ?? "agent"}
    >
      {references.length > 0 && onDiscussGlobal ? (
        <div className={clsx(d.contextLabel, d.referenceContext)}>
          <HeroButton
            variant="ghost"
            size="sm"
            type="button"
            onPress={onDiscussGlobal}
            data-testid="discuss-global-references"
            aria-label={`在全局讨论已批注的 ${references.length} 项`}
            title={references.map((card) => card.title).join("\n")}
          >
            在全局讨论 · {references.length}
            <ArrowUpRight size={12} />
          </HeroButton>
        </div>
      ) : null}
      <ComposerPill
        ref={pill}
        tone="agent"
        dictating={dictation.active}
        references={attachments}
        onHeight={onHeightChange}
        onSubmit={() => {
          if (composing.current) return;
          // 听写中回车 = ↑（等整理后发出）。
          if (dictation.phase === "listening") void sendDictation();
          else if (!dictation.active) void submit();
        }}
        leading={
          showSwitch ? (
            <ChannelSwitch channels={channels} channel={channel} onPress={(id) => pressChannel(id, { channel, onChannel, narrow, mobileOpen, onMobileOpen })} />
          ) : undefined
        }
        field={
          <>
          <DictationMirror field={inputElement} value={input} marks={dictation.marks} polishing={dictation.polishing} fresh={dictation.fresh} />
          <HeroTextArea
            ref={inputElement}
            rows={rows}
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
              if (dictation.keyDown(event)) return;
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) {
                // 组词中的 Escape 只取消组词，不向外冒泡（C-06）。
                if (event.key === "Escape") event.stopPropagation();
                return;
              }
              // C-06：输入框先退出，再轮到浮层和工作区。
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.blur();
                return;
              }
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder={dictation.phase === "finishing" ? "正在收尾…" : dictation.active ? (dictation.live ? "正在听…" : "正在录音，结束后转写…") : data.viewingMaterialEditable ? "让 Agent 改这份材料…" : "与天枢讨论…"}
            aria-label={`${label}对话输入`}
          />
          </>
        }
        action={
          dictation.active ? (
            <DictationControls dictation={dictation} onToInput={confirmDictation} onSend={sendDictation} canSend={!busy} />
          ) : (
            <>
              {allowAttachments ? <AttachButton data={data} className={pillStyles.tool} /> : null}
              <ComposerAction state={busy ? "stop" : input.trim() ? "send" : "mic"} onStop={data.stop} onMic={() => void dictation.start()} />
            </>
          )
        }
      />
    </div>
  );
}
