"use client";

import { useEffect, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import type { ConversationData } from "./useConversation";
import { WAITING_VISIBLE_MS } from "./reconnect";
import s from "@/styles/conversation-transcript.module.css";
import { useDots } from "@/lib/home/noEllipsis";

type HistoryView = Pick<ConversationData, "messages" | "streaming" | "historyStatus" | "historyError" | "historyWaiting" | "retryHistory">;

/** 连不上、正在自己重试时：等了一会儿才写「正在连接 · N 秒」（离线时「等待网络」），短暂的抖动不换字。 */
function WaitingLabel({ waiting, fallback }: { waiting: NonNullable<HistoryView["historyWaiting"]>; fallback: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = now - waiting.since;
  if (elapsed < WAITING_VISIBLE_MS) return <>{fallback}</>;
  return <>{waiting.offline ? "等待网络" : "正在连接"} · {Math.round(elapsed / 1000)} 秒</>;
}

/**
 * 对话记录读到哪一步：正在载入（连不上时自己重试，写已等秒数）、没读到、真的没有记录（`empty`，由调用方给：全局欢迎语 / 右列「暂无消息」）。
 * 没读到不画成「暂无消息」；已显示的消息照常留着，提示只接在它们下面，重试不动输入草稿和待发附件。
 * 连接类自己重试过仍没读到只写一行灰字和「重试」；登录、权限类（historyError）才用醒目的提示。
 */
export function ConversationHistoryState({ data, empty }: { data: HistoryView; empty: ReactNode }) {
  const dots = useDots();
  const shown = data.messages.length > 0;
  if (data.historyStatus === "loading") {
    const fallback = dots(shown ? "正在刷新对话记录…" : "正在载入对话记录…");
    return (
      <p className={s.historyLoading} role="status" data-testid="conversation-history-loading">
        {data.historyWaiting ? <WaitingLabel waiting={data.historyWaiting} fallback={fallback} /> : fallback}
      </p>
    );
  }
  if (data.historyStatus === "error") {
    const paused = !data.historyError;
    return (
      <div className={paused ? s.historyPaused : s.historyError} role={paused ? "status" : "alert"} data-testid="conversation-history-error">
        <p>{data.historyError ?? (shown ? "对话记录暂未刷新" : "对话记录暂未载入")}</p>
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
