"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, FileCheck2 } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { TMissionRoundSummary } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";
import { fieldNames } from "./CardDocument";
import t from "@/styles/material-tabs.module.css";
import s from "./mission-progress.module.css";

type RoundAction = Card["actions"][number];
type Snapshot = { round: TMissionRoundSummary; actions: RoundAction[] };

/** 上级先看准备进度；这里读取轮次，未确认的私人正文不作为入口。 */
export function MissionRoundProgress({ round, entry, onNavigate, onRefresh, compact = false }: {
  round: TMissionRoundSummary;
  entry: "member" | "ceo";
  onNavigate: (href: string) => void;
  onRefresh: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>({ round, actions: [] });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [noteVersion, setNoteVersion] = useState<number | null>(null);
  const [returning, setReturning] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [returnVersion, setReturnVersion] = useState<number | null>(null);
  const generation = useRef(0);
  const working = useRef(false);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const load = useCallback(async (): Promise<Snapshot | null> => {
    const request = ++generation.current;
    try {
      const { data, response, error: failure } = await browserApi.GET("/api/mission-rounds/{roundId}", { params: { path: { roundId: round.roundId } } });
      const card = data?.cards[0];
      if (!response.ok || card?.kind !== "mission-round") throw new Error(failure?.message ?? "准备进度暂时无法读取，请重试。");
      const next = { round: card.payload as TMissionRoundSummary, actions: card.actions };
      if (!mounted.current || request !== generation.current) return null;
      setSnapshot(next); setError("");
      return next;
    } catch (cause) {
      if (mounted.current && request === generation.current) setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "准备进度暂时无法读取，请重试。");
      return null;
    }
  }, [round.roundId]);
  useEffect(() => {
    if (!open) { generation.current++; return; }
    setLoading(true);
    void load().finally(() => { if (mounted.current) setLoading(false); });
    const timer = window.setInterval(() => { if (!working.current && document.visibilityState === "visible") void load(); }, 3_000);
    return () => { window.clearInterval(timer); generation.current++; };
  }, [open, load]);
  useEffect(() => {
    if (!open) return;
    // Consume Escape before the workspace's window listener closes the whole detail page.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);

  const act = async (actionType: string, input?: { note: string }) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try {
      const latest = await load();
      if (!latest) return;
      if (actionType === "mission-round.confirm" && latest.round.version !== noteVersion) {
        setError("任务版本已变化，核对结论已保留。请阅读最新报告后再确认。"); return;
      }
      const action = latest.actions.find((item) => item.actionType === actionType);
      if (!action) { setError("准备状态已变化，请核对最新进度后继续。"); return; }
      const { data, response, error: failure } = await browserApi.POST("/api/mission-rounds/actions/execute", { body: { actionId: action.actionId, ...(input ? { input } : {}) } });
      if (!response.ok) throw new Error(failure?.message ?? "操作未保存，请重试。");
      const card = data?.cards[0];
      if (card?.kind === "mission-round") setSnapshot({ round: card.payload as TMissionRoundSummary, actions: card.actions });
      else await load();
      setNote(""); setNoteVersion(null); onRefresh(); window.dispatchEvent(new Event("mission-round-changed"));
    } catch (cause) { setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "操作未保存，请检查连接后重试。"); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const sendReturn = async () => {
    if (working.current || !selected.length || !reason.trim() || returnVersion !== snapshot.round.version) return;
    working.current = true; setBusy(true); setError("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/mission-rounds/{roundId}/return-cards", { params: { path: { roundId: round.roundId } }, body: { cardIds: selected, reason: reason.trim(), version: returnVersion } });
      if (!response.ok) throw new Error(failure?.message ?? "退回未保存，输入已保留。");
      setReturning(false); setSelected([]); setReason(""); setReturnVersion(null);
      await load(); onRefresh(); window.dispatchEvent(new Event("mission-round-changed"));
    } catch (cause) { const message = cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "退回未保存，请检查连接后重试；输入已保留。"; await load(); setError(message); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };

  const current = open ? snapshot.round : round;
  const done = current.counts.cards - current.counts.unreviewed;
  const report = current.coAgentReview;
  const confirm = snapshot.actions.find((action) => action.actionType === "mission-round.confirm");
  const start = snapshot.actions.find((action) => action.actionType === "mission-round.open");
  const retryDraft = snapshot.actions.find((action) => action.actionType === "mission-round.draft");
  const extend = snapshot.actions.find((action) => action.actionType === "mission-round.reopen");
  const retry = report?.retryAction;
  const path = (id: string) => `${entry === "member" ? "/me" : ""}/mission-cards/${id}`;
  const label = report ? "Co-Agent 核对报告" : "任务准备进度";
  const personState = (card: TMissionRoundSummary["cards"][number]) => current.phase === "confirmed" ? "已确定"
    : current.phase === "drafting" ? "Co-Agent 正在起草"
    : current.draftFailures.some((failure) => failure.ownerId === card.ownerId) ? "起草未完成"
    : card.ownerConfirmedAt ? "本人已确认" : "待本人确认";
  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button variant="ghost" className={`${s.trigger} ${compact ? s.compact : ""}`} aria-label={`查看${label}`}>
      {compact ? <FileCheck2 size={16} aria-hidden /> : null}<span>{report ? label : `本人已确认 ${done} / ${current.counts.cards}`}</span><ChevronRight size={14} aria-hidden />
    </Button>
    <Popover.Content placement="bottom end" offset={6} className={`${t.popover} ${s.popover}`}>
      <TianshuPortalTheme><Popover.Dialog className={`${t.menu} ${s.panel}`} aria-label={label}>
        <header className={s.header}><strong>{current.battlefieldName}</strong><span>本人已确认 {done} / {current.counts.cards}</span></header>
        <ul className={s.people} aria-label="本人确认进度">{current.cards.map((card) => <li key={card.cardId}>
          <Button variant="ghost" className={s.person} isDisabled={card.contentVisible === false} aria-label={`${card.ownerName} · ${personState(card)}${card.contentVisible === false ? "，正文仅本人可见" : "，查看任务"}`} onPress={() => { if (card.contentVisible !== false) { setOpen(false); onNavigate(path(card.cardId)); } }}>
            <span>{card.ownerName}</span><span className={s.state} data-confirmed={!!card.ownerConfirmedAt || current.phase === "confirmed"}>{card.ownerConfirmedAt || current.phase === "confirmed" ? <Check size={13} aria-hidden /> : null}{personState(card)}</span>
          </Button>
        </li>)}</ul>
        {loading ? <p className={s.muted} role="status">正在读取最新进度…</p> : null}
        {current.phase === "closed" && current.counts.unreviewed > 0 ? <p className={s.muted}>准备时间已到，{current.counts.unreviewed} 人未确认</p> : null}
        {report ? <section className={s.report} aria-label="Co-Agent 核对报告">
          <h3>{report.status === "completed" ? "Co-Agent 核对报告" : report.status === "failed" ? "Co-Agent 核对未完成" : "Co-Agent 正在统一核对"}</h3>
          {report.summary ? <p>{report.summary}</p> : null}
          {report.status === "failed" ? <p className={s.muted}>{report.error || "本次核对未完成，原任务和记录已保留。"}</p> : null}
          {report.findings.length ? <ol className={s.findings}>{report.findings.map((item, index) => <li key={`${index}:${item.title}`}><h4><span>{({ question: "待明确", risk: "风险", suggestion: "建议" })[item.kind]}</span>{item.title}</h4><p>{item.body}</p><details><summary>查看依据</summary>{item.sources.map((source, sourceIndex) => { const card = current.cards.find((row) => row.cardId === source.cardId); return <div key={`${sourceIndex}:${source.cardId}`} className={s.source}><span>{card?.ownerName ?? "相关任务"}{source.field ? ` · ${fieldNames[source.field]}` : ""}{source.version ? ` · v${source.version}` : ""}</span>{source.quote ? <blockquote>{source.quote}</blockquote> : null}</div>; })}</details></li>)}</ol> : null}
        </section> : null}
        {error ? <p className={s.error} role="alert">{error}<button type="button" disabled={busy} onClick={() => void load()}>重新读取</button></p> : null}
        {!loading ? <div className={s.actions}>
          {start ? <Button variant="primary" isDisabled={busy || !!error} onPress={() => void act(start.actionType)}>下发本人确认</Button> : null}
          {retryDraft ? <Button variant="ghost" isDisabled={busy || !!error} onPress={() => void act(retryDraft.actionType)}>重试起草</Button> : null}
          {current.phase === "closed" && extend ? <Button variant="ghost" isDisabled={busy || !!error} onPress={() => void act(extend.actionType)}>继续本人准备</Button> : null}
          {retry ? <Button variant="ghost" isDisabled={busy || !!error} onPress={() => void act(retry.actionType)}>重试 Co-Agent 核对</Button> : null}
          {current.approver && ["reviewing", "confirmed"].includes(current.phase) ? <Button variant="ghost" isDisabled={busy || !!error} onPress={() => { setReturning(!returning); setReturnVersion(current.version); }}>退回相关任务</Button> : null}
        </div> : null}
        {returning && current.approver && ["reviewing", "confirmed"].includes(current.phase) ? <section className={s.returnForm} aria-label="退回相关任务">
          {current.cards.map((card) => <label key={card.cardId} className={s.choice}><input type="checkbox" checked={selected.includes(card.cardId)} disabled={busy} onChange={(event) => setSelected((values) => event.target.checked ? [...values, card.cardId] : values.filter((id) => id !== card.cardId))} />{card.ownerName}</label>)}
          <textarea aria-label="退回原因" placeholder="说明需要本人明确或修改的内容" rows={3} maxLength={2000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
          {returnVersion !== current.version ? <p className={s.muted}>任务版本已变化，输入已保留。<button type="button" disabled={busy} onClick={() => { setReturnVersion(current.version); setSelected((ids) => ids.filter((id) => current.cards.some((card) => card.cardId === id))); }}>已核对最新任务</button></p> : null}
          <Button variant="primary" isDisabled={busy || !!error || !selected.length || !reason.trim() || returnVersion !== current.version} onPress={() => void sendReturn()}>退回本人准备</Button>
        </section> : null}
        {confirm && current.approver ? <section className={s.confirmForm} aria-label="战场 DRI 确认任务组合"><label htmlFor={`mission-combination-${round.roundId}`}>战场 DRI 的核对结论</label><textarea id={`mission-combination-${round.roundId}`} placeholder="记录依赖、资源和待明确事项的处理结论" rows={3} maxLength={2000} value={note} disabled={busy} onChange={(event) => { setNote(event.target.value); if (!note.trim() || !event.target.value.trim()) setNoteVersion(current.version); }} />{note.trim() && noteVersion !== current.version ? <p className={s.muted}>报告或任务版本已变化，核对结论已保留。<button type="button" disabled={busy} onClick={() => { setNoteVersion(current.version); setError(""); }}>已核对最新报告</button></p> : null}<Button variant="primary" isDisabled={busy || !!error || !note.trim() || noteVersion !== current.version} onPress={() => void act(confirm.actionType, { note: note.trim() })}>确认任务组合</Button></section> : null}
      </Popover.Dialog></TianshuPortalTheme>
    </Popover.Content>
  </Popover>;
}
