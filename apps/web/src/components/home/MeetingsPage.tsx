"use client";

/**
 * 会议页 /me/work/meetings（11/16 重新设计第 5 节）：正文 680 一列，上下两区，结构不一样。
 * - 接下来：时间从近到远、按天分组；行首钟点一栏，当天一条竖线贯穿；标题 600。7 天以后的收在最后一行「7 天后 N」。
 * - 已开完：最近开完的在上；钟点栏空着，状态点骑在竖线的位置上（待处理 --warning、转写中转圈、有记录打勾、其余淡点）；标题 400。
 * 一场会只在一个区、一个位置；待处理不另起一区、不置顶。没有「来源与详情」折叠，来源在会议详情页看。
 * 只在飞书日历里、天枢没有会议页的日程，行尾一个 ArrowUpRight 开飞书。
 */
import { useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { MeetingBookingSheet } from "@/components/meeting/MeetingBookingSheet";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { calendarDate, clock, COMPANY_TIMEZONE } from "@/lib/companyTime";
import { meetingEnd } from "@/lib/home/focus";
import { EARLY_MS } from "@/lib/home/meeting";
import { usePartnerMeetings, type PartnerMeeting } from "@/lib/home/partnerMeetingFeed";
import { MeetingControl, type HomeMeeting } from "./MeetingControl";
import { OrganizeMinute, ReadError, RecordText, external, follow, tokenOf } from "./PartnerMeetings";
import { useViewChrome } from "./view";
import h from "@/styles/home.module.css";
import s from "./partner-meetings.module.css";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type MeetingDay = { day: string; label: string; items: PartnerMeeting[] };

/** 「今天」「明天」，其余「11月18日 周三」（公司时区）。 */
function dayLabel(day: string, now: number): string {
  if (day === calendarDate(new Date(now).toISOString())) return "今天";
  if (day === calendarDate(new Date(now + DAY_MS).toISOString())) return "明天";
  const date = new Date(`${day}T12:00:00+08:00`);
  const weekday = date.toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE, weekday: "short" });
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${weekday}`;
}

/** 还要开的（预约了没到结束、正在开）是「接下来」，7 天以后的另放；其余都是「已开完」。 */
export function meetingSections(items: PartnerMeeting[], now: number): { upcoming: MeetingDay[]; later: PartnerMeeting[]; done: PartnerMeeting[] } {
  const boundary = calendarDate(new Date(now + WEEK_MS).toISOString());
  const days = new Map<string, PartnerMeeting[]>();
  const later: PartnerMeeting[] = [];
  const done: PartnerMeeting[] = [];
  for (const item of items) {
    const active = item.stage === "live" || (item.stage === "scheduled" && now < meetingEnd(item));
    if (!active) { done.push(item); continue; }
    const day = calendarDate(item.at);
    if (day > boundary) { if (item.meetingId) later.push(item); continue; }
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  const ascending = (a: PartnerMeeting, b: PartnerMeeting) => Date.parse(a.at) - Date.parse(b.at);
  return {
    upcoming: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({ day, label: dayLabel(day, now), items: list.sort(ascending) })),
    later: later.sort(ascending),
    done: done.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  };
}

/**
 * 左栏「会议」行行尾（设计第 3 节）：下一场还没进「等你」的会。今天的写「14:30」，明天写「明天 09:30」，更远写「11/18」；没有为 null。
 * focusIds 是「等你」里会议行的 id（PartnerMeeting.id），同一场不在两处写。
 */
export function nextMeetingTrail(sections: ReturnType<typeof meetingSections>, focusIds: ReadonlySet<string>, now: number): string | null {
  const next = [...sections.upcoming.flatMap((day) => day.items), ...sections.later].find((item) => !focusIds.has(item.id));
  if (!next) return null;
  const day = calendarDate(next.at);
  const at = next.allDay ? "全天" : clock(new Date(next.at));
  if (day === calendarDate(new Date(now).toISOString())) return at;
  if (day === calendarDate(new Date(now + DAY_MS).toISOString())) return `明天 ${at}`;
  const [, month, date] = day.split("-");
  return `${month}/${date}`;
}

/** 已开完那一行的时间：今天写「今天 11:41」，别的「11/13 00:59」。 */
function doneTime(item: PartnerMeeting, now: number): string {
  const at = new Date(item.at);
  if (calendarDate(item.at) === calendarDate(new Date(now).toISOString())) return `今天 ${clock(at)}`;
  const [, month, day] = calendarDate(item.at).split("-");
  return `${month}/${day} ${clock(at)}`;
}

export function MeetingsPage({ meeting, go }: { meeting: HomeMeeting; go: (href: string) => void }) {
  const { items, error, loaded, reload } = usePartnerMeetings();
  const { lead, trail } = useViewChrome();
  const [booking, setBooking] = useState(false);
  const now = Date.now();
  const { upcoming, later, done } = meetingSections(items, now);
  const viewer = meeting.account;
  const count = upcoming.reduce((sum, day) => sum + day.items.length, 0);
  return (
    <div className={h.homeView} data-testid="meetings-page">
      <header className={h.viewHead}>
        {lead}
        <h1 className={h.viewTitle} tabIndex={-1}>会议</h1>
        <div className={s.actions}>
          <MeetingControl meeting={meeting} inline />
          {viewer.personId ? <HeroButton variant="tertiary" size="sm" onPress={() => setBooking(true)}>预约会议</HeroButton> : null}
        </div>
        {trail}
      </header>
      <div className={h.homeScroll}>
        <div className={h.homeInner} aria-busy={loaded ? undefined : true}>
          {error ? <ReadError message={error} retry={reload} /> : null}
          <section aria-label="接下来" className={h.section}>
            <p className={h.sectionTitle}>接下来 <span>{count}</span></p>
            {upcoming.map((day) => (
              <div key={day.day} className={s.day}>
                <p className={s.dayLabel}>{day.label}</p>
                <ul className={s.timeline}>{day.items.map((item) => <UpcomingRow key={item.id} item={item} now={now} go={go} meeting={meeting} />)}</ul>
              </div>
            ))}
            {loaded && !error && !count ? <p className={h.waitEmpty}>没有要开的会</p> : null}
            {later.length ? (
              <details className={s.later}>
                <summary>7 天后 <span>{later.length}</span></summary>
                <ul className={s.timeline}>{later.map((item) => <UpcomingRow key={item.id} item={item} now={now} go={go} meeting={meeting} />)}</ul>
              </details>
            ) : null}
          </section>
          <section aria-label="已开完" className={h.section}>
            <p className={h.sectionTitle}>已开完 <span>{done.length}</span></p>
            {done.length ? <ul className={s.timeline}>{done.map((item) => <DoneRow key={item.id} item={item} now={now} go={go} />)}</ul>
              : loaded && !error ? <p className={h.waitEmpty}>近 7 天没有开过会</p> : null}
          </section>
        </div>
      </div>
      {booking && viewer.personId ? <MeetingBookingSheet open viewer={{ ...viewer, personId: viewer.personId }} onClose={() => setBooking(false)} /> : null}
    </div>
  );
}

/** 标题：天枢的会点进会议页；只在飞书日历里的不跳转。 */
function Title({ item, go }: { item: PartnerMeeting; go: (href: string) => void }) {
  return item.meetingId
    ? <a className={s.lineTitle} href={item.href} onClick={(event) => follow(event, item.href, go)}>{item.title}</a>
    : <span className={s.lineTitle}>{item.title}</span>;
}

function FeishuOnly({ item }: { item: PartnerMeeting }) {
  return !item.meetingId && external(item.sourceUrl)
    ? <a className={s.out} href={item.sourceUrl!} target="_blank" rel="noopener noreferrer" aria-label="在飞书打开"><ArrowUpRight size={16} aria-hidden /></a>
    : null;
}

function UpcomingRow({ item, now, go, meeting }: { item: PartnerMeeting; now: number; go: (href: string) => void; meeting: Pick<HomeMeeting, "start"> }) {
  const live = item.stage === "live";
  const end = clock(new Date(meetingEnd(item)));
  const due = live || now >= Date.parse(item.at) - EARLY_MS;
  const meta = item.allDay ? item.statusText
    : [live ? `进行中 · 到 ${end}` : `到 ${end} · ${item.statusText}`, item.preflightText || null].filter(Boolean).join(" · ");
  return (
    <li className={s.line} data-row="upcoming" data-stage={item.stage}>
      <span className={s.clock}>{live ? <i className={s.liveDot} aria-label="进行中" /> : item.allDay ? "全天" : clock(new Date(item.at))}</span>
      <span className={s.lineBody}>
        <Title item={item} go={go} />
        <span className={s.lineMeta}>{meta}</span>
      </span>
      <span className={s.lineActs}>
        {due && external(item.joinUrl) ? <HeroButton variant="tertiary" size="sm" onPress={() => window.open(item.joinUrl!, "_blank", "noopener,noreferrer")}>加入会议</HeroButton>
          : due && item.canStartRecording && item.meetingId ? <HeroButton variant="tertiary" size="sm" onPress={() => void meeting.start({ meetingId: item.meetingId!, title: item.title })}>开始录音</HeroButton>
          : null}
        <FeishuOnly item={item} />
      </span>
    </li>
  );
}

function DoneRow({ item, now, go }: { item: PartnerMeeting; now: number; go: (href: string) => void }) {
  const { navigate } = useWorkspace();
  const [opened, setOpened] = useState(false);
  const [organize, setOrganize] = useState(false);
  const unmatched = item.stage === "unmatched";
  const record = item.sources?.find((source) => source.recordHref) ?? (item.recordHref ? { recordHref: item.recordHref, sourceUrl: item.sourceUrl ?? null } : null);
  const tone = item.needsAction ? "attention" : item.stage === "processing" ? "processing" : item.stage === "ready" ? "ready" : "quiet";
  return (
    <li className={s.line} data-row="done" data-stage={item.stage}>
      <span className={s.clock}><i className={s.mark} data-tone={tone} aria-hidden>{tone === "ready" ? <Check size={12} /> : null}</i></span>
      <span className={s.lineBody}>
        <Title item={item} go={go} />
        <span className={s.lineMeta}>{doneTime(item, now)} · <span data-tone={item.stage === "attention" ? "danger" : undefined}>{item.statusText}</span></span>
      </span>
      <span className={s.lineActs}>
        {unmatched ? <HeroButton variant="ghost" size="sm" aria-expanded={organize} onPress={() => setOrganize(!organize)}>整理妙记</HeroButton>
          : record && !item.needsAction ? <HeroButton variant="ghost" size="sm" aria-expanded={opened} onPress={() => setOpened(!opened)}>查看记录</HeroButton>
          : null}
        <FeishuOnly item={item} />
      </span>
      {opened && record ? <div className={s.lineDetail}><RecordText href={record.recordHref} sourceUrl={record.sourceUrl ?? null} /></div> : null}
      {organize && unmatched ? <div className={s.lineDetail}><OrganizeMinute token={tokenOf(item)} navigate={navigate} /></div> : null}
    </li>
  );
}
