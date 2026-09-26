"use client";

import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { TianshuMark } from "@/components/TianshuMark";
import { AttachButton, AttachmentStatus } from "./ConversationAttachments";
import x from "@/styles/conversation-attachments.module.css";
import { ConversationNotice, ConversationThinking, ConversationTurns } from "./Transcript";
import type { ConversationData } from "./useConversation";
import w from "@/styles/app-shell.module.css";
import t from "@/styles/conversation-transcript.module.css";

/**
 * 对话记录（clark `ConversationHistorySheet`）：从输入条升起的深色阅读面，非模态。
 * 页头动作位放天枢独有的会话与附件；clark 的静音键属于语音朗读，天枢没有，不放。
 */
export function ConversationHistorySheet({ data, label, global, onClose }: { data: ConversationData; label: string; global: boolean; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  const empty = data.messages.length === 0 && !data.streaming;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [data.messages, data.streaming]);

  return (
    <section className={`${w.sheet} ${w.historySheet}`} role="dialog" aria-modal="false" aria-label={`${label}的对话记录`} data-testid="conversation-sheet" data-empty={empty}>
      <div className={w.sheetHandle} aria-hidden />
      <header className={w.sheetHeader}>
        <div className={w.chatBrand}>
          <TianshuMark className={w.chatBrandMark} />
          <div>
            <small>独立对话 · {label}</small>
            <h2>天枢</h2>
          </div>
        </div>
        <div className={w.historyHeaderActions}>
          <AttachButton data={data} className={x.toolButton} />
          <HeroButton variant="ghost" size="sm" isIconOnly onPress={onClose} aria-label="收起对话记录">
            <ChevronDown size={24} />
          </HeroButton>
        </div>
      </header>
      <div className={w.sheetScroll}>
        <div className={w.historyContent}>
          {data.messages.length ? (
            <ConversationTurns messages={data.messages} />
          ) : !data.streaming ? (
            <div className={w.chatWelcome}>
              <p>{global ? "从你正在想的事情开始。" : `从“${label}”里你最想弄清的地方开始。`}</p>
            </div>
          ) : null}
          {data.error && !data.streaming ? <ConversationNotice text={data.error} /> : null}
          <AttachmentStatus data={data} className={t.meta} />
          {data.streaming ? <ConversationThinking stage={data.stage} startedAt={data.startedAt} onStop={data.stop} /> : null}
          <div ref={end} />
        </div>
      </div>
    </section>
  );
}
