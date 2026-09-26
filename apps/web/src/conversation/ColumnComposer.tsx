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
import type { ConversationData } from "./useConversation";
import d from "@/styles/conversation-dock.module.css";

/**
 * 二级页右列底下的输入条（clark CEO dock 的 `data-form=pill` 形态）：两行，底行左边是频道开关，右边一颗三态钮。
 * 草稿、引用预填、发送失败放回与首页输入条（ConversationDock）同一套规则、同一个草稿键。
 * 没有群组的页面只有「我的 Agent」一个频道：宽屏不画开关；窄屏画这一颗，它是打开对话浮层的入口。
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
  /** 引用追问：替换输入并聚焦。 */
  prefill?: { text: string; nonce: number } | null;
  onPrefillUsed?: () => void;
}) {
  const draftKey = `tianshu-conversation-draft-v1:${data.scope}`;
  const [input, setInput] = useState("");
  const pill = useRef<HTMLFormElement>(null);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const rows = usePillRows(input, pill, inputElement);
  const busy = data.streaming;

  // 草稿按对话范围保存（C-03：切换对象后不串草稿），关闭和改变宽度不丢。
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

  useEffect(() => {
    if (!prefill) return;
    updateInput(prefill.text);
    onPrefillUsed?.();
    requestAnimationFrame(() => {
      const element = inputElement.current;
      element?.focus({ preventScroll: true });
      element?.setSelectionRange(prefill.text.length, prefill.text.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只响应新的引用
  }, [prefill?.nonce]);

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    const kept = input;
    updateInput("");
    // C-04：服务端还没接收就失败时，把输入放回去，不先清空后提示失败。
    if (!(await data.send(text, []))) updateInput(kept);
  }

  const showSwitch = channels.length > 1 || narrow;
  const attachments = data.attachments.length ? (
    <>
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
            aria-label={`在全局讨论已引用的 ${references.length} 张卡片`}
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
        references={attachments}
        onHeight={onHeightChange}
        onSubmit={() => {
          if (!composing.current) void submit();
        }}
        leading={
          showSwitch ? (
            <ChannelSwitch channels={channels} channel={channel} onPress={(id) => pressChannel(id, { channel, onChannel, narrow, mobileOpen, onMobileOpen })} />
          ) : undefined
        }
        field={
          <HeroTextArea
            ref={inputElement}
            rows={rows}
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
            placeholder="问你的 Agent…"
            aria-label={`${label}对话输入`}
          />
        }
        action={
          <>
            <AttachButton data={data} className={pillStyles.tool} />
            <ComposerAction state={busy ? "stop" : input.trim() ? "send" : "mic"} onStop={data.stop} />
          </>
        }
      />
    </div>
  );
}
