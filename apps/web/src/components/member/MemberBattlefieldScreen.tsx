"use client";

/** clark BattlefieldGoals 的目标阅读面；轮次与任务卡改读成员接口，不带 CEO 决策内容。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Crown } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TMemberBattlefieldResponse } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { MissionStatus } from "@/components/MissionStatus";
import { RoundClock } from "@/components/missionCards/RoundClock";
import { useRoundNow } from "@/components/missionCards/useRoundNow";
import { roundStatusText } from "@/components/missionCards/roundStatusText";
import s from "./MemberBattlefieldScreen.module.css";

const EMPTY_CARDS: Card[] = [];
const REFRESH_ERROR = "暂时无法刷新战场，已保留当前内容；稍后会自动重试。";

export function MemberBattlefieldScreen({ initialData }: { initialData: TMemberBattlefieldResponse }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [view, setView] = useState<TMemberBattlefieldResponse | null>(initialData);
  const [error, setError] = useState("");
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const active = useRef(true);
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    refreshInFlight.current = (async () => {
      try {
        const { data, response } = await browserApi.GET("/api/me/battlefields/{id}", { params: { path: { id: initialData.id } } });
        if (!active.current) return;
        if (response.status === 401) {
          setView(null);
          router.push(`/access?next=${encodeURIComponent(`/me/battlefields/${initialData.id}`)}`);
          return;
        }
        if (response.status === 403 || response.status === 404) { setView(null); setError(""); return; }
        if (!response.ok || !data) throw new Error("refresh failed");
        setView(data);
        setError("");
      } catch { if (active.current) setError(REFRESH_ERROR); }
      finally { refreshInFlight.current = null; }
    })();
    return refreshInFlight.current;
  }, [initialData.id, router]);

  useEffect(() => {
    active.current = true;
    const resume = () => { if (document.visibilityState === "visible") void refresh(); };
    const changed = () => {
      // 拍板可能发生在旧请求途中；它落定后再读，不能吞掉确认或重开。
      if (refreshInFlight.current) void refreshInFlight.current.then(() => { if (active.current) void refresh(); });
      else void refresh();
    };
    const timer = window.setInterval(resume, 20_000);
    window.addEventListener("focus", resume);
    window.addEventListener("mission-round-changed", changed);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("mission-round-changed", changed);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh]);

  const round = view?.round ?? null;
  const now = useRoundNow(round?.closesAt ?? null, view?.serverNow ?? initialData.serverNow, round?.phase === "open" ? refresh : undefined);
  const awaitingSnapshot = round?.phase === "closed" || (round?.phase === "open" && !!round.closesAt && now >= Date.parse(round.closesAt));
  useEffect(() => {
    if (!awaitingSnapshot) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [awaitingSnapshot, refresh]);

  // 成员战场未开放独立 Agent；沿用全局入口，不把 CEO 战场 scope 注入对话。
  useRegisterDetail({ scope: "global", label: view?.name ?? "战场详情", mark: null, cards: EMPTY_CARDS });
  if (!view) return <div className={s.screen}><DetailFrame title="战场详情" onBack={workspace.close}><div className={s.content}><p className={s.empty} role="status">这个战场不存在或当前不可见。</p></div></DetailFrame></div>;

  const month = Number(view.period.slice(5));
  const mine = view.missionCards.find((card) => card.ownerId === workspace.viewerId);
  const shownRound = round && awaitingSnapshot ? { ...round, phase: "closed" as const } : round;
  const status = shownRound ? roundStatusText(shownRound, { cardId: mine?.cardId, feedbackCount: mine?.feedbackCount ?? 0, confirmation: view.confirmation })
    : view.monthTargetState === "confirmed" ? "任务卡草稿还没整理" : view.monthTargetText;
  const pendingCard = round?.approver && round.phase === "reviewing" ? round.cards.find((card) => card.pending > 0 && card.firstPendingFeedbackId) : undefined;
  // 已确定后拍板人的待办是更正申请（GAP-04）：同样直达第一条。
  const correctionCard = round?.approver && round.phase === "confirmed" && round.todo ? round.cards.find((card) => card.pendingCorrections > 0 && card.firstPendingCorrectionId) : undefined;
  const target = pendingCard ?? correctionCard;
  const nextCard = target ? view.missionCards.find((card) => card.cardId === target.cardId && card.canOpen) : view.missionCards.find((card) => card.canOpen);
  const query = pendingCard?.firstPendingFeedbackId ? `?feedback=${encodeURIComponent(pendingCard.firstPendingFeedbackId)}`
    : correctionCard?.firstPendingCorrectionId ? `?correction=${encodeURIComponent(correctionCard.firstPendingCorrectionId)}` : "";
  const nextHref = nextCard?.href ? `${nextCard.href}${query}` : null;

  return <div className={s.screen} data-member-battlefield={view.id}>
    <DetailFrame title={view.name} subtitle={`${month} 月 · 战场 ${view.code}`} onBack={workspace.close}
      actions={view.isDri ? <span className={s.dri}><Crown size={18} strokeWidth={1.65} aria-hidden />你是这个战场的 DRI</span> : undefined}>
      <div className={s.content}>
        <div className={s.owner}>战场 DRI <strong>{view.ownerName || "没有登记"}</strong></div>
        {error ? <p className={s.error} role="status">{error}</p> : null}
        <section className={s.goals} aria-label="战场目标">
          <div className={s.goal}><h2>六个月目标</h2><p>{view.sixMonthOutcome || "六个月目标没有登记"}</p></div>
          <div className={s.goal}><h2>本月目标 <span>{month} 月</span></h2><p>{view.monthTargetText}</p></div>
        </section>

        <section className={s.round} aria-labelledby="battlefield-round-title">
          <div className={s.roundHeading}><h2 id="battlefield-round-title">本轮</h2>{shownRound ? <RoundClock round={shownRound} now={now} /> : null}</div>
          <p className={s.roundStatus}>{status}</p>
          {round?.closesAt ? <p className={s.deadline}>讨论截止 <time dateTime={round.closesAt}>{monthDayTime(round.closesAt)}</time><span> · 拍板人 {round.deciderName}</span></p> : null}
          <div className={s.roundFoot}>
            <p>{round?.approver ? `${round.counts.cards} 张卡 · 待处理 ${round.counts.pending}` : mine ? `我的卡：${mine.missionCount} 项 · ${mine.feedbackCount} 条意见` : "这个月还没有你的卡"}</p>
            {/* 待办句已在上方状态行；按钮只写动作，与引导「下一件事」同一措辞。 */}
            {round?.approver && round.todo && nextHref ? <Button variant="primary" className={s.primary} aria-label={`查看 ${month} 月任务卡`} data-origin={nextHref} onPress={(event) => workspace.navigate(nextHref, event.target as Element)}>{`查看 ${month} 月任务卡`}<ChevronRight size={17} aria-hidden /></Button>
              : mine?.canOpen && mine.href ? <Button variant="ghost" className={s.open} aria-label="打开我的本月卡" data-origin={mine.href} onPress={(event) => workspace.navigate(mine.href!, event.target as Element)}>打开我的卡<ChevronRight size={17} aria-hidden /></Button> : null}
          </div>
        </section>

        <section className={s.section} aria-labelledby="battlefield-cards-title">
          <div className={s.sectionHeading}><h2 id="battlefield-cards-title">本月任务卡</h2>{view.missionCards.length ? <span>{view.missionCards.length} 张</span> : null}</div>
          {view.missionCards.length ? <ul className={s.cards}>{view.missionCards.map((card) => {
            const content = <><span className={s.initial} aria-hidden>{card.ownerName.slice(0, 1)}</span><span className={s.identity}><strong>{card.ownerName}{card.ownerId === workspace.viewerId ? <em>你</em> : null}</strong><span>{card.roleLabel ?? "参与 DRI"} · {card.missionCount} 项</span></span><span className={s.cardStatus}>{awaitingSnapshot ? "汇总中" : card.status}</span>{card.canOpen && card.href ? <ChevronRight size={18} aria-hidden /> : null}</>;
            return <li key={card.cardId}>{card.canOpen && card.href ? <Button variant="ghost" className={s.cardRow} aria-label={`打开${card.ownerName}的本月卡`} data-origin={card.href} onPress={(event) => workspace.navigate(card.href!, event.target as Element)}>{content}</Button> : <div className={s.cardRow}>{content}</div>}</li>;
          })}</ul> : <p className={s.empty}>这个战场的本月任务卡还没有登记。</p>}
        </section>

        <section className={s.section} aria-labelledby="battlefield-missions-title">
          <div className={s.sectionHeading}><h2 id="battlefield-missions-title">我在这里的 Mission</h2>{view.myMissions.length ? <span>{view.myMissions.length} 项</span> : null}</div>
          {view.myMissions.length ? <ul className={s.missions}>{view.myMissions.map((mission) => {
            const card = view.missionCards.find((candidate) => candidate.cardId === mission.personalCard?.cardId && candidate.canOpen);
            return <li key={mission.missionId} className={s.mission}>
              <div className={s.missionHeading}>{card?.href ? <Button variant="ghost" className={s.missionLink} aria-label={`打开个人任务：${mission.title}`} data-origin={card.href} onPress={(event) => workspace.navigate(card.href!, event.target as Element)}>{mission.title}<ChevronRight size={17} aria-hidden /></Button> : <h3>{mission.title}</h3>}<MissionStatus mission={mission} /></div>
              <p>{mission.outcome || "预期结果没有登记"}</p>
              <span className={s.missionMeta}>{mission.ownerDisplayName || "负责人没有登记"} · {mission.capabilityName}</span>
            </li>;
          })}</ul> : <p className={s.empty}>这个月还没有登记你在这里的 Mission。</p>}
        </section>
      </div>
    </DetailFrame>
  </div>;
}
