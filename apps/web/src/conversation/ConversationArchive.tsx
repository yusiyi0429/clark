"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { readQuotedMessage } from "./quotes";
import { ConversationTurns } from "./Transcript";
import { conversationEndpoints, type ConversationData, type Message } from "./useConversation";
import s from "@/styles/conversation-transcript.module.css";

/**
 * 新建对话与历史对话（存在感越低越好：这是工程师的习惯，一号位平时不需要它）。
 * - 「+」：对话区头部一颗 13px 的低对比度灰色小图标，悬停提示「新对话」，不弹确认。只在当前对话有内容时出现；
 *   点了当前对话归档（不删除），界面换成空白对话。
 * - 历史对话入口默认看不到：只有当前对话为空、且有归档过的对话时，空白处多一行很淡的「查看历史对话」。
 * - 历史对话：一个简单列表（首问前 20 字 + 日期）；点开只读回看，可以「切回这段对话继续」。
 * 首页全局对话层与战场页右栏共用。
 */

type SwitchView = Pick<ConversationData, "messages" | "streaming"> & Partial<Pick<ConversationData, "startNew" | "switching">>;

/** 「+ 新对话」小图标：当前对话为空、或回答进行中不出现（没有可归档的，也不在一轮中途切走）。 */
export function NewConversationKey({ data, className }: { data: SwitchView; className?: string }) {
  if (!data.startNew || !data.messages.length || data.streaming) return null;
  return (
    <button type="button" className={`${s.newConversation} ${className ?? ""}`} title="新对话" aria-label="新对话"
      disabled={data.switching || undefined} onClick={() => void data.startNew?.()} data-testid="conversation-new">
      <Plus size={13} strokeWidth={1.8} aria-hidden />
    </button>
  );
}

/** 当前对话为空时那一行很淡的「查看历史对话」（没有归档过的对话就不出现）。 */
export function ArchiveEntry({ data, onOpen }: { data: Pick<ConversationData, "messages" | "streaming"> & Partial<Pick<ConversationData, "archivedCount">>; onOpen: () => void }) {
  if (!data.archivedCount || data.messages.length || data.streaming) return null;
  return (
    <button type="button" className={s.archiveEntry} onClick={onOpen} data-testid="conversation-archive-entry">查看历史对话</button>
  );
}

/** 列表上的标题：首问（去掉页面前缀与引用格式）的前 20 字。 */
export function archiveTitle(firstQuestion: string): string {
  const text = readQuotedMessage(firstQuestion).message.replace(/\s+/g, " ").trim();
  if (!text) return "未命名对话";
  const chars = [...text];
  return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : text;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" });
/** 列表与回看里的日期：几月几日 时:分（北京时间；各环境的中文日期格式不一，按各段拼）。 */
export function archiveDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const part = Object.fromEntries(DATE.formatToParts(at).map((item) => [item.type, item.value]));
  return `${Number(part.month)}月${Number(part.day)}日 ${part.hour}:${part.minute}`;
}

export type ArchivedItem = { id: string; firstQuestion: string; startedAt: string; lastAt: string; archivedAt: string; messageCount: number };

/** 历史对话面板开没开（宿主持有）；回答开始时自动收起，回到当前对话。 */
export function useArchivePanel(streaming: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (streaming) setOpen(false);
  }, [streaming]);
  return { open, show: useCallback(() => setOpen(true), []), hide: useCallback(() => setOpen(false), []) };
}

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error" };

/**
 * 历史对话面板：列表 → 只读回看 → 切回继续。占对话正文的位置，输入条照常在下面；在这里发出的消息进当前对话（面板随之收起）。
 */
export function ConversationArchive({ data, onClose }: {
  data: Pick<ConversationData, "scope"> & Partial<Pick<ConversationData, "restoreArchived" | "switching" | "switchError">>;
  onClose: () => void;
}) {
  const [list, setList] = useState<Load<ArchivedItem[]>>({ status: "loading" });
  const [viewing, setViewing] = useState<{ item: ArchivedItem; messages: Load<Message[]> } | null>(null);
  const run = useRef(0);

  const loadList = useCallback(async () => {
    const id = ++run.current;
    setList({ status: "loading" });
    try {
      const response = await fetch(conversationEndpoints.archived(data.scope), { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { conversations?: ArchivedItem[] };
      if (id === run.current) setList({ status: "ready", value: Array.isArray(body.conversations) ? body.conversations : [] });
    } catch {
      if (id === run.current) setList({ status: "error" });
    }
  }, [data.scope]);
  useEffect(() => {
    void loadList();
    return () => { run.current += 1; };
  }, [loadList]);

  const openItem = useCallback(async (item: ArchivedItem) => {
    const id = ++run.current;
    setViewing({ item, messages: { status: "loading" } });
    try {
      const response = await fetch(conversationEndpoints.archivedMessages(data.scope, item.id), { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { messages?: Message[] };
      if (id === run.current) setViewing({ item, messages: { status: "ready", value: Array.isArray(body.messages) ? body.messages : [] } });
    } catch {
      if (id === run.current) setViewing({ item, messages: { status: "error" } });
    }
  }, [data.scope]);

  const resume = async (item: ArchivedItem) => {
    if (await data.restoreArchived?.(item.id)) onClose();
  };

  if (viewing) {
    const { item, messages } = viewing;
    return (
      <section className={s.archive} aria-label="历史对话回看" data-testid="conversation-archive-replay">
        <div className={s.archiveHead}>
          <span>只读回看 · {archiveDate(item.startedAt)}</span>
          <span className={s.archiveActions}>
            <button type="button" onClick={() => setViewing(null)}>返回列表</button>
            {data.restoreArchived ? (
              <button type="button" onClick={() => void resume(item)} disabled={data.switching || undefined} data-testid="conversation-archive-resume">切回这段对话继续</button>
            ) : null}
          </span>
        </div>
        {data.switchError ? <p className={s.archiveNote} role="alert">{data.switchError}</p> : null}
        {messages.status === "loading" ? <p className={s.historyLoading} role="status">正在载入这段对话…</p>
          : messages.status === "error" ? <p className={s.archiveNote} role="alert">这段对话没有载入，可以返回列表后再试。</p>
          : <ConversationTurns messages={messages.value} />}
      </section>
    );
  }

  return (
    <section className={s.archive} aria-label="历史对话" data-testid="conversation-archive">
      <div className={s.archiveHead}>
        <span>历史对话</span>
        <span className={s.archiveActions}>
          <button type="button" onClick={onClose}>返回当前对话</button>
        </span>
      </div>
      {list.status === "loading" ? <p className={s.historyLoading} role="status">正在载入历史对话…</p>
        : list.status === "error" ? (
          <p className={s.archiveNote} role="alert">历史对话没有载入。<button type="button" className={s.archiveInline} onClick={() => void loadList()}>重试</button></p>
        ) : list.value.length === 0 ? <p className={s.archiveNote}>还没有历史对话。</p>
        : (
          <ul className={s.archiveList}>
            {list.value.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => void openItem(item)} data-testid="conversation-archive-item">
                  <span className={s.archiveTitle}>{archiveTitle(item.firstQuestion)}</span>
                  <span className={s.archiveDate}>{archiveDate(item.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
