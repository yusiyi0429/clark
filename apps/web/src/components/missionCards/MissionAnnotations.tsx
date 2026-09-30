"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, MessageSquarePlus, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TianshuPortalTheme } from "ts-design";
import type { TMissionCardField, TMissionCardAnnotationView, TMissionCardRevisionView } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { annotationMarks, normalizeAnchorText, type TextAnchor } from "./annotationAnchors";
import type { PersonalMission } from "./CardDocument";
import a from "./mission-annotations.module.css";

export type AnnotationSelection = TextAnchor & { mission: PersonalMission; field: TMissionCardField; sourceText: string; range: Range };
export type AnnotationControls = {
  notes: TMissionCardAnnotationView[];
  revisions: TMissionCardRevisionView[];
  onSave: (selection: AnnotationSelection, body: string, clientId: string) => Promise<string | null>;
  onAnswer: (id: string, answer: string) => Promise<string | null>;
  onRetry: (id: string) => Promise<string | null>;
};

export function useMissionAnnotations(cardId: string) {
  const [notes, setNotes] = useState<TMissionCardAnnotationView[]>([]);
  const [revisions, setRevisions] = useState<TMissionCardRevisionView[]>([]);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = generation.current;
    try {
      const response = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/annotations`);
      if (!response.ok) throw new Error("批注暂时无法读取，请重试。");
      const data = await response.json() as { annotations: TMissionCardAnnotationView[]; revisions: TMissionCardRevisionView[] };
      if (current === generation.current) { setNotes(data.annotations); setRevisions(data.revisions); setError(""); }
    } catch { if (current === generation.current) setError("批注暂时无法读取，请重试。"); }
  }, [cardId]);
  useEffect(() => {
    generation.current++;
    setNotes([]);
    setRevisions([]);
    setError("");
    void refresh();
    const resume = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const interval = setInterval(resume, 2500);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { generation.current++; clearInterval(interval); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [refresh]);
  const save = useCallback(async (selection: AnnotationSelection, body: string, clientId: string): Promise<string | null> => {
    try {
      const response = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/annotations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, missionId: selection.mission.missionId, field: selection.field, sourceVersion: selection.mission.version, sourceText: selection.sourceText, quote: selection.quote, prefix: selection.prefix, suffix: selection.suffix, startOffset: selection.startOffset, body }) });
      const data = await response.json() as { annotation?: TMissionCardAnnotationView; message?: string };
      if (!response.ok || !data.annotation) return data.message ?? "批注未保存，请重试；输入已保留。";
      const saved = data.annotation;
      setNotes((current) => [...current.filter((note) => note.id !== saved.id), saved]);
      setError("");
      return null;
    } catch { return "暂时无法连接服务器，请重试；输入已保留。"; }
  }, [cardId]);
  const respond = useCallback(async (id: string, action: "answer" | "retry", body: object): Promise<string | null> => {
    try {
      const response = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/annotations/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { annotation?: TMissionCardAnnotationView; message?: string };
      if (!response.ok || !data.annotation) return data.message ?? "没有提交成功，请重试。";
      const saved = data.annotation;
      setNotes((current) => current.map((note) => note.id === id ? saved : note));
      void refresh(); return null;
    } catch { return "暂时无法连接服务器，输入已保留。"; }
  }, [cardId, refresh]);
  const answer = useCallback((id: string, text: string) => respond(id, "answer", { answer: text }), [respond]);
  const retry = useCallback((id: string) => respond(id, "retry", {}), [respond]);
  return { notes, revisions, error, refresh, save, answer, retry };
}

export function AnnotatedField({ mission, field, text, markdownText = text, notes, onSelect }: { mission: PersonalMission; field: TMissionCardField; text: string; markdownText?: string; notes: TMissionCardAnnotationView[]; onSelect: (selection: AnnotationSelection | null) => void }) {
  const [opened, setOpened] = useState<string | null>(null);
  const collect = (node: HTMLElement) => {
    const picked = window.getSelection();
    if (!picked || picked.isCollapsed || !node.contains(picked.anchorNode) || !node.contains(picked.focusNode)) { onSelect(null); return; }
    const range = picked.getRangeAt(0).cloneRange();
    const before = document.createRange(); before.selectNodeContents(node); before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange(); after.selectNodeContents(node); after.setStart(range.endContainer, range.endOffset);
    const quote = normalizeAnchorText(picked.toString());
    if (!quote || quote.length > 2000) { onSelect(null); return; }
    const rawBefore = before.toString().replace(/\s+/g, " ").trimStart();
    onSelect({ mission, field, sourceText: text, quote, prefix: rawBefore.slice(-200), suffix: after.toString().replace(/\s+/g, " ").slice(0, 200), startOffset: rawBefore.length, range });
  };
  return <div className={a.fieldWrap}>
    <div className={a.markdown} data-mission-field={`${mission.missionId}:${field}`} onMouseUp={(event) => collect(event.currentTarget)} onKeyUp={(event) => { if (event.shiftKey) collect(event.currentTarget); }} onTouchEnd={(event) => collect(event.currentTarget)}>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[annotationMarks(notes)]} components={{
        span: ({ node, children, ...props }) => {
          const id = node?.properties.dataAnnotationBubble;
          return typeof id === "string" ? <button type="button" className={a.bubble} aria-label="查看此处批注" aria-expanded={opened === id} onClick={() => setOpened(opened === id ? null : id)}><MessageCircle size={12} aria-hidden /></button> : <span {...props}>{children}</span>;
        },
      }}>{markdownText || "未提供"}</Markdown>
    </div>
    {opened ? <AnnotationNote note={notes.find((note) => note.id === opened)!} onClose={() => setOpened(null)} /> : null}
  </div>;
}

export function AnnotationNote({ note, onClose }: { note: TMissionCardAnnotationView; onClose?: () => void }) {
  if (!note) return null;
  return <aside className={a.note} aria-label="批注内容">
    <header><strong>{note.authorName}</strong><time dateTime={note.createdAt}>{monthDayTime(note.createdAt)}</time>{onClose ? <button type="button" aria-label="收起批注" onClick={onClose}><X size={14} aria-hidden /></button> : null}</header>
    <blockquote>{note.quote}</blockquote><p>{note.body}</p>
    {note.note ? <p className={a.reason}>{note.note}</p> : null}
    {note.clarifications?.length ? <details className={a.clarificationHistory}><summary>查看沟通记录 · {note.clarifications.length}</summary>{note.clarifications.map((item, index) => <div key={`${item.createdAt}:${index}`}><p>{item.question}</p><p><strong>{item.authorName}</strong>：{item.answer}</p><time dateTime={item.createdAt}>{monthDayTime(item.createdAt)}</time></div>)}</details> : null}
    <small>{({ saved: "批注已保存", queued: "Co-Agent 准备处理", applying: "Co-Agent 正在修改", needs_clarification: "待明确修改意图", applied: "已按批注修改", no_change: "已审阅 · 正文无需修改", failed: "修改未完成" } as const)[note.status]}{note.stale ? " · 原文已留存" : ""}</small>
  </aside>;
}

export function FieldAnnotationActivity({ notes, controls }: { notes: TMissionCardAnnotationView[]; controls: AnnotationControls }) {
  return <>{notes.filter((note) => ["queued", "applying", "needs_clarification", "failed"].includes(note.status)).map((note) => note.status === "needs_clarification" ? <Clarification key={note.id} note={note} onAnswer={controls.onAnswer} /> : <PendingNote key={note.id} note={note} onRetry={controls.onRetry} />)}</>;
}

function PendingNote({ note, onRetry }: { note: TMissionCardAnnotationView; onRetry: AnnotationControls["onRetry"] }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <div className={a.activity} data-failed={note.status === "failed" || undefined} role="status">
    <span className={a.activityDot} aria-hidden />
    <span>{note.status === "failed" ? note.note || "修改未完成，批注已保存。" : note.status === "queued" ? "Co-Agent 正在审阅这条批注…" : "Co-Agent 正在修改这段文字…"}</span>
    {note.canRetry ? <button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(""); const failure = await onRetry(note.id); setBusy(false); if (failure) setError(failure); }}>重试</button> : null}
    {error ? <p className={a.error}>{error}</p> : null}
  </div>;
}

function Clarification({ note, onAnswer }: { note: TMissionCardAnnotationView; onAnswer: AnnotationControls["onAnswer"] }) {
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const send = async (answer: string) => {
    if (!answer.trim() || locked.current || !note.canAnswer) return;
    locked.current = true; setBusy(true); setError("");
    const failure = await onAnswer(note.id, answer.trim());
    locked.current = false; setBusy(false);
    if (failure) setError(failure);
  };
  return <aside className={a.clarification} aria-label="明确修改意图">
    <header><span className={a.agentMark} aria-hidden>✦</span><span>Co-Agent 想确认</span></header>
    <h4>{note.question}</h4>
    <blockquote>你的批注：{note.body}</blockquote>
    <div className={a.options}>{note.options.map((option) => <button type="button" key={option} disabled={busy || !note.canAnswer} onClick={() => void send(option)}>{option}</button>)}<button type="button" aria-expanded={custom} disabled={busy || !note.canAnswer} onClick={() => setCustom(!custom)}>自己输入</button></div>
    {custom ? <div className={a.customAnswer}><textarea aria-label="补充你的意思" placeholder="写下你希望怎么改…" maxLength={4000} rows={2} autoFocus value={text} disabled={busy} onChange={(event) => setText(event.target.value)} /><button type="button" className={a.save} disabled={!text.trim() || busy} onClick={() => void send(text)}>确认并继续</button></div> : null}
    {!note.canAnswer ? <small>等待批注者或拍板人明确后继续</small> : <small>{busy ? "正在提交…" : "确定后立即修改，原文和记录都会保留"}</small>}
    {error ? <p className={a.error} role="alert">{error}</p> : null}
  </aside>;
}

export function RevisionHistory({ revisions }: { revisions: TMissionCardRevisionView[] }) {
  if (!revisions.length) return null;
  return <div className={a.revisions} aria-label="修改记录">{revisions.map((revision) => <details key={revision.id}>
    <summary><span>修改记录</span><time dateTime={revision.createdAt}>{monthDayTime(revision.createdAt)}</time><span>{revision.authorName} · v{revision.beforeVersion} → v{revision.afterVersion}</span></summary>
    <p className={a.reason}>{revision.reason}</p>
    <div className={a.revisionDiff}><div><small>修改前</small><p>{revision.before}</p></div><div><small>修改后</small><p>{revision.after}</p></div></div>
  </details>)}</div>;
}

export function SelectionPopover({ selection, onSave, onQuote, onClose }: { selection: AnnotationSelection; onSave: AnnotationControls["onSave"]; onQuote: () => void; onClose: () => void }) {
  const [mode, setMode] = useState<"menu" | "write">("menu");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const request = useRef({ body: "", id: "" });
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: window.innerHeight - 24, maxWidth: window.innerWidth - 24 });
  useEffect(() => {
    const place = () => {
      const rect = selection.range.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 12;
      const topEdge = (viewport?.offsetTop ?? 0) + 12;
      const rightEdge = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 12;
      const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 12;
      const width = panel.current?.offsetWidth ?? Math.min(mode === "write" ? 320 : 252, rightEdge - leftEdge);
      const height = panel.current?.offsetHeight ?? 48;
      const desiredTop = rect.bottom + height + 8 <= bottomEdge ? rect.bottom + 8 : rect.top - height - 8;
      const next = { left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)), top: Math.max(topEdge, Math.min(desiredTop, bottomEdge - height)), maxHeight: Math.max(0, bottomEdge - topEdge), maxWidth: Math.max(0, rightEdge - leftEdge) };
      setPosition((current) => current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight && current.maxWidth === next.maxWidth ? current : next);
    };
    place();
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", place); viewport?.addEventListener("scroll", place);
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && mode === "menu") onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) onClose(); } };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); viewport?.removeEventListener("resize", place); viewport?.removeEventListener("scroll", place); observer.disconnect(); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [mode, selection, onClose]);
  const send = async () => {
    if (!body.trim() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    if (request.current.body !== body.trim()) request.current = { body: body.trim(), id: crypto.randomUUID() };
    const failure = await onSave(selection, body.trim(), request.current.id);
    busyRef.current = false; setBusy(false);
    if (failure) setError(failure); else onClose();
  };
  const contents: ReactNode = mode === "menu" ? <>
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setMode("write")}><MessageSquarePlus size={15} aria-hidden />直接批注</button>
    <span className={a.divider} aria-hidden />
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onQuote}><MessageCircle size={15} aria-hidden />引用并对话</button>
  </> : <>
    <header><strong>直接批注</strong><button type="button" disabled={busy} aria-label="取消批注" onClick={onClose}><X size={15} aria-hidden /></button></header>
    <blockquote>{selection.quote}</blockquote>
    <textarea aria-label="批注内容" autoFocus rows={3} maxLength={4000} placeholder="写下你的意见…" value={body} disabled={busy} onChange={(event) => { setBody(event.target.value); setError(""); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
    <small>同卡成员可见 · 批注原文始终保留</small>
    {error ? <p className={a.error} role="alert">{error}</p> : null}
    <footer><button type="button" className={a.cancel} disabled={busy} onClick={onClose}>取消</button><button type="button" className={a.save} disabled={busy || !body.trim()} onClick={() => void send()}>{busy ? "保存中…" : "保存批注"}</button></footer>
  </>;
  return createPortal(<TianshuPortalTheme><div ref={panel} className={mode === "menu" ? a.menu : a.composer} style={position} role={mode === "menu" ? "toolbar" : "dialog"} aria-label={mode === "menu" ? "选中文字操作" : "添加批注"}>{contents}</div></TianshuPortalTheme>, document.body);
}
