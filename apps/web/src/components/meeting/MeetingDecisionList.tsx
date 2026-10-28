"use client";

import { useState } from "react";
import type { TMeetingCardDecision, TMeetingCardSection } from "@warmap/contracts";
import { basisLabel } from "./meetingCardModel";
import c from "./meeting-card.module.css";

type MeetingDecisionListProps = {
  decisions: TMeetingCardDecision[];
  sections: TMeetingCardSection[];
  /** 没有责任人的由主持人确认。 */
  hostId: string;
  viewerId: string;
  /** 已定版：不能再点。 */
  frozen: boolean;
  busy: boolean;
  nameOf: (personId: string) => string;
  onReview: (id: string, verdict: "confirm" | "reject", reason?: string) => Promise<boolean>;
};

/**
 * 会议卡上的「决策」：每条写着由谁确认、确认了没有。只有责任人（没有就是主持人）本人能点「确认 / 不对」，
 * 别人只看；定版后只读。
 */
export function MeetingDecisionList({ decisions, sections, hostId, viewerId, frozen, busy, nameOf, onReview }: MeetingDecisionListProps) {
  return (
    <section className={c.block}>
      <h3 className={c.blockLabel}>决策</h3>
      <div className={c.items}>
        {decisions.map((decision, index) => (
          <DecisionRow key={decision.id} number={index + 1} decision={decision} basis={basisLabel(decision.basisSectionIds, sections)}
            confirmer={decision.ownerPersonId ?? hostId} viewerId={viewerId} frozen={frozen} busy={busy} nameOf={nameOf} onReview={onReview} />
        ))}
      </div>
    </section>
  );
}

export function DecisionRow({ number, decision, basis, confirmer, viewerId, frozen, busy, nameOf, onReview }: {
  number: number; decision: TMeetingCardDecision; basis: string | null; confirmer: string;
} & Pick<MeetingDecisionListProps, "viewerId" | "frozen" | "busy" | "nameOf" | "onReview">) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const { review } = decision;
  const open = review.status === "pending" && !frozen;
  const self = confirmer === viewerId;
  const who = review.by ? nameOf(review.by) : "";
  const status = review.status === "confirmed" ? `${who}确认`
    : review.status === "rejected" ? `${who}：${review.reason ?? ""}`
    : frozen ? `${nameOf(confirmer)}没有确认` : `待${nameOf(confirmer)}确认`;
  const reject = async () => {
    if (await onReview(decision.id, "reject", reason.trim())) setRejecting(false);
  };
  return (
    <div className={c.item} role="group" aria-label={`第 ${number} 条决策`}>
      <span className={c.sectionNo} aria-hidden="true">{number}</span>
      <div className={c.itemMain}>
        <div className={c.itemHead}>
          <span className={c.itemText}>{decision.text}</span>
          {review.status === "confirmed" ? <span className={c.flag} data-tone="done">已确认</span>
            : review.status === "rejected" ? <span className={c.flag} data-tone="fail">不对</span> : null}
        </div>
        <div className={c.itemMeta}>
          <span>{status}</span>
          {basis ? <span className={c.basis}>{basis}</span> : null}
        </div>
        {open && self && !rejecting ? (
          <div className={c.actions}>
            <button type="button" className={c.primary} disabled={busy} onClick={() => void onReview(decision.id, "confirm")}>确认</button>
            <button type="button" className={c.ghost} disabled={busy} onClick={() => setRejecting(true)}>不对</button>
          </div>
        ) : open && self ? (
          <div className={c.actions}>
            <input className={c.reason} aria-label="哪里不对" placeholder="哪里不对" maxLength={200} value={reason} disabled={busy} autoFocus
              onChange={(event) => setReason(event.target.value)} />
            <span className={c.spacer} />
            <button type="button" className={c.ghost} disabled={busy} onClick={() => setRejecting(false)}>取消</button>
            <button type="button" className={c.primary} disabled={busy || !reason.trim()} onClick={() => void reject()}>提交</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
