"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, ChevronDown, ChevronLeft, ChevronRight, History, Link2, Paperclip, Plus, Trash2, X } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { TianshuMark } from "@/components/TianshuMark";
import d from "@/styles/conversation-dock.module.css";
import c from "@/styles/card-references.module.css";
import w from "@/styles/app-shell.module.css";
import t from "@/styles/conversation-transcript.module.css";
import { parseSseBlock, splitSse, type ConversationEvent } from "./sse";

type ReferenceSnapshot = { cardId: string; version: number; kind: string; title: string };
type Message = { sequence: number; role: "user" | "assistant"; content: string; referencesSnapshot?: ReferenceSnapshot[] };
type Status = "idle" | "streaming" | "complete" | "failed" | "aborted";
type Session = { id: string; title?: string; createdAt?: string };
type Attachment = { id: string; fileName: string; mimeType: string };

// Signal 内容由其页面 scope 自动带入对话；Signal Card 不可作为显式引用（与 API 白名单一致）。
const REFERENCEABLE = new Set(["issue", "meeting", "monthly-plan", "mission"]);
const ATTACHMENT_ACCEPT = ".pdf,.docx,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown";
/** 扩展对话输入框的设计稿占位文案（FRH4J Exp Input）。 */
export const EXPANDED_PLACEHOLDER = "问天枢：可引用 Issue、Meeting、计划、Mission、战场、能力与 Radar，或拖入文件…";

const KIND_LABEL: Record<string, string> = { issue: "Issue", signal: "Signal", meeting: "Meeting", "monthly-plan": "月度计划", mission: "Mission", battlefield: "战场", capability: "能力", radar: "Radar" };
const ATTACHMENT_LABEL: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "text/markdown": "Markdown",
};

/** scope 前缀 → 页面名；chip 第二段用页面对象名（label）。 */
const SCOPE_PAGE: Record<string, string> = { issue: "议题", meeting: "会议", signal: "信号", "monthly-plan": "月度计划", mission: "Mission" };

/** FRH4J Exp Title：「天枢 · 全局对话」/「天枢 · 会议对话」等，从 scope 本地推导。 */
export function conversationTitleFor(scope: string): string {
  const kind = scope === "global" ? "全局" : SCOPE_PAGE[scope.split(":", 1)[0]];
  return `天枢 · ${kind ?? ""}对话`;
}

/** FRH4J Scope Chip：「作用域：页面 · 对象」；global 固定为「首页 · 全公司」。 */
export function scopeChipFor(scope: string, label: string): string {
  if (scope === "global") return "作用域：首页 · 全公司";
  const page = SCOPE_PAGE[scope.split(":", 1)[0]];
  return page ? `作用域：${page} · ${label}` : `作用域：${label}`;
}

/** FRH4J Exp Header 品牌区：天枢标题 + Scope Chip，同一行。 */
export function ExpandedHeaderBrand({ scope, label }: { scope: string; label: string }) {
  return (
    <div className={w.chatBrand}>
      <TianshuMark className={w.chatBrandMark} />
      <div className={d.expHeading}>
        <h2 className={d.expTitle}>{conversationTitleFor(scope)}</h2>
        <span className={d.scopeChip} title={scopeChipFor(scope, label)}>{scopeChipFor(scope, label)}</span>
      </div>
    </div>
  );
}

export function isAttachable(file: { name: string }): boolean {
  return /\.(pdf|docx|md)$/i.test(file.name);
}

/** 未选择会话时回退 legacy scope 消息端点；选择后走 session 端点。 */
export function messagesEndpoint(scope: string, sessionId: string | null): string {
  const base = `/api/conversations/${encodeURIComponent(scope)}`;
  return sessionId ? `${base}/sessions/${encodeURIComponent(sessionId)}/messages` : `${base}/messages`;
}

export function sessionLabel(session: { id: string; title?: string }): string {
  return session.title ?? `会话 ${session.id.slice(0, 8)}`;
}

/** 应用内删除会话确认：扩展对话与右栏会话面板共用同一弹层。 */
export function SessionDeleteConfirm({
  target,
  onCancel,
  onConfirm,
}: {
  target: { id: string; title?: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = confirmRef.current;
    if (!dialog || !target) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [target]);
  if (!target) return null;
  return (
    <dialog ref={confirmRef} className={d.deleteConfirm} aria-label="删除会话确认" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <div className={d.deleteCard}>
        <h3>删除会话</h3>
        <p>删除后「{sessionLabel(target)}」的消息与附件不再可见，且不可恢复。</p>
        <div className={d.deleteActions}>
          <button type="button" className={d.deleteGhost} onClick={onCancel}>取消</button>
          <button type="button" className={d.deleteDanger} onClick={onConfirm}>删除</button>
        </div>
      </div>
    </dialog>
  );
}

/** 扩展对话弹层：会话列 + 消息主区 + 本次引用栏 + 附件上传；纯展示，回调由 ConversationDock 注入。 */
export function ExpandedConversationDialog({
  dialogRef,
  label,
  sessions,
  activeSessionId,
  sessionError,
  dragOver,
  deleteTarget,
  rail,
  railCount = 0,
  onDismiss,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onDeleteCancel,
  onDeleteConfirm,
  onUploadFiles,
  onDragEnter,
  onDragLeave,
  header,
  transcript,
  feedback,
  tray,
  composer,
}: {
  dialogRef: { current: HTMLDialogElement | null };
  label: string;
  sessions: { id: string; title?: string; createdAt?: string }[];
  activeSessionId: string | null;
  sessionError: string | null;
  dragOver: boolean;
  /** 待确认删除的会话；非空时显示应用内删除确认弹层。 */
  deleteTarget: { id: string; title?: string } | null;
  /** 本次引用栏：右侧常驻展示当前选中的引用与附件。 */
  rail: ReactNode;
  railCount?: number;
  onDismiss: () => void;
  onCreateSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  header: ReactNode;
  transcript: ReactNode;
  feedback: ReactNode;
  tray: ReactNode;
  composer: ReactNode;
}) {
  return (
    <dialog
      ref={dialogRef}
      className={w.historySheet}
      data-tone="light"
      data-expanded="true"
      data-drag-over={dragOver || undefined}
      aria-label={`${label}的对话记录`}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onDragEnter();
      }}
      onDragLeave={() => onDragLeave()}
      onDrop={(event) => {
        event.preventDefault();
        onDragLeave();
        if (event.dataTransfer?.files?.length) onUploadFiles(event.dataTransfer.files);
      }}
    >
      {header}
      <div className={d.sessionBody}>
        <nav className={d.sessionColumn} aria-label="会话列表">
          <header className={d.sessionHead}>
            <span className={d.sessionHeadTitle}>会话</span>
            <span className={d.sessionHeadCount}>{sessions.length} 个</span>
          </header>
          <button type="button" className={d.sessionNew} onClick={onCreateSession}>
            <Plus size={14} aria-hidden="true" />
            新建会话
          </button>
          {sessionError ? <p className={d.sessionError} role="alert">{sessionError}</p> : null}
          <ul className={d.sessionList}>
            {sessions.map((session) => (
              <li key={session.id} className={d.sessionItem} data-active={session.id === activeSessionId}>
                <button
                  type="button"
                  className={d.sessionSelect}
                  aria-current={session.id === activeSessionId ? "true" : undefined}
                  onClick={() => onSelectSession(session.id)}
                >
                  <span>{sessionLabel(session)}</span>
                  {session.createdAt ? <small>{session.createdAt.slice(0, 10)}</small> : null}
                </button>
                <button type="button" className={d.sessionDelete} aria-label={`删除会话 ${sessionLabel(session)}`} onClick={() => onDeleteSession(session.id)}>
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <p className={d.sessionHint}>{activeSessionId ? "当前会话独立保存消息与附件。" : "未选择会话：消息保存到本页默认会话。"}</p>
        </nav>
        <div className={d.sessionMain}>
          <div className={w.sheetScroll}>{transcript}</div>
          <div className={w.historyComposer}>
            {feedback}
            {tray}
            {composer}
          </div>
        </div>
        <aside className={d.contextRail} aria-label="本次引用">
          {rail}
        </aside>
        {railCount ? <p className={d.contextSummary} aria-live="polite">本次已附 {railCount} 项引用或附件。</p> : null}
      </div>
      <SessionDeleteConfirm target={deleteTarget} onCancel={onDeleteCancel} onConfirm={onDeleteConfirm} />
    </dialog>
  );
}

/**
 * 底部 Conversation dock：SSE 只驱动展示状态；业务状态永远来自 Card。
 * 引用只是未发送的 Card ID/version，发送后清空，快照由后端生成。
 * 扩展对话（global）：会话列选择后走 session endpoints；未选择时会话回退到按 scope 的 legacy messages。
 */
export function ConversationDock({
  scope,
  label,
  availableCards,
  variant = "dock",
  sidebar,
}: {
  scope: string;
  label: string;
  availableCards: Card[];
  variant?: "dock" | "sidebar";
  /** sidebar 变体的外观：Meeting 保持默认深色侧栏，Signal 阅读用 pen 的浅色 400px 栏。 */
  sidebar?: { title?: string; tone?: "light"; open?: boolean; placeholder?: string };
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(sidebar?.open ?? false);
  // 右栏会话管理面板（Session Tools 展开）：在右栏内部展开，不打开全局弹层。
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  // 扩展对话的会话与附件：列表/当前会话/已上传附件只活在内存，业务持久化在后端。
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const pickerFirst = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 删除激活会话后停在「未选择会话」空态，不自动回载 legacy 消息。
  const skipLegacyReload = useRef(false);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const historyDialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sidebarRailRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const referenceable = useMemo(() => availableCards.filter((card) => REFERENCEABLE.has(card.kind)), [availableCards]);
  const selectedCards = referenceable.filter((card) => selected.includes(card.id));
  const contextLabel = label;
  const sidebarTitle = sidebar?.title ?? "会议材料对话";
  // 扩展对话用设计稿占位文案；收起时 dock 用默认、sidebar 用注入文案。
  const composerPlaceholder = historyOpen ? EXPANDED_PLACEHOLDER : (sidebar?.placeholder ?? "输入你的想法…");

  // legacy（按 scope）与 session 消息共用同一 SSE 处理；未选择会话时回退 legacy。
  const historyUrl = messagesEndpoint(scope, activeSessionId);

  const loadHistory = useCallback(async () => {
    const response = await fetch(historyUrl, { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const body = (await response.json()) as { messages: Message[] };
    setMessages(body.messages);
  }, [historyUrl]);

  const loadSessions = useCallback(async () => {
    setSessionError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/sessions`, { headers: { accept: "application/json" } });
      if (response.status === 401) {
        window.location.assign("/access");
        return;
      }
      if (!response.ok) throw new Error("会话列表加载失败");
      const body = (await response.json()) as { sessions?: Session[] };
      setSessions(body.sessions ?? []);
    } catch (cause) {
      setSessionError((cause as Error).message);
    }
  }, [scope]);

  // 引用选择器是独立弹层：Escape 只关它并把焦点还给触发按钮，不带着对象页一起退出。
  useEffect(() => {
    if (!pickerOpen) return;
    pickerFirst.current?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // 原生 dialog 的 cancel 是 Escape 的默认行为：这里只关选择器，不能连 dialog 一起关。
      event.preventDefault();
      setPickerOpen(false);
      pickerTrigger.current?.focus({ preventScroll: true });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen]);

  useEffect(() => {
    setMessages([]);
    setPartial("");
    setSelected([]);
    setStatus("idle");
    if (skipLegacyReload.current) {
      skipLegacyReload.current = false;
      return;
    }
    void loadHistory();
  }, [loadHistory]);

  // 展开对话或 sidebar 挂载时拉一次会话列表（sidebar 的「会话 N」计数依赖它）；不自动选择，保持 legacy 回退语义。
  useEffect(() => {
    if (historyOpen || variant === "sidebar") void loadSessions();
  }, [historyOpen, variant, loadSessions]);

  useEffect(() => {
    if (!historyOpen || !historyDialog.current) return;
    const dialog = historyDialog.current;
    dialog.showModal();
    requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    return () => {
      if (dialog.open) dialog.close();
      requestAnimationFrame(() => historyTrigger.current?.focus({ preventScroll: true }));
    };
  }, [historyOpen]);

  function selectSession(id: string | null) {
    if (id === activeSessionId) return;
    setActiveSessionId(id);
    setAttachments([]);
    setAttachmentError(null);
    setMessages([]);
    setPartial("");
    setStatus("idle");
    setError(null);
    if (id) {
      void (async () => {
        const response = await fetch(messagesEndpoint(scope, id), {
          headers: { accept: "application/json" },
        });
        if (response.ok) setMessages(((await response.json()) as { messages: Message[] }).messages);
      })();
    }
    // id === null 不主动回载 legacy 历史：由既有 scope effect 统一处理。
  }

  async function createSession() {
    setSessionError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error("新建会话失败");
      const session = (await response.json()) as Session;
      setSessions((current) => [...current, session]);
      selectSession(session.id);
    } catch (cause) {
      setSessionError((cause as Error).message);
    }
  }

  function requestDeleteSession(id: string) {
    setDeleteTarget(sessions.find((session) => session.id === id) ?? { id });
  }

  async function deleteSession(id: string) {
    setDeleteTarget(null);
    setSessionError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error("删除会话失败");
      setSessions((current) => current.filter((session) => session.id !== id));
      if (activeSessionId === id) {
        skipLegacyReload.current = true;
        selectSession(null);
      }
    } catch (cause) {
      setSessionError((cause as Error).message);
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    if (!activeSessionId) {
      setAttachmentError("先选择或新建一个会话，再上传附件。");
      return;
    }
    const rejected = list.filter((file) => !isAttachable(file));
    const acceptable = list.filter(isAttachable);
    if (!acceptable.length) {
      setAttachmentError("仅支持 PDF、DOCX、Markdown（.md）附件。");
      return;
    }
    setUploading(true);
    setAttachmentError(null);
    try {
      const form = new FormData();
      for (const file of acceptable) form.append("files", file);
      const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/sessions/${encodeURIComponent(activeSessionId)}/attachments`, {
        method: "POST",
        body: form,
      });
      if (response.status === 401) {
        window.location.assign("/access");
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "附件上传失败");
      }
      const body = (await response.json()) as { attachments?: Attachment[] } | Attachment[];
      const uploaded = Array.isArray(body) ? body : body.attachments ?? [];
      setAttachments((current) => [...current, ...uploaded]);
      if (rejected.length) setAttachmentError(`已上传 ${acceptable.length} 份；${rejected.length} 份不是 PDF/DOCX/MD，已忽略。`);
    } catch (cause) {
      setAttachmentError((cause as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const message = input.trim();
    if (!message || status === "streaming") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setInput("");
    setPartial("");
    setError(null);
    setTools([]);
    setStatus("streaming");
    const references = selectedCards.map((card) => ({ cardId: card.id, version: card.version }));
    const attachmentRefs = attachments.map((attachment) => ({ id: attachment.id }));
    setSelected([]);
    setMessages((current) => [...current, { sequence: current.length + 1, role: "user", content: message }]);

    try {
      const response = await fetch(historyUrl, {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ message, references, attachments: attachmentRefs }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        window.location.assign("/access");
        return;
      }
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Conversation 发送失败");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const { events, rest } = splitSse(buffer);
        buffer = rest;
        for (const block of events) {
          const event: ConversationEvent | null = parseSseBlock(block);
          if (!event) continue;
          if (event.type === "message") setPartial((current) => current + (event.delta ?? ""));
          if (event.type === "tool" && event.phase === "started" && event.name) {
            setTools((current) => [...current, event.name!]);
          }
          if (event.type === "error") throw new Error(event.message ?? "Pi Runtime 失败");
          if (event.type === "done" && event.status === "completed") completed = true;
          if (event.type === "done" && event.status === "aborted") setStatus("aborted");
        }
        if (done) break;
      }
      if (!completed) throw new Error("Conversation 流在完成前断开");
      await loadHistory();
      setPartial("");
      setTools([]);
      setAttachments([]);
      setStatus("complete");
    } catch (cause) {
      await loadHistory().catch(() => undefined);
      if (controller.signal.aborted) {
        setStatus("aborted");
        setError("已停止，本轮没有保存 assistant 成功消息。");
      } else {
        setStatus("failed");
        setError((cause as Error).message);
      }
    } finally {
      abortRef.current = null;
    }
  }

  const streaming = status === "streaming";

  // 输入 composer 是同一份：历史打开时渲染在 dialog 底部，关闭时渲染为页面底部 dock。
  const inHistory = historyOpen || variant === "sidebar" || undefined;
  const tray = selectedCards.length || attachments.length ? (
    <div className={c.tray} data-in-history={inHistory} aria-label="对话上下文">
      <div className={c.chips}>
        {attachments.map((attachment) => (
          <span key={attachment.id} className={c.chip}>
            <span className={c.chipTitle} title={`${attachment.fileName}（${attachment.mimeType}）`}>
              📄 {attachment.fileName}
            </span>
          </span>
        ))}
        {selectedCards.map((card) => (
          <span key={card.id} className={c.chip}>
            <button
              type="button"
              className={c.chipTitle}
              title={`${card.title} v${card.version}`}
              onClick={() => setSelected((current) => current.filter((id) => id !== card.id))}
            >
              {card.title} v{card.version}
            </button>
            <button type="button" onClick={() => setSelected((current) => current.filter((id) => id !== card.id))} aria-label={`取消引用 ${card.title}`}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      {selectedCards.length ? (
        <button type="button" className={c.clear} onClick={() => setSelected([])} aria-label="清空引用">
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  ) : null;

  const railCount = selectedCards.length + attachments.length;
  // 本次引用栏：扩展对话右栏常驻展示本轮引用与附件（FRH4J Context Rail）。
  const rail = (
    <>
      <header className={d.railHead}>
        <span className={d.railTitle}>本次引用</span>
        <span className={d.railCount}>{railCount} 项</span>
      </header>
      {railCount ? (
        <ul className={d.railList}>
          {attachments.map((attachment) => (
            <li key={attachment.id} className={d.railItem}>
              <span className={d.railDot} aria-hidden="true" />
              <span className={d.railText}>
                <span className={d.railName} title={attachment.fileName}>{attachment.fileName}</span>
                <span className={d.railMeta}>{ATTACHMENT_LABEL[attachment.mimeType] ?? attachment.mimeType} · 待发送</span>
              </span>
              <button
                type="button"
                className={d.railRemove}
                aria-label={`移除附件 ${attachment.fileName}`}
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
          {selectedCards.map((card) => (
            <li key={card.id} className={d.railItem}>
              <span className={d.railDot} aria-hidden="true" />
              <span className={d.railText}>
                <span className={d.railName} title={card.title}>{KIND_LABEL[card.kind] ?? card.kind} · {card.title}</span>
                <span className={d.railMeta}>v{card.version} · 本轮引用</span>
              </span>
              <button
                type="button"
                className={d.railRemove}
                aria-label={`取消引用 ${card.title}`}
                onClick={() => setSelected((current) => current.filter((id) => id !== card.id))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={d.railEmpty}>尚未选择引用或附件。</p>
      )}
      <p className={d.railNote}>回答只引用以上对象，不检索其他数据。</p>
    </>
  );

  const attachmentControls = (
    <div className={c.picker}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className={d.fileInput}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          if (event.target.files) void uploadFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className={d.iconButton}
        aria-label={activeSessionId ? "上传附件（PDF/DOCX/Markdown）" : "选择会话后才能上传附件"}
        aria-busy={uploading}
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip size={19} aria-hidden="true" />
      </button>
    </div>
  );

  const composer = (
    <div className={d.dock} data-testid="conversation-dock" data-mode="keyboard" data-in-history={inHistory}>
      {variant === "dock" && !historyOpen ? (
        <button
          ref={historyTrigger}
          type="button"
          className={d.iconButton}
          onClick={() => setHistoryOpen(true)}
          aria-label={`查看“${contextLabel}”的对话记录`}
        >
          <History size={19} aria-hidden="true" />
        </button>
      ) : null}
      <div className={d.content}>
        <form
          className={d.inputForm}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder={composerPlaceholder}
            aria-label={`${contextLabel}对话输入`}
          />
          {streaming ? (
            <button type="button" className={d.sendButton} onClick={() => abortRef.current?.abort()} aria-label="停止本轮回答">
              <X size={17} aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className={d.sendButton} disabled={!input.trim()} aria-label={input.trim() ? "发送" : "输入内容后发送"}>
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          )}
        </form>
      </div>
      {historyOpen ? attachmentControls : null}
      {referenceable.length ? (
        <div className={c.picker}>
          {pickerOpen ? (
            <div className={c.pickerList} role="dialog" aria-label="可引用的卡片">
              {referenceable.map((card, index) => (
                <button
                  key={card.id}
                  ref={index === 0 ? pickerFirst : undefined}
                  type="button"
                  aria-pressed={selected.includes(card.id)}
                  onClick={() =>
                    setSelected((current) => (current.includes(card.id) ? current.filter((id) => id !== card.id) : [...current, card.id]))
                  }
                >
                  {card.title} v{card.version}
                </button>
              ))}
            </div>
          ) : null}
          <button
            ref={pickerTrigger}
            type="button"
            className={d.iconButton}
            aria-pressed={selected.length > 0}
            aria-expanded={pickerOpen}
            aria-label="选择引用的卡片"
            onClick={() => {
              const next = !pickerOpen;
              setPickerOpen(next);
              if (!next) pickerTrigger.current?.focus({ preventScroll: true });
            }}
          >
            <Link2 size={19} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );

  const transcript = (
    <div className={w.historyContent}>
      {messages.length === 0 && !partial ? <p className={t.empty}>从你正在想的事情开始。</p> : null}
      {messages.map((message) => (
        <div key={`${message.sequence}-${message.role}`} className={message.role === "user" ? t.user : t.assistant}>
          <p className={t.meta}>{message.role === "user" ? "CEO" : "WarMap"}</p>
          {message.referencesSnapshot?.length ? (
            <details className={t.sources}>
              <summary>来源 {message.referencesSnapshot.length} 张 Card</summary>
              <ul>
                {message.referencesSnapshot.map((reference) => (
                  <li key={reference.cardId}>{reference.title} v{reference.version}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <Markdown text={message.content} />
        </div>
      ))}
      {partial ? (
        <div className={t.assistant}>
          <p className={t.meta}>WarMap（{streaming ? "运行中" : "未完成"}）</p>
          <Markdown text={partial} />
        </div>
      ) : null}
      {streaming && !partial && tools.length ? <p className={t.empty}>正在查证：{tools[tools.length - 1]}</p> : null}
    </div>
  );

  // 扩展对话优先于 sidebar/dock 承载面：Meeting sidebar 也能展开同一套会话管理。
  if (historyOpen) {
    return (
      <ExpandedConversationDialog
        dialogRef={historyDialog}
        label={contextLabel}
        sessions={sessions}
        activeSessionId={activeSessionId}
        sessionError={sessionError}
        dragOver={dragOver}
        deleteTarget={deleteTarget}
        rail={rail}
        railCount={railCount}
        onDismiss={() => {
          setDeleteTarget(null);
          setHistoryOpen(false);
        }}
        onCreateSession={() => void createSession()}
        onSelectSession={(id) => selectSession(id)}
        onDeleteSession={(id) => requestDeleteSession(id)}
        onDeleteCancel={() => setDeleteTarget(null)}
        onDeleteConfirm={() => {
          if (deleteTarget) void deleteSession(deleteTarget.id);
        }}
        onUploadFiles={(files) => void uploadFiles(files)}
        onDragEnter={() => setDragOver(true)}
        onDragLeave={() => setDragOver(false)}
        header={
          <header className={w.sheetHeader}>
            <ExpandedHeaderBrand scope={scope} label={contextLabel} />
            <button ref={closeRef} type="button" onClick={() => setHistoryOpen(false)} aria-label="收起对话记录">
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </header>
        }
        transcript={transcript}
        feedback={
          <>
            {error ? <p className={d.historyError} role="alert">{error}</p> : null}
            {attachmentError ? <p className={d.historyError} role="alert">{attachmentError}</p> : null}
            {uploading ? <p className={d.sessionHint} aria-live="polite">附件上传中…</p> : null}
          </>
        }
        tray={null}
        composer={composer}
      />
    );
  }

  if (variant === "sidebar") {
    return (
      <aside className={d.sidebar} data-open={sidebarOpen} data-tone={sidebar?.tone} data-testid="meeting-chat-sidebar" aria-label={sidebarTitle}>
        {sidebarOpen ? (
          <>
            {/* pen Conv Header：Mark + Title + Session Tools（新建 26 圆 / 会话列表 pill），不再跳全局弹层。 */}
            <header className={d.sidebarHeader}>
              <TianshuMark className={d.sidebarMark} />
              <span className={d.sidebarTitle}>{sidebarTitle}</span>
              <div className={d.sessionTools}>
                <button
                  type="button"
                  className={d.sessionToolNew}
                  onClick={() => void createSession()}
                  aria-label="新建会话"
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={d.sessionToolList}
                  aria-expanded={sessionPanelOpen}
                  aria-label={`会话列表，共 ${sessions.length} 个`}
                  onClick={() => setSessionPanelOpen((open) => !open)}
                >
                  会话 {sessions.length}
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
                <button
                  ref={sidebarCloseRef}
                  type="button"
                  className={d.sessionToolNew}
                  onClick={() => {
                    setPickerOpen(false);
                    setSidebarOpen(false);
                    requestAnimationFrame(() => sidebarRailRef.current?.focus({ preventScroll: true }));
                  }}
                  aria-label={`折叠${sidebarTitle}`}
                >
                  <ChevronRight size={13} aria-hidden="true" />
                </button>
              </div>
            </header>
            {sessionPanelOpen ? (
              <div className={d.sessionPanel} aria-label="会话列表">
                {sessionError ? <p className={d.sessionError} role="alert">{sessionError}</p> : null}
                <ul className={d.sessionList}>
                  {sessions.map((session) => (
                    <li key={session.id} className={d.sessionItem} data-active={session.id === activeSessionId}>
                      <button
                        type="button"
                        className={d.sessionSelect}
                        aria-current={session.id === activeSessionId ? "true" : undefined}
                        onClick={() => selectSession(session.id)}
                      >
                        <span>{sessionLabel(session)}</span>
                        {session.createdAt ? <small>{session.createdAt.slice(0, 10)}</small> : null}
                      </button>
                      <button
                        type="button"
                        className={d.sessionDelete}
                        aria-label={`删除会话 ${sessionLabel(session)}`}
                        onClick={() => requestDeleteSession(session.id)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
                {sessions.length === 0 ? <p className={d.sessionHint}>还没有独立会话；消息保存到本页默认会话。</p> : null}
              </div>
            ) : null}
            <div className={d.sidebarScroll}>{transcript}</div>
            <div className={d.sidebarComposer}>
              {error ? <p className={d.historyError} role="alert">{error}</p> : null}
              {tray}
              {composer}
            </div>
            <SessionDeleteConfirm
              target={deleteTarget}
              onCancel={() => setDeleteTarget(null)}
              onConfirm={() => {
                if (deleteTarget) void deleteSession(deleteTarget.id);
              }}
            />
          </>
        ) : (
          <button
            ref={sidebarRailRef}
            type="button"
            className={d.sidebarRail}
            onClick={() => {
              setSidebarOpen(true);
              requestAnimationFrame(() => sidebarCloseRef.current?.focus({ preventScroll: true }));
            }}
            aria-expanded="false"
            aria-label={`展开${sidebarTitle}`}
          >
            <ChevronLeft size={16} aria-hidden="true" />
            <span>{sidebarTitle}</span>
          </button>
        )}
      </aside>
    );
  }

  return (
    <div className={d.layer} data-testid="global-controls">
      {tray}
      {error ? (
        <button type="button" className={d.caption} onClick={() => setHistoryOpen(true)}>
          <span role="alert">{error}</span>
        </button>
      ) : streaming ? (
        <button type="button" className={d.caption} onClick={() => setHistoryOpen(true)}>
          <span aria-live="polite">{partial ? partial.slice(0, 90) : tools.length ? `正在查证：${tools[tools.length - 1]}` : "正在思考…"}</span>
        </button>
      ) : null}
      {composer}
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className={t.prose}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
