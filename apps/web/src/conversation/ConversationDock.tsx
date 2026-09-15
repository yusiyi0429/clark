"use client";

import { useEffect, useRef, useState } from "react";
import type { Card } from "@/lib/api/client";

type Message = { sequence: number; role: "user" | "assistant"; content: string };
type State = "idle" | "streaming" | "failed" | "aborted";

export function ConversationDock({ scope, availableCards }: { scope: string; availableCards: Card[] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function loadHistory() {
    const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/messages`);
    if (response.ok) setMessages((await response.json()).messages);
  }

  useEffect(() => {
    void loadHistory();
  }, [scope]);

  async function send() {
    const message = text.trim();
    if (!message || state === "streaming") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setText("");
    setPartial("");
    setError(null);
    setState("streaming");
    setMessages((current) => [...current, { sequence: current.length + 1, role: "user", content: message }]);
    const references = availableCards
      .filter((card) => selected.includes(card.id))
      .map((card) => ({ cardId: card.id, version: card.version }));
    setSelected([]);

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/messages`, {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ message, references }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? "Conversation 发送失败");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)) as { type: string; delta?: string; message?: string; status?: string };
          if (event.type === "message") setPartial((current) => current + (event.delta ?? ""));
          if (event.type === "error") throw new Error(event.message ?? "Pi Runtime 失败");
          if (event.type === "done" && event.status === "completed") completed = true;
          if (event.type === "done" && event.status === "aborted") setState("aborted");
        }
        if (done) break;
      }
      if (!completed) throw new Error("Conversation 流在完成前断开");
      await loadHistory();
      setPartial("");
      setState("idle");
    } catch (cause) {
      await loadHistory().catch(() => undefined);
      if (controller.signal.aborted) {
        setState("aborted");
        setError("已停止，本轮没有保存 assistant 成功消息。");
      } else {
        setState("failed");
        setError((cause as Error).message);
      }
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <section className="conversation-dock" aria-labelledby={`conversation-${scope}`}>
      <h2 id={`conversation-${scope}`}>Conversation · {scope}</h2>
      <div className="conversation-history" aria-live="polite">
        {messages.map((message) => (
          <p key={`${message.sequence}-${message.role}`}><strong>{message.role === "user" ? "CEO" : "WarMap"}</strong> {message.content}</p>
        ))}
        {partial ? <p><strong>WarMap（{state === "streaming" ? "运行中" : "未完成"}）</strong> {partial}</p> : null}
      </div>
      {availableCards.length ? (
        <div className="reference-tray" aria-label="Card 引用">
          {availableCards.map((card) => (
            <label key={card.id}>
              <input
                type="checkbox"
                checked={selected.includes(card.id)}
                disabled={state === "streaming"}
                onChange={(event) => setSelected((current) => event.target.checked ? [...current, card.id] : current.filter((id) => id !== card.id))}
              />
              引用 {card.title} v{card.version}
            </label>
          ))}
        </div>
      ) : null}
      <div className="conversation-input">
        <textarea value={text} onChange={(event) => setText(event.target.value)} disabled={state === "streaming"} aria-label="Conversation 消息" />
        {state === "streaming" ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>停止</button>
        ) : (
          <button type="button" onClick={() => void send()} disabled={!text.trim()}>发送</button>
        )}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
