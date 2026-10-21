"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { TMissionRoundSummary } from "@warmap/contracts";
import { Card as HeroCard } from "@heroui/react";
import { ChevronRight, Lock } from "lucide-react";
import { AccountMenu, type Account } from "./AccountMenu";
import { logout } from "@/lib/logout";
import type { Card } from "@/lib/api/client";
import { payloadOf, type BattlefieldPayload, type CapabilityPayload, type IssuePayload, type MeetingPayload, type MonthlyPlanPayload } from "@/cards/payloads";
import { ContextMark, type ContextMarkKind } from "./ContextMark";
import { HeroButton } from "./HeroButton";
import { ReferenceButton } from "@/conversation/references";
import { TianshuMark } from "./TianshuMark";
import { COMPANY_TIMEZONE, monthDayTime } from "@/lib/companyTime";
import { MissionCardNoticeGroup } from "./missionCards/MissionCardNoticeGroup";
import { roundStatusText } from "./missionCards/roundStatusText";
import { MonthlyReviewNotices } from "./monthlyReview/MonthlyReviewNotices";
import { PersonalReviewBoard } from "./monthlyReview/PersonalReviewBoard";
import { useWeeklyReviewBoard, WeeklyReviewBoard } from "./weeklyReview/WeeklyReviewBoard";
import { RequestNotices } from "./requests/RequestNotices";
import { MeetingCardNotices } from "./meeting/MeetingCardNotices";
import { MeetingRecordDrop } from "./meeting/MeetingRecordDrop";
import { CycleCountdown } from "./CycleCountdown";
import { RADAR_ORIGIN_LABEL, RadarOriginIcon } from "./OriginTag";
import { preflightInFlight } from "@/cards/meetingIssueModel";
import n from "@/styles/notifications.module.css";

type RailKind = "decisions" | "meetings" | "research";
type Tone = "red" | "amber" | "neutral";
type RailItem = { id: string; title: string; meta: string; tone: Tone; href: string; missionRound?: Card; followUp?: boolean; canReschedule?: boolean; meetingId?: string };
type RailGroup = { kind: RailKind; title: string; subtitle: ReactNode; mark: ContextMarkKind; items: RailItem[] };

const RAIL: Record<RailKind, { title: string; mark: ContextMarkKind }> = {
  decisions: { title: "战略决策更新", mark: "issue" },
  meetings: { title: "战略会议安排", mark: "meeting" },
  research: { title: "战略问题研究", mark: "signal" },
};

/** 通知栏时钟：按公司时区拼「9月18日 / 星期五 / 10:30」。 */
export function clock(date: Date): { time: string; weekday: string; day: string } {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: COMPANY_TIMEZONE,
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { time: `${get("hour")}:${get("minute")}`, weekday: get("weekday"), day: `${get("month")}月${get("day")}日` };
}

const sameCompanyDay = (a: Date, b: Date) => clock(a).day === clock(b).day;

/** 左栏多久重读一次首页卡片：有会前预审在跑 5 秒，有待开的会或没定完的任务卡轮次 20 秒，否则不轮询。 */
export function railRefreshInterval(cards: Card[]): number | null {
  if (cards.some((card) => card.kind === "meeting" && preflightInFlight(payloadOf<MeetingPayload>(card)))) return 5_000;
  const waiting = cards.some((card) => {
    if (card.kind === "meeting") return payloadOf<MeetingPayload>(card).status === "scheduled";
    if (card.kind !== "mission-round") return false;
    const payload = payloadOf<TMissionRoundSummary>(card);
    return payload.phase !== "confirmed" || Boolean(payload.todo);
  });
  return waiting ? 20_000 : null;
}

function missionRoundMeta(payload: TMissionRoundSummary): string {
  if (payload.phase === "drafting") return "Co-Agent 正在起草";
  if (payload.phase === "draft") return payload.draftFailures.length ? "任务起草未完成" : "未交给本人确认";
  if (payload.phase === "open") {
    if (payload.closesAt && Date.parse(payload.closesAt) <= Date.parse(payload.serverNow)) return roundStatusText({ ...payload, phase: "closed" }, { feedbackCount: 0 });
    return roundStatusText(payload, { cardId: payload.cards.find((row) => row.mine)?.cardId, feedbackCount: 0 });
  }
  if (payload.phase === "reviewing") return roundStatusText(payload, { feedbackCount: 0 });
  if (payload.phase === "confirmed") return payload.todo ?? "已确定";
  return roundStatusText(payload, { feedbackCount: 0 });
}

/**
 * 把首页 Card 集合整理成三组通知（clark `notifications.tsx` 的分组与顺序）。
 * 只收需要行动的：未签发的月度计划、已排期会议、红色待决议题（v0.3 §645）；打开不会让条目消失（C-05）。
 */
export function railGroups(cards: Card[], now: Date = new Date(), viewerId?: string): RailGroup[] {
  const names = new Map<string, string>();
  for (const card of cards) {
    if (card.kind === "battlefield") names.set(payloadOf<BattlefieldPayload>(card).battlefieldId, card.title);
    if (card.kind === "capability") names.set(payloadOf<CapabilityPayload>(card).capabilityId, card.title);
  }
  const scopeName = (location: IssuePayload["location"]) =>
    location.level === "battlefield" ? names.get(location.battlefieldId) ?? "战场" : location.level === "capability" ? names.get(location.capabilityId) ?? "能力" : "公司";

  const monthly = cards
    .filter((card) => card.kind === "monthly-plan" && payloadOf<MonthlyPlanPayload>(card).status !== "confirmed")
    .map<RailItem>((card) => ({
      id: card.id,
      title: card.title,
      // 与月度页同一口径：未签发都叫「协商中」（C-05：通知与详情状态一致）。
      meta: "协商中 · 待签发",
      tone: "amber",
      href: `/plans/${payloadOf<MonthlyPlanPayload>(card).period}`,
    }));

  const missionRounds = cards.flatMap<RailItem>((card) => {
    if (card.kind !== "mission-round") return [];
    const payload = payloadOf<TMissionRoundSummary>(card);
    // 确认后退出；拍板人还有更正申请待处理时服务端才会把它放回来，待办写在 todo（GAP-04）。
    if (payload.phase === "confirmed" && !payload.todo) return [];
    const firstCard = payload.cards[0];
    return [{ id: card.id, title: card.title, meta: missionRoundMeta(payload), tone: "amber", href: firstCard ? `/mission-cards/${firstCard.cardId}` : "/", missionRound: card }];
  });

  const meetings = cards
    .filter((card) => {
      if (card.kind !== "meeting") return false;
      const meeting = payloadOf<MeetingPayload>(card);
      const ended = Boolean(meeting.hasEnded || meeting.endedAt) || Date.parse(meeting.endsAt) <= now.getTime();
      return meeting.status === "scheduled" && (!ended || meeting.leadDriId === viewerId);
    })
    .sort((a, b) => payloadOf<MeetingPayload>(a).scheduledAt.localeCompare(payloadOf<MeetingPayload>(b).scheduledAt));
  const meetingItems = meetings.map<RailItem>((card) => {
    const payload = payloadOf<MeetingPayload>(card);
    const at = payload.scheduledAt;
    const followUp = Boolean(payload.hasEnded || payload.endedAt) || Date.parse(payload.endsAt) <= now.getTime();
    return {
      id: card.id,
      title: card.title,
      meta: followUp ? "待交记录" : sameCompanyDay(new Date(at), now) ? clock(new Date(at)).time : monthDayTime(at),
      followUp,
      meetingId: card.objectRef.id,
      canReschedule: card.actions.some((action) => action.actionType === "meeting.reschedule"),
      tone: "neutral",
      href: `/meetings/${card.objectRef.id}`,
    };
  });
  const allToday = meetings.length > 0 && meetings.every((card) => sameCompanyDay(new Date(payloadOf<MeetingPayload>(card).scheduledAt), now));
  const leads = new Set(
    meetings.map((card) => {
      const meeting = payloadOf<MeetingPayload>(card);
      return meeting.participants.find((person) => person.personId === meeting.leadDriId)?.displayName ?? "";
    }),
  );
  const lead = leads.size === 1 ? [...leads][0] : "";
  const meetingSubtitle = meetingItems.some((item) => item.followUp) ? "含待处理的会后记录" : allToday ? `今天${lead ? ` · ${lead}主持` : ""}` : `${meetings.length} 场待开`;

  const urgent = cards.filter((card) => card.kind === "issue" && card.urgency === "red");
  // 议题来源：雷达自动升级的（AI 候选议题）写「雷达」并带雷达小图标。
  const origins = new Set(urgent.map((card) => { const payload = payloadOf<IssuePayload>(card); return payload.nature === "ai_suggested" && payload.origin === "radar" ? "radar-ai" : payload.origin; }));
  const researchSubtitle: ReactNode[] = [
    origins.has("radar") ? "Co-Agent 提请" : "",
    origins.has("radar-ai") ? <span key="radar-ai" aria-label={RADAR_ORIGIN_LABEL} title={RADAR_ORIGIN_LABEL}><RadarOriginIcon />雷达</span> : "",
    origins.has("dri") ? "负责人提请" : "",
    origins.has("ceo") ? "一号位发起" : "",
  ].filter(Boolean).flatMap((part, index) => (index ? [" · ", part] : [part]));
  const researchItems = urgent.map<RailItem>((card) => {
    const payload = payloadOf<IssuePayload>(card);
    return {
      id: card.id,
      title: card.title,
      meta: payload.origin === "radar" ? "雷达 · 需要尽快判断" : `${scopeName(payload.location)} · ${payload.origin === "dri" ? "提请" : "待判断"}`,
      tone: "red",
      href: `/issues/${card.objectRef.id}`,
    };
  });

  const groups: RailGroup[] = [
    { kind: "decisions", ...RAIL.decisions, subtitle: missionRounds.length ? "月度目标与任务卡" : "月度协商", items: [...monthly, ...missionRounds] },
    { kind: "meetings", ...RAIL.meetings, subtitle: meetingSubtitle, items: meetingItems },
    { kind: "research", ...RAIL.research, subtitle: researchSubtitle.length ? <>{researchSubtitle}</> : "", items: researchItems },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** 通知栏顶部：左边一颗功能键（CEO 是配置，成员是退出登录），右边天枢胶囊与时钟。 */
export function RailClock({ lead, onHome, homeActive }: { lead: ReactNode; onHome?: () => void; homeActive: boolean }) {
  const [now, setNow] = useState<Date | null>(null);
  // 按分钟边界跳，回到前台时重新对齐（clark 同）。
  useEffect(() => {
    let timer: number;
    const update = () => {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(update, 60_000 - (current.getTime() % 60_000) + 20);
    };
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      update();
    };
    timer = window.setTimeout(update, 0);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  const parts = now ? clock(now) : null;
  return (
    <header className={n.railClock} data-testid="notification-clock">
      <span className={n.railLock}>{lead}</span>
      <HeroButton
        variant="ghost"
        size="sm"
        data-ts-layout="true"
        type="button"
        className={n.homeCapsule}
        onPress={onHome}
        aria-label="天枢，返回首页"
        aria-current={homeActive ? "page" : undefined}
      >
        <TianshuMark className={n.clockLogo} />
        <span className={n.railDate}>
          <span>{parts?.day}</span>
          <span className={n.railWeekday}>{parts?.weekday}</span>
        </span>
        <time dateTime={now?.toISOString()}>{parts?.time}</time>
      </HeroButton>
    </header>
  );
}

/** 通知栏（clark 同一套分组玻璃卡）。点通知直接打开对象，来源卡片长成工作区。 */
export function NotificationRail({
  cards,
  onNavigate,
  onHome,
  homeActive = true,
  currentHref,
  account,
  viewerId,
}: {
  cards: Card[];
  onNavigate: (href: string, origin?: Element | null) => void;
  /** 左下角自己的名字：个人菜单。 */
  account?: Account;
  viewerId?: string;
  onHome?: () => void;
  homeActive?: boolean;
  /** 当前打开的对象（高亮所在分组与那一行）。 */
  currentHref?: string;
}) {
  const router = useRouter();
  const groups = railGroups(cards, new Date(), viewerId);
  const rail = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, number>());
  const weeklyReviews = useWeeklyReviewBoard();
  const layoutKey = groups.map((group) => `${group.kind}:${group.items.length}`).join("|");

  // 同成员工作台同步其他拍板人的变更；倒计时本身由分组与卡页共享分钟时钟。会前预审在跑时 5 秒一次，预审一出结果左栏就换上结论。
  const refreshEvery = railRefreshInterval(cards);
  useEffect(() => {
    if (!refreshEvery) return;
    const refresh = () => { if (document.visibilityState === "visible") router.refresh(); };
    const timer = window.setInterval(refresh, refreshEvery);
    window.addEventListener("focus", refresh);
    window.addEventListener("meeting-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("meeting-changed", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [refreshEvery, router]);
  const refreshRound = useCallback(() => router.refresh(), [router]);
  // 分组出现 / 消失时，其余卡片从旧位置滑到新位置（FLIP，clark 同）。
  useLayoutEffect(() => {
    if (!rail.current || rail.current.offsetParent === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rail.current.querySelectorAll<HTMLElement>("[data-notice]").forEach((node) => {
      const key = node.dataset.notice!;
      const top = node.offsetTop;
      const previous = positions.current.get(key);
      if (!reduced && previous !== undefined && Math.abs(previous - top) > 1) {
        node.animate([{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }], { duration: 420, easing: "cubic-bezier(.22,1,.36,1)" });
      }
      positions.current.set(key, top);
    });
  }, [layoutKey]);

  return (
    <aside className={n.rail} ref={rail} tabIndex={-1} aria-label="通知与日程">
      <RailClock
        onHome={() => onHome?.()}
        homeActive={homeActive}
        lead={
          <HeroButton variant="ghost" size="sm" isIconOnly type="button" onPress={() => void logout()} aria-label="退出登录" title="退出登录">
            <Lock aria-hidden="true" />
          </HeroButton>
        }
      />
      <div className={n.noticeList}>
        <CycleCountdown />
        <MeetingCardNotices meetingBase="/meetings" onNavigate={onNavigate} />
        <WeeklyReviewBoard onNavigate={onNavigate} state={weeklyReviews} />
        <PersonalReviewBoard onNavigate={onNavigate} />
        <RequestNotices base="/requests" currentHref={currentHref} onNavigate={onNavigate} />
        <MonthlyReviewNotices onNavigate={onNavigate} ceo />
        {groups.map((group) => {
          const current = group.items.some((item) => item.href === currentHref || (item.missionRound && payloadOf<TMissionRoundSummary>(item.missionRound).cards.some((row) => `/mission-cards/${row.cardId}` === currentHref?.split("?")[0])));
          return (
            <HeroCard<"section">
              render={(props) => <section {...props} />}
              key={group.kind}
              className={n.card}
              data-notice={group.kind}
              data-current={current || undefined}
              aria-label={group.title}
            >
              <ReferenceButton corner cards={cards.filter((card) => group.items.some((item) => item.id === card.id))} title={group.title} />
              <HeroCard.Header<"header"> render={(props) => <header {...props} />} className={n.glassHeader}>
                <ContextMark kind={group.mark} className={n.glyph} />
                <span className={n.identity}>
                  <strong>
                    {group.title}
                    <b className={n.count} aria-label={`${group.items.length} 项通知`}>
                      {group.items.length}
                    </b>
                  </strong>
                  {group.subtitle ? <small>{group.subtitle}</small> : null}
                </span>
              </HeroCard.Header>
              <div className={n.tray}>
                {group.items.map((item) => item.missionRound ? (
                  <MissionCardNoticeGroup key={item.id} round={payloadOf<TMissionRoundSummary>(item.missionRound)} entry="ceo" embedded currentHref={currentHref} onNavigate={onNavigate} onRefresh={refreshRound} />
                ) : (
                  <RailItemFrame key={item.id} item={item} onNavigate={onNavigate}>{(pick, busy) => <>
                  <HeroButton
                    variant="ghost"
                    size="sm"
                    data-ts-layout="true"
                    type="button"
                    className={n.item}
                    data-tone={item.tone}
                    data-origin={item.href}
                    aria-current={item.href === currentHref ? "true" : undefined}
                    aria-label={`${item.title}，${item.meta}`}
                    onPress={(event) => onNavigate(item.href, (event.target as Element).closest("[data-notice]"))}
                  >
                    <span className={n.mark} aria-hidden="true" />
                    <span className={n.itemText}>
                      <span>{item.title}</span>
                      <small>{item.meta}</small>
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </HeroButton>
                  {item.followUp ? <div className={n.meetingFollowUp}>
                    {item.canReschedule ? <button type="button" onClick={(event) => onNavigate(`${item.href}?meetingAction=reschedule`, event.currentTarget)}>重新安排</button> : null}
                    <button type="button" disabled={busy} onClick={pick}>{busy ? "上传中…" : "上传"}</button>
                  </div> : null}
                  </>}</RailItemFrame>
                ))}
              </div>
            </HeroCard>
          );
        })}
      </div>
      {account ? (
        <div className={n.railFoot}>
          <AccountMenu account={account} onNavigate={(href) => onNavigate(href)} />
        </div>
      ) : null}
    </aside>
  );
}

/** 通知栏一行：开完待交记录的会整行能拖文件上传（MeetingRecordDrop）；其余照旧。 */
function RailItemFrame({ item, onNavigate, children }: { item: RailItem; onNavigate: (href: string, from?: Element | null) => void; children: (pick: () => void, busy: boolean) => ReactNode }) {
  if (!item.followUp || !item.meetingId) return <div>{children(() => undefined, false)}</div>;
  return <MeetingRecordDrop meetingId={item.meetingId} title={item.title} href={item.href} onNavigate={onNavigate} className={n.meetingDrop} errorClassName={n.meetingDropError}>
    {children}
  </MeetingRecordDrop>;
}
