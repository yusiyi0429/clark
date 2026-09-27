import type { components } from "@/lib/api/schema";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import s from "@/styles/member-meeting-schedule.module.css";

type Item = components["schemas"]["MemberMeetingsResponse"]["meetings"][number];
const day = (iso: string) => new Date(iso).toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE, month: "numeric", day: "numeric", weekday: "short" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function MemberMeetingSchedule({ meetings, onNavigate }: { meetings: Item[]; onNavigate: (href: string, from?: Element | null) => void }) {
  if (!meetings.length) return null;
  return <section className={s.card} aria-label="会议安排"><header><strong>会议安排</strong><span>{meetings.length} 场</span></header>
    {meetings.map((meeting) => <button type="button" key={meeting.meetingId} onClick={(event) => onNavigate(meeting.href, event.currentTarget)}>
      <i aria-hidden /><span><strong>{meeting.title}</strong><small>{day(meeting.startsAt)} · {clock(meeting.startsAt)}–{meeting.endsAt ? clock(meeting.endsAt) : "待定"}</small><small>{meeting.hostName} 主持</small></span>
    </button>)}
  </section>;
}
