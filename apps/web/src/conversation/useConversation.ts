"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseSseBlock, splitSse, type ConversationEvent } from "./sse";

/**
 * 对话的数据与调用：与原 ConversationDock 同一组端点与请求体（只抽出来，不改调用逻辑）。
 * - 未选择会话时走按 scope 的默认会话端点，选择后走 session 端点；
 * - 发送走 SSE，完成后重载历史；会话列表 / 新建 / 删除 / 附件上传端点不变。
 * 展示态（思考阶段、秒数、失败文案）在这里派生，供 clark 风格的界面使用。
 */

export type ReferenceSnapshot = { cardId: string; version: number; kind: string; title: string };
export type Message = { sequence: number; role: "user" | "assistant"; content: string; referencesSnapshot?: ReferenceSnapshot[]; attachments?: Attachment[]; createdAt?: string };
export type Session = { id: string; title?: string; createdAt?: string };
export type Attachment = { id: string; fileName: string; mimeType: string };
export type ConversationStatus = "idle" | "streaming" | "complete" | "failed" | "aborted";
/** clark 的三段思考：尚无事件 = 思考；开始用工具 = 快速查证；首个文字 = 整理回答。 */
export type ThinkingStage = "thinking" | "researching" | "answering";
export type CardRef = { cardId: string; version: number };

export function messagesEndpoint(scope: string, sessionId: string | null): string {
  const base = `/api/conversations/${encodeURIComponent(scope)}`;
  return sessionId ? `${base}/sessions/${encodeURIComponent(sessionId)}/messages` : `${base}/messages`;
}

export function isAttachable(file: { name: string }): boolean {
  return /\.(pdf|docx|md)$/i.test(file.name);
}

export function sessionLabel(session: { id: string; title?: string }): string {
  return session.title ?? `会话 ${session.id.slice(0, 8)}`;
}

/** 服务端错误码 → 面向 CEO 的中文（clark 的失败文案；不显示英文原文）。 */
export function failureCopy(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "TURN_TIMEOUT":
      return "这次回答等待较久，已停止。你仍可以打开战场、查看目标或研究已有议题。";
    case "TURN_IN_PROGRESS":
      return "上一轮回答还没结束，请稍后再发。";
    case "REFERENCE_VERSION_CONFLICT":
      return "引用的卡片已更新，请重新引用后再发。";
    case "REFERENCE_NOT_FOUND":
      return "引用的卡片已不存在，请移除后再发。";
    case "ATTACHMENT_NOT_FOUND":
      return "附件已失效，请重新上传。";
    case "SEARCH_BUDGET_EXHAUSTED":
      return "本轮查证次数已用完，请换个问法或稍后再试。";
    default:
      return fallback && /[一-龥]/.test(fallback) ? fallback : "对话服务暂时没有接通。页面操作仍可用。";
  }
}

class TurnError extends Error {
  constructor(public code: string | undefined, message: string) {
    super(message);
  }
}

export function useConversation(scope: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [partial, setPartial] = useState("");
  const [stage, setStage] = useState<ThinkingStage>("thinking");
  const [startedAt, setStartedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastReply, setLastReply] = useState<{ text: string; ms: number } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 删除激活会话后停在「未选择会话」空态，不自动回载默认会话消息。
  const skipLegacyReload = useRef(false);

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

  useEffect(() => {
    setMessages([]);
    setPartial("");
    setStatus("idle");
    if (skipLegacyReload.current) {
      skipLegacyReload.current = false;
      return;
    }
    void loadHistory();
  }, [loadHistory]);

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
        const response = await fetch(messagesEndpoint(scope, id), { headers: { accept: "application/json" } });
        if (response.ok) setMessages(((await response.json()) as { messages: Message[] }).messages);
      })();
    }
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

  async function deleteSession(id: string) {
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

  /**
   * 发送一轮。返回 false 表示在服务端接收之前就失败了（C-04：调用方保留输入与引用）。
   * 请求与 SSE 处理与原实现相同；只在展示上派生思考阶段与失败文案。
   */
  async function send(message: string, references: CardRef[]): Promise<boolean> {
    const text = message.trim();
    if (!text || status === "streaming") return false;
    const controller = new AbortController();
    abortRef.current = controller;
    const began = Date.now();
    setPartial("");
    setError(null);
    setStage("thinking");
    setStartedAt(began);
    setStatus("streaming");
    const attachmentRefs = attachments.map((attachment) => ({ id: attachment.id }));
    setMessages((current) => [...current, { sequence: current.length + 1, role: "user", content: text }]);

    let accepted = false;
    let reply = "";
    try {
      const response = await fetch(historyUrl, {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ message: text, references, attachments: attachmentRefs }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        window.location.assign("/access");
        return true;
      }
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
        throw new TurnError(body.code, body.message ?? "Conversation 发送失败");
      }
      accepted = true;
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
          if (event.type === "message") {
            reply += event.delta ?? "";
            setPartial(reply);
            setStage("answering");
          }
          if (event.type === "tool" && event.phase === "started") setStage((current) => (current === "answering" ? current : "researching"));
          if (event.type === "error") throw new TurnError(event.code, event.message ?? "Pi Runtime 失败");
          if (event.type === "done" && event.status === "completed") completed = true;
          if (event.type === "done" && event.status === "aborted") setStatus("aborted");
        }
        if (done) break;
      }
      if (!completed) throw new TurnError(undefined, "Conversation 流在完成前断开");
      await loadHistory();
      setPartial("");
      setAttachments([]);
      setLastReply({ text: reply, ms: Date.now() - began });
      setStatus("complete");
      return true;
    } catch (cause) {
      await loadHistory().catch(() => undefined);
      setPartial("");
      if (controller.signal.aborted) {
        setStatus("aborted");
        setError("已停止本次回答。");
      } else {
        setStatus("failed");
        setError(failureCopy((cause as TurnError).code, (cause as Error).message));
      }
      return accepted;
    } finally {
      abortRef.current = null;
    }
  }

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return {
    scope,
    messages,
    status,
    streaming: status === "streaming",
    partial,
    stage,
    startedAt,
    error,
    lastReply,
    sessions,
    activeSessionId,
    sessionError,
    attachments,
    uploading,
    attachmentError,
    loadSessions,
    selectSession,
    createSession,
    deleteSession,
    uploadFiles,
    removeAttachment: (id: string) => setAttachments((current) => current.filter((item) => item.id !== id)),
    send,
    stop,
  };
}

export type ConversationData = ReturnType<typeof useConversation>;
