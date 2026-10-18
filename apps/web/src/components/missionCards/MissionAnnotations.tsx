"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, MessageSquarePlus, X } from "lucide-react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { TianshuPortalTheme } from "ts-design";
import type { TMissionCardField, TMissionCardAnnotationView, TMissionCardRevisionView } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { annotationMarks, fieldSelectionRange, normalizeAnchorText, revisionAnchor, type MarkAnchor, type TextAnchor } from "./annotationAnchors";
import type { PersonalMission } from "./CardDocument";
import a from "./mission-annotations.module.css";

export type AnnotationSelection = TextAnchor & { mission: PersonalMission; field: TMissionCardField; sourceText: string; sourceRound?: number; range: Range };
export type AnnotationControls = {
  notes: TMissionCardAnnotationView[];
  revisions: TMissionCardRevisionView[];
  onSave: (selection: AnnotationSelection, body: string, clientId: string, intent?: "note" | "edit") => Promise<string | null>;
  onAnswer: (id: string, answer: string) => Promise<string | null>;
  onRetry: (id: string) => Promise<string | null>;
  onResolve?: (id: string, reason: string) => Promise<string | null>;
  closedReason?: string | null;
};
const RecordContext = createContext<{ notes: TMissionCardAnnotationView[]; revisions: TMissionCardRevisionView[]; controls?: AnnotationControls } | null>(null);
function AnnotationSpan({ node, children, ...props }: ComponentProps<"span"> & ExtraProps) {
  const records = useContext(RecordContext), id = node?.properties.dataAnnotationBubble;
  const ids = typeof id === "string" ? id.split(" ") : [];
  return records && ids.length ? <RecordIcon notes={records.notes.filter((note) => ids.includes(note.id))} revisions={records.revisions.filter((revision) => ids.includes(revision.id))} controls={records.controls} /> : <span {...props}>{children}</span>;
}
const annotationComponents = { span: AnnotationSpan };

export function useMissionAnnotations(cardId: string, round = 1) {
  const [notes, setNotes] = useState<TMissionCardAnnotationView[]>([]);
  const [revisions, setRevisions] = useState<TMissionCardRevisionView[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const scope = useRef(0);
  const live = useRef(true);
  const activeCard = useRef(cardId);
  const mutations = useRef(0);
  const mutationSerial = useRef(0);
  const latestMutation = useRef(new Map<string, number>());
  const isCurrent = useCallback((requestScope: number, requestCard: string) => live.current && scope.current === requestScope && activeCard.current === requestCard, []);
  const refresh = useCallback(async () => {
    const requestScope = scope.current;
    if (!isCurrent(requestScope, cardId)) return;
    // 后发的读取优先；写入开始与完成都会使之前的读取失效。
    const current = ++generation.current;
    try {
      const response = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/annotations`);
      if (!response.ok) throw new Error("批注暂时无法读取，请重试。");
      const data = await response.json() as { annotations: TMissionCardAnnotationView[]; revisions: TMissionCardRevisionView[] };
      if (isCurrent(requestScope, cardId) && current === generation.current) { setNotes(data.annotations); setRevisions(data.revisions); setError(""); }
    } catch { if (isCurrent(requestScope, cardId) && current === generation.current) setError("批注暂时无法读取，请重试。"); }
  }, [cardId, isCurrent]);
  useEffect(() => {
    scope.current++; live.current = true; activeCard.current = cardId;
    generation.current++;
    mutations.current = 0; mutationSerial.current = 0; latestMutation.current.clear();
    setNotes([]);
    setRevisions([]);
    setError("");
    setPending(false);
    void refresh();
    const resume = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const interval = setInterval(resume, 2500);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { live.current = false; scope.current++; generation.current++; clearInterval(interval); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [cardId, refresh]);
  const beginMutation = useCallback(() => {
    const requestScope = scope.current;
    if (!isCurrent(requestScope, cardId)) return null;
    mutations.current++; setPending(true); generation.current++;
    return { scope: requestScope, serial: ++mutationSerial.current };
  }, [cardId, isCurrent]);
  const finishMutation = useCallback((requestScope: number) => {
    if (!isCurrent(requestScope, cardId)) return;
    mutations.current--; setPending(mutations.current > 0);
  }, [cardId, isCurrent]);
  const acceptMutation = useCallback((request: { scope: number; serial: number }, saved: TMissionCardAnnotationView) => {
    if (!isCurrent(request.scope, cardId)) return false;
    // POST 期间开始的 GET 仍可能包含旧快照；成功响应之后一并作废。
    generation.current++;
    if ((latestMutation.current.get(saved.id) ?? 0) <= request.serial) {
      latestMutation.current.set(saved.id, request.serial);
      setNotes((current) => {
        if (!isCurrent(request.scope, cardId) || (latestMutation.current.get(saved.id) ?? 0) > request.serial) return current;
        return current.some((note) => note.id === saved.id) ? current.map((note) => note.id === saved.id ? saved : note) : [...current, saved];
      });
      setError("");
    }
    return true;
  }, [cardId, isCurrent]);
  const changedCard = "任务卡已关闭或切换，重新打开原任务卡可查看保存结果。";
  const save = useCallback(async (selection: AnnotationSelection, body: string, clientId: string, intent: "note" | "edit" = "note"): Promise<string | null> => {
    const request = beginMutation();
    if (!request) return changedCard;
    try {
      const response = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/annotations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, intent, missionId: selection.mission.missionId, field: selection.field, sourceRound: selection.sourceRound ?? round, sourceVersion: selection.mission.version, sourceText: selection.sourceText, quote: selection.quote, prefix: selection.prefix, suffix: selection.suffix, startOffset: selection.startOffset, body }) });
      const data = await response.json() as { annotation?: TMissionCardAnnotationView; message?: string };
      if (!isCurrent(request.scope, cardId)) return changedCard;
      if (!response.ok || !data.annotation) return data.message ?? "批注未保存，请重试；输入已保留。";
      return acceptMutation(request, data.annotation) ? null : changedCard;
    } catch { return isCurrent(request.scope, cardId) ? "暂时无法连接服务器，请重试；输入已保留。" : changedCard; }
    finally { finishMutation(request.scope); }
  }, [cardId, round, beginMutation, acceptMutation, finishMutation, isCurrent]);
  const respond = useCallback(async (id: string, action: "answer" | "retry" | "resolve", body: object): Promise<string | null> => {
    const request = beginMutation();
    if (!request) return changedCard;
    latestMutation.current.set(id, request.serial);
    try {
      const response = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/annotations/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { annotation?: TMissionCardAnnotationView; message?: string };
      if (!isCurrent(request.scope, cardId)) return changedCard;
      if (!response.ok || !data.annotation) return data.message ?? "没有提交成功，请重试。";
      if (!acceptMutation(request, data.annotation)) return changedCard;
      void refresh(); return null;
    } catch { return isCurrent(request.scope, cardId) ? "暂时无法连接服务器，输入已保留。" : changedCard; }
    finally { finishMutation(request.scope); }
  }, [cardId, refresh, beginMutation, acceptMutation, finishMutation, isCurrent]);
  const answer = useCallback((id: string, text: string) => respond(id, "answer", { answer: text }), [respond]);
  const retry = useCallback((id: string) => respond(id, "retry", {}), [respond]);
  const resolve = useCallback((id: string, reason: string) => respond(id, "resolve", { reason }), [respond]);
  return { notes, revisions, error, pending, refresh, save, answer, retry, resolve };
}

export function AnnotatedField({ mission, field, text, markdownText = text, notes, revisions = [], controls, onSelect, sourceRound }: { mission: PersonalMission; field: TMissionCardField; text: string; markdownText?: string; notes: TMissionCardAnnotationView[]; revisions?: TMissionCardRevisionView[]; controls?: AnnotationControls; onSelect: (selection: AnnotationSelection | null) => void; sourceRound?: number }) {
  const fieldNode = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const collect = useCallback(() => {
    const node = fieldNode.current;
    if (!node) return;
    const range = fieldSelectionRange(node, window.getSelection());
    if (!range) { onSelect(null); return; }
    const before = document.createRange(); before.selectNodeContents(node); before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange(); after.selectNodeContents(node); after.setStart(range.endContainer, range.endOffset);
    const quote = normalizeAnchorText(range.toString());
    if (!quote || quote.length > 2000) { onSelect(null); return; }
    const rawBefore = before.toString().replace(/\s+/g, " ").trimStart();
    onSelect({ mission, field, sourceText: text, sourceRound, quote, prefix: rawBefore.slice(-200), suffix: after.toString().replace(/\s+/g, " ").slice(0, 200), startOffset: rawBefore.length, range });
  }, [mission, field, text, sourceRound, onSelect]);
  const schedule = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { frame.current = null; collect(); });
  }, [collect]);
  useEffect(() => {
    const changed = () => {
      const node = fieldNode.current, picked = window.getSelection();
      // Editing a popover never replaces the captured document selection.
      if (document.activeElement?.closest("[data-mission-selection-panel]")) return;
      if (node && picked && (node.contains(picked.anchorNode) || node.contains(picked.focusNode))) schedule();
    };
    document.addEventListener("selectionchange", changed);
    return () => { document.removeEventListener("selectionchange", changed); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, [schedule]);
  const linked = new Set(revisions.map((revision) => revision.annotationId).filter(Boolean));
  const marks: MarkAnchor[] = [
    ...notes.filter((note) => !linked.has(note.id)),
    ...revisions.map((revision) => {
      const anchor = revisionAnchor(revision.before, revision.after);
      return { ...(anchor ?? { quote: "", prefix: "", suffix: "", startOffset: 0 }), id: [revision.id, ...notes.filter((note) => note.id === revision.annotationId).map((note) => note.id)].join(" ") };
    }),
  ];
  return <div className={a.fieldWrap}>
    <div ref={fieldNode} className={a.markdown} data-mission-field={`${mission.missionId}:${field}`} onPointerUp={schedule} onDoubleClick={schedule} onKeyUp={(event) => { if (event.shiftKey) schedule(); }} onTouchEnd={schedule}>
      <RecordContext.Provider value={{ notes, revisions, controls }}><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[annotationMarks(marks)]} components={annotationComponents}>{markdownText || "未提供"}</Markdown></RecordContext.Provider>
    </div>
  </div>;
}

function RecordIcon({ notes, revisions, controls }: { notes: TMissionCardAnnotationView[]; revisions: TMissionCardRevisionView[]; controls?: AnnotationControls }) {
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returningFocus = useRef(false);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 500 });
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const preview = () => { cancelClose(); if (returningFocus.current) { returningFocus.current = false; return; } setOpen(true); };
  const close = () => { setOpen(false); setPinned(false); if (document.activeElement !== button.current) { returningFocus.current = true; button.current?.focus(); } };
  const leave = () => { if (!pinned) closeTimer.current = setTimeout(() => setOpen(false), 120); };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const place = () => {
      if (!button.current) return;
      const rect = button.current.getBoundingClientRect(), viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12, top = (viewport?.offsetTop ?? 0) + 12;
      const right = left + (viewport?.width ?? window.innerWidth) - 24, bottom = top + (viewport?.height ?? window.innerHeight) - 24;
      const width = panel.current?.offsetWidth ?? Math.min(340, right - left), height = panel.current?.offsetHeight ?? 200;
      setPosition({ left: Math.max(left, Math.min(rect.left, right - width)), top: Math.max(top, Math.min(rect.bottom + 7, bottom - height)), maxHeight: bottom - top });
    };
    const outside = (event: PointerEvent) => { if (!button.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) { setOpen(false); setPinned(false); } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } };
    place(); document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    const observer = new ResizeObserver(place); if (panel.current) observer.observe(panel.current);
    viewport?.addEventListener("resize", place); viewport?.addEventListener("scroll", place);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); viewport?.removeEventListener("resize", place); viewport?.removeEventListener("scroll", place); };
  }, [open, pinned]);
  const visibleNotes = pinned ? notes : notes.slice(-1), visibleRevisions = pinned ? revisions : revisions.slice(-1);
  return <>
    <button ref={button} type="button" className={a.bubble} aria-label="查看此处批注与修改记录" aria-expanded={open} onPointerEnter={(event) => { if (event.pointerType !== "touch") preview(); }} onPointerLeave={leave} onFocus={preview} onBlur={leave} onPointerDown={(event) => event.stopPropagation()} onClick={() => { cancelClose(); if (pinned) { setOpen(false); setPinned(false); } else { setOpen(true); setPinned(true); } }}><MessageCircle size={12} aria-hidden /></button>
    {open ? createPortal(<TianshuPortalTheme><div ref={panel} className={a.recordPopover} style={position} data-pinned={pinned || undefined} role={pinned ? "dialog" : "tooltip"} aria-label="批注与修改记录" onPointerEnter={cancelClose} onPointerLeave={leave}>
      <header><span>{revisions.length ? "修改记录" : "批注"}</span>{pinned ? <button type="button" aria-label="收起记录" onClick={close}><X size={14} aria-hidden /></button> : null}</header>
      {visibleRevisions.map((revision) => <section className={a.recordEntry} key={revision.id}>
        <div className={a.recordMeta}>{revision.authorName}<time dateTime={revision.createdAt}>{monthDayTime(revision.createdAt)}</time></div>
        <small>原文</small><p>{revision.before}</p><small>修改依据</small><p>{revision.reason}</p>
        {notes.filter((note) => note.id === revision.annotationId && !visibleNotes.includes(note)).map((note) => <p key={note.id}>{note.body}</p>)}
        <small>修改后</small><p>{revision.after}</p>
      </section>)}
      {visibleNotes.map((note) => pinned ? <AnnotationNote key={note.id} note={note} onRetry={controls?.onRetry} /> : <section key={note.id} className={a.recordEntry}><div className={a.recordMeta}>{note.authorName}<time dateTime={note.createdAt}>{monthDayTime(note.createdAt)}</time></div><small>原文</small><p>{note.quote}</p><small>批注</small><p>{note.body}</p>{note.note ? <p>{note.note}</p> : null}</section>)}
      {!pinned && notes.length + revisions.length > visibleNotes.length + visibleRevisions.length ? <small className={a.recordMore}>点击查看全部记录</small> : null}
    </div></TianshuPortalTheme>, document.body) : null}
  </>;
}

export function AnnotationNote({ note, onClose, onRetry }: { note: TMissionCardAnnotationView; onClose?: () => void; onRetry?: AnnotationControls["onRetry"] }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!note) return null;
  return <aside className={a.note} aria-label="批注内容">
    <header><strong>{note.authorName}</strong><time dateTime={note.createdAt}>{monthDayTime(note.createdAt)}</time>{onClose ? <button type="button" aria-label="收起批注" onClick={onClose}><X size={14} aria-hidden /></button> : null}</header>
    <blockquote>{note.quote}</blockquote><p>{note.body}</p>
    {note.note ? <p className={a.reason}>{note.note}</p> : null}
    {note.clarifications?.length ? <details className={a.clarificationHistory}><summary>查看沟通记录 · {note.clarifications.length}</summary>{note.clarifications.map((item, index) => <div key={`${item.createdAt}:${index}`}><p>{item.question}</p><p><strong>{item.authorName}</strong>：{item.answer}</p><time dateTime={item.createdAt}>{monthDayTime(item.createdAt)}</time></div>)}</details> : null}
    <small>{({ saved: "批注已保存", queued: "Co-Agent 准备处理", applying: "Co-Agent 正在修改", needs_clarification: "待明确修改意图", applied: "已按批注修改", no_change: "保留备注 · 正文未修改", failed: "修改未完成" } as const)[note.status]}{note.stale ? " · 原文已留存" : ""}</small>
    {note.status === "saved" && note.canRetry && onRetry ? <button type="button" className={a.noteApply} disabled={busy} onClick={async () => { setBusy(true); setError(""); const failure = await onRetry(note.id); setBusy(false); if (failure) setError(failure); }}>{busy ? "提交中…" : "让 Agent 修改"}</button> : null}
    {error ? <p className={a.error} role="alert">{error}</p> : null}
  </aside>;
}

export function FieldAnnotationActivity({ notes, controls }: { notes: TMissionCardAnnotationView[]; controls: AnnotationControls }) {
  return <>{notes.filter((note) => ["queued", "applying", "needs_clarification", "failed"].includes(note.status)).map((note) => <div key={note.id}>{note.status === "needs_clarification" ? <Clarification note={note} onAnswer={controls.onAnswer} closedReason={controls.closedReason} /> : <PendingNote note={note} onRetry={controls.onRetry} />}{note.canResolve && controls.onResolve ? <ResolveNote id={note.id} onResolve={controls.onResolve} /> : null}</div>)}</>;
}

function ResolveNote({ id, onResolve }: { id: string; onResolve: NonNullable<AnnotationControls["onResolve"]> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const resolve = async () => {
    if (!reason.trim() || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    const failure = await onResolve(id, reason.trim());
    locked.current = false; setBusy(false);
    if (failure) setError(failure); else setOpen(false);
  };
  return <div className={a.resolve}><button type="button" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>保留备注，暂不修改</button>{open ? <div className={a.resolveForm}><label htmlFor={`annotation-resolve-${id}`}>暂不修改的原因</label><textarea id={`annotation-resolve-${id}`} autoFocus rows={2} maxLength={1000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} placeholder="说明为什么保留备注、暂不改正文…" />{error ? <p role="alert" className={a.error}>{error}</p> : null}<div className={a.options}><button type="button" disabled={busy || !reason.trim()} onClick={() => void resolve()}>{busy ? "保存中…" : "确认保留备注"}</button><button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button></div></div> : null}</div>;
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

function Clarification({ note, onAnswer, closedReason }: { note: TMissionCardAnnotationView; onAnswer: AnnotationControls["onAnswer"]; closedReason?: string | null }) {
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
    {custom ? <div className={a.customAnswer}><textarea aria-label="补充你的意思" placeholder="写下你希望怎么改…" maxLength={4000} rows={2} autoFocus value={text} disabled={busy || !note.canAnswer} onChange={(event) => setText(event.target.value)} /><button type="button" className={a.save} disabled={!text.trim() || busy || !note.canAnswer} onClick={() => void send(text)}>确认并继续</button></div> : null}
    {!note.canAnswer ? <small>{closedReason ?? "等待批注者或拍板人明确后继续"}</small>  : busy ? <small>正在提交…</small> : null}
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

export function SelectionPopover({ selection, onSave, onQuote, onClose, canCreate = true, closedReason }: { selection: AnnotationSelection; onSave: AnnotationControls["onSave"]; onQuote: () => void; onClose: () => void; canCreate?: boolean; closedReason?: string | null }) {
  const [mode, setMode] = useState<"menu" | "write">("menu");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const request = useRef({ body: "", intent: "note" as "note" | "edit", id: "" });
  const [sending, setSending] = useState<"note" | "edit" | null>(null);
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
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !busyRef.current) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) onClose(); } };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); viewport?.removeEventListener("resize", place); viewport?.removeEventListener("scroll", place); observer.disconnect(); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [mode, selection, onClose]);
  const send = async (intent: "note" | "edit") => {
    if (!canCreate || !body.trim() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setSending(intent); setError("");
    if (request.current.body !== body.trim() || request.current.intent !== intent || !request.current.id) request.current = { body: body.trim(), intent, id: crypto.randomUUID() };
    const failure = await onSave(selection, body.trim(), request.current.id, intent);
    busyRef.current = false; setBusy(false); setSending(null);
    if (failure) setError(failure); else onClose();
  };
  const contents: ReactNode = mode === "menu" ? <>
    {canCreate ? <><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setMode("write")}><MessageSquarePlus size={15} aria-hidden />直接批注</button><span className={a.divider} aria-hidden /></> : null}
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onQuote}><MessageCircle size={15} aria-hidden />引用并对话</button>
  </> : <>
    <textarea aria-label="修改意见" autoFocus rows={3} maxLength={4000} placeholder="写下修改意见" value={body} disabled={busy || !canCreate} onChange={(event) => { setBody(event.target.value); setError(""); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send("note"); } }} />
    {!canCreate && closedReason ? <p className={a.reason} role="status">{closedReason}</p> : null}
    {error ? <p className={a.error} role="alert">{error}</p> : null}
    <footer><button type="button" className={a.cancel} disabled={busy || !canCreate || !body.trim()} onClick={() => void send("note")}>{sending === "note" ? "保存中…" : "保存"}</button><button type="button" className={a.save} disabled={busy || !canCreate || !body.trim()} onClick={() => void send("edit")}>{sending === "edit" ? "修改中…" : "立即修改"}</button></footer>
  </>;
  return createPortal(<TianshuPortalTheme><div ref={panel} data-mission-selection-panel className={mode === "menu" ? a.menu : a.composer} style={position} role={mode === "menu" ? "toolbar" : "dialog"} aria-label={mode === "menu" ? "选中文字操作" : "添加批注"}>{contents}</div></TianshuPortalTheme>, document.body);
}
