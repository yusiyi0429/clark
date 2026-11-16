"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { HeroButton } from "@/components/HeroButton";
import { MeetingBookingSheet } from "@/components/meeting/MeetingBookingSheet";
import { attachFeishuMinute } from "@/components/meeting/meetingDecisionApi";
import { Select } from "@/components/ui/Select";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { calendarDate, COMPANY_TIMEZONE } from "@/lib/companyTime";
import { meetingHref, meetingSpan } from "@/lib/home/meeting";
import { usePartnerMeetings, type PartnerMeeting } from "@/lib/home/partnerMeetingFeed";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import type { HomeMeeting } from "./MeetingControl";
import h from "@/styles/home.module.css";
import s from "./partner-meetings.module.css";

export { PartnerMeetingsProvider } from "@/lib/home/partnerMeetingFeed";

export const tokenOf = (item: PartnerMeeting) => item.id.slice("feishu-minute:".length);
const active = (item: PartnerMeeting) => item.stage === "scheduled" || item.stage === "live";
export const external = (href: string | null | undefined) => Boolean(href && /^https?:\/\//i.test(href));
const internal = (href: string) => href.startsWith("/") && !href.startsWith("//");
type Navigate = (href: string) => void;

export function follow(event: MouseEvent, href: string, navigate: Navigate) {
  if (internal(href) && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    navigate(href);
  }
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

/**
 * 「等你」里的一场会（设计 4.7）：快开始的第二行「会议 · 11:44–12:44」，行尾「加入会议」（有入会地址）或「开始录音」（本人能在这台电脑录）；
 * 开完要处理的第二行「会议 · 今天 11:41 · 状态」，整行点进会议页，不放按钮。时间位由调用方算好传进来。
 */
export function FocusMeetingRow({ item, when, time, go, meeting }: {
  item: PartnerMeeting; when: "soon" | "after"; time: ReactNode; go: Navigate; meeting: Pick<HomeMeeting, "start">;
}) {
  const span = meetingSpan(item.at, item.endsAt ?? null);
  return (
    <li className={h.wait} data-kind="meeting" data-when={when}>
      {/* 只在飞书日历里的会（没有会议页，href 是飞书）：新标签页开，不把新首页和正在录的会换走。 */}
      <a className={h.waitMain} href={item.href} {...(external(item.href) ? { target: "_blank", rel: "noopener noreferrer" } : { onClick: (event: MouseEvent) => follow(event, item.href, go) })}>
        <span className={h.waitTitle}>{item.title}</span>
        <span className={h.waitSource}>
          <span className={h.waitFrom}>{when === "soon" ? `会议 · ${span}` : `会议 · ${meetingTime(item, Date.now())}`}</span>
          {when === "after" ? <><span aria-hidden>·</span><span className={h.waitFrom} data-tone={item.stage === "attention" ? "danger" : undefined}>{item.statusText}</span></> : null}
        </span>
      </a>
      {time}
      <span className={h.waitActs}>
        {when === "soon" && item.joinUrl ? (
          <HeroButton variant="tertiary" size="sm" onPress={() => window.open(item.joinUrl!, "_blank", "noopener,noreferrer")}>加入会议</HeroButton>
        ) : when === "soon" && item.canStartRecording && item.meetingId ? (
          <HeroButton variant="tertiary" size="sm" onPress={() => void meeting.start({ meetingId: item.meetingId!, title: item.title })}>开始录音</HeroButton>
        ) : null}
      </span>
    </li>
  );
}

/** 时间是会议本身的时间；预约独立展示，不伪装成伙伴已经收到的事件。 */
export function usePartnerMeetingFeed(): { blocks: TimedBlock[]; notice: ReactNode; scheduled: ReactNode } {
  const { items, error, reload } = usePartnerMeetings();
  const appointments = items.filter((item) => item.stage === "scheduled").sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    blocks: items.filter((item) => item.stage !== "scheduled").map((item) => ({
      key: "partner-meeting:" + item.id,
      at: item.at,
      node: <MeetingRows items={[item]} inbox timeline />,
    })),
    notice: error ? <ReadError message={error} retry={reload} /> : null,
    scheduled: appointments.length ? <details className={s.later}>
      <summary>会议安排 <span>{appointments.length}</span></summary>
      <MeetingRows items={appointments} inbox />
    </details> : null,
  };
}

/** 兼容原收件入口；主会话可直接合并 blocks，复用同一个会议 provider。 */
export function PartnerMeetingInbox() {
  const { blocks, notice, scheduled } = usePartnerMeetingFeed();
  if (!blocks.length && !notice && !scheduled) return null;
  return <section aria-label="会议收件" className={s.inbox}>
    <h2 className={h.sectionTitle}>会议收件</h2>
    {notice}
    {scheduled}
    {blocks.map((block) => <div key={block.key} data-block={block.key}>{block.node}</div>)}
  </section>;
}

export function ReadError({ message, retry }: { message: string; retry(): void }) {
  return <p role="alert" className={s.error}>{message}<button type="button" className={s.link} onClick={retry}>重试</button></p>;
}

function MeetingRows({ items, inbox = false, timeline = false }: { items: PartnerMeeting[]; inbox?: boolean; timeline?: boolean }) {
  const { navigate } = useWorkspace();
  return <ul className={s.rows}>
    {items.map((item) => <MeetingRow key={item.id} item={item} navigate={navigate} inbox={inbox} timeline={timeline} />)}
  </ul>;
}

function MeetingRow({ item, navigate, inbox, timeline }: { item: PartnerMeeting; navigate: Navigate; inbox: boolean; timeline: boolean }) {
  const now = Date.now();
  const unmatched = item.stage === "unmatched";
  const titleHref = item.meetingId ? item.href : unmatched ? null : external(item.sourceUrl) ? item.sourceUrl : external(item.href) ? item.href : null;
  const join = active(item) && (item.stage === "live" || !item.endsAt || Date.parse(item.endsAt) > now) && external(item.joinUrl) ? item.joinUrl : null;
  const sourceHref = external(item.sourceUrl) && item.sourceUrl !== titleHref && item.sourceUrl !== join ? item.sourceUrl : null;
  const sources = item.sources?.length ? item.sources : item.recordHref
    ? [{ label: "查看记录", recordHref: item.recordHref, sourceUrl: item.sourceUrl }] : [];
  const [opened, setOpened] = useState<string | null>(null);
  const [organize, setOrganize] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const lastLocated = useRef("");
  const anchorId = inbox && item.id.startsWith("feishu-minute:") ? "minute-" + encodeURIComponent(tokenOf(item)) : undefined;
  useEffect(() => {
    if (!anchorId) return;
    const locate = () => {
      if (location.hash.slice(1) !== anchorId) { lastLocated.current = ""; return; }
      const target = row.current;
      if (!target || lastLocated.current === anchorId) return;
      // Native details may wrap this row in the header's schedule disclosure.
      let parent = target.closest<HTMLDetailsElement>("details");
      while (parent) {
        parent.open = true;
        parent = parent.parentElement?.closest<HTMLDetailsElement>("details") ?? null;
      }
      lastLocated.current = anchorId;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    };
    locate();
    window.addEventListener("hashchange", locate);
    return () => window.removeEventListener("hashchange", locate);
  }, [anchorId]);
  const record = sources.find((source) => source.recordHref && source.recordHref === opened);
  const sourceLabel = item.source === "feishu" ? (unmatched ? "飞书妙记" : item.meetingId ? "飞书会议" : "飞书日程") : "天枢会议";
  const primary = s.link + " " + s.primary;
  const firstRecord = sources.find((source) => source.recordHref);
  const openRecord = (href: string) => setOpened(opened === href ? null : href);
  return <li ref={row} className={s.row + (timeline ? " " + s.event : "")} id={anchorId}
    tabIndex={anchorId ? -1 : undefined} data-stage={item.stage}>
    <div className={s.rowBody}>
      <div className={s.subject}>
        {titleHref && (internal(titleHref) || external(titleHref)) ? <a className={s.title} href={titleHref}
          target={external(titleHref) ? "_blank" : undefined} rel={external(titleHref) ? "noopener noreferrer" : undefined}
          onClick={(event) => follow(event, titleHref, navigate)}>{item.title}</a> : <strong className={s.title}>{item.title}</strong>}
        <p className={s.meta}>会议时间 · <time dateTime={item.at}>{meetingTime(item, now)}</time></p>
        <p className={s.status} data-needs-action={item.needsAction || undefined}>{item.statusText}</p>
      </div>
      <div className={s.actions}>
        {join ? <a className={primary} href={join} target="_blank" rel="noopener noreferrer">加入会议</a>
          : unmatched ? <button type="button" className={primary} aria-expanded={organize} onClick={() => setOrganize(!organize)}>整理妙记</button>
          : item.meetingId && item.needsAction ? <a className={primary} href={item.href} onClick={(event) => follow(event, item.href, navigate)}>处理会议事项</a>
          : firstRecord ? <button type="button" className={primary} aria-expanded={opened === firstRecord.recordHref} onClick={() => openRecord(firstRecord.recordHref)}>查看记录</button>
          : item.meetingId ? <a className={primary} href={item.href} onClick={(event) => follow(event, item.href, navigate)}>打开会议</a>
          : titleHref ? <a className={primary} href={titleHref} target="_blank" rel="noopener noreferrer">查看日程</a> : null}
      </div>
    </div>
    <details className={s.sources}>
      <summary>来源与详情</summary>
      <div className={s.sourceBody}>
        <p className={s.meta}>{sourceLabel}</p>
        {item.preflightText && item.meetingId ? <a className={s.preflight} href={item.href} onClick={(event) => follow(event, item.href, navigate)}>{item.preflightText}</a> : null}
        <div className={s.actions}>
          {sources.map((source) => source.recordHref ? <button type="button" key={source.recordHref} className={s.link}
            aria-expanded={opened === source.recordHref} onClick={() => openRecord(source.recordHref)}>
            {sources.length === 1 ? "查看记录" : source.label}
          </button> : null)}
          {sourceHref ? <a className={s.link} href={sourceHref} target="_blank" rel="noopener noreferrer">打开来源</a> : null}
        </div>
      </div>
    </details>
    {record?.recordHref ? <RecordText key={record.recordHref} href={record.recordHref} sourceUrl={record.sourceUrl ?? null} /> : null}
    {organize && unmatched ? <OrganizeMinute token={tokenOf(item)} navigate={navigate} /> : null}
  </li>;
}

export function RecordText({ href, sourceUrl }: { href: string; sourceUrl: string | null }) {
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

export function OrganizeMinute({ token, navigate }: { token: string; navigate: Navigate }) {
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
