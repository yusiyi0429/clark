"use client";

/**
 * 材料批注（用户 2026-09-30）：选中材料里任意文字 → 写批注 → Markdown / HTML 立即排队让 Co-Agent 按批注改（同一份一条条改），
 * PDF / Word 只留批注。改过的地方悬停看批注和修改历史；删掉的内容正文里不显示，进「垃圾篓」可恢复；
 * 对话里达成共识时 Co-Agent 的修改提议显示在材料上方，本人点了才改。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Check, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import type {
  TMaterialAnnotationView, TMaterialBlockHistoryEntry, TMaterialDetailResponse, TMaterialEditProposalView, TMaterialRemovedView,
} from "@warmap/contracts";
import s from "./material-annotations.module.css";

export type MaterialSelection = { text: string; prefix: string; suffix: string; top: number; left: number };
const date = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const MESSAGE = "tianshu-material-selection";

/** 给 Word 预览（srcDoc）用的选区脚本；HTML 预览由 API 注入同样的脚本。 */
export const SELECTION_SCRIPT = `<script>(function(){function t(n){return (n||"").replace(/\\s+/g," ")}document.addEventListener("mouseup",function(){setTimeout(function(){var s=getSelection();if(!s||s.isCollapsed||!t(s.toString()).trim()){parent.postMessage({type:"${MESSAGE}",text:""},"*");return}var r=s.getRangeAt(0),b=r.getBoundingClientRect(),a=document.createRange();a.selectNodeContents(document.body);a.setEnd(r.startContainer,r.startOffset);var z=document.createRange();z.selectNodeContents(document.body);z.setStart(r.endContainer,r.endOffset);parent.postMessage({type:"${MESSAGE}",text:t(s.toString()).trim(),prefix:t(a.toString()).slice(-200),suffix:t(z.toString()).slice(0,200),rect:{top:b.top,left:b.left,width:b.width,height:b.height}},"*")},0)})})();</script>`;

/** 选区：正文（Markdown）用 mouseup；HTML / Word 预览在 iframe 里，靠 postMessage 传出来。坐标都相对 host（article）。 */
export function useMaterialSelection(hostRef: RefObject<HTMLElement | null>, frameRef: RefObject<HTMLIFrameElement | null>) {
  const [selection, setSelection] = useState<MaterialSelection | null>(null);
  const clear = useCallback(() => { setSelection(null); window.getSelection()?.removeAllRanges(); }, []);
  const onMouseUp = useCallback((scope: HTMLElement | null) => {
    const host = hostRef.current;
    const picked = window.getSelection();
    if (!host || !scope || !picked || picked.isCollapsed) return;
    const text = picked.toString().replace(/\s+/g, " ").trim();
    if (!text || !scope.contains(picked.anchorNode)) return;
    const range = picked.getRangeAt(0);
    const before = document.createRange(); before.selectNodeContents(scope); before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange(); after.selectNodeContents(scope); after.setStart(range.endContainer, range.endOffset);
    const rect = range.getBoundingClientRect(); const hostRect = host.getBoundingClientRect();
    setSelection({ text: text.slice(0, 2000), prefix: before.toString().replace(/\s+/g, " ").slice(-200), suffix: after.toString().replace(/\s+/g, " ").slice(0, 200),
      top: rect.bottom - hostRect.top + 6, left: Math.max(0, Math.min(rect.left - hostRect.left, host.clientWidth - 320)) });
  }, [hostRef]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current; const host = hostRef.current;
      if (!frame || !host || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: string; text?: string; prefix?: string; suffix?: string; rect?: { top: number; left: number; height: number } };
      if (data?.type !== MESSAGE) return;
      if (!data.text || !data.rect) { setSelection(null); return; }
      const frameRect = frame.getBoundingClientRect(); const hostRect = host.getBoundingClientRect();
      setSelection({ text: data.text.slice(0, 2000), prefix: (data.prefix ?? "").slice(-200), suffix: (data.suffix ?? "").slice(0, 200),
        top: frameRect.top - hostRect.top + data.rect.top + data.rect.height + 6,
        left: Math.max(0, Math.min(frameRect.left - hostRect.left + data.rect.left, host.clientWidth - 320)) });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frameRef, hostRef]);
  return { selection, clear, onMouseUp };
}

/** 选中后浮出的「写批注」：先是一颗小按钮，点开是输入框；回车发送，Shift+回车换行。 */
export function AnnotationComposer({ selection, editable, onSubmit, onClose }: {
  selection: MaterialSelection; editable: boolean; onSubmit: (body: string) => Promise<string | null>; onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setOpen(false); setBody(""); setError(""); }, [selection.text, selection.top]);
  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true); setError("");
    const failure = await onSubmit(body.trim());
    setBusy(false);
    if (failure) setError(failure); else onClose();
  };
  if (!open) return <button type="button" className={s.pill} style={{ top: selection.top, left: selection.left }}
    onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(true)}><MessageSquarePlus size={14} aria-hidden />写批注</button>;
  return <div className={s.composer} style={{ top: selection.top, left: selection.left }} role="dialog" aria-label="写批注">
    <p className={s.quote}>「{selection.text}」</p>
    <textarea autoFocus rows={3} maxLength={2000} value={body} disabled={busy} placeholder={editable ? "写下你的意见，Co-Agent 会按它改这里" : "写下你的批注（PDF、Word 不能改，只留批注）"}
      onChange={(event) => { setBody(event.target.value); setError(""); }}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } if (event.key === "Escape") onClose(); }} />
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    <div className={s.composerActions}>
      <button type="button" className={s.ghost} onClick={onClose}>取消</button>
      <button type="button" className={s.send} disabled={!body.trim() || busy} onClick={() => void send()}>{busy ? "发送中…" : editable ? "发送并修改" : "发送"}</button>
    </div>
  </div>;
}

const STATUS: Record<TMaterialAnnotationView["status"], string> = {
  queued: "排队中", applying: "修改中", applied: "已改", no_change: "无需修改", failed: "没改成", kept: "批注",
};

/** 材料上方的一行：正在改的批注数、全部批注、垃圾篓。 */
export function AnnotationBar({ detail, onRestore }: { detail: TMaterialDetailResponse; onRestore: (removed: TMaterialRemovedView) => Promise<string | null> }) {
  const [panel, setPanel] = useState<"notes" | "trash" | null>(null);
  const working = detail.annotations.filter((note) => note.status === "queued" || note.status === "applying").length;
  if (!detail.annotations.length && !detail.removed.length) return null;
  return <div className={s.bar}>
    {working ? <span className={s.working} role="status"><span className={s.pulse} aria-hidden />Co-Agent 正在按批注修改{working > 1 ? `（还有 ${working} 条）` : ""}…</span> : null}
    <span className={s.spacer} />
    {detail.annotations.length ? <button type="button" aria-expanded={panel === "notes"} onClick={() => setPanel(panel === "notes" ? null : "notes")}>批注 {detail.annotations.length}</button> : null}
    {detail.removed.length ? <button type="button" aria-expanded={panel === "trash"} onClick={() => setPanel(panel === "trash" ? null : "trash")}><Trash2 size={13} aria-hidden />已删除 {detail.removed.length} 段</button> : null}
    {panel === "notes" ? <ol className={s.panel} aria-label="批注">{detail.annotations.map((note) => <li key={note.id}>
      <p className={s.quote}>「{note.quote}」</p>
      <p>{note.body}</p>
      <small>{note.author.displayName} · {date(note.createdAt)} · <span className={s.status} data-status={note.status}>{STATUS[note.status]}{note.status === "applied" && note.appliedVersion ? ` · 第 ${note.appliedVersion} 版` : ""}</span>{note.note ? ` · ${note.note}` : ""}</small>
    </li>)}</ol> : null}
    {panel === "trash" ? <TrashPanel removed={detail.removed} onRestore={onRestore} /> : null}
  </div>;
}

function TrashPanel({ removed, onRestore }: { removed: TMaterialRemovedView[]; onRestore: (removed: TMaterialRemovedView) => Promise<string | null> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  return <ol className={s.panel} aria-label="已删除的内容">
    {error ? <li className={s.error} role="alert">{error}</li> : null}
    {removed.map((item) => <li key={item.id}>
      <p className={s.removedText}>{item.text}</p>
      <small>第 {item.version} 版删掉 · {item.requestedBy?.displayName ?? "Agent"} · {date(item.at)}{item.annotation ? ` · 按批注「${item.annotation.body.slice(0, 30)}」` : ""}</small>
      {item.restorable ? <button type="button" className={s.restore} disabled={busy !== null} onClick={async () => {
        setBusy(item.id); setError("");
        const failure = await onRestore(item);
        setBusy(null);
        if (failure) setError(failure);
      }}><RotateCcw size={12} aria-hidden />{busy === item.id ? "恢复中…" : "恢复"}</button> : null}
    </li>)}
  </ol>;
}

/** Co-Agent 在对话里达成共识后的修改提议：显示在材料上方，本人点「按这个改」才改。 */
export function ProposalBanner({ proposal, onDecide }: { proposal: TMaterialEditProposalView; onDecide: (decision: "apply" | "dismiss") => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const decide = async (decision: "apply" | "dismiss") => {
    setBusy(true); setError("");
    const failure = await onDecide(decision);
    setBusy(false);
    if (failure) setError(failure);
  };
  const shown = all ? proposal.changes : proposal.changes.slice(0, 2);
  return <section className={s.proposal} aria-label="Co-Agent 的修改提议">
    <header>Co-Agent 按对话里的共识提议修改 · {date(proposal.createdAt)}</header>
    <p className={s.summary}>{proposal.summary}</p>
    <ol className={s.changes}>{shown.map((change, index) => <li key={index}><del>{change.before}</del><ins>{change.after}</ins></li>)}</ol>
    {proposal.changes.length > 2 && !all ? <button type="button" className={s.ghost} onClick={() => setAll(true)}>还有 {proposal.changes.length - 2} 处</button> : null}
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    <div className={s.composerActions}>
      <button type="button" className={s.ghost} disabled={busy} onClick={() => void decide("dismiss")}><X size={13} aria-hidden />忽略</button>
      <button type="button" className={s.send} disabled={busy} onClick={() => void decide("apply")}><Check size={13} aria-hidden />{busy ? "修改中…" : "按这个改"}</button>
    </div>
  </section>;
}

/** 悬停在改过的段落上：历次改动（新的在前），每次的批注、原文、谁、何时。 */
export function HistoryCard({ history }: { history: TMaterialBlockHistoryEntry[] }) {
  return <div className={s.history} role="note">
    {history.map((entry) => <div key={entry.version} className={s.entry}>
      {entry.annotation ? <p className={s.note}><strong>{entry.annotation.author.displayName}</strong> 批注「{entry.annotation.quote.slice(0, 40)}」：{entry.annotation.body}</p> : null}
      {entry.kind === "modified" ? <p className={s.before}>原来：{entry.before}</p> : <p className={s.before}>这段是新加的</p>}
      <small>第 {entry.version} 版 · {entry.requestedBy?.displayName ?? "Agent"}让 Co-Agent 改的 · {date(entry.at)}</small>
    </div>)}
  </div>;
}

/** 有批注在改时每 2.5 秒读一次，改完为止。 */
export function usePollWhileWorking(detail: TMaterialDetailResponse | null, reload: () => void) {
  const working = detail?.annotations.some((note) => note.status === "queued" || note.status === "applying") ?? false;
  const reloadRef = useRef(reload); reloadRef.current = reload;
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => reloadRef.current(), 2500);
    return () => window.clearInterval(timer);
  }, [working]);
}
