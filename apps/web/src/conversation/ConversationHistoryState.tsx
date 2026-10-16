"use client";

import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import type { ConversationData } from "./useConversation";
import s from "@/styles/conversation-transcript.module.css";

type HistoryView = Pick<ConversationData, "messages" | "streaming" | "historyStatus" | "historyError" | "retryHistory">;

/**
 * 对话记录读到哪一步：正在载入、没读到（可重试）、真的没有记录（`empty`，由调用方给：全局欢迎语 / 右列「暂无消息」）。
 * 没读到不画成「暂无消息」；已显示的消息照常留着，提示只接在它们下面，重试不动输入草稿和待发附件。
 */
export function ConversationHistoryState({ data, empty }: { data: HistoryView; empty: ReactNode }) {
  const shown = data.messages.length > 0;
  if (data.historyStatus === "loading") {
    return (
      <p className={s.historyLoading} role="status" data-testid="conversation-history-loading">
        {shown ? "正在刷新对话记录…" : "正在载入对话记录…"}
      </p>
    );
  }
  if (data.historyStatus === "error") {
    const lead = shown ? "对话记录没有刷新成功，已显示的内容仍保留。" : "对话记录没有载入，这不代表没有记录。";
    return (
      <div className={s.historyError} role="alert" data-testid="conversation-history-error">
        <p>{data.historyError ? `${lead} ${data.historyError}` : lead}</p>
        <HeroButton variant="ghost" size="sm" type="button" onPress={data.retryHistory} aria-label="重试载入对话记录">
          <RotateCw size={13} aria-hidden />
          重试
        </HeroButton>
      </div>
    );
  }
  return !shown && !data.streaming ? <>{empty}</> : null;
}

/** 这条对话记录归谁：全局对话，或当前对象（都只属于本人）。 */
export function conversationOwner(scope: string, label: string): { global: boolean; short: string; full: string } {
  const global = scope === "global";
  return { global, short: global ? "全局对话" : "当前对象", full: global ? "全局对话" : `当前对象 · ${label}` };
}
