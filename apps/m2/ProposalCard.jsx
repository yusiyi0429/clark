import React,{useState} from 'react';
import {Button} from '@heroui/react';
import {documentFieldLabel} from './document-template.mjs';
import NexusOrb from './NexusOrb.jsx';
const text=v=>Array.isArray(v)?v.join('\n'):String(v??'');
export default function ProposalCard({proposal,node,onAction,compact=false}){
 const [busy,setBusy]=useState(false);
 async function handle(type){if(busy)return;setBusy(true);try{await onAction({type,cardId:proposal.cardId,proposalId:proposal.id});}finally{setBusy(false);}}
 const reviewer=proposal.reviewerName||node?.owner||'成果负责人';
 const card=<section id={compact?undefined:'proposal-'+proposal.id} className={compact?'island-proposal-card':'revision-message-card'} aria-label="Nexus 修订建议">
  <strong className="proposal-request">请 {reviewer} 确认以下修改</strong>
  {Object.entries(proposal.patch).map(([key,value])=><div className="proposal-diff" key={key}>
   <strong>{node?.referenceLabel||node?.title||'当前文档'} · {documentFieldLabel(node?.level,key)}</strong>
   <div className="proposal-value"><span>原来</span><del>{text(proposal.before?.[key])}</del></div>
   <div className="proposal-value"><span>修改后</span><ins>{text(value)}</ins></div>
  </div>)}
  {proposal.status==='pending'?(proposal.stale?<small className="proposal-status">材料已更新，请重新分析</small>:proposal.canAccept?<div className="proposal-actions">
   <Button className="proposal-confirm" isDisabled={busy} onPress={()=>handle('acceptProposal')}>{busy?'处理中…':'确认'}</Button>
   <Button className="proposal-reject" isDisabled={busy} onPress={()=>handle('rejectProposal')}>拒绝</Button>
  </div>:<small className="proposal-status">等待 {reviewer} 确认</small>):<small className="proposal-status">{proposal.status==='accepted'?`已修改 · v${proposal.resultVersion}`:'已拒绝'}</small>}
 </section>;
 return compact?card:<div className="message nexus-revision-message"><span className="avatar nexus-avatar"><NexusOrb/></span><div><small>Nexus</small>{card}</div></div>;
}
