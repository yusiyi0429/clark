"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CalendarDays, Lock, ChevronRight, X } from "lucide-react";
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

const KIND_COPY: Record<NoticeKind, { scope: string; kindLabel: string; glyph: string }> = {
  urgent: { scope: "雷达", kindLabel: "需要尽快判断", glyph: "急" },
  inquiry: { scope: "天枢", kindLabel: "负责人提请", glyph: "请" },
  agenda: { scope: "天枢", kindLabel: "会议安排", glyph: "会" },
  monthly: { scope: "天枢", kindLabel: "月度协商", glyph: "月" },
};

function issueScope(location: IssuePayload["location"]): string {
  if (location.level === "battlefield") return location.battlefieldId;
  if (location.level === "capability") return location.capabilityId;
  return "公司";
}

function clock(date: Date): { time: string; weekday: string; day: string } {
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
  return { time: `${get("hour")}:${get("minute")}`, weekday: get("weekday"), day: `${get("month")}${get("day")}` };
}

/** 通知栏：真实 Card 投影 + 浮卡打开/关闭的焦点与 Escape 行为。 */
export function NotificationRail({ cards, onNavigate }: { cards: Card[]; onNavigate: (href: string) => void }) {
  const [now, setNow] = useState<Date | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
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

  const urgent = notices.filter((notice) => notice.kind === "urgent");
  const rest = notices.filter((notice) => notice.kind !== "urgent");
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
          <button type="button" aria-label="已登录 CEO 会话">
            <Lock aria-hidden="true" />
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

      <div className={n.noticeList} data-obscured={open ? "true" : undefined}>
        {ordered.map((notice) => {
          const tone = notice.kind === "urgent" ? "inquiry" : notice.kind;
          return (
            <section
              key={notice.id}
              className={`${n.card} ${n[tone]}`}
              data-notice={notice.kind}
              data-attention={notice.kind === "urgent" ? "urgent" : undefined}
              role="button"
              tabIndex={0}
              aria-label={`查看${notice.title}`}
              aria-haspopup="dialog"
              aria-expanded={openId === notice.id}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
                openNotice(notice, event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openNotice(notice, event.currentTarget);
                }
              }}
            >
              <header className={n.notificationGlassHeader}>
                <span className={n.notificationGlyph} aria-hidden="true">
                  <span className={n.notificationGlyphMark}>{KIND_COPY[notice.kind].glyph}</span>
                </span>
                <span className={n.notificationIdentity}>
                  <strong>天枢 · {notice.scope}</strong>
                  <small>{notice.kindLabel}</small>
                </span>
                <time>{notice.time}</time>
              </header>
              {tone === "agenda" ? (
                <div className={n.agenda}>
                  <span className={n.meeting}>
                    <span className={n.meetingMark} aria-hidden="true" />
                    <span>
                      <strong>{notice.title}</strong>
                      <time>{notice.time}</time>
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </span>
                </div>
              ) : (
                <div className={`${n.notificationBody} ${tone === "monthly" ? n.monthlyBody : n.inquiryBody}`}>
                  <div className={n.inquiryHead}>
                    <span className={n.inquiryMeta}>
                      <strong>{notice.title}</strong>
                      <time>{notice.time}</time>
                    </span>
                    <span className={n.inquiryText}>{notice.body}</span>
                    {notice.reason ? <span className={n.urgentReason}>{notice.reason}</span> : null}
                  </div>
                </div>
              )}
            </section>
          );
        })}
        {ordered.length === 0 ? <p className={n.railFoot}>本周没有待处理通知。</p> : null}
      </div>

      {open ? (
        <div className={n.noticeOverlay}>
          <button type="button" className={n.overlayBackdrop} aria-label="关闭通知浮卡" onClick={closeNotice} />
          <section
            className={`${n.floatingCard} ${n.card} ${n[open.kind === "urgent" ? "inquiry" : open.kind]}`}
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
              <div className={n.inquiryHead}>
                <span className={n.inquiryMeta}>
                  <strong>{open.title}</strong>
                  <time>{open.time}</time>
                </span>
                <span className={n.inquiryText}>{open.body}</span>
                {open.reason ? <span className={n.inquiryReason}>{open.reason}</span> : null}
              </div>
            </div>
            <div className={n.actions}>
              <button
                type="button"
                onClick={() => {
                  closeNotice();
                  onNavigate(open.href);
                }}
              >
                {open.kind === "agenda" ? <CalendarDays size={14} aria-hidden="true" /> : null}
                {open.cta}
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
              <button type="button" onClick={closeNotice}>
                <ChevronRight size={14} aria-hidden="true" />
                稍后处理
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
