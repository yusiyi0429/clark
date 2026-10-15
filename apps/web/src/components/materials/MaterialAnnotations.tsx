"use client";

/**
 * 材料批注（用户 2026-09-30，10-06 改为按「谁写的」区分）：选中材料里任意文字 → 写批注。能改这份的人（上传者、对象负责人）
 * 可以「立即修改」，排队让 Co-Agent 按批注改（同一份一条条改）；其他人的批注先保存，等能改的人「采用 / 不采用」；PDF / Word 只留批注。
 * 改过的地方悬停看批注和修改历史；删掉的内容正文里不显示，进「垃圾篓」可恢复；对话里的修改提议显示在材料上方，能改的人点了才改。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import type {
  TMaterialAnnotationView, TMaterialBlockHistoryEntry, TMaterialDetailResponse, TMaterialEditProposalView, TMaterialRemovedView,
  TMaterialRevisionOrigin, TMaterialView,
} from "@warmap/contracts";
import s from "./material-annotations.module.css";

export type MaterialSelection = { text: string; prefix: string; suffix: string; top: number; left: number };
const date = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const MESSAGE = "tianshu-material-selection";

/** 给 Word 预览（srcDoc）用的选区脚本；HTML 预览由 API 注入同样的脚本。 */
export const SELECTION_SCRIPT = `<script>(function(){function t(n){return (n||"").replace(/\\s+/g," ")}function p(){var s=getSelection();if(!s||s.isCollapsed||!t(s.toString()).trim()){parent.postMessage({type:"${MESSAGE}",text:""},"*");return}var r=s.getRangeAt(0),b=r.getBoundingClientRect(),a=document.createRange();a.selectNodeContents(document.body);a.setEnd(r.startContainer,r.startOffset);var z=document.createRange();z.selectNodeContents(document.body);z.setStart(r.endContainer,r.endOffset);parent.postMessage({type:"${MESSAGE}",text:t(s.toString()).trim(),prefix:t(a.toString()).slice(-200),suffix:t(z.toString()).slice(0,200),rect:{top:b.top,left:b.left,width:b.width,height:b.height}},"*")}document.addEventListener("mouseup",function(){setTimeout(p,0)});if(matchMedia("(pointer: coarse)").matches){var w;document.addEventListener("selectionchange",function(){clearTimeout(w);w=setTimeout(function(){if(t(String(getSelection())).trim())p()},300)})}})();</script>`;

/** 触屏：长按选字不触发 mouseup，改听 selectionchange；「写批注」由 CSS 固定在屏幕底部，不用选区坐标。 */
const touchSelection = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/**
 * 选区：正文（Markdown）用 mouseup（触屏用 selectionchange）；HTML / Word 预览在 iframe 里，靠 postMessage 传出来。坐标都相对 host（article）。
 */
export function useMaterialSelection(hostRef: RefObject<HTMLElement | null>, frameRef: RefObject<HTMLIFrameElement | null>, scopeRef?: RefObject<HTMLElement | null>) {
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
  useEffect(() => {
    if (!scopeRef || !touchSelection()) return;
    let timer: number | undefined;
    const changed = () => {
      window.clearTimeout(timer);
      // 停手 300ms 再取，拖动选区手柄时不跟着闪。选区收起时不清：输入框获得焦点、点「写批注」都会收起选区，关掉靠「取消」。
      timer = window.setTimeout(() => onMouseUp(scopeRef.current), 300);
    };
    document.addEventListener("selectionchange", changed);
    return () => { window.clearTimeout(timer); document.removeEventListener("selectionchange", changed); };
  }, [onMouseUp, scopeRef]);
  return { selection, clear, onMouseUp };
}

/**
 * 选中后浮出的「写批注」：先是一颗小按钮，点开是输入框；回车保存，Shift+回车换行。
 * 能改这份材料的人（上传者、对象负责人）有「保存」和「立即修改」，和任务卡批注同一套按钮；其他人只有「保存」，等能改的人采用。
 */
export function AnnotationComposer({ selection, canEdit, onSubmit, onClose }: {
  selection: MaterialSelection; canEdit: boolean; onSubmit: (body: string, intent: "note" | "edit") => Promise<string | null>; onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState<"note" | "edit" | null>(null);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); setBody(""); setError(""); }, [selection.text, selection.top]);
  // 材料区是可滚动的盒子：选中末尾的字时输入框会落到盒子外面，打开时滚到整个能看见。
  useEffect(() => { if (open) box.current?.scrollIntoView({ block: "nearest" }); }, [open]);
  const send = async (intent: "note" | "edit") => {
    if (!body.trim() || sending) return;
    setSending(intent); setError("");
    const failure = await onSubmit(body.trim(), intent);
    setSending(null);
    if (failure) setError(failure); else onClose();
  };
  // 触屏：挂到 body 上固定在屏幕底部（面板有布局隔离，fixed 会跟着面板走、还压不过对话输入条）；选区收起后也还在，所以带一个关掉的按钮。
  const docked = touchSelection();
  const place = (node: ReactNode) => docked ? createPortal(node, document.body) : node;
  const at = docked ? undefined : { top: selection.top, left: selection.left };
  if (!open) {
    const pill = <button type="button" className={s.pill} style={at}
      onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(true)}><MessageSquarePlus size={14} aria-hidden />写批注</button>;
    return docked ? place(<div className={s.dock}>{pill}<button type="button" className={s.dockClose} aria-label="不写批注" onClick={onClose}><X size={16} aria-hidden /></button></div>) : pill;
  }
  return place(<div ref={box} className={s.composer} style={at} role="dialog" aria-label="写批注">
    <p className={s.quote}>「{selection.text}」</p>
    <textarea autoFocus rows={3} maxLength={2000} value={body} disabled={sending !== null} placeholder="写下修改意见"
      onChange={(event) => { setBody(event.target.value); setError(""); }}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send("note"); } if (event.key === "Escape") onClose(); }} />
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    <footer>
      <button type="button" className={s.ghost} onClick={onClose}>取消</button>
      <button type="button" className={canEdit ? s.keep : s.apply} disabled={!body.trim() || sending !== null} onClick={() => void send("note")}>{sending === "note" ? "保存中…" : "保存"}</button>
      {canEdit ? <button type="button" className={s.apply} disabled={!body.trim() || sending !== null} onClick={() => void send("edit")}>{sending === "edit" ? "修改中…" : "立即修改"}</button> : null}
    </footer>
  </div>);
}

const STATUS: Record<TMaterialAnnotationView["status"], string> = {
  noted: "已保存", queued: "排队中", applying: "修改中", applied: "已改", no_change: "无需修改", failed: "没改成", declined: "不采用",
};

export type DecideAnnotation = (id: string, decision: "adopt" | "decline", reason?: string) => Promise<string | null>;

/** 材料上方的一行：正在改的批注数、全部批注、垃圾篓。 */
export function AnnotationBar({ detail, onRestore, onDecide }: { detail: TMaterialDetailResponse;
  onRestore: (removed: TMaterialRemovedView) => Promise<string | null>; onDecide?: DecideAnnotation }) {
  const [panel, setPanel] = useState<"notes" | "trash" | null>(null);
  const working = detail.annotations.filter((note) => note.status === "queued" || note.status === "applying").length;
  if (!detail.annotations.length && !detail.removed.length) return null;
  return <div className={s.bar}>
    {working ? <span className={s.working} role="status"><span className={s.pulse} aria-hidden />Co-Agent 正在按批注修改{working > 1 ? `（还有 ${working} 条）` : ""}…</span> : null}
    <span className={s.spacer} />
    {detail.annotations.length ? <button type="button" aria-expanded={panel === "notes"} onClick={() => setPanel(panel === "notes" ? null : "notes")}>批注 {detail.annotations.length}</button> : null}
    {detail.removed.length ? <button type="button" aria-expanded={panel === "trash"} onClick={() => setPanel(panel === "trash" ? null : "trash")}><Trash2 size={13} aria-hidden />已删除 {detail.removed.length} 段</button> : null}
    {panel === "notes" ? <ol className={s.panel} aria-label="批注">{detail.annotations.map((note) =>
      <NoteItem key={note.id} note={note} material={detail.material} onDecide={onDecide} />)}</ol> : null}
    {panel === "trash" ? <TrashPanel removed={detail.removed} onRestore={onRestore} /> : null}
  </div>;
}

/**
 * 一条批注。不能改这份材料的人看到「待{上传者}处理」；能改的人在别人保存的批注上「采用 / 不采用」，在自己保存的上「立即修改」。
 * 不采用的收起成一行（谁不采用、原因），悬停或点一下才展开原文和意见。
 */
function NoteItem({ note, material, onDecide }: { note: TMaterialAnnotationView; material: TMaterialView; onDecide?: DecideAnnotation }) {
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const decide = async (decision: "adopt" | "decline") => {
    if (!onDecide || busy) return;
    setBusy(true); setError("");
    const failure = await onDecide(note.id, decision, decision === "decline" ? reason.trim() : undefined);
    setBusy(false);
    if (failure) setError(failure);
  };
  const declined = note.status === "declined";
  const label = declined ? `${note.decidedBy?.displayName ?? ""}不采用${note.note ? `：${note.note}` : ""}`
    : note.status === "noted" && material.editable && !material.canEdit ? `待${material.owner.displayName}处理` : STATUS[note.status];
  const adoptedBy = !declined && note.decidedBy && note.decidedBy.personId !== note.author.personId ? note.decidedBy.displayName : null;
  return <li data-status={note.status} tabIndex={declined ? 0 : undefined}>
    <p className={s.quote}>「{note.quote}」</p>
    <p>{note.body}</p>
    <small>{note.author.displayName} · {date(note.createdAt)} · <span className={s.status} data-status={note.status}>{label}{note.status === "applied" && note.appliedVersion ? ` · 第 ${note.appliedVersion} 版` : ""}</span>
      {adoptedBy ? ` · ${adoptedBy}采用` : ""}{note.stale ? " · 原文已改" : ""}{note.note && !declined ? ` · ${note.note}` : ""}</small>
    {onDecide && (note.canDecide || note.canApply) ? declining ? <div className={s.decline}>
      <input aria-label="不采用的原因" placeholder="原因（可不填）" maxLength={1000} value={reason} disabled={busy} autoFocus
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void decide("decline"); } if (event.key === "Escape") setDeclining(false); }} />
      <button type="button" className={s.ghost} disabled={busy} onClick={() => setDeclining(false)}>取消</button>
      <button type="button" className={s.keep} disabled={busy} onClick={() => void decide("decline")}>{busy ? "提交中…" : "不采用"}</button>
    </div> : <div className={s.decide}>
      {note.canDecide ? <>
        <button type="button" className={s.apply} disabled={busy} onClick={() => void decide("adopt")}>{busy ? "提交中…" : "采用"}</button>
        <button type="button" className={s.keep} disabled={busy} onClick={() => setDeclining(true)}>不采用</button>
      </> : <button type="button" className={s.apply} disabled={busy} onClick={() => void decide("adopt")}>{busy ? "提交中…" : "立即修改"}</button>}
    </div> : null}
    {error ? <p className={s.error} role="alert">{error}</p> : null}
  </li>;
}

function TrashPanel({ removed, onRestore }: { removed: TMaterialRemovedView[]; onRestore: (removed: TMaterialRemovedView) => Promise<string | null> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  return <ol className={s.panel} aria-label="已删除的内容">
    {error ? <li className={s.error} role="alert">{error}</li> : null}
    {removed.map((item) => <li key={item.id}>
      <p className={s.removedText}>{item.text}</p>
      <small>第 {item.version} 版删掉 · {item.requestedBy?.displayName ?? "Agent"} · {date(item.at)}{item.annotation ? ` · 按${item.annotation.author.personId === item.requestedBy?.personId ? "" : `${item.annotation.author.displayName}的`}批注「${item.annotation.body.slice(0, 30)}」` : ""}</small>
      {item.restorable ? <button type="button" className={s.restore} disabled={busy !== null} onClick={async () => {
        setBusy(item.id); setError("");
        const failure = await onRestore(item);
        setBusy(null);
        if (failure) setError(failure);
      }}><RotateCcw size={12} aria-hidden />{busy === item.id ? "恢复中…" : "恢复"}</button> : null}
    </li>)}
  </ol>;
}

/** Co-Agent 在对话里的修改提议：显示在材料上方，点「按这个改」才改。不能改这份材料的人提的，写明是谁提的。 */
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
    <header>{proposal.proposedBy.personId === proposal.proposedFor.personId ? "Co-Agent 按对话里的共识提议修改" : `${proposal.proposedBy.displayName}在对话里提议修改`} · {date(proposal.createdAt)}</header>
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

/** 这一版是有人上传（或资料包导入）的新版本，不是 Agent 改的；没有 origin 的旧数据按 Agent 改的看。 */
export const uploadedVersion = (revision: { origin?: TMaterialRevisionOrigin } | null | undefined) =>
  revision?.origin === "upload" || revision?.origin === "import";

/** 悬停在改过的段落上：历次改动（新的在前），每次的批注、原文、谁、何时；别人的批注写明谁采用的；上传的新版本写谁上传的。 */
export function HistoryCard({ history }: { history: TMaterialBlockHistoryEntry[] }) {
  return <div className={s.history} role="note">
    {history.map((entry) => <div key={entry.version} className={s.entry}>
      {entry.annotation ? <p className={s.note}><strong>{entry.annotation.author.displayName}</strong> 批注「{entry.annotation.quote.slice(0, 40)}」：{entry.annotation.body}</p> : null}
      {entry.kind === "modified" ? <p className={s.before}>原来：{entry.before}</p> : <p className={s.before}>这段是新加的</p>}
      <small>第 {entry.version} 版 · {uploadedVersion(entry) ? entry.requestedBy ? `${entry.requestedBy.displayName}上传` : "上传的新版本"
        : entry.annotation && entry.requestedBy && entry.annotation.author.personId !== entry.requestedBy.personId
          ? `${entry.requestedBy.displayName}采用` : `${entry.requestedBy?.displayName ?? "Agent"}让 Co-Agent 改的`} · {date(entry.at)}</small>
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
