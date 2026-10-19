import React,{useState} from 'react';
import {Button} from '@heroui/react';
import {documentFieldLabel} from './document-template.mjs';
import {proposalRows,stripMarks,inlineChange,changeSummary} from './proposal-diff.mjs';
import NexusOrb from './NexusOrb.jsx';
// Each change reads as 原来 / 改成 (or 新增 / 删去); unchanged items fold into one line (陈溪南 2026-10-19).
function FieldChange({label,before,after}){
 const rows=proposalRows(before,after);
 return <div className="proposal-diff">
  <strong>{label}<span className="proposal-count"> · {changeSummary(before,after)}</span></strong>
  <ul className="proposal-rows">{rows.filter(r=>r.kind!=='same').map((r,i)=><li key={i} className={`proposal-row is-${r.kind}`}>
   {r.kind==='changed'?<ChangedLine before={stripMarks(r.before)} after={stripMarks(r.after)}/>:r.before!=null&&r.after==null?<p className="change-line is-was"><span>删去</span><del>{stripMarks(r.before)}</del></p>:<p className="change-line is-now"><span>新增</span><ins>{stripMarks(r.after)}</ins></p>}
  </li>)}</ul>
 </div>;
}
// A changed item: the old text in full, then the new text with the changed words marked.
function ChangedLine({before,after}){
 const c=inlineChange(before,after),small=c.head.length+c.tail.length<6;
 return <><p className="change-line is-was"><span>原来</span><del>{before}</del></p><p className="change-line is-now"><span>改成</span><ins>{small?after:<>{c.head}<mark className="diff-mark">{c.added}</mark>{c.tail}</>}</ins></p></>;
}
// On a PO the unit plan's gates are the 里程碑; when both lists change, show them once.
const fieldLabel=(level,key)=>level==='po'&&key==='logic'?'里程碑':documentFieldLabel(level,key);
const shownFields=patch=>Object.entries(patch).filter(([key])=>!(key==='milestones'&&'logic' in patch));
// Only the changes and the two answers; who decides is in the header, the reason is in the group (陈溪南 2026-10-19).
// Two answers only, 确认 or 拒绝; 拒绝 asks why, and the reason goes to the group for everyone and Nexus (陈溪南 2026-10-19).
export default function ProposalCard({proposal,node,onAction,onOpen,compact=false}){
 const [busy,setBusy]=useState(false),[rejecting,setRejecting]=useState(null);
 async function handle(type,extra){if(busy)return;setBusy(true);try{await onAction({type,cardId:proposal.cardId,proposalId:proposal.id,...(extra||{})});setRejecting(null);}finally{setBusy(false);}}
 const reviewer=proposal.reviewerName||node?.owner||'成果负责人';
 // Which card this changes is what people look for first, so it reads as the card's headline and opens the card.
 const targetText=<>{node?.referenceLabel&&<span className="proposal-target-ref">{node.referenceLabel}</span>}{node?.title||'当前文档'}</>;
 const target=onOpen&&!compact?<button type="button" className="proposal-target" onClick={()=>onOpen(proposal.cardId)}>{targetText}</button>:<span className="proposal-target">{targetText}</span>;
 const shownPatch=proposal.edited&&proposal.acceptedPatch?proposal.acceptedPatch:proposal.patch;
 const fields=shownFields(shownPatch),changes=fields.map(([key,value])=><FieldChange key={key} label={fieldLabel(node?.level,key)} before={proposal.before?.[key]} after={value}/>);
 const what=`改 ${fields.length} 处`;
 // Once the card moved on, the old proposal is an archive for tracing, not something to act on.
 const archived=proposal.status==='superseded'||proposal.status==='pending'&&proposal.stale;
 const card=archived?<section id={compact?undefined:'proposal-'+proposal.id} className={`${compact?'island-proposal-card':'revision-message-card'} is-archived`} aria-label="已归档的修订建议">
  <small className="proposal-status">修订建议已归档 · 卡片已更新{proposal.supersededBy?`到 v${proposal.supersededBy}`:''}</small>
  <details><summary>查看原建议</summary>{target}{changes}</details>
 </section>:<section id={compact?undefined:'proposal-'+proposal.id} className={compact?'island-proposal-card':'revision-message-card'} aria-label="Nexus 修订建议">
  <strong className="proposal-request">{proposal.status==='pending'?`请 ${reviewer} 确认 · ${what}`:proposal.status==='accepted'?`${reviewer} 已接受 · ${what}`:`${reviewer} 没有采用 · ${what}`}</strong>
  {target}
  {proposal.status!=='pending'&&!compact?<details className="proposal-handled"><summary>查看改动</summary>{changes}</details>:changes}
  {proposal.status==='pending'?proposal.canAccept?(rejecting!=null?<div className="proposal-reject-form">
   <textarea autoFocus rows={3} value={rejecting} placeholder="说说为什么不采用、想怎么改。群里的人和 Nexus 都会看到，Nexus 会按你的意思再出一版。" aria-label="拒绝理由" onChange={e=>setRejecting(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setRejecting(null);}}/>
   <div className="proposal-actions"><Button className="proposal-confirm" isDisabled={busy||!rejecting.trim()} onPress={()=>handle('rejectProposal',{reason:rejecting.trim()})}>{busy?'发送中…':'发送理由'}</Button><Button className="proposal-reject" isDisabled={busy} onPress={()=>setRejecting(null)}>取消</Button></div>
  </div>:<div className="proposal-actions">
   <Button className="proposal-confirm" isDisabled={busy} onPress={()=>handle('acceptProposal')}>{busy?'处理中…':'确认'}</Button>
   <Button className="proposal-reject" isDisabled={busy} onPress={()=>setRejecting('')}>拒绝</Button>
  </div>):null:null}
 </section>;
 return compact?card:<div className="message nexus-revision-message"><span className="avatar nexus-avatar"><NexusOrb/></span><div><small>Nexus</small>{card}</div></div>;
}
