"use client";

import { useEffect, useState, type ReactNode } from "react";
import type {
  TContinueMeetingWork, TMeetingWorkConclusion, TMeetingWorkFeedItem, TMeetingWorkHandoffs,
  TMeetingWorkReceipt, TMeetingWorkTarget, TMeetingWorkTargetOption,
} from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { unwrap } from "@/lib/board/cloud";
import { cardHref, infoHref, projectHref, topicHref } from "@/lib/home/derive";
import { monthDayTime } from "@/lib/companyTime";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import s from "./meeting-work-handoffs.module.css";

const labels = { project: "项目", task: "Task", card: "执行子会话", topic: "探索子会话" };
const stateText = { pending: "待递送", delivered: "已递送", failed: "失败" };
const keyOf = (t: TMeetingWorkTarget) => JSON.stringify([t.projectId, t.kind, t.id]);
const same = (a: TMeetingWorkTarget, b: TMeetingWorkTarget) => a.projectId === b.projectId && a.kind === b.kind && a.id === b.id;
const destHref = (t: TMeetingWorkTarget) => t.kind === "project" ? projectHref(t.projectId)
  : t.kind === "task" ? infoHref(t.id) : t.kind === "card" ? cardHref(t.id) : topicHref(t.id);
const destName = (t: TMeetingWorkTargetOption) => t.kind === "project" ? t.projectName : `${t.projectName} / ${t.name}`;
const errorText = (e: unknown) => e instanceof Error ? e.message : "未能读取，请重试";
const readItems = () => unwrap<TMeetingWorkHandoffs>(browserApi.GET("/api/me/meeting-work-handoffs"));
const readTargets = () => unwrap<{ targets: TMeetingWorkTargetOption[] }>(browserApi.GET("/api/me/meeting-work-handoff-targets"));
const submit = (change: TMeetingWorkConclusion, targets: TContinueMeetingWork["targets"]) => unwrap<{ receipts: TMeetingWorkReceipt[] }>(
  browserApi.POST("/api/me/meeting-work-handoffs/{confirmationRef}", { params: { path: { confirmationRef: change.confirmationRef } },
    body: { authorization: "continue", revision: change.revision, targets } }));
const refreshed = "tianshu:meeting-work-confirmed";

/** Only suggest an accessible Task explicitly identified by the Nexus world object reference. */
export function suggestedMeetingTarget(ref: string, options: readonly TMeetingWorkTargetOption[]): TMeetingWorkTargetOption | null {
  const id = ref.replace(/@\d+$/, "");
  return options.find(option => option.kind === "task" && option.id === id) ?? null;
}

function Source({ change }: { change: TMeetingWorkConclusion }) {
  const source = change.source;
  const url = [source.reference, source.minutesRef].find(ref => ref && /^https?:\/\//i.test(ref));
  const ref = source.reference ?? source.minutesRef;
  return <details className={s.source}><summary>会议出处 · {source.readState === "excerpt" ? "已收到摘录" : "仅有出处"}</summary>
    {source.quote && <blockquote>{source.quote}</blockquote>}
    <p>{url ? <a href={url} target="_blank" rel="noreferrer">打开出处</a> : ref} · {source.version}</p>
    <p>Nexus 会议 {change.meetingId} · 确认版本 {change.revision}</p>
  </details>;
}

function Content({ change }: { change: TMeetingWorkConclusion }) {
  const c = change.content;
  if (c.value !== undefined) return <p className={s.value}>{c.value}</p>;
  const op = "operation" in c && typeof c.operation === "string" ? c.operation : c.classification;
  return <p className={s.value}>{op} · {c.targetRef}{c.fieldKey ? ` · ${c.fieldKey}` : ""}</p>;
}

export function MeetingWorkFeedEntry({ item }: { item: TMeetingWorkFeedItem }) {
  return <section className={s.entry} aria-label="已递送的会后变化">
    <div className={s.meta}>会议交接 · {item.superseded ? "此确认已被新版替代" : "已递送"}</div>
    <strong>{item.conclusion.question}</strong><Content change={item.conclusion} />
    {item.instruction && <p>本次交代 · {item.instruction}</p>}
    <p>{labels[item.target.kind]} · <a href={destHref(item.target)}>{destName(item.target)}</a></p>
    {item.criteria.length > 0 && <details><summary>关联完成标准（{item.criteria.length}）</summary><ul>
      {item.criteria.map(c => <li key={`${c.kind}:${c.id}:${c.index}`}>{c.text}</li>)}
    </ul></details>}
    <Source change={item.conclusion} />
  </section>;
}

type Selected = TContinueMeetingWork["targets"];
function TargetPicker({ targets, excluded, suggestion, action, onContinue, onCancel }: {
  targets: TMeetingWorkTargetOption[]; excluded: TMeetingWorkReceipt[]; action: string;
  suggestion?: TMeetingWorkTargetOption | null;
  onContinue: (selected: Selected) => Promise<void>; onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Map<string, string>>(() => suggestion && !excluded.some(r => same(r.target, suggestion))
    ? new Map([[keyOf(suggestion), ""]]) : new Map());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const choices = targets.filter(t => !excluded.some(r => same(t, r.target)));
  const selection = choices.filter(t => selected.has(keyOf(t)));
  const change = (key: string, value: string | null) => setSelected(old => {
    const next = new Map(old);
    if (value === null) next.delete(key);
    else next.set(key, value);
    return next;
  });
  async function send() {
    if (busy || !selection.length) return;
    setBusy(true); setError("");
    try {
      await onContinue(selection.map(({ projectId, id, kind }) => ({ projectId, id, kind, instruction: selected.get(keyOf({ projectId, kind, id })) })));
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <div className={s.picker}><fieldset disabled={busy}>
    <legend>选择工作去向</legend>
    {!choices.length && <p className={s.meta}>没有其他可递送的既有工作。</p>}
    {choices.map(t => {
      const key = keyOf(t);
      const title = destName(t);
      return <div key={key}><label className={s.choice}><input type="checkbox" checked={selected.has(key)}
        onChange={e => change(key, e.target.checked ? "" : null)} />{labels[t.kind]} · {title}{suggestion && same(t, suggestion) ? "（会议指向此 Task）" : ""}</label>
        {selected.has(key) && <label className={s.note}>给{title}的交代（可选）
          <textarea value={selected.get(key)} maxLength={4000} onChange={e => change(key, e.target.value)} /></label>}
      </div>;
    })}
  </fieldset><div className={s.actions}>
    <button type="button" className={s.primary} disabled={busy || !selection.length || selection.length > 30} onClick={() => void send()}>{busy ? "递送中" : action}</button>
    <button type="button" disabled={busy} onClick={onCancel}>暂不递送</button>
  </div>{selection.length > 30 && <p role="status">每次最多选择 30 个去向。</p>}{error && <p role="alert">{error}</p>}</div>;
}

/** The pending Nexus decision remains the only judge. It atomically records its explicit destinations when this action is chosen. */
export function ConfirmAndHandOff({ requestId, amendedValue, onConfirmed }: { requestId: string; amendedValue?: string; onConfirmed: (ref: string) => void }) {
  const [targets, setTargets] = useState<TMeetingWorkTargetOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function choose() {
    setLoading(true); setError("");
    try { setTargets((await readTargets()).targets); }
    catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }
  if (targets) return <TargetPicker targets={targets} excluded={[]} action={amendedValue === undefined ? "确认并继续推进" : "确认修改并继续推进"} onCancel={() => setTargets(null)}
    onContinue={async selected => {
      const result = await unwrap(browserApi.POST("/api/me/nexus-confirmations/{id}/decision", { params: { path: { id: requestId } },
        body: { ...(amendedValue === undefined ? { decision: "confirmed" as const } : { decision: "amended" as const, value: amendedValue }),
          continueWork: { authorization: "continue", targets: selected } } }));
      window.dispatchEvent(new Event(refreshed)); onConfirmed(result.confirmationRef);
    }} />;
  return <div className={s.actions}><button type="button" className={s.primary} disabled={loading} onClick={() => void choose()}>{loading ? "读取去向" : "选择去向并确认"}</button>
    {error && <span role="alert">{error}</span>}</div>;
}

function ChangeRow({ item, targets, update }: {
  item: TMeetingWorkHandoffs["items"][number]; targets: TMeetingWorkTargetOption[];
  update: (receipts: TMeetingWorkReceipt[]) => void;
}) {
  const { conclusion: change, receipts } = item;
  const suggestion = suggestedMeetingTarget(change.content.targetRef, targets);
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState("");
  const counts = receipts.reduce((total, receipt) => ({ ...total, [receipt.status]: total[receipt.status] + 1 }), { delivered: 0, pending: 0, failed: 0 });
  useEffect(() => {
    const anchor = `meeting-work-${change.confirmationRef}`;
    const reveal = () => {
      if (window.location.hash.slice(1) !== anchor) return;
      const article = document.getElementById(anchor);
      if (!article) return;
      article.querySelectorAll<HTMLDetailsElement>("details").forEach(detail => { detail.open = true; });
      article.scrollIntoView?.({ block: "nearest" });
      article.focus({ preventScroll: true });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [change.confirmationRef]);
  async function retry(r: TMeetingWorkReceipt) {
    setPending(old => [...old, r.id]); setError("");
    try { update((await submit(change, [{ ...r.target, instruction: r.instruction }])).receipts); }
    catch (e) { setError(errorText(e)); }
    finally { setPending(old => old.filter(id => id !== r.id)); }
  }
  return <article className={s.entry} id={`meeting-work-${change.confirmationRef}`} tabIndex={-1}>
    <header className={s.header}><span>会议交接 · {change.decision === "amended" ? "已修改并确认" : "已确认"}</span>
      <time dateTime={change.confirmedAt}>确认于 {monthDayTime(change.confirmedAt)} 北京时间</time></header>
    <h3 className={s.title}>{change.question}</h3><Content change={change} />
    <p className={s.progress} aria-label="递送进度">
      <span data-state="delivered">已递送 <strong>{counts.delivered}</strong></span>
      <span data-state="pending">待递送 <strong>{counts.pending}</strong></span>
      <span data-state="failed">失败 <strong>{counts.failed}</strong></span>
    </p>
    <p className={s.next}>下一步 · {counts.failed ? "重试失败的去向，查看下方原因与操作。"
      : counts.pending ? "递送等待中的工作去向。"
      : counts.delivered ? "打开递送去向查看，或添加工作去向。" : "选择既有工作去向，继续推进。"}</p>
    {receipts.length > 0 && <details className={s.receiptDetails} open={counts.failed + counts.pending > 0}>
      <summary>递送明细（{receipts.length}）{counts.failed + counts.pending > 0 ? ` · ${counts.failed + counts.pending} 个待处理` : ""}</summary>
      <ul className={s.receipts} aria-label="递送回执">{receipts.map(r => {
      const dest = targets.find(t => same(t, r.target));
      const label = dest ? destName(dest) : `${labels[r.target.kind]} ${r.target.id}（${r.status === "delivered" ? "历史去向" : "当前不可选"}）`;
      return <li key={r.id} data-state={r.status}><div className={s.receiptBody}><span>{stateText[r.status]} · {label}</span>
        {r.instruction && <p className={s.meta}>本次交代 · {r.instruction}</p>}
        {r.reason && <p className={r.status === "failed" ? s.failure : s.meta}>{r.reason}</p>}</div>
        {r.status === "delivered" ? <a href={destHref(r.target)}>打开去向</a>
          : <button type="button" className={s.primary} disabled={pending.includes(r.id)} onClick={() => void retry(r)}>{pending.includes(r.id) ? "递送中" : r.status === "pending" ? "递送此去向" : "重试此去向"}</button>}
      </li>;
    })}</ul></details>}
    {suggestion && !receipts.some(r => same(r.target, suggestion)) && <p className={s.meta}>建议去向 · {destName(suggestion)}</p>}
    {choosing ? <TargetPicker targets={targets} excluded={receipts} suggestion={suggestion} action="继续推进" onCancel={() => setChoosing(false)}
      onContinue={async selected => { update((await submit(change, selected)).receipts); setChoosing(false); }} />
      : <div className={s.actions}><button type="button" className={!receipts.length ? s.primary : undefined} onClick={() => setChoosing(true)}>{receipts.length ? "添加工作去向" : "选择工作去向"}</button></div>}
    {error && <p role="alert">{error}</p>}
    <Source change={change} />
  </article>;
}

export function useMeetingWorkHandoffFeed(): { blocks: TimedBlock[]; notice: ReactNode } {
  const [items, setItems] = useState<TMeetingWorkHandoffs["items"]>([]);
  const [targets, setTargets] = useState<TMeetingWorkTargetOption[]>([]);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => setVersion(v => v + 1);
    async function load() {
      try {
        const data = await readItems();
        if (!active) return;
        setItems(data.items); setError("");
        if (!data.items.length) { setTargets([]); return; }
      } catch (e) {
        if (active) { setItems([]); setTargets([]); setError(errorText(e)); }
        return;
      }
      try {
        const choices = await readTargets();
        if (active) setTargets(choices.targets);
      } catch (e) { if (active) { setTargets([]); setError(`工作去向读取失败 · ${errorText(e)}`); } }
    }
    void load();
    window.addEventListener("focus", refresh); window.addEventListener(refreshed, refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); window.removeEventListener(refreshed, refresh); };
  }, [version]);
  const blocks = items.map(item => ({ key: `meeting-handoff:${item.conclusion.confirmationRef}`, at: item.conclusion.confirmedAt,
    node: <ChangeRow item={item} targets={targets} update={next => setItems(old =>
      old.map(row => row.conclusion.confirmationRef !== item.conclusion.confirmationRef ? row : { ...row, receipts: [
        ...row.receipts.filter(r => !next.some(n => n.id === r.id)), ...next,
      ] }))} /> }));
  const notice = error ? <p className={s.notice} role="alert">{error} <button type="button" onClick={() => setVersion(v => v + 1)}>重试</button></p> : null;
  return { blocks, notice };
}

/** Compatibility surface for pages that do not yet render the unified WorkTimeline. */
export function MeetingWorkHandoffs() {
  const { blocks, notice } = useMeetingWorkHandoffFeed();
  if (!blocks.length && !notice) return null;
  return <section id="meeting-work-handoffs" className={s.panel} aria-label="会后工作交接"><h2>会后工作交接</h2>
    {notice}{blocks.map(block => <div key={block.key} data-block={block.key}>{block.node}</div>)}
  </section>;
}
