"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Settings, X } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { payloadOf, type IssuePayload, type MeetingPayload, type MonthlyPlanPayload } from "@/cards/payloads";
import { TianshuMark } from "./TianshuMark";
import n from "@/styles/notifications.module.css";

type NoticeKind = "urgent" | "inquiry" | "agenda" | "monthly";

type Notice = {
  id: string;
  kind: NoticeKind;
  scope: string;
  kindLabel: string;
  time: string;
  title: string;
  body: string;
  reason?: string;
  href: string;
  cta: string;
};

const KIND_COPY: Record<NoticeKind, { scope: string; kindLabel: string }> = {
  urgent: { scope: "雷达", kindLabel: "需要尽快判断" },
  inquiry: { scope: "天枢", kindLabel: "负责人提请" },
  agenda: { scope: "天枢", kindLabel: "会议安排" },
  monthly: { scope: "天枢", kindLabel: "月度协商" },
};

function issueScope(location: IssuePayload["location"]): string {
  if (location.level === "battlefield") return location.battlefieldId;
  if (location.level === "capability") return location.capabilityId;
  return "公司";
}

export function clock(date: Date): { time: string; weekday: string; day: string } {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
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

/** 通知栏：真实 Card 投影 + 浮卡打开/关闭的焦点与 Escape 行为。卡面结构按 pen 通知卡组件（Accent Bar + Head + Actions）。 */
export function NotificationRail({ cards, onNavigate }: { cards: Card[]; onNavigate: (href: string) => void }) {
  const [now, setNow] = useState<Date | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // 「稍后处理」：本次会话内把通知移出列表；刷新后重新出现（不改业务状态）。
  const [deferredIds, setDeferredIds] = useState<string[]>([]);
  const originRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const notices: Notice[] = [];
  for (const card of cards) {
    if (card.kind === "issue") {
      const payload = payloadOf<IssuePayload>(card);
      const urgent = payload.urgency.level === "red";
      notices.push({
        id: card.id,
        kind: urgent ? "urgent" : "inquiry",
        scope: urgent ? KIND_COPY.urgent.scope : issueScope(payload.location),
        kindLabel: urgent ? KIND_COPY.urgent.kindLabel : KIND_COPY.inquiry.kindLabel,
        time: payload.urgency.decisionBy ? `决定期限 ${payload.urgency.decisionBy.slice(0, 10)}` : "待判断",
        title: card.title,
        body: payload.research.doc?.summary ?? "预研尚未产出判断，可先查看当前材料。",
        reason: payload.urgency.reason,
        href: `/issues/${card.objectRef.id}`,
        cta: "查看判断与依据",
      });
    }
    if (card.kind === "meeting") {
      const payload = payloadOf<MeetingPayload>(card);
      notices.push({
        id: card.id,
        kind: "agenda",
        scope: KIND_COPY.agenda.scope,
        kindLabel: KIND_COPY.agenda.kindLabel,
        time: payload.scheduledAt.slice(0, 16).replace("T", " "),
        title: card.title,
        body: `关联 Issue ${payload.issueIds.length} 个 · ${payload.participants.map((person) => person.displayName).join("、")}`,
        href: `/meetings/${card.objectRef.id}`,
        cta: "进入会前预审",
      });
    }
    if (card.kind === "monthly-plan") {
      const payload = payloadOf<MonthlyPlanPayload>(card);
      notices.push({
        id: card.id,
        kind: "monthly",
        scope: KIND_COPY.monthly.scope,
        kindLabel: KIND_COPY.monthly.kindLabel,
        time: payload.period,
        title: `月度计划 ${payload.period}`,
        body: payload.companyOutcome,
        href: `/plans/${payload.period}`,
        cta: "进入月度计划",
      });
    }
  }

  const visible = notices.filter((notice) => !deferredIds.includes(notice.id));
  const urgent = visible.filter((notice) => notice.kind === "urgent");
  const rest = visible.filter((notice) => notice.kind !== "urgent");
  const ordered = [...urgent, ...rest].slice(0, 6);
  const open = ordered.find((notice) => notice.id === openId) ?? null;
  const time = now ? clock(now) : { time: "--:--", weekday: "", day: "" };

  function openNotice(notice: Notice, element: HTMLElement) {
    originRef.current = element;
    setOpenId(notice.id);
    requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
  }

  function closeNotice() {
    setOpenId(null);
    requestAnimationFrame(() => originRef.current?.focus({ preventScroll: true }));
  }

  function defer(id: string) {
    setOpenId((current) => (current === id ? null : current));
    setDeferredIds((current) => [...current, id]);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeNotice();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={n.rail} data-testid="notification-rail">
      <div className={n.railClock} data-testid="notification-clock">
        <span className={n.railLock}>
          <button type="button" aria-label="配置" onClick={() => onNavigate("/config")}>
            <Settings aria-hidden="true" />
          </button>
        </span>
        <span className={n.homeCapsule} aria-current="page">
          <TianshuMark className={n.clockLogo} />
          <span className={n.railDate}>
            <span>{time.day}</span>
            <span className={n.railWeekday}>{time.weekday}</span>
            <time dateTime={now?.toISOString()}>{time.time}</time>
          </span>
        </span>
      </div>

      <div className={n.noticeList}>
        {ordered.map((notice) => (
          <section key={notice.id} className={n.card} data-notice={notice.kind} aria-label={notice.title}>
            {notice.kind === "agenda" ? (
              /* pen 通知卡 · 会议：只有一行（Bar + Title/Time + Chevron），整行是打开按钮。 */
              <button
                type="button"
                className={n.meetingRow}
                aria-haspopup="dialog"
                aria-expanded={openId === notice.id}
                onClick={(event) => openNotice(notice, event.currentTarget)}
              >
                <span className={n.accentBar} aria-hidden="true" />
                <span className={n.meetingText}>
                  <strong>{notice.title}</strong>
                  <time>{notice.time}</time>
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={n.head}
                  aria-haspopup="dialog"
                  aria-expanded={openId === notice.id}
                  {...(notice.body ? { "aria-describedby": `notice-summary-${notice.id}` } : {})}
                  onClick={(event) => openNotice(notice, event.currentTarget)}
                >
                  <span className={n.accentBar} aria-hidden="true" />
                  <span className={n.headLeft}>
                    <strong className={n.headTitle}>{notice.title}</strong>
                    {notice.reason ? <span className={n.headReason}>{notice.reason}</span> : null}
                    {notice.body ? (
                      <span id={`notice-summary-${notice.id}`} className={n.cardSummary} role="tooltip">
                        {notice.body}
                      </span>
                    ) : null}
                  </span>
                  <time className={n.headTime}>{notice.time}</time>
                </button>
                {notice.kind !== "monthly" ? (
                  <div className={n.cardActions}>
                    <button type="button" className={n.cta} onClick={() => onNavigate(notice.href)}>
                      {notice.cta}
                    </button>
                    <button type="button" className={n.later} onClick={() => defer(notice.id)}>
                      稍后处理
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </section>
        ))}
        {ordered.length === 0 ? <p className={n.railFoot}>本周没有待处理通知。</p> : null}
      </div>

      {open ? (
        <div className={n.noticeOverlay}>
          <button type="button" className={n.overlayBackdrop} aria-label="关闭通知浮卡" onClick={closeNotice} />
          <section
            className={n.floatingCard}
            data-notice={open.kind}
            role="dialog"
            aria-modal="true"
            aria-label={open.title}
          >
            <header className={n.floatingHeader}>
              <span>
                天枢 · {open.scope} · {open.kindLabel}
              </span>
              <button ref={closeRef} type="button" onClick={closeNotice} aria-label="关闭通知浮卡">
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div className={n.floatingScroll}>
              <div className={n.floatingBody}>
                <span className={n.floatingMeta}>
                  <strong>{open.title}</strong>
                  <time>{open.time}</time>
                </span>
                <span className={n.floatingText}>{open.body}</span>
                {open.reason ? <span className={n.floatingReason}>{open.reason}</span> : null}
              </div>
            </div>
            <div className={n.floatingActions}>
              <button
                type="button"
                className={n.cta}
                onClick={() => {
                  closeNotice();
                  onNavigate(open.href);
                }}
              >
                {open.cta}
              </button>
              <button type="button" className={n.later} onClick={() => defer(open.id)}>
                稍后处理
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
