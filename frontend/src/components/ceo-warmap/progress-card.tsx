'use client';

import { ReferenceButton } from './card-references';
import { cardReference } from '@/lib/warmap/card-reference';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowLeftRight, ChevronRight } from 'lucide-react';
import { battlefieldProgress, type BattlefieldMode } from './battlefield-progress';
import type { Zone } from './model';
import useSWR from 'swr';
import { missionSnapshots, type MissionAssessment } from '@/lib/warmap/mission-progress';
import s from './progress-card.module.css';

export function ProgressCard({ zone, pendingIssues, mode, urgentCount, onToggle, onOpen, onAssessment, children, className }: {
  zone: Zone; pendingIssues: string; mode: BattlefieldMode; urgentCount: number;
  onToggle: () => void; onOpen: (element: HTMLElement) => void; children: ReactNode;
  onAssessment: (zone: string, assessment: MissionAssessment) => void;
  className?: string;
}) {
  const flipped = mode === 'progress';
  const root = useRef<HTMLElement>(null);
  const frontButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const progress = battlefieldProgress[zone.id];
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceId = useId();
  const ringGradientId = useId();
  const snapshot = missionSnapshots[zone.id];
  const completed = snapshot?.missions.filter(m=>m.completed).length ?? 0;
  const total = snapshot?.missions.length ?? 0;
  const {data:assessment,error:assessmentError,mutate:retryAssessment} = useSWR<MissionAssessment>(flipped&&snapshot?`mission-progress-${zone.id}`:null,async()=>{const r=await fetch('/api/warmap-progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({zone:zone.id})});if(!r.ok)throw new Error('评估暂不可用');return r.json();},{revalidateOnFocus:false,shouldRetryOnError:false,dedupingInterval:60000});
  useEffect(()=>{if(assessment)onAssessment(zone.id,assessment);},[assessment,zone.id,onAssessment]);
  useLayoutEffect(() => {
    const active = document.activeElement;
    // Keep focus on the corresponding control, never on the now inert face.
    if (active instanceof HTMLElement && root.current?.contains(active)) {
      (flipped ? backButton : frontButton).current?.focus({ preventScroll: true });
    }
  }, [flipped]);

  const reference=cardReference(`zone:${zone.id}`,zone.name,'战场',`负责人：${zone.owner}\n六个月目标：${zone.ltco}\n本月目标：${zone.monthly}\n当前局面：${zone.position}\n待决策事项：${pendingIssues||'无'}\n战役：${zone.campaigns.map(c=>`${c.name}：${c.focus}；最近成果：${c.achieved}`).join('\n')}\n本月 Mission：${completed}/${total} 已完成\n${assessment?`Agent调整后完成度：${assessment.percent}%\n评估依据：${assessment.rationale}\n评估于：${assessment.assessedAt}`:'Agent完成度尚未评估'}\n${snapshot?.missions.map(m=>`${m.title}：${m.completed?'已完成':'未完成'}；${m.feedback}`).join('\n')||''}\n六个月进度：衡量口径尚未确认，不代表零进度。\n${progress?`按期判断：${progress.outlook}\n阻碍：${progress.blocker}\n反馈依据：${progress.evidence.join('\n')}`:''}`);
  return <article ref={root} className={`${s.frame} ${className ?? ''}`} data-origin={zone.id} data-testid={`zone-${zone.id}`} data-mode={mode}>
    <div className={s.rotor} data-flipped={flipped}>
      <div className={`${s.face} ${s.front}`} inert={flipped} aria-hidden={flipped}>
        <header className={s.header}>
          <button type="button" className={s.title} onClick={e => onOpen(e.currentTarget)}><h2>{zone.name}</h2><ChevronRight size={14}/></button>
          <ReferenceButton item={reference}/><button type="button" ref={frontButton} className={s.flip} onClick={onToggle} aria-label={`查看${zone.name}进展`} title="查看进展"><ArrowLeftRight size={15}/><span>进展</span></button>
        </header>
        {children}
      </div>
      <div className={`${s.face} ${s.back}`} inert={!flipped} aria-hidden={!flipped}>
        <div className={s.atmosphere} aria-hidden="true"><span/><span/></div>
        <header className={s.header}>
          <h2>{zone.name}</h2>
          <ReferenceButton item={reference}/><button type="button" ref={backButton} className={s.flip} onClick={onToggle} aria-label={`返回${zone.name}待决策`}><ArrowLeft size={14}/><span>待决策</span>{urgentCount > 0 && <span className={s.urgent} aria-label={`${urgentCount} 条紧急议题`}>{urgentCount}</span>}</button>
        </header>
        {progress ? <>
          <div className={s.charts}>
            <div className={s.chart}>
              <span className={s.chartEyebrow}>六个月目标</span>
              <div className={s.ring} role="img" aria-label="六个月目标进展待评估：衡量口径尚未确认，不表示零进度。" data-long-term-progress="unassessed">
                <svg viewBox="0 0 160 160" aria-hidden="true">
                  <defs><linearGradient id={ringGradientId} x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop offset="0%" stopColor="#8aaed4"/><stop offset="48%" stopColor="#c5d5eb"/><stop offset="100%" stopColor="#9ca9d0"/></linearGradient></defs>
                  <circle cx="80" cy="80" r="62" fill="none" strokeWidth="13" className={s.arcPending}/>
                  <g className={s.ambientRing}><circle cx="80" cy="80" r="62" fill="none" strokeWidth="13" stroke={`url(#${ringGradientId})`}/></g>
                </svg>
                <div className={s.ringCenter}><strong className={s.unassessed}>待评估</strong><span>衡量口径待确认</span></div>
              </div>
              <strong className={s.chartTitle}>{progress.longLabel}</strong>
              <span className={s.chartNote}>{progress.deadline}</span>
            </div>
            <div className={s.chart}>
              <span className={s.chartEyebrow}>{progress.month}进展</span>
              <div className={s.ring} role="progressbar" aria-label={`${zone.name}本月加权完成度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={assessment?.percent} aria-valuetext={assessment?`Agent 评估 ${assessment.percent}%，已完成 ${completed}/${total} 个 Mission`:'Agent 尚未完成评估'}>
                <svg viewBox="0 0 160 160" aria-hidden="true">
                  <circle cx="80" cy="80" r="62" fill="none" strokeWidth="13" className={s.arcPending}/>
                  {!!assessment?.percent && <circle cx="80" cy="80" r="62" fill="none" strokeWidth="13" pathLength="100" strokeDasharray={`${assessment.percent} 100`} strokeLinecap="round" transform="rotate(-90 80 80)" className={s.arcDone}/>}
                </svg>
                <div className={s.ringCenter}><strong className={assessment?s.ringValue:s.unassessed}>{assessment?<>{assessment.percent}<small>%</small></>:assessmentError?'待评估':'评估中'}</strong><span>{completed}/{total} 已完成</span></div>
              </div>
              <strong className={s.chartTitle}>{progress.monthLabel}</strong>
              <span className={s.chartNote}>Agent 按难度与结果贡献评估</span>
            </div>
          </div>
          <div className={s.evidence} data-open={evidenceOpen} onKeyDown={e => { if (e.key === 'Escape' && evidenceOpen) { e.preventDefault(); e.stopPropagation(); setEvidenceOpen(false); } }}>
            <button type="button" data-progress-evidence aria-expanded={evidenceOpen} aria-controls={evidenceId} onClick={() => setEvidenceOpen(previous => !previous)}>反馈与依据<span title="上一次进度反馈收集时间（当前为示例数据）">上次收集：{progress.collectedAt}</span></button>
            <div id={evidenceId} inert={!evidenceOpen} aria-hidden={!evidenceOpen}><p><b>{progress.deadline}</b> · {progress.longTerm}</p><p><b>{progress.month}目标</b> · {progress.monthly}</p><p>六个月目标的衡量口径尚未确认，当前未形成进度评估。空环不表示零进度。</p>{assessment&&<><p><b>Mission 简单完成率 {assessment.simplePercent}% → 加权完成度 {assessment.percent}%</b></p><p>{assessment.rationale}</p>{assessment.items.map(i=><p key={i.id}>{snapshot.missions.find(m=>m.id===i.id)?.title} · 权重 {i.weight} · 本项完成 {i.completion}%<br/>{i.reason}</p>)}<p>计算口径：Σ（权重 × 本项完成度）÷ Σ 权重。{assessment.source}</p></>}{assessmentError&&<button onClick={()=>void retryAssessment()}>重新评估 Mission</button>}{progress.measures.map(m => <p key={m.label}>{m.label}：{m.kind === 'quantity' ? `${m.actual} / ${m.target} ${m.unit}` : m.result}</p>)}<p>{progress.blocker}</p><p>Agent 评估：{progress.outlook}</p>{progress.evidence.map(line => <p key={line}>{line}</p>)}</div>
          </div>
        </> : <div className={s.missing}><p>尚未提供目标与进展</p><span>收到负责人反馈后展示，不推断为零进度。</span></div>}
      </div>
    </div>
  </article>;
}
