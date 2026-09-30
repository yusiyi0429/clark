import type { components } from "@/lib/api/schema";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import s from "@/styles/member-meeting-schedule.module.css";

type Item = components["schemas"]["MemberMeetingsResponse"]["meetings"][number];
const day = (iso: string) => new Date(iso).toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE, month: "numeric", day: "numeric", weekday: "short" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function MemberMeetingSchedule({ meetings, onNavigate }: { meetings: Item[]; onNavigate: (href: string, from?: Element | null) => void }) {
  if (!meetings.length) return null;
  return <section className={s.card} aria-label="会议安排"><header><strong>会议安排</strong><span>{meetings.length} 场</span></header>
    {meetings.map((meeting) => <div key={meeting.meetingId}>
    <button type="button" onClick={(event) => onNavigate(meeting.href, event.currentTarget)}>
      <i aria-hidden /><span><strong>{meeting.title}</strong><small>{day(meeting.startsAt)} · {clock(meeting.startsAt)}–{meeting.endsAt ? clock(meeting.endsAt) : "待定"}</small><small>{meeting.hostName} 主持</small></span>
    </button>
    {meeting.followUp ? <div className={s.followUp}><small>会议已结束，待你提交记录或重新安排</small><div>
      <button type="button" onClick={(event) => onNavigate(`${meeting.href}?meetingAction=reschedule`, event.currentTarget)}>重新安排</button>
      <button type="button" onClick={(event) => onNavigate(`${meeting.href}?meetingAction=transcript`, event.currentTarget)}>上传文字纪要</button>
    </div></div> : null}
    </div>)}
  </section>;
}
