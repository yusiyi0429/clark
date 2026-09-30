"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Card } from "@heroui/react";
import { ChevronDown, ChevronRight, Crown } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { roundClockText } from "@/components/missionCards/RoundClock";
import { useRoundNow } from "@/components/missionCards/useRoundNow";
import { monthDayTime } from "@/lib/companyTime";
import type { components } from "@/lib/api/schema";
import s from "./member-home-widgets.module.css";

export type MemberWork = components["schemas"]["MemberWork"];
type Navigate = (href: string, origin?: Element | null) => void;

/** clark ProjectSection / BattlefieldGoals：按 DRI-01 的新规则只保留本月目标。 */
export function MemberHomeWidgets({ work, onNavigate, onRefresh, radar }: { work: MemberWork | null; onNavigate: Navigate; onRefresh: () => void; radar?: ReactNode }) {
  if (!work) return <p className={s.loading} role="status">正在读取本月工作…</p>;
  // 雷达和 CEO 首页一样放在右上角：单独一栏，不和战场、本月卡挤在同一个网格里。
  return <div className={s.workRow}><section className={s.widgets} aria-label="本月工作">
    {work.battlefields.length ? work.battlefields.map((battlefield) => <BattlefieldWidget key={battlefield.id} battlefield={battlefield} onNavigate={onNavigate} />) :
      <Card className={s.widget}><div className={s.heading}><h2>参与的战场</h2></div><p className={s.empty}>还没有登记你参与的战场</p></Card>}
    <Card className={s.widget} data-widget="mission-cards">
      <div className={s.heading}><h2>我的本月卡</h2><span className={s.month}>{Number(work.period.slice(5))} 月</span></div>
      {work.missionCards.length ? <div className={s.cardList}>{work.missionCards.map((card) => <PersonalCardEntry key={card.cardId} card={card} onNavigate={onNavigate} onRefresh={onRefresh} />)}</div> : null}
      {/* 没有任务卡、但这个月有独立登记的 Mission（9 月 Mission 是直接导入的）：列出来，下月卡确定前一直显示。 */}
      {!work.missionCards.length && work.missions.length ? <ul className={s.missionList} aria-label={`${Number(work.period.slice(5))} 月 Mission`}>
        {work.missions.map((mission) => <li key={mission.id}><span className={s.missionCode}>{mission.code}</span>{mission.title}</li>)}
      </ul> : null}
      {!work.missionCards.length && !work.missions.length ? <p className={s.empty}>这个月还没有你的卡</p> : null}
    </Card>
  </section>{radar ? <div className={s.radarSlot} data-widget="radar">{radar}</div> : null}</div>;
}

function BattlefieldWidget({ battlefield, onNavigate }: { battlefield: MemberWork["battlefields"][number]; onNavigate: Navigate }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const target = useRef<HTMLParagraphElement>(null);
  const goalId = useId();
  const href = `/me/battlefields/${encodeURIComponent(battlefield.id)}`;
  useEffect(() => {
    const node = target.current;
    if (!node) return;
    const measure = () => setOverflows(node.scrollHeight > parseFloat(getComputedStyle(node).lineHeight) * 3 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [battlefield.monthTargetText]);
  return <Card className={`${s.widget} ${s.battlefield}`} data-widget="battlefield" data-origin={href}>
    <div className={s.heading}>
      <h2><HeroButton variant="ghost" className={s.titleLink} aria-label={`查看战场：${battlefield.name}`} onPress={(event) => onNavigate(href, event.target)}>
        {battlefield.name}<ChevronRight size={18} aria-hidden />
      </HeroButton></h2>
      {battlefield.isDri ? <span className={s.crown} role="img" aria-label="你是这个战场的 DRI" title="你是这个战场的 DRI"><Crown size={20} strokeWidth={1.65} aria-hidden /></span> : null}
    </div>
    <div className={s.goal}>
      <span className={s.label}>PO · 本月目标</span>
      <p ref={target} id={goalId} className={s.goalText} data-expanded={expanded} data-empty={battlefield.monthTargetState !== "confirmed"}>{battlefield.monthTargetText}</p>
      {overflows ? <button type="button" className={s.expand} aria-expanded={expanded} aria-controls={goalId} onClick={() => setExpanded((value) => !value)}>
        {expanded ? "收起" : "展开全文"}<ChevronDown size={14} aria-hidden />
      </button> : null}
    </div>
  </Card>;
}

function PersonalCardEntry({ card, onNavigate, onRefresh }: { card: MemberWork["missionCards"][number]; onNavigate: Navigate; onRefresh: () => void }) {
  const now = useRoundNow(card.closesAt, card.serverNow, card.phase === "open" ? onRefresh : undefined);
  const clock = roundClockText(card, now);
  const awaitingSnapshot = card.phase === "open" && !!card.closesAt && now >= Date.parse(card.closesAt);
  return <HeroButton variant="ghost" className={s.personalLink} data-origin={card.href} aria-label={`打开我的本月卡：${card.battlefieldName}`} onPress={(event) => onNavigate(card.href, event.target)}>
    <span className={s.cardName}>{card.battlefieldName}<ChevronRight size={16} aria-hidden /></span>
    <span className={s.cardStatus}>{awaitingSnapshot ? "已截止 · 汇总中" : card.status}</span>
    <span className={s.cardMeta}>{card.missionCount} 项个人任务{card.placeholder ? " · 占位" : ""}</span>
    {card.closesAt && card.phase !== "confirmed" ? <span className={s.deadline}><time dateTime={card.closesAt}>{monthDayTime(card.closesAt)} 截止</time><span>{clock}</span></span> : null}
  </HeroButton>;
}
