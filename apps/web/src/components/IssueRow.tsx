"use client";

import { ChevronRight, Clock3 } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import type { Card } from "@/lib/api/client";
import { payloadOf, type IssuePayload, type MeetingPayload } from "@/cards/payloads";
import { calendarDate, monthDayTime } from "@/lib/companyTime";
import { ReferenceButton } from "@/conversation/references";
import { isFromRadar, RADAR_ORIGIN_LABEL, RadarOriginTag } from "@/components/OriginTag";
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
  /** 兼容旧调用：不再显示「AI 建议」，这一项被忽略。 */
  nature?: "ai_suggested";
  /** 雷达自动升级的议题：标题旁放「雷达图标 + 雷达」小标签（其他来源的议题不标来源）。 */
  fromRadar?: true;
};

const URGENCY_NAMES: Record<IssueUrgencyLevel, string> = { red: "需要尽快决策", yellow: "需在窗口内决策", gray: "待决策" };

/** 首页 / 战场卡上的一条待决策议题（clark `home-board.tsx` renderIssue）。整行是来源节点，打开议题时长成工作区。 */
export function IssueRow({
  issue,
  card,
  onNavigate,
}: {
  issue: IssueRowData;
  /** 议题的 Card：有它才显示「引用到对话」（打开键的兄弟节点）。 */
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
        aria-label={`${URGENCY_NAMES[issue.urgency]}：${issue.title}${isFromRadar(issue) ? `（${RADAR_ORIGIN_LABEL}）` : ""}${issue.meetingTime ? `。会议时间 ${issue.meetingTime}` : ""}`}
      >
        <span className={`${s.dot} ${s[issue.urgency]}`} aria-hidden="true" />
        <span className={s.issueText}>
          <span title={issue.title}>{issue.title}<RadarOriginTag issue={issue} /></span>
          {issue.decisionBy ? <small>决定期限 {issue.decisionBy}</small> : null}
          {issue.meetingTime ? (
            <span className={s.meetingState} title={issue.meetingTime}>
              <Clock3 size={13} aria-hidden="true" />
              <span data-meeting-full="">{issue.meetingTime}</span>
              {/* 三列紧凑卡只留日期（CSS 切换；完整时间在 title 与按钮读屏名里） */}
              <span data-meeting-short="" aria-hidden="true">{issue.meetingTime.split(" ")[0]}</span>
            </span>
          ) : null}
        </span>
        <ChevronRight size={14} className={s.issueArrow} aria-hidden="true" />
      </HeroButton>
      {card ? <ReferenceButton cards={[card]} title={issue.title} /> : null}
    </div>
  );
}

/** 议题 Card → 议题行数据（首页集团块、公司能力、手持「公司全局」共用）。 */
export function issueRowData(card: Card, meetingTimes: Map<string, string>): IssueRowData {
  const payload = payloadOf<IssuePayload>(card);
  return {
    id: card.objectRef.id,
    title: card.title,
    urgency: payload.urgency.level,
    decisionBy: calendarDate(payload.urgency.decisionBy) || undefined,
    meetingTime: meetingTimes.get(card.objectRef.id) || undefined,
    ...(isFromRadar(payload) ? { fromRadar: true as const } : {}),
  };
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
