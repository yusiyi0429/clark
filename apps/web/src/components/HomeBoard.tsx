"use client";

import { Fragment, useMemo } from "react";
import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { ChevronRight } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { renderCard } from "@/cards/registry";
import { payloadOf, type CapabilityPayload, type IssuePayload, type RadarPayload } from "@/cards/payloads";
import { BattlefieldDisplayProvider, useBattlefieldDisplay, type BattlefieldMode } from "@/cards/battlefieldDisplay";
import { HeroButton } from "@/components/HeroButton";
import { IssueRow, meetingTimesByIssue, type IssueRowData } from "@/components/IssueRow";
import { ReferenceButton } from "@/conversation/references";
import { useProgressCounts } from "@/components/progress/useProgressCounts";
import { calendarDate } from "@/lib/companyTime";
import b from "@/styles/home-board.module.css";
import r from "@/styles/radar.module.css";

type Props = {
  cards: Card[];
  onCard: (card: Card) => void;
  onNavigate: (href: string, origin?: Element | null) => void;
  /** 约会议：CEO 主要靠和 Agent 对话约，这里只在战场工具条上留一个不抢眼的入口；没有登录人时没有。 */
  onBookMeeting?: () => void;
};

/** 首页看板（clark `home-board.tsx`）：公司战略议题 + 雷达 → 战场翻转卡 → 公司能力（战场网格里的最后一张卡）。 */
export function HomeBoard(props: Props) {
  return (
    <BattlefieldDisplayProvider>
      <HomeBoardContent {...props} />
    </BattlefieldDisplayProvider>
  );
}

/** 雷达卡上那一行小字：扫描中 / 未读数 / 默认邀请。首页看板和手持的「公司全局」共用。 */
export function radarStatusText(payload: RadarPayload | null): string {
  if (payload?.lastRun?.status === "running") return "正在扫描";
  if (payload && payload.unreadCount > 0) return `${payload.unreadCount} 条未读`;
  return "看看外面的变化";
}

export function issueRowData(card: Card, meetingTimes: Map<string, string>): IssueRowData {
  const payload = payloadOf<IssuePayload>(card);
  return {
    id: card.objectRef.id,
    title: card.title,
    urgency: payload.urgency.level,
    decisionBy: calendarDate(payload.urgency.decisionBy) || undefined,
    meetingTime: meetingTimes.get(card.objectRef.id) || undefined,
  };
}

type CapabilitySection = { key: string; code: string; name: string; order: number; issues: Card[] };

/**
 * 公司能力的议题按能力域分组（SSOT CEO-01）：只返回有议题的能力域，按排序；未登记能力的议题归入末尾「其他」。
 * 首页卡与公司能力详情共用；能力域本身（目标、支撑、Mission）只在详情里列。
 */
export function capabilitySections(cards: Card[]): CapabilitySection[] {
  const sections = new Map<string, CapabilitySection>();
  for (const card of cards) if (card.kind === "capability") {
    const payload = payloadOf<CapabilityPayload>(card);
    sections.set(payload.capabilityId, { key: payload.capabilityId, code: payload.code, name: payload.name, order: payload.sortOrder, issues: [] });
  }
  const other: CapabilitySection = { key: "other", code: "", name: "其他", order: Number.MAX_SAFE_INTEGER, issues: [] };
  for (const card of cards) {
    if (card.kind !== "issue") continue;
    const location = payloadOf<IssuePayload>(card).location;
    if (location.level !== "capability") continue;
    (sections.get(location.capabilityId) ?? other).issues.push(card);
  }
  return [...sections.values(), other]
    .filter((section) => section.issues.length > 0)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** 「全局进展」入口的读屏名称：带上红线条数。首页手持的「公司全局」同用。 */
export function progressEntryLabel(counts: { redLines: number } | null): string {
  return counts?.redLines ? `全局进展，${counts.redLines} 条红线` : "全局进展";
}

function HomeBoardContent({ cards, onCard, onNavigate, onBookMeeting }: Props) {
  const display = useBattlefieldDisplay();
  const radar = cards.find((card) => card.kind === "radar");
  const battlefields = cards.filter((card) => card.kind === "battlefield");
  const meetingTimes = useMemo(() => meetingTimesByIssue(cards), [cards]);
  const strategy = cards.filter((card) => card.kind === "issue" && payloadOf<IssuePayload>(card).location.level === "company");
  const sections = useMemo(() => capabilitySections(cards), [cards]);
  const capabilityIssues = sections.flatMap((section) => section.issues);
  const row = (card: Card) => <IssueRow key={card.id} issue={issueRowData(card, meetingTimes)} card={card} onNavigate={onNavigate} />;

  const radarStatus = radarStatusText(radar ? payloadOf<RadarPayload>(radar) : null);
  const progress = useProgressCounts();

  return (
    <div className={b.board} data-testid="decision-home">
      {/* 公司战略议题空着时整块收起，雷达收成一条。 */}
      <div className={b.top} data-collapsed={strategy.length ? undefined : true}>
        {strategy.length ? <section className={`${b.panel} ${b.strategy}`}>
          <div className={`${b.heading} ${b.headingStatic}`}>
            <h2>公司战略议题</h2>
          </div>
          <ReferenceButton corner cards={strategy} title="公司战略议题" />
          <div className={b.strategicIssues}>{strategy.map(row)}</div>
        </section> : null}
        <div className={b.radarWrapper}>
          {radar ? (
            <HeroButton
              variant="ghost"
              size="sm"
              data-ts-layout="true"
              type="button"
              className={`${r.radar} ${b.radar}`}
              data-origin="/radar"
              onPress={(event) => onNavigate("/radar", event.target as Element)}
            >
              <h2>雷达信号</h2>
              <small className={b.radarStatus}>{radarStatus}</small>
              <div className={`${r.stage} ${b.scanStage}`} aria-hidden="true">
                <div className={r.scope}>
                  <span className={r.crosshair} />
                  <span className={r.sweep} />
                  <div>
                    <i className={r.echo} />
                    <i className={r.echo} />
                    <i className={r.echo} />
                  </div>
                  <span className={r.center} />
                </div>
              </div>
              <ChevronRight className={r.launch} size={16} aria-hidden="true" />
            </HeroButton>
          ) : null}
        </div>
      </div>

      <div className={b.battlefieldToolbar} data-testid="battlefield-toolbar">
        <span>战场</span>
        <div className={b.toolbarActions}>
          {onBookMeeting ? (
            <HeroButton variant="ghost" size="sm" data-ts-layout="true" type="button" className={b.progressEntry} onPress={onBookMeeting}>
              约会议
            </HeroButton>
          ) : null}
          <HeroButton
            variant="ghost"
            size="sm"
            data-ts-layout="true"
            type="button"
            className={b.progressEntry}
            data-origin="/progress"
            aria-label={progressEntryLabel(progress)}
            onPress={(event) => onNavigate("/progress", event.target as Element)}
          >
            全局进展
            {progress?.redLines ? <span className={b.progressBadge} data-tone="red">{progress.redLines} 红线</span> : null}
            <ChevronRight size={14} aria-hidden="true" />
          </HeroButton>
          <ToggleButtonGroup
            className={b.modeSwitch}
            aria-label="战场展示方式"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[display.mode]}
            onSelectionChange={(keys) => {
              const next = [...keys][0] as BattlefieldMode | undefined;
              if (next) display.setMode(next);
            }}
          >
            <ToggleButton id="decisions">待决策</ToggleButton>
            <ToggleButton id="progress">进展</ToggleButton>
          </ToggleButtonGroup>
        </div>
      </div>
      <div className={b.battlefields}>
        {battlefields.map((card) => (
          <Fragment key={card.id}>{renderCard({ card, collection: cards, onCard, onNavigate })}</Fragment>
        ))}
        {/* 战场网格里的一张普通卡：与战场卡同宽、同一行按最高的那张拉齐；只列有议题的能力域，细节点进去看。 */}
        <section className={`${b.panel} ${b.capabilities}`}>
          <HeroButton
            variant="ghost"
            size="sm"
            data-ts-layout="true"
            type="button"
            className={b.heading}
            data-origin="/capabilities"
            onPress={(event) => onNavigate("/capabilities", event.target as Element)}
          >
            <h2>公司能力</h2>
            <ChevronRight size={14} aria-hidden="true" />
          </HeroButton>
          <ReferenceButton corner cards={capabilityIssues} title="公司能力" />
          {sections.length ? (
            <div className={b.groups} data-testid="capability-issues">
              {sections.map((section) => (
                <section key={section.key} className={b.group} data-capability-category={section.key} aria-label={`${section.name}能力域`}>
                  <h3>{section.name}</h3>
                  {section.issues.map((card) => (
                    <div key={card.id}>{row(card)}</div>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <p className={b.empty}>暂无待决策议题</p>
          )}
        </section>
      </div>
    </div>
  );
}
