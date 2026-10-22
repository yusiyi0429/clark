"use client";

import { useMemo } from "react";
import { Activity, ChevronRight, Radar } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { payloadOf, type BattlefieldPayload, type IssuePayload, type RadarPayload } from "@/cards/payloads";
import { HeroButton } from "@/components/HeroButton";
import { meetingTimesByIssue, type IssueUrgencyLevel } from "@/components/IssueRow";
import { capabilitySections, issueRowData, progressEntryLabel, radarStatusText } from "@/components/HomeBoard";
import { useProgressCounts } from "@/components/progress/useProgressCounts";
import g from "@/styles/ceo-glance.module.css";

type Props = {
  cards: Card[];
  onNavigate: (href: string, origin?: Element | null) => void;
};

/** 一组待决策议题里最急的那一档，决定角标颜色。 */
const topUrgency = (levels: IssueUrgencyLevel[]): IssueUrgencyLevel =>
  levels.includes("red") ? "red" : levels.includes("yellow") ? "yellow" : "gray";

/**
 * 手持（≤959：单屏、三折叠双屏）首页通知下面的「公司全局」。CEO 在手机上只看这些：每个战场一行（谁负责、几项待决策）、
 * 雷达一行；公司级战略议题和能力议题有才出现。完整看板（战场翻转卡、进展示意、能力卡）留给三屏工作台（HomeBoard）。
 */
export function CeoGlance({ cards, onNavigate }: Props) {
  const meetingTimes = useMemo(() => meetingTimesByIssue(cards), [cards]);
  const strategy = cards.filter((card) => card.kind === "issue" && payloadOf<IssuePayload>(card).location.level === "company");
  const battlefields = cards.filter((card) => card.kind === "battlefield");
  const capabilityIssues = useMemo(() => capabilitySections(cards).flatMap((section) => section.issues), [cards]);
  const radar = cards.find((card) => card.kind === "radar");
  const radarPayload = radar ? payloadOf<RadarPayload>(radar) : null;
  const open = (href: string) => (event: { target: EventTarget }) => onNavigate(href, event.target as Element);
  const progress = useProgressCounts();

  return (
    <section className={g.glance} aria-labelledby="ceo-glance-title" data-testid="ceo-glance">
      <h2 id="ceo-glance-title" className={g.title}>公司全局</h2>

      {strategy.length ? (
        <ul className={g.list} aria-label="公司战略议题">
          {strategy.map((card) => {
            const issue = issueRowData(card, meetingTimes);
            const href = `/issues/${issue.id}`;
            return (
              <li key={card.id}>
                <HeroButton variant="ghost" data-ts-layout="true" type="button" className={g.row} data-origin={href} onPress={open(href)}>
                  <span className={g.dot} data-urgency={issue.urgency} aria-hidden="true" />
                  <span className={g.text}>
                    <span className={g.name}>{issue.title}</span>
                    <small>公司战略议题{issue.meetingTime ? ` · 会议 ${issue.meetingTime}` : issue.decisionBy ? ` · 决定期限 ${issue.decisionBy}` : ""}</small>
                  </span>
                  <ChevronRight size={16} className={g.arrow} aria-hidden="true" />
                </HeroButton>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ul className={g.list} aria-label="战场与雷达">
        {battlefields.map((card) => {
          const payload = payloadOf<BattlefieldPayload>(card);
          const href = `/battlefields/${encodeURIComponent(payload.battlefieldId)}`;
          const pending = payload.pendingIssues.length;
          return (
            <li key={card.id}>
              <HeroButton variant="ghost" data-ts-layout="true" type="button" className={g.row} data-origin={href} onPress={open(href)}
                aria-label={`${card.title}，负责人 ${payload.ownerDisplayName || "待指派"}${pending ? `，${pending} 项待决策` : ""}`}>
                <span className={g.code} aria-hidden="true">{payload.code}</span>
                <span className={g.text}>
                  <span className={g.name}>{card.title}</span>
                  <small>负责人 · {payload.ownerDisplayName || "待指派"}</small>
                  {payload.target ? <small className={g.target}>本月 · {payload.target}</small> : null}
                </span>
                {pending ? <span className={g.pending} data-urgency={topUrgency(payload.pendingIssues.map((issue) => issue.urgency))}>{pending} 待决策</span> : null}
                <ChevronRight size={16} className={g.arrow} aria-hidden="true" />
              </HeroButton>
            </li>
          );
        })}
        <li>
          <HeroButton variant="ghost" data-ts-layout="true" type="button" className={g.row} data-origin="/progress" onPress={open("/progress")} aria-label={progressEntryLabel(progress)}>
            <span className={g.icon} aria-hidden="true"><Activity size={16} /></span>
            <span className={g.text}>
              <span className={g.name}>全局进展</span>
            </span>
            {progress?.redLines ? <span className={g.pending} data-urgency="red">{progress.redLines} 红线</span> : null}
            <ChevronRight size={16} className={g.arrow} aria-hidden="true" />
          </HeroButton>
        </li>
        {radar ? (
          <li>
            <HeroButton variant="ghost" data-ts-layout="true" type="button" className={g.row} data-origin="/radar" onPress={open("/radar")}>
              <span className={g.icon} aria-hidden="true"><Radar size={16} /></span>
              <span className={g.text}>
                <span className={g.name}>雷达信号</span>
                <small>{radarStatusText(radarPayload)}</small>
              </span>
              <ChevronRight size={16} className={g.arrow} aria-hidden="true" />
            </HeroButton>
          </li>
        ) : null}
        {capabilityIssues.length ? (
          <li>
            <HeroButton variant="ghost" data-ts-layout="true" type="button" className={g.row} data-origin="/capabilities" onPress={open("/capabilities")}>
              <span className={g.icon} aria-hidden="true">能</span>
              <span className={g.text}>
                <span className={g.name}>公司能力</span>
                <small>能力建设议题</small>
              </span>
              <span className={g.pending} data-urgency={topUrgency(capabilityIssues.map((card) => payloadOf<IssuePayload>(card).urgency.level))}>{capabilityIssues.length} 待决策</span>
              <ChevronRight size={16} className={g.arrow} aria-hidden="true" />
            </HeroButton>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
