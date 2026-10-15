"use client";

import type { TDecisionHistoryChange, TDecisionHistoryEntry, TDecisionHistoryPending, TIssueDecisionHistory } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { clip, historyAnchorId, shortDate } from "@/cards/meetingSources";
import { SourceList } from "./SourceViewer";
import d from "@/styles/decision-workspace.module.css";

/**
 * 议题的三层历史（feedback 9 / H05）：仍有效的历史决定、此后实际变化、本次待判断，互不混用。
 * 已撤回或被替代的决定收在最后的折叠里，写明「不再约束」；未确认的会后候选只出现在「本次待判断」，标明不是决定。
 * 每一条都有锚点（historyAnchorId），预审依据和执行变化里的「关联决定」可以直接定位过来。
 */

const VIA: Record<TDecisionHistoryEntry["confirmedVia"], string> = {
  "issue.decide": "直接决定",
  "issue.decide_override": "预研未完成时决定",
  "meeting.confirm_item": "会后确认",
  imported: "历史纪要导入",
};

export const CHANGE_KIND: Record<TDecisionHistoryChange["kind"], string> = {
  monthly_feedback: "阶段反馈",
  discussion: "群讨论",
  material_revision: "材料更新",
  signal: "外部信号",
  execution_fact: "执行事实",
};

export type HistoryView = {
  status: "loading" | "ready" | "error";
  data: TIssueDecisionHistory | null;
  error: string | null;
  reload?: () => void;
};

/** 议题页的空态：没有仍有效的决定、没有后续变化、也没有被替代 / 撤回的旧决定。 */
export const HISTORY_EMPTY_LINE = "暂无历史决定和后续变化。";
export function hasHistoryContent(history: TIssueDecisionHistory | null): boolean {
  return Boolean(history && (history.effective.length || history.changes.length || history.inactive.length));
}

/**
 * compact（议题页自己用）：不列「本次待判断」（就是这一页本身，可选路径已在「备选方案」）；
 * 只显示有内容的分层；全部为空时整节收成一行弱色小字。会议页不带 compact，三层照旧。
 */
export function DecisionHistoryLayers({ issueId, view, currentMeetingId = null, compact = false }: { issueId: string; view: HistoryView; currentMeetingId?: string | null; compact?: boolean }) {
  const history = view.data;
  if (compact && view.status !== "error" && (view.status === "ready" ? !hasHistoryContent(history) : !history)) {
    return view.status === "ready"
      ? <p className={d.layerEmpty} data-history-empty="">{HISTORY_EMPTY_LINE}</p>
      : <p className={d.layerLoading} role="status">正在读取该议题的历史决定…</p>;
  }
  if (!history) {
    if (view.status === "error") {
      return (
        <p className={d.errorLine} role="alert">
          {view.error ?? "历史决定读取失败"}
          {view.reload ? <button type="button" onClick={view.reload}>重试</button> : null}
        </p>
      );
    }
    if (view.status === "ready") return <p className={d.layerEmpty}>未读取到该议题的历史决定。</p>;
    return <p className={d.layerLoading} role="status">正在读取该议题的历史决定…</p>;
  }
  const meetings = history.relatedMeetings.filter((meeting) => meeting.id !== currentMeetingId);
  return (
    <div className={d.layers} data-history-issue={issueId}>
      {view.status === "error" ? (
        <p className={d.errorLine} role="alert">
          历史刷新失败，下面是上一次读到的内容。
          {view.reload ? <button type="button" onClick={view.reload}>重试</button> : null}
        </p>
      ) : null}
      {!compact || history.effective.length ? <section className={d.layer} data-layer="effective" aria-label="仍有效的历史决定">
        <h4>仍有效的历史决定<span>{history.effective.length ? `${history.effective.length} 条` : ""}</span></h4>
        {history.effective.length ? (
          <ol>{history.effective.map((entry) => <EffectiveEntry key={entry.ref} entry={entry} issueId={issueId} />)}</ol>
        ) : <p className={d.layerEmpty}>暂无仍有效的已确认决定。</p>}
      </section> : null}
      {!compact || history.changes.length ? <section className={d.layer} data-layer="changes" aria-label="此后实际变化">
        <h4>此后实际变化<span>{history.changesSince ? `自 ${shortDate(history.changesSince)} 起${history.changes.length ? ` · ${history.changes.length} 条` : ""}` : ""}</span></h4>
        {history.changes.length ? (
          <ol>{history.changes.map((change) => <ChangeEntry key={change.ref} change={change} issueId={issueId} />)}</ol>
        ) : <p className={d.layerEmpty}>{history.changesNote ?? "决定之后未获得执行证据（待补）。"}</p>}
      </section> : null}
      {!compact ? <section className={d.layer} data-layer="pending" aria-label="本次待判断">
        <h4>本次待判断<span>{history.pending.length ? `${history.pending.length} 项` : ""}</span></h4>
        {history.pending.length ? (
          <ol>{history.pending.map((item) => <PendingEntry key={item.ref} item={item} issueId={issueId} />)}</ol>
        ) : <p className={d.layerEmpty}>该议题当前无待判断事项。</p>}
      </section> : null}
      {history.inactive.length ? (
        <details className={d.inactive} data-layer="inactive">
          <summary>已被替代或撤回（不再约束） · {history.inactive.length} 条</summary>
          <ol>{history.inactive.map((entry) => <InactiveEntry key={entry.ref} entry={entry} issueId={issueId} />)}</ol>
        </details>
      ) : null}
      {meetings.length ? <SourceList label="相关会议" refs={meetings.map((meeting) => `meeting:${meeting.id}`)} issueId={issueId} /> : null}
    </div>
  );
}

function sourceLine(entry: TDecisionHistoryEntry): string | null {
  const { source } = entry;
  if (source.kind === "imported") return source.importedRef ? `出处：${source.importedRef}` : null;
  if (source.kind === "meeting-item") {
    const meeting = source.meetingTitle ? `会议「${source.meetingTitle}」` : "会后确认";
    return source.quote ? `${meeting} · 原话「${clip(source.quote, 60)}」` : meeting;
  }
  return null;
}

/** 条目自身的 ref 和本议题本身不必再列成依据。 */
const otherRefs = (refs: string[], self: string, issueId: string) => refs.filter((ref) => ref !== self && ref !== `issue:${issueId}`);

function EffectiveEntry({ entry, issueId }: { entry: TDecisionHistoryEntry; issueId: string }) {
  const meta = [entry.decidedBy?.displayName, monthDayTime(entry.decidedAt), VIA[entry.confirmedVia], entry.option?.label ? `选项「${entry.option.label}」` : null]
    .filter(Boolean).join(" · ");
  const line = sourceLine(entry);
  return (
    <li id={historyAnchorId(issueId, entry.ref)} className={d.entry} data-layer="effective">
      <p className={d.entryText}>
        {entry.kind === "judgment" ? <span className={d.badge}>CEO 判断</span> : null}
        {entry.text}
      </p>
      <p className={d.entryMeta}>{meta}</p>
      {line ? <p className={d.entryMeta}>{line}</p> : null}
      <SourceList label="出处" refs={otherRefs(entry.sourceRefs, entry.ref, issueId)} issueId={issueId} />
    </li>
  );
}

function ChangeEntry({ change, issueId }: { change: TDecisionHistoryChange; issueId: string }) {
  // 群讨论、执行事实、阶段反馈的原文已经写在这里；材料更新和外部信号再给一颗按钮打开原件 / 原文。
  const open = change.kind === "material_revision" || change.kind === "signal" ? [change.ref] : [];
  return (
    <li id={historyAnchorId(issueId, change.ref)} className={d.entry} data-layer="change">
      <p className={d.entryMeta}>
        <span className={d.changeKind}>{CHANGE_KIND[change.kind]}</span>
        {[monthDayTime(change.at), change.author?.displayName, change.stance ? `发言性质：${change.stance}` : null].filter(Boolean).join(" · ")}
      </p>
      <p className={d.changeText}>{change.text}</p>
      <p className={d.entryMeta}>出处：{change.sourceRef}{change.kind === "discussion" ? " · 个人发言，不构成决定" : ""}</p>
      <SourceList label="查看" refs={[...open, ...(change.relatedDecisionRefs ?? [])]} issueId={issueId} />
    </li>
  );
}

function PendingEntry({ item, issueId }: { item: TDecisionHistoryPending; issueId: string }) {
  return (
    <li id={historyAnchorId(issueId, item.ref)} className={d.entry} data-layer="pending">
      <p className={d.entryText}>
        <span className={d.badge} data-tone="pending">{item.kind === "issue_pending" ? "待决定" : "会后候选"}</span>
        {item.text}
      </p>
      {item.options.length ? <p className={d.entryMeta}>可选路径：{item.options.map((option) => option.label).join(" / ")}</p> : null}
      {item.source?.meetingTitle ? (
        <p className={d.entryMeta}>来自会议「{item.source.meetingTitle}」{item.source.quote ? ` · 原话「${clip(item.source.quote, 60)}」` : ""}</p>
      ) : null}
      <p className={d.pendingNote}>{item.note}</p>
    </li>
  );
}

function InactiveEntry({ entry, issueId }: { entry: TDecisionHistoryEntry; issueId: string }) {
  const state = entry.status === "superseded" ? "已被替代" : "已撤回";
  const refs = [entry.supersededBy, entry.revokedBy].filter((ref): ref is string => Boolean(ref));
  return (
    <li id={historyAnchorId(issueId, entry.ref)} className={d.entry} data-layer="inactive">
      <p className={d.entryText}><del>{entry.text}</del></p>
      <p className={d.entryMeta}>
        {[`${state}${entry.statusAt ? ` · ${monthDayTime(entry.statusAt)}` : ""}${entry.statusReason ? `：${entry.statusReason}` : ""}`,
          `原决定 ${monthDayTime(entry.decidedAt)}`, VIA[entry.confirmedVia]].join(" · ")}
      </p>
      {sourceLine(entry) ? <p className={d.entryMeta}>{sourceLine(entry)}</p> : null}
      <SourceList label={entry.status === "superseded" ? "被它替代" : "撤回依据"} refs={refs} issueId={issueId} />
    </li>
  );
}
