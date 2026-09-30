"use client";

import { useEffect, useState } from "react";
import type { TMissionRoundSummary } from "@warmap/contracts";
import { Check, ChevronRight } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { ContextMark } from "@/components/ContextMark";
import { RoundClock } from "./RoundClock";
import { useRoundNow } from "./useRoundNow";
import n from "@/styles/notifications.module.css";
import s from "./mission-card-notice.module.css";

/** 概念版 mission-card-group：一轮一组、每人一行。权限、顺序与状态句都取服务端投影。 */
export function MissionCardNoticeGroup({ round, entry, embedded = false, currentHref, onNavigate, onRefresh }: {
  round: TMissionRoundSummary;
  entry: "member" | "ceo";
  embedded?: boolean;
  currentHref?: string;
  onNavigate: (href: string, origin?: Element | null) => void;
  onRefresh: () => void;
}) {
  const now = useRoundNow(round.closesAt, round.serverNow, round.phase === "open" ? onRefresh : undefined);
  // 手持首页上多张卡先收成一行汇总（像 iOS 的堆叠通知），点开再看每人；三屏以上一直展开（CSS 按宽度切换）。
  const [expanded, setExpanded] = useState(false);
  const awaitingSnapshot = round.phase === "closed" || (round.phase === "open" && !!round.closesAt && now >= Date.parse(round.closesAt));
  useEffect(() => {
    if (!awaitingSnapshot) return;
    const timer = window.setInterval(onRefresh, 3_000);
    return () => window.clearInterval(timer);
  }, [awaitingSnapshot, onRefresh]);

  // 确认后整组退出；只有拍板人还有更正申请要处理时，这一轮重新出现（GAP-04）。
  const confirmed = round.phase === "confirmed";
  if ((confirmed && !(round.approver && round.counts.corrections > 0)) || !round.cards.length) return null;
  const live = awaitingSnapshot ? { ...round, phase: "closed" as const } : round;
  const stateText = (card: TMissionRoundSummary["cards"][number]) => awaitingSnapshot ? "汇总中" : round.phase === "open" ? card.ownerConfirmedAt ? "已完成审核" : "审核中" : card.line;
  const month = Number(round.period.slice(5));
  const title = `${month} 月 Mission Card${embedded ? ` · ${round.battlefieldName}` : ""}`;
  const path = (cardId: string) => `${entry === "member" ? "/me" : ""}/mission-cards/${cardId}`;
  const pendingCard = round.phase === "reviewing" ? round.cards.find((card) => card.pending > 0 && card.firstPendingFeedbackId) : undefined;
  const correctionCard = confirmed ? round.cards.find((card) => card.pendingCorrections > 0 && card.firstPendingCorrectionId) : undefined;
  const todoHref = pendingCard ? `${path(pendingCard.cardId)}?feedback=${encodeURIComponent(pendingCard.firstPendingFeedbackId!)}`
    : correctionCard ? `${path(correctionCard.cardId)}?correction=${encodeURIComponent(correctionCard.firstPendingCorrectionId!)}` : path(round.cards[0].cardId);
  const current = round.cards.some((card) => path(card.cardId) === currentHref?.split("?")[0]);

  return <section className={embedded ? s.embedded : `${n.card} ${s.group}`} data-slot={embedded ? undefined : "card"} data-notice={`mission-round:${round.roundId}`} data-notice-group="mission-card" data-current={current || undefined} aria-label={title}>
    <header className={embedded ? s.embeddedHeader : `${n.glassHeader} ${s.header}`} data-subline="true">
      {!embedded ? <ContextMark kind="monthly" className={n.glyph} /> : null}
      <div className={embedded ? s.embeddedIdentity : n.identity}>
        <strong className={s.heading}><span className={s.titleWords}><span className={s.monthTitle}>{month} 月 Mission Card</span>{embedded ? <span className={s.battlefieldTitle}><span className={s.sep}>{" · "}</span>{round.battlefieldName}</span> : null}</span><span className={s.badges}><b className={embedded ? s.count : n.count} aria-label={`${round.cards.length} 张任务卡`}>{round.cards.length}</b>{confirmed ? null : <em className={s.tag}>{round.phase === "drafting" ? "工作中" : round.draftOrigin === "agent" ? "Co-Agent 起草" : round.draftOrigin === "placeholder" ? "占位" : "草稿"}</em>}</span></strong>
        <RoundClock round={live} now={now} tone="glass" />
      </div>
    </header>
    <div className={`${embedded ? "" : n.tray} ${s.tray}`}>
      {round.approver && round.todo ? <HeroButton variant="ghost" className={s.todo} data-origin={todoHref} aria-label={round.todo} onPress={(event) => onNavigate(todoHref, (event.target as Element).closest("[data-notice-group]"))}>
        <span className={s.todoDot} aria-hidden="true" /><span className={s.todoText}>{round.todo}</span><ChevronRight size={15} aria-hidden="true" />
      </HeroButton> : null}
      {round.cards.length > 1 ? <HeroButton variant="ghost" className={s.summary} aria-expanded={expanded} onPress={() => setExpanded((value) => !value)}>
        <span className={s.summaryText}>{round.cards.length} 张任务卡{round.counts.feedback ? ` · ${round.counts.feedback} 条意见` : ""}</span>
        <span className={s.summaryAction}>{expanded ? "收起" : "逐个看"}<ChevronRight size={15} aria-hidden="true" /></span>
      </HeroButton> : null}
      <ul className={s.rows} data-collapsed={round.cards.length > 1 && !expanded || undefined} aria-label={`${title} · ${round.cards.length} 张`}>
        {round.cards.map((card) => <li key={card.cardId}>
          <HeroButton variant="ghost" className={s.row} data-origin={path(card.cardId)} aria-current={path(card.cardId) === currentHref?.split("?")[0] ? "true" : undefined} data-waiting={round.approver && (card.pending > 0 || card.pendingCorrections > 0) || undefined}
            aria-label={`${card.ownerName}${card.mine ? "（你）" : ""} · ${card.roleLabel ?? "参与 DRI"} · ${card.missionCount} 项个人任务 · ${stateText(card)}，查看详情：${card.ownerName}的 ${month} 月 Mission Card`}
            onPress={(event) => onNavigate(path(card.cardId), (event.target as Element).closest("[data-notice-group]"))}>
            <span className={s.initial} aria-hidden="true">{card.ownerName.slice(0, 1)}</span>
            <span className={s.who}><span className={s.name}>{card.ownerName}{card.mine ? <em className={s.mine}>你</em> : null}{card.placeholder ? <em className={s.mine}>占位</em> : null}</span><span className={s.role}>{(card.roleLabel ?? "参与 DRI").replace(/ 战役 DRI$/, " 战役")} · <span className={s.missionCount}>{card.missionCount} 项</span></span></span>
            <span className={s.line} data-review={round.phase === "open" && !awaitingSnapshot ? card.ownerConfirmedAt ? "done" : "wait" : undefined}>{round.phase === "open" && card.ownerConfirmedAt && !awaitingSnapshot ? <Check size={14} aria-hidden /> : null}{stateText(card)}</span><ChevronRight size={15} aria-hidden="true" />
          </HeroButton>
        </li>)}
      </ul>
    </div>
  </section>;
}
