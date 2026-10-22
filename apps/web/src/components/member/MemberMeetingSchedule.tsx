import type { components } from "@/lib/api/schema";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import { MeetingRecordDrop } from "@/components/meeting/MeetingRecordDrop";
import s from "@/styles/member-meeting-schedule.module.css";

type Item = components["schemas"]["MemberMeetingsResponse"]["meetings"][number];
const day = (iso: string) => new Date(iso).toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE, month: "numeric", day: "numeric", weekday: "short" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** 会议安排：开完待交记录的会，整张卡能拖文件进来上传，也能点「上传」选文件（MeetingRecordDrop）。 */
export function MemberMeetingSchedule({ meetings, onNavigate }: { meetings: Item[]; onNavigate: (href: string, from?: Element | null) => void }) {
  if (!meetings.length) return null;
  return <section className={s.card} aria-label="会议安排"><header><strong>会议安排</strong><span>{meetings.length} 场</span></header>
    {meetings.map((meeting) => {
      const open = <button type="button" onClick={(event) => onNavigate(meeting.href, event.currentTarget)}>
        <i aria-hidden /><span><strong>{meeting.title}</strong><small>{day(meeting.startsAt)} · {clock(meeting.startsAt)}–{meeting.endsAt ? clock(meeting.endsAt) : "待定"}</small><small>{meeting.hostName} 主持</small></span>
      </button>;
      if (!meeting.followUp) return <div key={meeting.meetingId}>{open}</div>;
      return <MeetingRecordDrop key={meeting.meetingId} meetingId={meeting.meetingId} title={meeting.title} href={meeting.href} onNavigate={onNavigate}
        className={s.drop} errorClassName={s.error}>
        {(pick, busy) => <>{open}<div className={s.followUp}><small>待交记录</small><div>
          <button type="button" onClick={(event) => onNavigate(`${meeting.href}?meetingAction=reschedule`, event.currentTarget)}>重新安排</button>
          <button type="button" disabled={busy} onClick={pick}>{busy ? "上传中…" : "上传"}</button>
        </div></div></>}
      </MeetingRecordDrop>;
    })}
  </section>;
}
