import React,{useState,useRef,useEffect,useLayoutEffect} from 'react';
import {Button} from '@heroui/react';
import {m2Fetch} from './deployment-client.mjs';
import {proposalTarget} from './proposal-summary-input.mjs';
import NexusOrb from './NexusOrb.jsx';
import {enterSubmit} from './enter-submit.mjs';
async function readSummary(id){const r=await m2Fetch('/api/proposal-summary?id='+encodeURIComponent(id));const v=await r.json();if(!r.ok)throw Error(v.error||'摘要暂不可用');return v;}
export default function ProposalCard({proposal,node,onAction,onOpen,compact=false}){
 const [busy,setBusy]=useState(false),[rejecting,setRejecting]=useState(null),[summary,setSummary]=useState(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[width,setWidth]=useState(0);
 const element=useRef(null);
 const patch=proposal.edited&&proposal.acceptedPatch?proposal.acceptedPatch:proposal.patch;
 const stamp=JSON.stringify([proposal.id,proposal.baseVersion,proposal.before,patch,proposal.reason]);
 useEffect(()=>{let active=true;setSummary(null);setError('');readSummary(proposal.id,stamp).then(v=>{if(active)setSummary(v);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[stamp,retry]);
 useLayoutEffect(()=>{const observer=new ResizeObserver(([entry])=>setWidth(entry.borderBoxSize?.[0]?.inlineSize||entry.target.getBoundingClientRect().width));observer.observe(element.current);return()=>observer.disconnect();},[]);
 async function handle(type,extra){if(busy)return;setBusy(true);try{await onAction({type,cardId:proposal.cardId,proposalId:proposal.id,...(extra||{})});setRejecting(null);}finally{setBusy(false);}}
 const reviewer=proposal.reviewerName||node?.owner||'成果负责人';
 const ref=node?.referenceLabel||'当前文档';
 const title=proposal.op==='add-mission'?`新增 ${proposal.mission?.title||'Mission'}`:proposal.op?`${proposal.op==='withdraw-mission'?'撤掉':'恢复'} ${proposal.missionSummary?.title||proposal.missionId}`:node?.level==='po'&&node?.title?.includes('：')?node.title.split('：')[0]:node?.title||ref;
 const state=proposal.status==='superseded'||proposal.status==='pending'&&proposal.stale?'archived':proposal.status==='pending'?'pending':proposal.status==='accepted'?'accepted':'rejected';
 const status={pending:`待 ${reviewer} 确认`,accepted:'已修改',rejected:'未采用',archived:'已归档'}[state];
 const groups=[];
 for(const change of summary?.changes||[]){
  const parts=change.where.split(' · '),part=parts.length>2?[parts[0],parts.at(-1)].join(' · '):parts[0];
  const target=change.targetLabel?change:proposalTarget(proposal,node);
  const label=target.targetLabel,key=target.targetRef||label;
  let group=groups.at(-1);if(!group||group.key!==key){group={label,key,rows:[]};groups.push(group);}group.rows.push({...change,part});
 }
 const source=(text,name)=>name&&!text.includes(name)?`（${name}）`:'';
 const card=<section ref={element} style={width?{maxHeight:Math.floor(width*2),'--proposal-card-width':width+'px'}:undefined} id={compact?undefined:'proposal-'+proposal.id} className={`${compact?'island-proposal-card':'revision-message-card'} proposal-task proposal-summary-card is-${state}`} aria-label={`Nexus 修订卡 · ${title} · ${status}`}>
  <header className="proposal-head"><strong>修订卡</strong><span className="proposal-reviewer" title={status}>{status}</span></header>
  <div className="proposal-body" aria-label="修改摘要">
   {!summary&&!error&&<p className="proposal-summary-loading" role="status">正在整理修改摘要…</p>}
   {error&&<div role="alert" className="proposal-summary-error"><p>摘要暂不可用，尚未展示完整修改。</p><button type="button" onClick={()=>setRetry(n=>n+1)}>重新整理</button></div>}
   {summary&&groups.map((group,i)=><div className="proposal-summary-group" key={i}><h4>修改：{group.label}</h4>{group.rows.map((c,j)=><div className="proposal-summary-change" key={j}>{c.part&&<strong className="proposal-summary-field">{c.part}</strong>}<div className="proposal-summary-pair"><p><span>原来</span>{c.before}{source(c.before,c.beforeSource)}</p><p><span>改为</span>{c.after}{source(c.after,c.afterSource)}</p></div></div>)}</div>)}
  </div>
  {state==='pending'&&node?.locked?<div className="proposal-foot proposal-locked">{node.lockedReason||'这张卡已锁定，不能再改'}</div>:state==='pending'&&proposal.canAccept?(rejecting!=null?<div className="proposal-foot proposal-reject-form">
   <textarea autoFocus rows={2} value={rejecting} placeholder="说说为什么不采用、想怎么改" aria-label="不采用的理由" onChange={e=>setRejecting(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setRejecting(null);return;}enterSubmit(e,()=>handle('rejectProposal',{reason:rejecting.trim()}),!busy&&!!rejecting.trim());}}/>
   <div className="proposal-actions"><Button className="proposal-confirm" isDisabled={busy||!rejecting.trim()} onPress={()=>handle('rejectProposal',{reason:rejecting.trim()})}>{busy?'发送中…':'发送理由'}</Button><Button className="proposal-reject" isDisabled={busy} onPress={()=>setRejecting(null)}>取消</Button></div>
  </div>:<div className="proposal-foot proposal-actions"><Button className="proposal-confirm" isDisabled={busy||!summary} onPress={()=>handle('acceptProposal')}>{busy?'处理中…':'确认修改'}</Button><Button className="proposal-reject" isDisabled={busy} onPress={()=>setRejecting('')}>不采用</Button></div>):null}
 </section>;
 return compact?card:<div className="message nexus-revision-message"><span className="avatar nexus-avatar"><NexusOrb/></span><div><small>Nexus</small>{card}</div></div>;
}
