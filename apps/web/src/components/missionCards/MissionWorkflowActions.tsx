"use client";

import { useState } from "react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import type { CardAction } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import s from "./mission-card.module.css";
import t from "@/styles/material-tabs.module.css";

type RoundAction = Pick<CardAction, "actionId" | "actionType" | "label">;
type Props = {
  payload: TPersonalMissionCardPayload;
  actions: RoundAction[];
  viewerId?: string | null;
  pending: boolean;
  onAction: (action: RoundAction, input?: { note: string }) => void;
  onStartProcessing?: () => void;
  note?: string;
  onNoteChange?: (note: string) => void;
  error?: string;
  /** 人员状态菜单内展开全部操作；页头只保留一个主入口。 */
  inMenu?: boolean;
  onDismiss?: () => void;
};

function DraftFailureReason({ message }: { message: string }) {
  if (message.length <= 160 && message.split(/\r?\n/).length <= 2) return <p>{message}</p>;
  return <><p className={s.draftFailureSummary}>{message.length > 160 ? `${message.slice(0, 160).trimEnd()}…` : message}</p><details className={s.draftFailureDetails}><summary>查看原因</summary><p>{message}</p></details></>;
}

/** 起草错误仍贴近正文；审核操作统一收进页头。 */
export function MissionDraftStatus({ payload, pending, onAction }: Pick<Props, "payload" | "pending" | "onAction">) {
  const { round } = payload;
  const drafting = round.phase === "drafting";
  const failures = (round.draftFailures ?? []).filter((failure) => round.approver || failure.ownerId === payload.card.ownerId);
  if (payload.draftFailure && !failures.some((failure) => failure.ownerId === payload.card.ownerId)) failures.push({ ownerId: payload.card.ownerId, ownerName: payload.card.ownerName, message: payload.draftFailure });
  if (!drafting && !failures.length) return null;
  const retry = round.approver && round.phase === "draft" && failures.length ? round.retryDraftAction : null;
  return <section className={s.workflow} aria-label="任务起草状态"><div className={s.draftStatus} role="status" aria-live="polite">
    <div className={s.draftStatusTop}><p className={s.draftStatusTitle}>{drafting ? "Co-Agent 正在起草任务" : "任务起草未完成"}</p>{retry ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => onAction(retry)}>重试起草</Button> : null}</div>
    {drafting ? <p className={s.hint}>完成后，任务正文会在这里更新。</p> : <>{failures.map((failure) => <div key={failure.ownerId} className={s.draftFailure}><p className={s.draftFailureOwner}>{failure.ownerName}</p><DraftFailureReason message={failure.message} /></div>)}<p className={s.hint}>{retry ? "重试会为未完成的任务卡重新起草。" : `等待${round.deciderName}重试起草。`}</p></>}
  </div></section>;
}

export function MissionWorkflowActions({ payload, actions, pending, onAction, onStartProcessing, note = "", onNoteChange, error, inMenu = false, onDismiss }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { round, confirmation } = payload;
  const open = round.approver && round.phase === "draft" && !round.draftFailures.length && !payload.draftFailure ? actions.find((action) => action.actionType === "mission-round.open") : undefined;
  const close = round.approver && (round.phase === "open" || round.phase === "closed") ? actions.find((action) => action.actionType === "mission-round.close") : undefined;
  const reopen = round.approver && round.phase === "reviewing" ? actions.find((action) => action.actionType === "mission-round.reopen") : undefined;
  const confirm = round.approver && round.phase === "reviewing" && !round.counts.pending ? actions.find((action) => action.actionType === "mission-round.confirm") : undefined;
  const startable = round.approver && ((round.phase === "reviewing" && round.counts.pending > 0) || (round.phase === "confirmed" && payload.correctionAccess.canApply && round.counts.corrections > 0));
  if (!open && !close && !reopen && !confirm && !startable && !confirmation) return null;
  const label = open ? "下发审核" : close ? "开始汇总" : startable ? "处理待办" : confirm ? "核对并确认" : "确认记录";
  const dismiss = () => { setExpanded(false); onDismiss?.(); };
  const act = (action: RoundAction) => { dismiss(); onAction(action); };
  const contents = <section className={s.workflowPanel} aria-label="任务审核操作">
    <p className={s.hint}>{round.phase === "open" ? `已完成审核 ${round.cards.filter((row) => row.ownerConfirmedAt).length} / ${round.cards.length} · 全员完成后自动汇总` : round.phase === "reviewing" ? round.counts.pending ? `${round.counts.pending} 条意见待处理` : "意见已处理，待核对并确认" : confirmation ? `${confirmation.byName}于 ${monthDayTime(confirmation.at)} 确认` : `拍板人 · ${round.deciderName}`}</p>
    <div className={s.inlineActions}>
      {open ? <Button variant="primary" className={s.headerPrimary} isDisabled={pending} onPress={() => act(open)}>下发审核</Button> : null}
      {close ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => act(close)}>开始汇总</Button> : null}
      {startable ? <Button variant="primary" className={s.headerPrimary} isDisabled={pending} onPress={() => { dismiss(); onStartProcessing?.(); }}>从第一条开始</Button> : null}
      {reopen ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => act(reopen)}>重新开放审核</Button> : null}
      {confirm ? <Button variant="primary" className={s.headerPrimary} isDisabled={pending} onPress={() => setConfirming(!confirming)}>确认前核对</Button> : null}
    </div>
    {confirming && confirm ? <div className={s.proposal}>
      <label htmlFor={`mission-check-${round.roundId}`}>依赖、冲突与协作的核对结论</label>
      <p className={s.hint}>请核对 {round.counts.cards} 张任务卡的交接与协作安排。确认后成为本月承诺。</p>
      <textarea id={`mission-check-${round.roundId}`} autoFocus rows={3} maxLength={2000} value={note} disabled={pending} onChange={(event) => onNoteChange?.(event.target.value)} />
      {error ? <p className={s.proposalError} role="alert">{error}</p> : null}
      <div className={s.inlineActions}><Button variant="primary" className={s.headerPrimary} isDisabled={pending || !note.trim()} onPress={() => onAction(confirm, { note: note.trim() })}>确认本月任务</Button><Button variant="ghost" className={s.textAction} onPress={() => setConfirming(false)}>取消</Button></div>
    </div> : null}
    {confirmation ? <p className={s.confirmationNote}>{confirmation.note}</p> : null}
  </section>;
  if (inMenu) return contents;
  return <Popover isOpen={expanded} onOpenChange={setExpanded}><Button variant="primary" className={s.headerPrimary} isDisabled={pending} aria-label={`任务审核操作：${label}`}>{label}</Button><Popover.Content placement="bottom end" offset={6} className={t.popover}><TianshuPortalTheme><Popover.Dialog className={`${t.menu} ${s.workflowPopover}`} aria-label="任务审核操作">{contents}</Popover.Dialog></TianshuPortalTheme></Popover.Content></Popover>;
}
