"use client";

import { Button } from "ts-design/primitives";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import type { CardAction } from "@/lib/api/client";
import s from "./mission-card.module.css";

type RoundAction = Pick<CardAction, "actionId" | "actionType" | "label">;
type Props = {
  payload: TPersonalMissionCardPayload;
  pending: boolean;
  onAction: (action: RoundAction) => void;
};

function DraftFailureReason({ message }: { message: string }) {
  if (message.length <= 160 && message.split(/\r?\n/).length <= 2) return <p>{message}</p>;
  return <><p className={s.draftFailureSummary}>{message.length > 160 ? `${message.slice(0, 160).trimEnd()}…` : message}</p><details className={s.draftFailureDetails}><summary>查看原因</summary><p>{message}</p></details></>;
}

/** 只展示起草进度与失败重试；本人确认及组合操作由页头持有。 */
export function MissionDraftStatus({ payload, pending, onAction }: Props) {
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
