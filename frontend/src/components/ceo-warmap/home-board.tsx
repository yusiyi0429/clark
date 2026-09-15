'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, Check, Clock3 } from 'lucide-react';
import { ReferenceButton } from './card-references';
import { cardReference } from '@/lib/warmap/card-reference';
import { issueReference } from './reference-model';
import { CapabilityIssues, capabilityIssueGroups } from './capability-issues';
import { decisionMeta, type DecisionRecords } from './decision-model';
import { issues, strategyIds, zones, type IssueId, type ViewId } from './model';
import { ProgressCard } from './progress-card';
import { RadarIssueRows } from './radar-feed';
import { issueLocation, type RadarState } from '@/lib/warmap/radar-types';
import type { MissionAssessment } from '@/lib/warmap/mission-progress';
import type { BattlefieldDisplay, BattlefieldMode } from './battlefield-progress';
import { meetingsForIssue } from './meeting-model';
import r from './radar.module.css';
import s from './home-board.module.css';

interface HomeBoardProps {
  onMissionAssessment: (zone: string, assessment: MissionAssessment) => void;
  radar?: RadarState;
  onRadarSignal: (id: string) => void;
  decisions: DecisionRecords;
  display: BattlefieldDisplay;
  onDisplayMode: (mode: BattlefieldMode) => void;
  onFlipZone: (zone: ViewId) => void;
  activeIssue?: IssueId | null;
  onOpenView: (view: ViewId, from?: HTMLElement) => void;
  onOpenIssue: (id: IssueId) => void;
}

const urgencyNames = { red: '需要尽快决策', yellow: '需在窗口内决策', gray: '待决策' };
const battlefieldIssues: Partial<Record<ViewId, IssueId[]>> = {
  lighthouse: ['capacity', 'voice', 'payment', 'participation'],
  tokenops: ['capacity'],
};

/** Mount after receipt restoration, so only live actions receive a visual acknowledgement. */
export function HomeBoard({ radar, onRadarSignal, onMissionAssessment, decisions, display, onDisplayMode, onFlipZone, activeIssue, onOpenView, onOpenIssue }: HomeBoardProps) {
  const [previous, setPrevious] = useState(decisions);
  const [recent, setRecent] = useState<DecisionRecords>({});
  if (previous !== decisions) {
    const changed: DecisionRecords = {};
    for (const id of Object.keys(decisions) as IssueId[]) {
      if (decisions[id] && decisions[id] !== previous[id]) changed[id] = decisions[id];
    }
    setPrevious(decisions);
    setRecent(current => ({ ...current, ...changed }));
  }
  useEffect(() => {
    if (!Object.keys(recent).length) return;
    const timer = window.setTimeout(() => setRecent({}), 1300);
    return () => window.clearTimeout(timer);
  }, [recent]);

  const visible = (id: IssueId) => !decisions[id] || !!recent[id];
  const renderIssue = (id: IssueId, instance: string) => {
    if (!visible(id)) return null;
    const meta = decisionMeta[id];
    const receipt = decisions[id] && recent[id];
    const meetings = meetingsForIssue(id);
    const meetingTimes = meetings.map(meeting => meeting.time.replaceAll(' - ', '–')).join('、');
    return <div key={id} className={`${s.issueSlot} ${receipt ? s.resolving : ''}`} data-home-issue={id} data-issue-instance={instance} data-urgency={meta.urgency}>
      {receipt ? <div className={s.receipt} role="status"><Check size={15} aria-hidden="true"/><span>{receipt.summary}</span></div> :
        <button type="button" className={s.issue} data-selected={activeIssue === id} onClick={() => onOpenIssue(id)} aria-label={`${urgencyNames[meta.urgency]}：${issues[id].title}${meetings.length ? `。会议时间 ${meetingTimes}` : ''}`}>
          <span className={`${s.dot} ${s[meta.urgency]}`} aria-hidden="true"/>
          <span className={s.issueText}>
            <span>{issues[id].title}</span>
            {meetings.length > 0 && <span className={s.meetingState}><Clock3 size={13} aria-hidden="true"/><span>{meetingTimes}</span></span>}
          </span>
          <ChevronRight size={14} className={s.issueArrow} aria-hidden="true"/>
        </button>}{!receipt&&<ReferenceButton item={issueReference(id,decisions[id])}/>}
    </div>;
  };

  return <div className={s.board} data-testid="decision-home">
    <div className={s.top}>
      <section className={`${s.panel} ${s.strategy}`} data-origin="strategy">
        <button type="button" className={s.heading} onClick={e => onOpenView('strategy', e.currentTarget)}><h2>公司战略议题</h2><ChevronRight size={16} aria-hidden="true"/></button>
        <ReferenceButton corner item={cardReference('group:strategy','公司战略议题','议题集合',[...strategyIds.filter(visible).map(id=>`${issues[id].title}\n${issues[id].judgment}`),...(radar?.signals.filter(signal=>signal.issue?.status==='pending'&&issueLocation(signal.issue.fields)==='strategy').map(signal=>`${signal.issue!.title}\n${signal.issue!.judgment}\n外部来源：${signal.url}`)||[])].join('\n\n'),'静态议题为演练材料；雷达议题来自标注的外部来源')}/>
        <div className={s.strategicIssues}>{strategyIds.map(id => renderIssue(id, 'strategy'))}</div>
        <RadarIssueRows signals={radar?.signals??[]} location="strategy" onSelect={onRadarSignal}/>
        {!strategyIds.some(visible) && !radar?.signals.some(x=>x.issue?.status==='pending'&&issueLocation(x.issue.fields)==='strategy') && <p className={s.empty}>暂无待决策议题</p>}
      </section>
      <div className={s.radarWrapper}><button type="button" className={`${r.radar} ${s.radar}`} data-origin="radar" onClick={e => onOpenView('radar', e.currentTarget)}>
        <h2>雷达信号</h2>
        <small className={s.radarStatus}>{radar?.run.status==='running'?'正在扫描':radar?.signals.filter(x=>!x.read&&!x.dismissed).length?`${radar.signals.filter(x=>!x.read&&!x.dismissed).length} 条未读`:'看看外面的变化'}</small>
        <div className={`${r.stage} ${s.scanStage}`} aria-hidden="true"><div className={r.scope}><span className={r.crosshair}/><span className={r.sweep}/><div><i className={r.echo}/><i className={r.echo}/><i className={r.echo}/></div><span className={r.center}/></div></div>
        <ChevronRight className={r.launch} size={16} aria-hidden="true"/>
      </button></div>
    </div>

    <div className={s.battlefieldToolbar} data-testid="battlefield-toolbar">
      <span>战场</span>
      <div className={s.modeSwitch} role="group" aria-label="战场展示方式" data-mode={display.mode}>
        <i aria-hidden="true"/>
        <button type="button" aria-pressed={display.mode === 'decisions'} onClick={() => onDisplayMode('decisions')}>待决策</button>
        <button type="button" aria-pressed={display.mode === 'progress'} onClick={() => onDisplayMode('progress')}>进展</button>
      </div>
    </div>
    <div className={s.battlefields}>
      {zones.map(zone => {
        const ids = battlefieldIssues[zone.id] || [];
        const direct = ids.filter(id => !decisionMeta[id].campaignId);
        return <ProgressCard className={s.battlefield} pendingIssues={[...ids.filter(id=>!decisions[id]).map(id=>`${issues[id].title}\n当前判断：${issues[id].judgment}\n紧要程度：${decisionMeta[id].urgency}\n原因：${decisionMeta[id].reason||'未标注'}\n会议安排：${meetingsForIssue(id).map(meeting=>meeting.time).join('、')||'尚未安排，继续与 Agent 沟通'}`),...(radar?.signals.filter(signal=>signal.issue?.status==='pending'&&issueLocation(signal.issue.fields)===zone.id).map(signal=>`${signal.issue!.title}\n判断：${signal.issue!.judgment}\n会议安排：尚未安排，继续与 Agent 沟通\n来源：${signal.url}`)||[])].join('\n\n')} onAssessment={onMissionAssessment} key={zone.id} zone={zone} mode={display.overrides[zone.id] ?? display.mode} urgentCount={ids.filter(id => !decisions[id] && decisionMeta[id].urgency === 'red').length} onToggle={() => onFlipZone(zone.id)} onOpen={element => onOpenView(zone.id, element)}>
          <RadarIssueRows signals={radar?.signals??[]} location={zone.id} onSelect={onRadarSignal}/>
          {direct.some(visible) && <div className={s.directIssues}>{direct.map(id => renderIssue(id, zone.id))}</div>}
          {zone.campaigns.map(campaign => {
            const campaignIds = ids.filter(id => decisionMeta[id].campaignId === campaign.id);
            if (!campaignIds.some(visible)) return null;
            return <section key={campaign.id} className={s.campaign} data-campaign={campaign.id}><div className={s.campaignHeading}><h3>{campaign.name}</h3></div>{campaignIds.map(id => renderIssue(id, zone.id))}</section>;
          })}
          {!ids.some(visible) && !radar?.signals.some(x=>x.issue?.status==='pending'&&issueLocation(x.issue.fields)===zone.id) && <p className={s.empty}>暂无待决策议题</p>}
        </ProgressCard>;
      })}
    </div>

    <section className={`${s.panel} ${s.capabilities}`} data-origin="capabilities">
      <button type="button" className={s.heading} onClick={e => onOpenView('capabilities', e.currentTarget)}><h2>公司能力</h2><ChevronRight size={16} aria-hidden="true"/></button>
      <ReferenceButton corner item={cardReference('group:capabilities','公司能力','能力建设',capabilityIssueGroups.flatMap(group=>group.issues).filter(visible).map(id=>`${issues[id].title}\n${issues[id].judgment}`).join('\n\n')||'公司能力建设议题，具体内容请引用下方议题卡片。')}/><CapabilityIssues visible={visible} renderIssue={id => renderIssue(id, 'capabilities')}/>
    </section>
    <p className={s.note}>目标与 Mission 为演练数据 · 雷达信号来自实时外部检索</p>
  </div>;
}
