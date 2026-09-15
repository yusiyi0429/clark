'use client';

import { ReferenceButton } from './card-references';
import { issueReference } from './reference-model';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { BookOpen, Check, Clock3, MessageCircle, Pin, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SelectionToolbar, useSelectionQuote } from '@/components/provenance/selection-quote';
import { issuePreRead, issues, type IssueId } from './model';
import type { DecisionReceipt } from './decision-model';
import { meetingsForIssue } from './meeting-model';
import s from './issue-workspace.module.css';

export function IssueWorkspace({ id, initialResearch, panelRef, closing, onClose, receipt, onQuote, onAsk }: {
  id:IssueId; initialResearch:boolean; panelRef:RefObject<HTMLElement|null>; closing:boolean;
  onClose:()=>void; receipt?:DecisionReceipt;
  onQuote:(text:string)=>void; onAsk:(text:string)=>void;
}) {
  const issue=issues[id];
  const preRead=issuePreRead[id];
  const meeting=meetingsForIssue(id).find(item=>item.id===preRead.meetingId);
  const [tab,setTab]=useState<'summary'|'research'>(initialResearch?'research':'summary');
  const [read,setRead]=useState(false);
  const [pinned,setPinned]=useState(false);
  const reading=useRef<HTMLDivElement>(null);
  const {selected,clear,onMouseUp}=useSelectionQuote(reading);
  useEffect(()=>{if(initialResearch){const frame=requestAnimationFrame(()=>setTab('research'));return()=>cancelAnimationFrame(frame);}},[initialResearch]);
  const quote=(text:string)=>onQuote(text);
  const discussion=<section className={s.discussion} aria-labelledby="issue-discussion-title">
    <header><div><h2 id="issue-discussion-title">{receipt?'会议结论':meeting?'带到会议讨论':'继续与 Agent 沟通'}</h2><p>{receipt?'这是会议中形成并回传的结论。':meeting?'这些是理解取舍的备选路径，不需要在本页点选。':'这个议题尚未进入会议议程，先把信息与分歧弄清楚。'}</p></div><span>{receipt?'已记录':meeting?`${meeting.time.replaceAll(' - ', '–')} 讨论`:'待澄清'}</span></header>
    {receipt?<div className={s.receipt}><Check size={16}/><p>{receipt.summary}</p></div>:<ol className={s.options}>{issue.options.map((option,index)=><li key={option}><span aria-hidden="true">{String(index+1).padStart(2,'0')}</span><p>{option}</p></li>)}</ol>}
    <small>{meeting?'本页只用于会前了解信息；会议中形成判断，由参会 DRI 与天枢协同记录结论。':'当前不提供会前阅读；信息充分并排入会议后，再由参会 DRI 与天枢协同准备和记录。'}</small>
  </section>;
  return <section ref={panelRef} className={s.workspace} role="dialog" aria-modal="false" aria-labelledby="issue-workspace-title" data-testid="issue-workspace" data-issue-id={id}>
    <header className={s.header}><div><span>{issue.scope}</span><h1 id="issue-workspace-title">{issue.title}</h1></div><ReferenceButton item={issueReference(id,receipt)}/><button data-close-sheet type="button" onClick={onClose} disabled={closing} aria-label="关闭议题，返回原位置"><X size={19}/></button></header>
    <div className={s.columns}>
      <div className={s.materials}>
        <nav className={s.tabs} aria-label="研究内容"><button aria-pressed={tab==='summary'} onClick={()=>{clear();setTab('summary');}}>总结与判断</button><button aria-pressed={tab==='research'} onClick={()=>{clear();setTab('research');}}>研究与依据</button></nav>
        <div className={s.reading} ref={reading} onMouseUp={onMouseUp}>
          {meeting&&<section className={s.preRead} aria-label="会前阅读信息">
            <div className={s.preReadTop}><span>会前阅读 · {meeting.time.replaceAll(' - ', '–')} 讨论</span><strong><Clock3 size={13}/>{preRead.readMinutes} 分钟</strong></div>
            <div className={s.preReadGrid}><div><small>为什么现在</small><p>{preRead.whyNow}</p></div><div><small>判断窗口</small><p>{preRead.decisionWindow}</p></div></div>
            <div className={s.preReadMeta}><span>主责 DRI · {preRead.dri}</span><span>{preRead.reversibility}</span><span>{preRead.missionRefs.join(' · ')}</span></div>
            <div className={s.changed}><small>上次阅读后</small>{preRead.changed.map(item=><span key={item}>{item}</span>)}</div>
          </section>}
          <p className={s.note}>案例材料 · 材料核验与变化记录由本体提供</p>
          {tab==='summary'?<>
            <section className={s.judgment}><h2>当前判断</h2><p>{issue.judgment}</p><button onClick={()=>quote(issue.judgment)}>追问这条判断</button></section>
            {discussion}
            <section className={s.section}><h2>判断的依据</h2><ol>{issue.evidence.map((point,i)=><li key={point}><span>{String(i+1).padStart(2,'0')}</span><p>{point}</p></li>)}</ol></section>
            <section className={s.unknown}><h2>还没弄清的</h2><p>{issue.unknown}</p></section>
            {meeting&&<section className={s.preflightActions} aria-label="会前动作">
              <div><h2>读到这里就可以</h2><p>不用在会前表态，也不要求读完才能进入会议。</p></div>
              <div className={s.actionRow}>
                <button type="button" aria-pressed={read} onClick={()=>setRead(value=>!value)}><BookOpen size={14}/>{read?'已阅':'阅'}</button>
                <button type="button" onClick={()=>onAsk(`请 ${preRead.dri} 补充：关于“${issue.title}”，${issue.unknown}`)}><MessageCircle size={14}/>请补充</button>
                <button type="button" aria-pressed={pinned} onClick={()=>setPinned(value=>!value)}><Pin size={14}/>{pinned?'已带到会议':'带到会议'}</button>
              </div>
              {(read||pinned)&&<small role="status">{[read?'已记住阅读位置':'',pinned?'已放入本场会议的讨论重点':''].filter(Boolean).join('；')}。这不是决策记录。</small>}
            </section>}
          </>:<><div className={s.prose}><Markdown remarkPlugins={[remarkGfm]}>{issue.research}</Markdown></div><section className={s.section}><h2>材料来源</h2><p>{issue.source}</p>{issue.evidence.map(point=><p key={point}>{point}</p>)}</section>{discussion}</>}
          <SelectionToolbar selected={selected} onQuote={()=>{if(selected){quote(selected.text);clear();}}}/>
        </div>
      </div>
    </div>
  </section>;
}
