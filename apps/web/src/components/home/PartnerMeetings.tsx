"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { HeroButton } from "@/components/HeroButton";
import { MeetingBookingSheet } from "@/components/meeting/MeetingBookingSheet";
import { attachFeishuMinute } from "@/components/meeting/meetingDecisionApi";
import { Select } from "@/components/ui/Select";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { calendarDate, COMPANY_TIMEZONE } from "@/lib/companyTime";
import { meetingHref } from "@/lib/home/meeting";
import { usePartnerMeetings, type PartnerMeeting } from "@/lib/home/partnerMeetingFeed";
import type { WaitingItem } from "@/lib/home/types";
import { MeetingControl, type HomeMeeting } from "./MeetingControl";
import h from "@/styles/home.module.css";
import s from "./partner-meetings.module.css";

export { PartnerMeetingsProvider } from "@/lib/home/partnerMeetingFeed";

const WEEK = 7 * 86_400_000;
const tokenOf = (item: PartnerMeeting) => item.id.slice("feishu-minute:".length);
const active = (item: PartnerMeeting) => item.stage === "scheduled" || item.stage === "live";
const external = (href: string | null | undefined) => Boolean(href && /^https?:\/\//i.test(href));
const internal = (href: string) => href.startsWith("/") && !href.startsWith("//");
type Navigate = (href: string) => void;

function follow(event: MouseEvent, href: string, navigate: Navigate) {
  if (internal(href) && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    navigate(href);
  }
}

/** 展示按公司日历的今天起七天。更早只留还需要跟进的场次；归档的可从伙伴收件再读。 */
export function homeMeetingGroups(items: PartnerMeeting[], now: number) {
  const today = calendarDate(new Date(now).toISOString());
  const boundary = calendarDate(new Date(now + WEEK).toISOString());
  const current: PartnerMeeting[] = [];
  const later: PartnerMeeting[] = [];
  for (const item of items) {
    const day = calendarDate(item.at);
    if (item.stage === "scheduled" && day > boundary) {
      if (item.meetingId) later.push(item);
    } else if (day >= today || item.needsAction || item.stage === "live" || item.stage === "processing" || item.stage === "unmatched") {
      current.push(item);
    }
  }
  const byTime = (a: PartnerMeeting, b: PartnerMeeting) => Date.parse(a.at) - Date.parse(b.at);
  return { current: current.sort(byTime), later: later.sort(byTime) };
}

export function meetingWaitingItems(items: PartnerMeeting[], waiting: WaitingItem[]) {
  const shown = new Set(waiting.flatMap(({ open }) => open.kind === "meeting" ? [open.id] : []));
  return items.filter((item) => item.needsAction && !(item.meetingId && shown.has(item.meetingId)));
}

function meetingTime(item: PartnerMeeting, now: number) {
  const at = new Date(item.at);
  const day = calendarDate(item.at);
  const today = calendarDate(new Date(now).toISOString());
  const tomorrow = calendarDate(new Date(now + 86_400_000).toISOString());
  const label = day === today ? "今天" : day === tomorrow ? "明天" : at.toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE, month: "numeric", day: "numeric" });
  const clock = at.toLocaleTimeString("zh-CN", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return label + " " + (item.allDay ? "全天" : clock);
}

export function MeetingWaitingRows({ items, go }: { items: PartnerMeeting[]; go: Navigate }) {
  return <ul className={h.waiting}>{items.map((item) => (
    <li key={item.id} className={h.wait} data-kind="meeting">
      <a className={h.waitMain} href={item.href} onClick={(event) => follow(event, item.href, go)}>
        <span className={h.waitTitle}>{item.title}</span><span className={h.waitSource}>{item.statusText}</span>
      </a>
    </li>
  ))}</ul>;
}

export function PartnerHomeMeetings({ meeting }: { meeting: HomeMeeting }) {
  const { items, error, reload } = usePartnerMeetings();
  const [booking, setBooking] = useState(false);
  const { current, later } = homeMeetingGroups(items, Date.now());
  const viewer = meeting.account;
  return <section aria-label="会议" className={h.section}>
    <div className={s.heading}>
      <h2 className={h.sectionTitle}>会议</h2>
      <div className={s.actions}>
        <MeetingControl meeting={meeting} inline />
        {viewer.personId ? <HeroButton variant="ghost" size="sm" onPress={() => setBooking(true)}>预约会议</HeroButton> : null}
      </div>
    </div>
    {error ? <ReadError message={error} retry={reload} /> : null}
    {current.length ? <MeetingRows items={current} /> : null}
    {later.length ? <details className={s.later}>
      <summary>后续预约 <span>{later.length}</span></summary>
      <MeetingRows items={later} />
    </details> : null}
    {booking && viewer.personId ? <MeetingBookingSheet open viewer={{ ...viewer, personId: viewer.personId }} onClose={() => setBooking(false)} /> : null}
  </section>;
}

/** 同一个 item 保留自己的行和原会议入口，从预约、入会更新到正文。 */
export function PartnerMeetingInbox() {
  const { items, error, reload } = usePartnerMeetings();
  const section = useRef<HTMLElement>(null);
  const lastLocated = useRef("");
  useEffect(() => {
    const locate = () => {
      const hash = location.hash;
      if (!hash.startsWith("#minute-")) { lastLocated.current = ""; return; }
      if (lastLocated.current === hash) return;
      const target = document.getElementById(hash.slice(1));
      if (!target || !section.current?.contains(target)) return;
      lastLocated.current = hash;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    };
    locate();
    window.addEventListener("hashchange", locate);
    return () => window.removeEventListener("hashchange", locate);
  }, [items]);
  if (!items.length && !error) return null;
  return <section ref={section} aria-label="会议收件" className={s.inbox}>
    <h2 className={h.sectionTitle}>会议收件</h2>
    {error ? <ReadError message={error} retry={reload} /> : null}
    <MeetingRows items={items} inbox />
  </section>;
}

function ReadError({ message, retry }: { message: string; retry(): void }) {
  return <p role="alert" className={s.error}>{message}<button type="button" className={s.link} onClick={retry}>重试</button></p>;
}

function MeetingRows({ items, inbox = false }: { items: PartnerMeeting[]; inbox?: boolean }) {
  const { navigate } = useWorkspace();
  return <ul className={s.rows}>
    {items.map((item) => <MeetingRow key={item.id} item={item} navigate={navigate} inbox={inbox} />)}
  </ul>;
}

function MeetingRow({ item, navigate, inbox }: { item: PartnerMeeting; navigate: Navigate; inbox: boolean }) {
  const now = Date.now();
  const unmatched = item.stage === "unmatched";
  const titleHref = item.meetingId ? item.href : unmatched ? null : external(item.sourceUrl) ? item.sourceUrl : external(item.href) ? item.href : null;
  const join = active(item) && (item.stage === "live" || !item.endsAt || Date.parse(item.endsAt) > now) && external(item.joinUrl) ? item.joinUrl : null;
  const sourceHref = external(item.sourceUrl) && item.sourceUrl !== titleHref && item.sourceUrl !== join ? item.sourceUrl : null;
  const sources = item.sources?.length ? item.sources : item.recordHref
    ? [{ label: "查看记录", recordHref: item.recordHref, sourceUrl: item.sourceUrl }] : [];
  const [opened, setOpened] = useState<string | null>(null);
  const [organize, setOrganize] = useState(false);
  const record = sources.find((source) => source.recordHref && source.recordHref === opened);
  const sourceLabel = item.source === "feishu" ? (unmatched ? "飞书妙记" : item.meetingId ? "飞书会议" : "飞书日程") : "天枢会议";
  return <li className={s.row} id={unmatched && inbox ? "minute-" + encodeURIComponent(tokenOf(item)) : undefined}
    tabIndex={unmatched && inbox ? -1 : undefined} data-stage={item.stage}>
    <div className={s.rowBody}>
      <div className={s.subject}>
        {titleHref && (internal(titleHref) || external(titleHref)) ? <a className={s.title} href={titleHref}
          target={external(titleHref) ? "_blank" : undefined} rel={external(titleHref) ? "noopener noreferrer" : undefined}
          onClick={(event) => follow(event, titleHref, navigate)}>{item.title}</a> : <strong className={s.title}>{item.title}</strong>}
        <p className={s.meta}><time dateTime={item.at}>{meetingTime(item, now)}</time><span> · {sourceLabel}{item.statusText === sourceLabel ? "" : " · " + item.statusText}</span></p>
        {item.preflightText && item.meetingId ? <a className={s.preflight} href={item.href} onClick={(event) => follow(event, item.href, navigate)}>{item.preflightText}</a> : null}
      </div>
      <div className={s.actions}>
        {join ? <a className={s.link} href={join} target="_blank" rel="noopener noreferrer">加入会议</a> : null}
        {sources.map((source) => source.recordHref ? <button type="button" key={source.recordHref} className={s.link}
          aria-expanded={opened === source.recordHref} onClick={() => setOpened(opened === source.recordHref ? null : source.recordHref)}>
          {sources.length === 1 ? "查看记录" : source.label}
        </button> : null)}
        {sourceHref && (!sources.length || !unmatched) ? <a className={s.link} href={sourceHref} target="_blank" rel="noopener noreferrer">打开来源</a> : null}
        {unmatched ? <button type="button" className={s.link} aria-expanded={organize} onClick={() => setOrganize(!organize)}>整理妙记</button> : null}
      </div>
    </div>
    {record?.recordHref ? <RecordText key={record.recordHref} href={record.recordHref} sourceUrl={record.sourceUrl ?? null} /> : null}
    {organize && unmatched ? <OrganizeMinute token={tokenOf(item)} navigate={navigate} /> : null}
  </li>;
}

function RecordText({ href, sourceUrl }: { href: string; sourceUrl: string | null }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError("");
    async function read() {
      try {
        const response = await fetch(href, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          if (response.status === 403 || response.status === 404) throw new Error("这份记录已不可读");
          throw new Error("没有读到会议记录");
        }
        const result: components["schemas"]["PartnerMeetingRecordResponse"] = await response.json();
        if (!result.text.trim()) throw new Error("记录正文还未就绪");
        if (!controller.signal.aborted) setText(result.text);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "没有读到会议记录");
      }
    }
    void read();
    return () => controller.abort();
  }, [href, attempt]);
  return <div className={s.detail} aria-label="会议记录">
    {error ? <ReadError message={error} retry={() => setAttempt(attempt + 1)} /> : text === null ? <span role="status">正在读取记录…</span>
      : <div className={s.transcript} tabIndex={0} role="region" aria-label="记录正文">{text}</div>}
    {sourceUrl && external(sourceUrl) ? <a className={s.link} href={sourceUrl} target="_blank" rel="noopener noreferrer">打开原文</a> : null}
  </div>;
}

type Minute = components["schemas"]["FeishuMinuteInboxResponse"]["minutes"][number];
const attachErrors: Record<string, string> = { MINUTE_TAKEN: "已经记入另一场会议", MINUTE_NOT_PENDING: "妙记已经处理过了", SUGGESTION_CHANGED: "候选场次已更新，请重新选择" };

function OrganizeMinute({ token, navigate }: { token: string; navigate: Navigate }) {
  const { reload } = usePartnerMeetings();
  const [minute, setMinute] = useState<Minute | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [booking, setBooking] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setChoice("");
    setMinute(null);
    async function read() {
      try {
        const { response, data } = await browserApi.GET("/api/me/feishu-minutes", { signal: controller.signal, cache: "no-store" });
        if (controller.signal.aborted) return;
        if (!response.ok || !data) throw new Error("没有读到待整理的妙记");
        const current = data.minutes.find((entry) => entry.minuteToken === token);
        if (!current) { reload(); throw new Error("已处理或无权整理这份妙记"); }
        setMinute(current);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "没有读到待整理的妙记");
      }
    }
    void read();
    return () => controller.abort();
  }, [token, attempt, reload]);
  const choices = minute?.suggestions ?? (minute?.suggestion ? [minute.suggestion] : []);
  async function attach() {
    if (!choice || busy) return;
    setBusy(true);
    try {
      const result = await attachFeishuMinute(token, choice);
      if ("code" in result) throw new Error(attachErrors[result.code] ?? "归入会议失败");
      window.dispatchEvent(new Event("meeting-changed"));
      navigate(meetingHref(result.meetingId));
    } catch (cause) {
      setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "归入会议失败");
    } finally { setBusy(false); }
  }
  if (error) return <ReadError message={error} retry={() => setAttempt(attempt + 1)} />;
  if (!minute) return <p className={s.detail} role="status">正在读取可归入的会议…</p>;
  return <div className={s.detail}>
    {choices.length ? <div className={s.organize}>
      <Select aria-label="归入哪场会议" placeholder="选择已有会议" value={choice} disabled={busy}
        options={choices.map((entry) => ({ value: entry.meetingId, label: entry.title }))} onChange={setChoice} />
      <HeroButton size="sm" variant="tertiary" isDisabled={busy || !choice} onPress={() => void attach()}>归入所选会议</HeroButton>
    </div> : null}
    <button type="button" className={s.link} disabled={busy} onClick={() => setBooking(true)}>整理为新会议</button>
    {booking ? <MeetingBookingSheet open organize={{ minute, meetingBase: "/me/work/meetings", onOrganized: reload }} onClose={() => setBooking(false)} /> : null}
  </div>;
}
