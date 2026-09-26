"use client";

import { ChevronRight, Clock3 } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import type { Card } from "@/lib/api/client";
import { payloadOf, type MeetingPayload } from "@/cards/payloads";
import { monthDayTime } from "@/lib/companyTime";
import { ReferenceButton } from "@/conversation/references";
import s from "@/styles/home-board.module.css";

export type IssueUrgencyLevel = "red" | "yellow" | "gray";

export type IssueRowData = {
  id: string;
  title: string;
  urgency: IssueUrgencyLevel;
  /** 决定期限（天枢独有，clark 同位置的 small 行样式）。 */
  decisionBy?: string;
  /** 已排期会议的开始时间「9/23 10:00」。 */
  meetingTime?: string;
};

const URGENCY_NAMES: Record<IssueUrgencyLevel, string> = { red: "需要尽快决策", yellow: "需在窗口内决策", gray: "待决策" };

/** 首页 / 战场卡上的一条待决策议题（clark `home-board.tsx` renderIssue）。整行是来源节点，打开议题时长成工作区。 */
export function IssueRow({
  issue,
  card,
  onNavigate,
}: {
  issue: IssueRowData;
  /** 议题的 Card：有它才显示「引用到全局对话」（打开键的兄弟节点）。 */
  card?: Card;
  onNavigate: (href: string, origin?: Element | null) => void;
}) {
  const href = `/issues/${issue.id}`;
  return (
    <div className={s.issueSlot} data-origin={href} data-urgency={issue.urgency}>
      <HeroButton
        variant="ghost"
        size="sm"
        data-ts-layout="true"
        type="button"
        className={s.issue}
        onPress={(event) => onNavigate(href, event.target as Element)}
        aria-label={`${URGENCY_NAMES[issue.urgency]}：${issue.title}${issue.meetingTime ? `。会议时间 ${issue.meetingTime}` : ""}`}
      >
        <span className={`${s.dot} ${s[issue.urgency]}`} aria-hidden="true" />
        <span className={s.issueText}>
          <span>{issue.title}</span>
          {issue.decisionBy ? <small>决定期限 {issue.decisionBy}</small> : null}
          {issue.meetingTime ? (
            <span className={s.meetingState}>
              <Clock3 size={13} aria-hidden="true" />
              <span>{issue.meetingTime}</span>
            </span>
          ) : null}
        </span>
        <ChevronRight size={14} className={s.issueArrow} aria-hidden="true" />
      </HeroButton>
      {card ? <ReferenceButton cards={[card]} title={issue.title} /> : null}
    </div>
  );
}

/** 已排期会议的开始时间，按议题索引（同一议题取最早一场）。只读首页集合里的 Meeting Card。 */
export function meetingTimesByIssue(cards: Card[]): Map<string, string> {
  const earliest = new Map<string, string>();
  for (const card of cards) {
    if (card.kind !== "meeting") continue;
    const meeting = payloadOf<MeetingPayload>(card);
    if (meeting.status !== "scheduled") continue;
    for (const issueId of meeting.issueIds) {
      const current = earliest.get(issueId);
      if (!current || meeting.scheduledAt < current) earliest.set(issueId, meeting.scheduledAt);
    }
  }
  return new Map([...earliest].map(([issueId, at]) => [issueId, monthDayTime(at)]));
}
