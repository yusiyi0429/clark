'use client';

import { ArrowUpRight, Check, Clock3 } from 'lucide-react';
import { LockScreenButton } from '@/components/log-out-button';
import { TianshuMark } from '@/components/brand/tianshu-mark';
import { todayMeetings } from './meeting-model';
import { zones } from './model';
import type { HeavyNoticeId } from './decision-model';
import s from './fold-material-desk.module.css';

export function FoldMaterialDesk({
  completions,
  onOpen,
}: {
  completions: Partial<Record<HeavyNoticeId, string>>;
  onOpen: (id: HeavyNoticeId) => void;
}) {
  return (
    <section className={s.desk} aria-label="双屏会前阅读桌面">
      <header className={s.header}>
        <div className={s.brand}><TianshuMark/><span>天枢</span></div>
        <div className={s.intro}><small>双屏 · 阅读模式</small><h1>今天需要读完的材料</h1></div>
        <LockScreenButton className={s.lock}/>
      </header>

      <div className={s.spread}>
        <section className={s.meetingPage} aria-labelledby="fold-meetings-title">
          <div className={s.pageHeading}><div><span>01</span><h2 id="fold-meetings-title">会前材料</h2></div><small>{todayMeetings.length} 场会议</small></div>
          <div className={s.meetingList}>
            {todayMeetings.map((meeting, index) => {
              const completion = completions[meeting.reviewId];
              return <button key={meeting.id} type="button" className={s.meeting} onClick={() => onOpen(meeting.reviewId)}>
                <span className={s.timeline}><i/><b>{index + 1}</b></span>
                <span className={s.meetingBody}>
                  <span className={s.time}><Clock3 size={13}/>{meeting.time}</span>
                  <strong>{meeting.title}</strong>
                  <p>{meeting.summary}</p>
                  <small>{completion ? <><Check size={13}/>{completion}</> : <>预计阅读 {meeting.issueIds.length + 2} 分钟 · {meeting.issueIds.length} 项议题</>}</small>
                </span>
                <ArrowUpRight size={17} className={s.openIcon}/>
              </button>;
            })}
          </div>
        </section>

        <section className={s.missionPage} aria-labelledby="fold-missions-title">
          <div className={s.pageHeading}><div><span>02</span><h2 id="fold-missions-title">本月 Outcome / Mission</h2></div><small>9 月协商稿</small></div>
          <button type="button" className={s.monthlyLead} onClick={() => onOpen('monthly')}>
            <span><small>公司级 Outcome</small><strong>验证持续使用，以及从共识到负责人行动的闭环</strong></span>
            <ArrowUpRight size={18}/>
          </button>
          <div className={s.missionList}>
            {zones.map((zone, index) => <article key={zone.id}>
              <span className={s.zoneIndex}>0{index + 1}</span>
              <div><h3>{zone.name}</h3><p>{zone.monthly}</p><small>六个月方向 · {zone.ltco}</small></div>
            </article>)}
          </div>
          <button type="button" className={s.readMonthly} onClick={() => onOpen('monthly')}>打开完整月度协商稿 <ArrowUpRight size={15}/></button>
        </section>
      </div>
      <p className={s.hint}>继续展开第三屏，将回到公司全局战场；材料的确认与会议记录仍由原工作区承接。</p>
    </section>
  );
}
