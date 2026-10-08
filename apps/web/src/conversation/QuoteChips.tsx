"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Quote, X } from "lucide-react";
import type { TextQuote } from "./quotes";
import s from "@/styles/conversation-quotes.module.css";

/** Hover and keyboard focus preview only this small control; clicking pins the readable selection. */
export function QuoteChips({ quotes, onRemove, sent = false }: { quotes: TextQuote[]; onRemove?: (ids: string[]) => void; sent?: boolean }) {
  const [preview, setPreview] = useState<{ id: string; pinned: boolean; left: number; bottom?: number; top?: number; width: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringFocus = useRef(false);
  const previewId = useId();
  const current = quotes.find((item) => item.id === preview?.id);
  const cancelLeave = () => { if (leaving.current) clearTimeout(leaving.current); leaving.current = null; };
  const close = () => { cancelLeave(); setPreview(null); };
  const restoreFocus = () => {
    restoringFocus.current = true; trigger.current?.focus({ preventScroll: true });
    queueMicrotask(() => { restoringFocus.current = false; });
  };
  const position = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    const horizontal = { width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) };
    return rect.top > 160
      ? { ...horizontal, bottom: window.innerHeight - rect.top + 8, top: undefined, maxHeight: Math.min(320, rect.top - 20) }
      : { ...horizontal, bottom: undefined, top: rect.bottom + 8, maxHeight: Math.max(80, Math.min(320, window.innerHeight - rect.bottom - 20)) };
  };
  const open = (quote: TextQuote, element: HTMLButtonElement, pinned: boolean) => {
    cancelLeave(); trigger.current = element;
    setPreview((previous) => ({ id: quote.id, pinned: pinned || (previous?.id === quote.id && previous.pinned), ...position(element) }));
  };
  const leave = () => {
    cancelLeave();
    leaving.current = setTimeout(() => setPreview((previous) => previous?.pinned ? previous : null), 120);
  };
  useEffect(() => () => { if (leaving.current) clearTimeout(leaving.current); }, []);
  useEffect(() => {
    if (!preview || !current) return;
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); close(); restoreFocus();
    };
    const reposition = () => { if (trigger.current) setPreview((previous) => previous ? { ...previous, ...position(trigger.current!) } : null); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition); document.removeEventListener("scroll", reposition, true);
    };
    // Interaction callbacks only read the current trigger. Updating the position keeps this listener intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.id, current?.id]);
  if (!quotes.length) return null;
  return <div className={s.chips} data-sent={sent || undefined} aria-label={sent ? "本条消息的文字引用" : "待发送的文字引用"}>
    {quotes.map((quote, index) => <span className={s.chip} key={quote.id}>
      <button type="button" className={s.label} aria-label={`查看引用${quotes.length > 1 ? ` ${index + 1}` : ""}${quote.source?.label ? `：${quote.source.label}` : ""}`} aria-expanded={preview?.id === quote.id} aria-describedby={preview?.id === quote.id ? previewId : undefined}
        onMouseEnter={(event) => open(quote, event.currentTarget, false)} onMouseLeave={leave}
        onFocus={(event) => { if (!restoringFocus.current) open(quote, event.currentTarget, false); }} onBlur={() => { if (!preview?.pinned) leave(); }}
        onClick={(event) => { if (preview?.id === quote.id && preview.pinned) close(); else open(quote, event.currentTarget, true); }}>
        <Quote size={12} aria-hidden />
        <span>引用{quotes.length > 1 ? ` ${index + 1}` : ""}{quote.source?.label ? ` · ${quote.source.label}` : ""}</span>
      </button>
      {onRemove ? <button type="button" className={s.remove} aria-label={`移除引用${quotes.length > 1 ? ` ${index + 1}` : ""}`} onClick={() => { onRemove([quote.id]); if (preview?.id === quote.id) close(); }}><X size={12} aria-hidden /></button> : null}
    </span>)}
    {preview && current ? createPortal(<div ref={popup} id={previewId} className={s.preview} role={preview.pinned ? "dialog" : "tooltip"} aria-label={preview.pinned ? "引用原文" : undefined} style={{ width: preview.width, left: preview.left, bottom: preview.bottom, top: preview.top, maxHeight: preview.maxHeight }} onMouseEnter={cancelLeave} onMouseLeave={leave}>
      <div className={s.previewHeader}><span>{current.source?.label ?? "引用原文"}</span>{preview.pinned ? <button type="button" aria-label="关闭引用原文" onClick={() => { close(); restoreFocus(); }}><X size={14} aria-hidden /></button> : null}</div>
      <p>{current.text}</p>
    </div>, document.body) : null}
  </div>;
}
