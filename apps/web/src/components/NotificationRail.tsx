"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { TMissionRoundDraftPayload, TMissionRoundSummary } from "@warmap/contracts";
import { Card as HeroCard } from "@heroui/react";
import { ChevronRight, Lock } from "lucide-react";
import { AccountMenu, type Account } from "./AccountMenu";
import { logout } from "@/lib/logout";
import type { Card } from "@/lib/api/client";
import { payloadOf, type BattlefieldPayload, type CapabilityPayload, type IssuePayload, type MeetingPayload, type MonthlyPlanPayload } from "@/cards/payloads";
import { ContextMark, type ContextMarkKind } from "./ContextMark";
import { HeroButton } from "./HeroButton";
import { ReferenceButton } from "@/conversation/references";
import { StrategicConfirmCard, pendingStrategicItems } from "./StrategicConfirmCard";
import { TianshuMark } from "./TianshuMark";
import { useConfirm } from "./ConfirmDialog";
import { ActionFeedback, useCardAction } from "@/lib/useCardAction";
import { COMPANY_TIMEZONE, monthDayTime } from "@/lib/companyTime";
import { MissionCardNoticeGroup } from "./missionCards/MissionCardNoticeGroup";
import n from "@/styles/notifications.module.css";

type RailKind = "decisions" | "meetings" | "research";
type Tone = "red" | "amber" | "neutral";
type RailItem = { id: string; title: string; meta: string; tone: Tone; href: string; missionRound?: Card };
type RailGroup = { kind: RailKind; title: string; subtitle: string; mark: ContextMarkKind; items: RailItem[] };

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

function missionRoundMeta(payload: TMissionRoundSummary | TMissionRoundDraftPayload): string {
  if (!("phase" in payload)) return "可以整理个人卡草稿";
  if (payload.phase === "draft") return "草稿 · 可以统一开放讨论";
  if (payload.phase === "open" && payload.closesAt) {
    const minutes = Math.max(0, Math.ceil((Date.parse(payload.closesAt) - Date.parse(payload.serverNow)) / 60_000));
    return minutes ? `讨论中 · ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : "已截止 · 汇总中";
  }
  if (payload.phase === "reviewing") return payload.counts.pending ? `${payload.counts.pending} 条待你处理` : "意见已全部处理，待你确认";
  if (payload.phase === "confirmed") return payload.todo ?? "已确定";
  return "已截止 · 汇总中";
}

/**
 * 把首页 Card 集合整理成三组通知（clark `notifications.tsx` 的分组与顺序）。
 * 只收需要行动的：未签发的月度计划、已排期会议、红色待决议题（v0.3 §645）；打开不会让条目消失（C-05）。
 */
export function railGroups(cards: Card[], now: Date = new Date()): RailGroup[] {
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
    const payload = payloadOf<TMissionRoundSummary | TMissionRoundDraftPayload>(card);
    // 确认后退出；拍板人还有更正申请待处理时服务端才会把它放回来，待办写在 todo（GAP-04）。
    if ("phase" in payload && payload.phase === "confirmed" && !payload.todo) return [];
    const firstCard = "cards" in payload ? payload.cards[0] : null;
    return [{ id: card.id, title: card.title, meta: missionRoundMeta(payload), tone: "amber", href: firstCard ? `/mission-cards/${firstCard.cardId}` : "/", missionRound: card }];
  });

  const meetings = cards
    .filter((card) => card.kind === "meeting" && payloadOf<MeetingPayload>(card).status === "scheduled")
    .sort((a, b) => payloadOf<MeetingPayload>(a).scheduledAt.localeCompare(payloadOf<MeetingPayload>(b).scheduledAt));
  const meetingItems = meetings.map<RailItem>((card) => {
    const at = payloadOf<MeetingPayload>(card).scheduledAt;
    return {
      id: card.id,
      title: card.title,
      meta: sameCompanyDay(new Date(at), now) ? clock(new Date(at)).time : monthDayTime(at),
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
  const meetingSubtitle = allToday ? `今天${lead ? ` · ${lead}主持` : ""}` : `${meetings.length} 场待开`;

  const urgent = cards.filter((card) => card.kind === "issue" && card.urgency === "red");
  const origins = new Set(urgent.map((card) => payloadOf<IssuePayload>(card).origin));
  const researchSubtitle = [origins.has("radar") ? "Co-Agent 提请" : "", origins.has("dri") ? "负责人提请" : "", origins.has("ceo") ? "待你判断" : ""]
    .filter(Boolean)
    .join(" · ");
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
    { kind: "decisions", ...RAIL.decisions, subtitle: missionRounds.length ? "月度目标与个人卡" : "月度协商", items: [...monthly, ...missionRounds] },
    { kind: "meetings", ...RAIL.meetings, subtitle: meetingSubtitle, items: meetingItems },
    { kind: "research", ...RAIL.research, subtitle: researchSubtitle, items: researchItems },
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
  onCard,
  account,
}: {
  cards: Card[];
  onNavigate: (href: string, origin?: Element | null) => void;
  /** 在通知栏卡上办完的动作（战略议题确认）返回的新 Card。 */
  onCard?: (card: Card) => void;
  /** 左下角自己的名字：个人菜单。 */
  account?: Account;
  onHome?: () => void;
  homeActive?: boolean;
  /** 当前打开的对象（高亮所在分组与那一行）。 */
  currentHref?: string;
}) {
  const router = useRouter();
  const { ask, dialog } = useConfirm();
  const [notice, setNotice] = useState("");
  const action = useCardAction((updated) => {
    onCard?.(updated);
    router.refresh();
  }, "/api/mission-rounds/actions/execute");
  const groups = railGroups(cards);
  const rail = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, number>());
  const strategic = pendingStrategicItems(cards).length;
  const layoutKey = [`strategic:${strategic}`, ...groups.map((group) => `${group.kind}:${group.items.length}`)].join("|");

  // 同成员工作台同步其他拍板人的变更；倒计时本身由分组与卡页共享分钟时钟。
  const needsRoundRefresh = cards.some((card) => {
    if (card.kind !== "mission-round") return false;
    const payload = payloadOf<TMissionRoundSummary>(card);
    return payload.phase !== "confirmed" || Boolean(payload.todo);
  });
  useEffect(() => {
    if (!needsRoundRefresh) return;
    const refresh = () => { if (document.visibilityState === "visible") router.refresh(); };
    const timer = window.setInterval(refresh, 20_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [needsRoundRefresh, router]);
  const refreshRound = useCallback(() => router.refresh(), [router]);
  const requestedDraft = useRef<string | null>(null);

  async function openItem(item: RailItem, origin: Element | null) {
    if (!item.missionRound) {
      onNavigate(item.href, origin);
      return;
    }
    const draft = item.missionRound.actions.find((descriptor) => descriptor.actionType === "mission-round.draft");
    if (!draft) {
      if (item.href !== "/") onNavigate(item.href, origin);
      else setNotice("这一轮暂无可打开的个人卡。");
      return;
    }
    setNotice("");
    action.reset();
    if (!await ask("草稿是占位：Agent 起草未接入，由 9 月个人卡生成，待大家讨论修改。整理草稿不会确认个人承诺，也不会开放讨论。", "整理个人卡草稿")) return;
    const saved = await action.run(draft);
    if (saved) {
      const firstCard = payloadOf<TMissionRoundSummary>(saved).cards[0];
      if (firstCard) onNavigate(`/mission-cards/${firstCard.cardId}`, origin);
      else setNotice("草稿已整理，这一轮暂无可打开的个人卡。");
    }
  }

  // 引导的下一件事定位真实 slot，只打开原有确认框；整理仍由用户明确按下。
  useEffect(() => {
    const slot = new URLSearchParams(window.location.search).get("missionRoundDraft");
    if (!slot || requestedDraft.current === slot) return;
    const item = groups.flatMap((group) => group.items).find((item) => item.missionRound?.objectRef.type === "mission-round-slot" && item.missionRound.objectRef.id === slot);
    if (!item) return;
    requestedDraft.current = slot;
    void openItem(item, null);
  });

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
        {onCard ? <StrategicConfirmCard cards={cards} onCard={onCard} onNavigate={onNavigate} /> : null}
        {groups.map((group) => {
          const current = group.items.some((item) => item.href === currentHref || (item.missionRound && "cards" in payloadOf<TMissionRoundSummary | TMissionRoundDraftPayload>(item.missionRound) && payloadOf<TMissionRoundSummary>(item.missionRound).cards.some((row) => `/mission-cards/${row.cardId}` === currentHref?.split("?")[0])));
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
                {group.items.map((item) => item.missionRound && "phase" in payloadOf<TMissionRoundSummary | TMissionRoundDraftPayload>(item.missionRound) ? (
                  <MissionCardNoticeGroup key={item.id} round={payloadOf<TMissionRoundSummary>(item.missionRound)} entry="ceo" embedded currentHref={currentHref} onNavigate={onNavigate} onRefresh={refreshRound} />
                ) : (
                  <HeroButton
                    key={item.id}
                    variant="ghost"
                    size="sm"
                    data-ts-layout="true"
                    type="button"
                    className={n.item}
                    data-tone={item.tone}
                    data-origin={item.href}
                    aria-current={item.href === currentHref ? "true" : undefined}
                    aria-label={`${item.title}，${item.meta}`}
                    isDisabled={Boolean(item.missionRound) && action.pending}
                    onPress={(event) => void openItem(item, (event.target as Element).closest("[data-notice]"))}
                  >
                    <span className={n.mark} aria-hidden="true" />
                    <span className={n.itemText}>
                      <span>{item.title}</span>
                      <small>{item.meta}</small>
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </HeroButton>
                ))}
                {group.kind === "decisions" ? <>
                  {action.pending ? <p role="status">正在整理个人卡草稿…</p> : null}
                  {notice ? <p role="status">{notice}</p> : null}
                  <ActionFeedback state={action.state} onRetry={action.retry} label="整理个人卡草稿" />
                </> : null}
              </div>
            </HeroCard>
          );
        })}
      </div>
      {dialog}
      {account ? (
        <div className={n.railFoot}>
          <AccountMenu account={account} onNavigate={(href) => onNavigate(href)} />
        </div>
      ) : null}
    </aside>
  );
}
