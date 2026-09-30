"use client";

import { useState } from "react";
import { Button } from "ts-design/primitives";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import type { CardAction } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import s from "./mission-card.module.css";

function DraftFailureReason({ message }: { message: string }) {
  if (message.length <= 160 && message.split(/\r?\n/).length <= 2) return <p>{message}</p>;
  return <>
    <p className={s.draftFailureSummary}>{message.length > 160 ? `${message.slice(0, 160).trimEnd()}…` : message}</p>
    <details className={s.draftFailureDetails}><summary>查看原因</summary><p>{message}</p></details>
  </>;
}

/** Only actionable controls remain in the document. The product guide lives behind help. */
export function MissionWorkflowActions({ payload, actions, pending, onAction, onStartProcessing, note = "", onNoteChange, error }: {
  payload: TPersonalMissionCardPayload;
  actions: Pick<CardAction, "actionId" | "actionType" | "label">[];
  viewerId?: string | null;
  pending: boolean;
  onAction: (action: Pick<CardAction, "actionId" | "actionType" | "label">, input?: { note: string }) => void;
  onStartProcessing?: () => void;
  note?: string;
  onNoteChange?: (note: string) => void;
  error?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const { round, confirmation } = payload;
  const drafting = round.phase === "drafting";
  const failures = (round.draftFailures ?? []).filter((failure) => round.approver || failure.ownerId === payload.card.ownerId);
  if (payload.draftFailure && !failures.some((failure) => failure.ownerId === payload.card.ownerId)) failures.push({ ownerId: payload.card.ownerId, ownerName: payload.card.ownerName, message: payload.draftFailure });
  const retryDraft = round.approver && round.phase === "draft" && failures.length ? round.retryDraftAction : null;
  const open = round.approver && round.phase === "draft" && !failures.length ? actions.find((action) => action.actionType === "mission-round.open") : undefined;
  const close = round.approver && round.phase === "open" ? actions.find((action) => action.actionType === "mission-round.close") : undefined;
  const reopen = round.approver && round.phase === "reviewing" ? actions.find((action) => action.actionType === "mission-round.reopen") : undefined;
  const confirm = round.approver && round.phase === "reviewing" && !round.counts.pending ? actions.find((action) => action.actionType === "mission-round.confirm") : undefined;
  const startable = round.approver && ((round.phase === "reviewing" && round.counts.pending > 0) || (round.phase === "confirmed" && payload.correctionAccess.canApply && round.counts.corrections > 0));
  if (!drafting && !failures.length && !open && !close && !reopen && !confirm && !startable && !confirmation) return null;
  return <section className={s.workflow} aria-label="任务审核操作">
    {drafting || failures.length ? <div className={s.draftStatus} role="status" aria-live="polite">
      <div className={s.draftStatusTop}><p className={s.draftStatusTitle}>{drafting ? "Co-Agent 正在起草任务" : "任务起草未完成"}</p>{retryDraft ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => onAction(retryDraft)}>重试起草</Button> : null}</div>
      {drafting ? <p className={s.hint}>完成后，任务正文会在这里更新。</p> : <>{failures.map((failure) => <div key={failure.ownerId} className={s.draftFailure}><p className={s.draftFailureOwner}>{failure.ownerName}</p><DraftFailureReason message={failure.message} /></div>)}<p className={s.hint}>{retryDraft ? "重试会为未完成的任务卡重新起草。" : `等待${round.deciderName}重试起草。`}</p></>}
    </div> : null}
    {open || close || reopen || confirm || startable || confirmation ? <>
    <div className={s.workflowRow}>
      {round.phase === "reviewing" ? <p>{round.counts.pending ? `${round.counts.pending} 条意见待审核` : "意见已审核，待确认"}</p> : confirmation ? <p>{confirmation.byName}于 {monthDayTime(confirmation.at)} 确认</p> : <p>拍板人 · {round.deciderName}</p>}
      <div className={s.inlineActions}>
        {open ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => onAction(open)}>开放讨论</Button> : null}
        {close ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => onAction(close)}>结束讨论</Button> : null}
        {startable ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={onStartProcessing}>从第一条开始</Button> : null}
        {reopen ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => onAction(reopen)}>继续讨论</Button> : null}
        {confirm ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => setConfirming(!confirming)}>确认前核对</Button> : null}
      </div>
    </div>
    {confirming && confirm ? <div className={s.proposal}>
      <label htmlFor={`mission-check-${round.roundId}`}>依赖、冲突与协作的核对结论</label>
      <p className={s.hint}>请核对 {round.counts.cards} 张任务卡的交接与协作安排。确认后成为本月承诺。</p>
      <textarea id={`mission-check-${round.roundId}`} autoFocus rows={3} maxLength={2000} value={note} disabled={pending} onChange={(event) => onNoteChange?.(event.target.value)} />
      {error ? <p className={s.proposalError} role="alert">{error}</p> : null}
      <div className={s.inlineActions}><Button variant="primary" className={s.primary} isDisabled={pending || !note.trim()} onPress={() => onAction(confirm, { note: note.trim() })}>确认本月任务</Button><Button variant="ghost" className={s.secondary} onPress={() => setConfirming(false)}>取消</Button></div>
    </div> : null}
    </> : null}
  </section>;
}
