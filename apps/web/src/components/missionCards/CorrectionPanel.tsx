"use client";

/**
 * GAP-04 已确定个人卡的更正：字段下方的内联编辑、已采纳的历史、待处理与未采纳的申请。
 * 显示哪些入口只看服务端给的 correctionAccess；草稿、展开状态与请求都由 MissionCardScreen 持有。
 */
import { Button } from "ts-design/primitives";
import type { TMissionCardCorrectionAccess, TMissionCardField, TPersonalMissionCardPayload } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import type { PersonalMission } from "./CardDocument";
import s from "./mission-card.module.css";

export type Correction = TPersonalMissionCardPayload["corrections"][number];
export type CorrectionDraft = { missionId: string; field: TMissionCardField; sourceVersion: number; text: string; reason: string; clientId: string };
export type CorrectionControls = {
  draft: CorrectionDraft | null;
  draftError: string;
  /** 展开历史的字段：`${missionId}-${field}`。 */
  history: string | null;
  rejecting: { id: string; note: string } | null;
  decisionError: { correctionId: string; message: string } | null;
  busy: boolean;
  onOpen: (mission: PersonalMission, field: TMissionCardField) => void;
  onEdit: (patch: Partial<Pick<CorrectionDraft, "text" | "reason">>) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onHistory: (key: string | null) => void;
  onRejecting: (rejecting: { id: string; note: string } | null) => void;
  onDecide: (item: Correction, decision: "apply" | "reject") => void;
};

function Diff({ item, before, after }: { item: Correction; before: string; after: string }) {
  return <div className={s.diff}><p><span>{before}</span><del>{item.original || "未提供"}</del></p><p><span>{after}</span><ins>{item.proposed}</ins></p></div>;
}

function CorrectionNote({ item, label, access, deciderName, controls }: { item: Correction; label: string; access: TMissionCardCorrectionAccess; deciderName: string; controls: CorrectionControls }) {
  const deciding = item.status === "pending" && access.canApply;
  const rejecting = controls.rejecting?.id === item.id ? controls.rejecting : null;
  const error = controls.decisionError?.correctionId === item.id ? controls.decisionError.message : null;
  const status = item.status === "rejected" ? `未采纳${item.note ? ` · ${item.note}` : ""}` : access.closedReason ? "未处理 · 月份已过" : deciding ? null : `更正申请 · 等${deciderName}处理`;
  return <article id={`correction-${item.id}`} className={s.remark} tabIndex={-1} aria-label={`${label}的更正申请`}>
    <header><span className={s.remarkWho}>{item.authorName}</span><span>申请更正</span><time dateTime={item.createdAt}>{monthDayTime(item.createdAt)}</time></header>
    <Diff item={item} before="原文" after="改为" />
    <p>原因：{item.reason}</p>
    {status ? <p className={s.fixStatus} data-waiting={item.status === "pending" && !access.closedReason || undefined}>{status}</p> : null}
    {deciding ? <div className={s.decide}>
      {rejecting ? <div className={s.rejectNote}>
        <label htmlFor={`reject-${item.id}`}>不采纳的原因</label>
        <input id={`reject-${item.id}`} type="text" value={rejecting.note} maxLength={300} autoFocus disabled={controls.busy} aria-describedby={error ? `correction-decision-error-${item.id}` : undefined} onChange={(event) => controls.onRejecting({ id: item.id, note: event.target.value })} />
        <div className={s.inlineActions}><Button variant="ghost" className={s.secondary} isDisabled={controls.busy || !rejecting.note.trim()} aria-label={`确认不采纳：${label}`} onPress={() => controls.onDecide(item, "reject")}>确认不采纳</Button><Button variant="ghost" className={s.secondary} isDisabled={controls.busy} aria-label={`取消不采纳：${label}`} onPress={() => controls.onRejecting(null)}>取消</Button></div>
      </div> : <div className={s.inlineActions}>
        <Button variant="primary" className={s.decisionPrimary} isDisabled={controls.busy || item.stale} aria-label={`采纳：${label}`} aria-describedby={item.stale ? `stale-${item.id}` : undefined} onPress={() => controls.onDecide(item, "apply")}>采纳</Button>
        <Button variant="ghost" className={s.secondary} isDisabled={controls.busy} aria-label={`不采纳：${label}`} onPress={() => controls.onRejecting({ id: item.id, note: "" })}>不采纳</Button>
        {item.stale ? <span id={`stale-${item.id}`} className={s.blocked}>原文已变化</span> : null}
      </div>}
      {error ? <p id={`correction-decision-error-${item.id}`} className={s.proposalError} role="alert">{error}</p> : null}
    </div> : null}
  </article>;
}

/** 一个字段下方的更正：先是正在写的更正，再是点开的历史，最后是待处理与未采纳的申请（新的在前）。 */
export function CorrectionPanel({ mission, field, label, items, access, deciderName, controls }: {
  mission: PersonalMission; field: TMissionCardField; label: string; items: Correction[];
  access: TMissionCardCorrectionAccess; deciderName: string; controls: CorrectionControls;
}) {
  const key = `${mission.missionId}-${field}`;
  const draft = controls.draft?.missionId === mission.missionId && controls.draft.field === field ? controls.draft : null;
  const applied = items.filter((item) => item.status === "applied");
  const open = items.filter((item) => item.status !== "applied");
  const verb = access.canApply ? "更正" : "申请更正";
  const errorId = `correction-error-${key}`;
  return <>
    {draft ? <div className={s.proposal}>
      <label htmlFor={`correction-${key}`}>{verb}：{label}</label>
      <textarea id={`correction-${key}`} value={draft.text} maxLength={field === "title" ? 200 : 4000} rows={4} autoFocus disabled={controls.busy} aria-describedby={controls.draftError ? errorId : undefined} onChange={(event) => controls.onEdit({ text: event.target.value })} />
      <label htmlFor={`correction-reason-${key}`}>原因</label>
      <input id={`correction-reason-${key}`} type="text" value={draft.reason} maxLength={300} required disabled={controls.busy} onChange={(event) => controls.onEdit({ reason: event.target.value })} />
      <p className={s.hint}>{access.canApply ? "提交后立即生效，改前改后都会留痕。" : `提交后等${deciderName}处理，正文先不变。`}{field === "milestones" || field === "successEvidence" ? " 每行一条，最多 30 条，每条不超过 500 字。" : ""}</p>
      {controls.draftError ? <p id={errorId} className={s.proposalError} role="alert">{controls.draftError}</p> : null}
      <div className={s.inlineActions}><Button variant="primary" className={s.primary} isDisabled={controls.busy || !draft.text.trim() || !draft.reason.trim()} aria-label={`提交${verb}：${label}`} onPress={controls.onSubmit}>{controls.busy ? "正在提交…" : "提交"}</Button><Button variant="ghost" className={s.secondary} isDisabled={controls.busy} aria-label={`取消${verb}：${label}`} onPress={controls.onCancel}>取消</Button></div>
    </div> : null}
    {controls.history === key && applied.length ? <ol id={`correction-history-${key}`} className={s.history} aria-label={`${label}的更正记录`}>{applied.map((item) => <li key={item.id}>
      <p className={s.historyMeta}>{item.direct ? `${item.authorName} 直接更正` : `${item.authorName} 申请 · ${item.decidedByName ?? deciderName} 已采纳`} · <time dateTime={item.decidedAt ?? item.createdAt}>{monthDayTime(item.decidedAt ?? item.createdAt)}</time></p>
      <Diff item={item} before="改前" after="改后" />
      <p>原因：{item.reason}</p>
    </li>)}</ol> : null}
    {open.length ? <div className={s.remarks}>{open.map((item) => <CorrectionNote key={item.id} item={item} label={label} access={access} deciderName={deciderName} controls={controls} />)}</div> : null}
  </>;
}
