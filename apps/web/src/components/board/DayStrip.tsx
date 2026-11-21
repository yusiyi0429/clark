"use client";

/**
 * 今日日程条（原型 v8.4 dayStrip）：横着一条，8 点到 20 点，会和飞书日程按几点到几点画，竖线是现在，走过的部分淡一层。
 * 数据来自现有的会（/api/me/meetings）和飞书日程（/api/me/feishu-events），不加新接口；全天的不画。
 */
import { useEffect, useState } from "react";
import { browserApi } from "@/lib/api/client";
import { useFeishuEvents } from "@/components/meeting/useFeishuEvents";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import s from "@/styles/v2-month.module.css";

export type DayEvent = { id: string; title: string; startsAt: string; endsAt: string };

const H0 = 8;
const H1 = 20;
const SPAN = (H1 - H0) * 60;

/** 公司时区里的日期和当天第几分钟。 */
export function companyClock(iso: string | number | Date): { date: string; minute: number } {
  const date = new Date(iso);
  const day = date.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE });
  const [h, m] = date.toLocaleTimeString("en-GB", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":").map(Number);
  return { date: day, minute: (h ?? 0) * 60 + (m ?? 0) };
}

/** 今天的那几件，按开始时间排，压进 8–20 点。 */
export function todayEvents(events: DayEvent[], now: Date): (DayEvent & { from: number; to: number; at: string })[] {
  const today = companyClock(now).date;
  return events
    .map((event) => ({ event, start: companyClock(event.startsAt), end: companyClock(event.endsAt) }))
    .filter(({ start }) => start.date === today)
    .map(({ event, start, end }) => ({
      ...event,
      from: Math.max(H0 * 60, start.minute),
      to: Math.min(H1 * 60, end.date === today ? Math.max(end.minute, start.minute + 15) : H1 * 60),
      at: `${String(Math.floor(start.minute / 60)).padStart(2, "0")}:${String(start.minute % 60).padStart(2, "0")}`,
    }))
    .filter((event) => event.to > event.from)
    .sort((a, b) => a.from - b.from);
}

const pct = (minute: number) => `${(((minute - H0 * 60) / SPAN) * 100).toFixed(2)}%`;

export function useDayEvents(): DayEvent[] {
  const feishu = useFeishuEvents();
  const [meetings, setMeetings] = useState<DayEvent[]>([]);
  useEffect(() => {
    let alive = true;
    void browserApi.GET("/api/me/meetings").then(({ data }) => {
      if (!alive || !data) return;
      setMeetings(data.meetings.filter((meeting) => meeting.endsAt).map((meeting) => ({ id: meeting.meetingId, title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt! })));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return [...meetings, ...feishu.filter((event) => !event.allDay).map((event) => ({ id: `feishu:${event.eventId}`, title: event.title, startsAt: event.startsAt, endsAt: event.endsAt }))];
}

export function DayStrip({ events, compact = false }: { events: DayEvent[]; compact?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const list = todayEvents(events, now);
  const current = Math.min(H1 * 60, Math.max(H0 * 60, companyClock(now).minute));
  const hours = Array.from({ length: H1 - H0 - 1 }, (_, i) => H0 + 1 + i).filter((hour) => !compact || hour % 2 === 0);
  return (
    <div className={s.day} role="img" aria-label={`今天：${list.map((event) => `${event.at} ${event.title}`).join("，") || "没有安排"}`} data-testid="day-strip">
      <span className={s.dayPast} style={{ width: pct(current) }} />
      {hours.map((hour) => <span key={hour} className={s.dayHour} style={{ left: pct(hour * 60) }}>{hour}</span>)}
      {list.map((event) => (
        <span key={event.id} className={s.dayEvent} style={{ left: pct(event.from), width: `calc(${pct(event.to)} - ${pct(event.from)})` }} title={`${event.at} ${event.title}`}>
          <b>{event.at}</b><span>{event.title}</span>
        </span>
      ))}
      <span className={s.dayNow} style={{ left: pct(current) }} />
    </div>
  );
}
