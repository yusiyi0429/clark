'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { issuePreRead, issues, type IssueId } from './model';
import type { DecisionRecords, DecisionReceipt, HeavyNoticeId } from './decision-model';
import type { TodayMeeting } from './meeting-model';
import s from './meeting-workspace.module.css';

type ReadState = { read: IssueId[]; pinned: IssueId[]; requested: IssueId[] };

type MeetingWorkspaceProps = {
  meeting: TodayMeeting;
  onClose: () => void;
  onCloseStart?: () => void;
  onComplete: (id: HeavyNoticeId, summary: string) => void;
  onDecision: (receipt: DecisionReceipt) => void;
  decisions: DecisionRecords;
};

export function MeetingWorkspace(props: MeetingWorkspaceProps) {
  const { meeting, onClose, onCloseStart } = props;
  const [closing,setClosing]=useState(false);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  const close=()=>{if(closing)return;setClosing(true);onCloseStart?.();timer.current=setTimeout(onClose,window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:240);};
  const [readState, setReadState] = useState<ReadState>({ read: [], pinned: [], requested: [] });
  const meetingIssues = meeting.issueIds.map((id) => issues[id]);

  const toggle = (field: keyof ReadState, id: IssueId) => setReadState((previous) => ({
    ...previous,
    [field]: previous[field].includes(id)
      ? previous[field].filter((value) => value !== id)
      : [...previous[field], id],
  }));

  return (
    <section className={s.workspace} role="dialog" aria-modal="false" aria-labelledby="meeting-workspace-title" data-meeting-workspace data-stage="brief" data-closing={closing}>
      <header className={s.header}>
        <div><span>{meeting.time} · 会前阅读</span><h1 id="meeting-workspace-title">{meeting.title}</h1></div>
        <div className={s.headerMeta}><span>主责 DRI · {meeting.leadDri}</span><span>{meeting.participants.length} 人参会</span></div>
        <button type="button" onClick={close} aria-label="关闭会议空间"><X size={19} /></button>
      </header>

      <div className={s.split}>
      <div className={s.materialPane} data-testid="meeting-materials">
        <div className={s.brief}>
          <div className={s.briefLead}>
            <div><small>这场会为什么存在</small><p>{meeting.summary}</p></div>
            <div><small>CEO 的会前位置</small><p>先看清问题，不在材料页表态。会议的开启、录音和会后核对由本场主责 DRI 负责。</p></div>
          </div>
          <div className={s.issueList}>
            {meetingIssues.map((issue) => {
              const preRead = issuePreRead[issue.id];
              const read = readState.read.includes(issue.id);
              const pinned = readState.pinned.includes(issue.id);
              const requested = readState.requested.includes(issue.id);
              return (
                <article key={issue.id} className={s.issueCard} data-read={read}>
                  <div className={s.issueTop}><div><small>{issue.scope}</small><h2>{issue.title}</h2></div><span>{preRead.readMinutes} 分钟 · {preRead.reversibility}</span></div>
                  <div className={s.orientation}><div><small>为什么现在</small><p>{preRead.whyNow}</p></div><div><small>判断窗口</small><p>{preRead.decisionWindow}</p></div></div>
                  <div className={s.judgment}><small>DRI 当前判断 · {preRead.dri}</small><p>{issue.judgment}</p></div>
                  <div className={s.issueBottom}><span>关联 · {preRead.missionRefs.join(' / ')}</span><span>上次阅读后 · {preRead.changed.join('；')}</span></div>
                  <div className={s.briefActions}>
                    <button type="button" aria-pressed={read} onClick={() => toggle('read', issue.id)}>{read ? <Check size={14} /> : null}{read ? '已阅' : '阅'}</button>
                    <button type="button" aria-pressed={requested} onClick={() => toggle('requested', issue.id)}>{requested ? '已请补充' : '请补充'}</button>
                    <button type="button" aria-pressed={pinned} onClick={() => toggle('pinned', issue.id)}>{pinned ? '已带到会议' : '带到会议'}</button>
                  </div>
                </article>
              );
            })}
          </div>
          <footer className={s.briefFooter}>
            <div><strong>{readState.read.length} / {meeting.issueIds.length}</strong><span>已建立阅读位置，不是流程完成率</span></div>
          </footer>
        </div>
      </div>
      </div>
    </section>
  );
}
