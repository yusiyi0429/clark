"use client";

import { useState } from "react";
import type { TMeetingCardDecision, TMeetingCardSection } from "@warmap/contracts";
import { Select } from "@/components/ui/Select";
import type { MeetingPerson } from "./ActionItemRow";
import { basisLabel } from "./meetingCardModel";
import c from "./meeting-card.module.css";

type MeetingDecisionListProps = {
  decisions: TMeetingCardDecision[];
  sections: TMeetingCardSection[];
  /** 没有责任人的由主持人交给一位参会人。 */
  hostId: string;
  viewerId: string;
  /** 参会人：主持人补归属时从里面选。 */
  people: MeetingPerson[];
  /** 已定版：不能再点。 */
  frozen: boolean;
  /** 天枢不再逐条确认（会议写本体关掉了，会后判定归 Nexus）：不出确认、补归属，没处理的只写责任人。 */
  noReview?: boolean;
  busy: boolean;
  nameOf: (personId: string) => string;
  onReview: (id: string, verdict: "confirm" | "reject", reason?: string) => Promise<boolean>;
  onAssign: (id: string, ownerPersonId: string) => Promise<boolean>;
};

/**
 * 会议卡上的「决策」：每条写着由谁确认、确认了没有。只有责任人本人能点「确认 / 不对」；没有责任人的，主持人先从参会人里选一位交给他
 * （斯一第 3 条），别人只看；定版后只读。
 */
export function MeetingDecisionList({ decisions, sections, ...row }: MeetingDecisionListProps) {
  return (
    <section className={c.block}>
      <h3 className={c.blockLabel}>决策</h3>
      <div className={c.items}>
        {decisions.map((decision, index) => (
          <DecisionRow key={decision.id} number={index + 1} decision={decision} basis={basisLabel(decision.basisSectionIds, sections)} {...row} />
        ))}
      </div>
    </section>
  );
}

export function DecisionRow({ number, decision, basis, hostId, viewerId, people, frozen, noReview, busy, nameOf, onReview, onAssign }: {
  number: number; decision: TMeetingCardDecision; basis: string | null;
} & Omit<MeetingDecisionListProps, "decisions" | "sections">) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const { review, ownerPersonId: owner } = decision;
  const open = review.status === "pending" && !frozen && !noReview;
  const self = owner === viewerId;
  const assigning = open && !owner && hostId === viewerId;
  const who = review.by ? nameOf(review.by) : "";
  const status = review.status === "confirmed" ? `${who}确认`
    : review.status === "rejected" ? `${who}：${review.reason ?? ""}`
    : noReview ? (owner ? nameOf(owner) : null)
    : !owner ?(frozen ? "没有责任人" : `待${nameOf(hostId)}指定责任人`)
    : frozen ? `${nameOf(owner)}没有确认` : `待${nameOf(owner)}确认`;
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
        {assigning ? (
          <div className={c.actions}>
            <Select aria-label={`第 ${number} 条决策交给谁确认`} placeholder="交给谁确认" size="compact" className={c.ownerPicker} value="" disabled={busy}
              options={people.map((person) => ({ value: person.personId, label: person.displayName }))}
              onChange={(value) => { if (value) void onAssign(decision.id, value); }} />
          </div>
        ) : open && self && !rejecting ? (
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
