import {currentVersion} from './governance.mjs';
import {splitProposal} from './proposal-units.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sourceCurrent=(state,p)=>[p.fromParent,p.fromMission].every(ref=>!ref||state.cards[ref.id]&&currentVersion(state.cards[ref.id]).number===ref.version);
const sameSuggestion=(a,b,original=false)=>a.cardId===b.cardId&&(a.op||null)===(b.op||null)&&(a.op?equal([a.missionId,a.mission],[b.missionId,b.mission]):(equal(a.patch,b.patch)||original&&a.originalPatch&&equal(a.originalPatch,b.patch)));
// A model's intention is not a delivered card. Inspect the result of the actual state transaction.
export function proposalDelivery(state,previousIds,scope,planned){
 const saved=(state.proposals||[]).filter(p=>p.scope===scope&&!previousIds.has(p.id)&&!p.carriedFrom&&['pending','accepted'].includes(p.status));
 const units=planned.flatMap(p=>splitProposal(p,state.cards[p.cardId]?.versions.find(v=>v.number===p.baseVersion)?.content||{}));
 const outcomes=units.map(p=>{
  const created=saved.filter(q=>sameSuggestion(q,p,true));if(created.length)return {cardId:p.cardId,status:'saved',proposalIds:created.map(q=>q.id)};
  const card=state.cards[p.cardId],v=card&&currentVersion(card);
  if(!p.op&&v&&Object.keys(p.patch||{}).length&&Object.entries(p.patch||{}).every(([key,value])=>equal(v.content[key],value)))return {cardId:p.cardId,status:'unchanged'};
  const existing=(state.proposals||[]).find(q=>q.scope===scope&&q.status==='pending'&&q.baseVersion===v?.number&&sourceCurrent(state,q)&&sameSuggestion(q,p));
  if(existing)return {cardId:p.cardId,status:'duplicate',proposalIds:[existing.id]};
  return {cardId:p.cardId,status:!card||!sourceCurrent(state,p)||!p.op&&p.baseVersion!==v.number?'stale':'skipped'};
 });
 const used=new Set(outcomes.filter(o=>o.status==='saved').flatMap(o=>o.proposalIds));
 return {saved:saved.filter(p=>used.has(p.id)),outcomes};
}
export function deliveryNotice(delivery,label=id=>id){
 const misses=delivery.outcomes.filter(o=>o.status!=='saved');if(!misses.length)return '';
 const why={duplicate:'已有相同待确认修订卡，正文未因此修改',unchanged:'当前正文已是这份内容，未新增版本',stale:'正文或依据已更新，这次没有覆盖新版本',skipped:'这次没有保存新修订，正文未因此修改'};
 const parts=[...new Map(misses.map(o=>[o.cardId+'|'+o.status,`${label(o.cardId)}：${why[o.status]}`])).values()];
 return (delivery.saved.length?'另有建议未新增：':'本次没有新增修改：')+parts.join('；')+'。';
}
// Retain substantive answers, but never announce cards that the state transaction did not deliver.
export function withoutUnsentCardClaims(reply){return String(reply||'').split(/(?<=[。！？])/).filter(sentence=>!/(?:(?:已|已经|现已|这就).{0,12}(?:出|给出|发出|生成).{0,10}(?:卡|卡片)|(?:请|等待).{0,10}(?:确认|接受).{0,8}(?:卡|修订)|(?:已|已经|现已).{0,8}(?:改|更新|补进|写入).{0,10}(?:正文|左侧|Mission))/i.test(sentence)).join('').trim();}
