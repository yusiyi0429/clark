"use client";

/**
 * 本月页的伙伴胶囊（原型 v8.4 .cap，第 10 节）：收起时是伙伴；点它、或者在本月页直接开口打字，就展开接字；
 * 发出去的话进主对话（总线程），回复留在胶囊里，下一句一开口就盖掉。这次只能聊，不能经胶囊操作卡。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import type { Buddy } from "@/components/buddy/useBuddy";
import { useConversation } from "@/conversation/useConversation";
import s from "@/styles/v2-month.module.css";

/** 胶囊里只放回复的头一段，长的去对话页看。 */
export function capsuleReply(text: string, max = 120): string {
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/[#>*_`]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

export function MonthCapsule({ buddy }: { buddy: Buddy | null }) {
  const data = useConversation("global");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  /** 发出这句时对话里有几条：之后的第一条伙伴回复就是这次的。 */
  const [asked, setAsked] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const name = buddy?.name?.trim() || "伙伴";

  // 宽屏上在本月页直接开口：按下的字落进胶囊（输入框、按钮里打字不算）。
  useEffect(() => {
    const type = (event: KeyboardEvent) => {
      if (event.key.length !== 1 || event.key === " " || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (window.matchMedia("(max-width: 959px)").matches) return;
      setOpen(true);
      requestAnimationFrame(() => field.current?.focus());
    };
    window.addEventListener("keydown", type);
    return () => window.removeEventListener("keydown", type);
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (box.current?.contains(event.target as Node) || text.trim() || data.streaming) return;
      setOpen(false);
      setAsked(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, text, data.streaming]);

  const reply = asked === null ? null : data.messages.slice(asked).find((message) => message.role === "assistant") ?? null;
  const send = async () => {
    const value = text.trim();
    if (!value || data.streaming) return;
    setAsked(data.messages.length);
    setText("");
    const accepted = await data.send(value, []);
    if (!accepted) { setText(value); setAsked(null); }
  };

  if (!open) {
    return (
      <div className={s.capsule}>
        <button type="button" className={s.capsuleFigure} aria-label={`跟${name}说`} onClick={() => { setOpen(true); requestAnimationFrame(() => field.current?.focus()); }}>
          <BuddyMark buddy={buddy} place="entry" active={false} />
        </button>
      </div>
    );
  }
  const saying = reply && !text ? capsuleReply(reply.content) : null;
  return (
    <div className={s.capsule} ref={box}>
      <div className={s.capsuleBox} data-busy={data.streaming || undefined}>
        {saying ? <p className={s.capsuleSay} aria-live="polite">{saying}</p> : (
          <textarea ref={field} className={s.capsuleField} rows={1} value={text} placeholder={`跟${name}说…`} aria-label={`跟${name}说`}
            readOnly={data.streaming}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { setOpen(false); setAsked(null); return; }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
            }} />
        )}
        {saying ? <button type="button" className={s.capsuleAgain} onClick={() => { setAsked(null); requestAnimationFrame(() => field.current?.focus()); }}>接着说</button> : null}
        {text.trim() ? <button type="button" className={s.capsuleSend} aria-label="发送" onClick={() => void send()}><ArrowUp size={16} aria-hidden /></button> : null}
        <i className={s.capsuleFlow} aria-hidden />
      </div>
    </div>
  );
}
