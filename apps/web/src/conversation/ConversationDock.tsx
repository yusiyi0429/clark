"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, ChevronDown, History, Link2, X } from "lucide-react";
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

const REFERENCEABLE = new Set(["issue", "signal", "meeting", "monthly-plan"]);

/**
 * 底部 Conversation dock：SSE 只驱动展示状态；业务状态永远来自 Card。
 * 引用只是未发送的 Card ID/version，发送后清空，快照由后端生成。
 */
export function ConversationDock({
  scope,
  label,
  availableCards,
}: {
  scope: string;
  label: string;
  availableCards: Card[];
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
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const pickerFirst = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const referenceable = useMemo(() => availableCards.filter((card) => REFERENCEABLE.has(card.kind)), [availableCards]);
  const selectedCards = referenceable.filter((card) => selected.includes(card.id));
  const contextLabel = label;

  const loadHistory = useCallback(async () => {
    const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/messages`, { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const body = (await response.json()) as { messages: Message[] };
    setMessages(body.messages);
  }, [scope]);

  // 引用选择器是独立弹层：Escape 只关它并把焦点还给触发按钮，不带着对象页一起退出。
  useEffect(() => {
    if (!pickerOpen) return;
    pickerFirst.current?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
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
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!historyOpen) return;
    requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setHistoryOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen]);

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
    setSelected([]);
    setMessages((current) => [...current, { sequence: current.length + 1, role: "user", content: message }]);

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/messages`, {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ message, references }),
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

  return (
    <>
      {historyOpen ? (
        <div className={w.historySheet} role="dialog" aria-modal="true" aria-label={`${contextLabel}的对话记录`}>
          <header className={w.sheetHeader}>
            <div className={w.chatBrand}>
              <TianshuMark className={w.chatBrandMark} />
              <div>
                <small>独立对话 · {contextLabel}</small>
                <h2>天枢</h2>
              </div>
            </div>
            <button ref={closeRef} type="button" onClick={() => setHistoryOpen(false)} aria-label="收起对话记录">
              <ChevronDown size={22} aria-hidden="true" />
            </button>
          </header>
          <div className={w.sheetScroll}>
            <div className={w.historyContent}>
              {messages.length === 0 ? <p className={t.empty}>从你正在想的事情开始。</p> : null}
              {messages.map((message) => (
                <div key={`${message.sequence}-${message.role}`} className={message.role === "user" ? t.user : t.assistant}>
                  <p className={t.meta}>{message.role === "user" ? "CEO" : "WarMap"}</p>
                  {message.referencesSnapshot?.length ? (
                    <details className={t.sources}>
                      <summary>来源 {message.referencesSnapshot.length} 张 Card</summary>
                      <ul>
                        {message.referencesSnapshot.map((reference) => (
                          <li key={reference.cardId}>
                            {reference.title} v{reference.version}
                          </li>
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
              {status === "complete" && !messages.length ? <p className={t.empty}>本轮已结束。</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className={d.layer} data-testid="global-controls" data-history-open={historyOpen}>
        {selectedCards.length ? (
          <div className={c.tray} aria-label="Card 引用">
            <div className={c.chips}>
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
            <button type="button" className={c.clear} onClick={() => setSelected([])} aria-label="清空引用">
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {error ? (
          <button type="button" className={d.caption} onClick={() => setHistoryOpen(true)}>
            <span role="alert">{error}</span>
          </button>
        ) : streaming ? (
          <button type="button" className={d.caption} onClick={() => setHistoryOpen(true)}>
            <span aria-live="polite">{partial ? partial.slice(0, 90) : tools.length ? `正在查证：${tools[tools.length - 1]}` : "正在思考…"}</span>
          </button>
        ) : null}

        <div className={d.dock} data-testid="conversation-dock" data-mode="keyboard">
          <button
            type="button"
            className={d.iconButton}
            onClick={() => setHistoryOpen(true)}
            aria-label={`查看“${contextLabel}”的对话记录`}
          >
            <History size={19} aria-hidden="true" />
          </button>
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
                placeholder="输入你的想法…"
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
      </div>
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className={t.prose}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
