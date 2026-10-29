import {ownerEditCommands,requestedEditPaths,automaticChangePaths,allChangesRequested,automaticValuesRequested} from './owner-edit-intent.mjs';
import {splitProposal,patchPaths,pathsOverlap,remainingPatch} from './proposal-units.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {currentVersion,applyAction,mayRevise,roomOf} from './governance.mjs';
import {memberActor} from './shared-projection.mjs';
import {disagrees,agrees} from './stance.mjs';
// 两人意见相反不能算“已定” (陈溪南 2026-10-22 走查第 2 条): someone whose latest word on the topic is an objection,
// not followed by their own agreement, keeps it open.
export function contested(topic,records=[]){
 const ids=new Set([...(topic.sourceIds||[]),...(topic.trackedSourceIds||[])]),latest=new Map();
 for(const r of records)if(ids.has(r.id)&&r.author!=='Nexus'){const prev=latest.get(r.author);if(!prev||String(r.createdAt||'')>=String(prev.createdAt||''))latest.set(r.author,r);}
 return [...latest.values()].some(r=>disagrees(r.text)&&!agrees(r.text));
}
const reopen=(t,records)=>t.stage==='已定'&&contested(t,records)?{...t,stage:'讨论',status:t.status==='agreement'?'discussing':t.status}:t;
export function mergeTopics(previous=[],updates=[],records){
 const result=structuredClone(previous);
 for(const topic of updates){
  const key=topic.anchor?JSON.stringify(topic.anchor):topic.title;
  const id=createHash('sha256').update(key).digest('hex').slice(0,20);
  const index=result.findIndex(t=>t.id===id||(!t.id&&t.title===topic.title));
  // Absorb an older topic only when this one covers its anchor or its opening message; sharing a later reply is
  // not enough (that is how an unresolved topic used to vanish from the minutes).
  const matching=result.filter(t=>t.anchor&&topic.anchor&&JSON.stringify(t.anchor)===JSON.stringify(topic.anchor)||!!t.sourceIds?.[0]&&topic.sourceIds.includes(t.sourceIds[0]));
  const old=index>=0?result[index]:matching[0]||{};
  const next={...old,...topic,id,sourceIds:topic.status==='agreement'?topic.sourceIds:[...new Set([...(old.sourceIds||[]),...topic.sourceIds])],quotes:topic.status==='agreement'?topic.quotes:[...new Map([...(old.quotes||[]),...topic.quotes].map(q=>[q.id+q.text,q])).values()],updatedAt:new Date().toISOString()};
  next.trackedSourceIds=[...new Set([...matching.flatMap(t=>[...(t.trackedSourceIds||[]),...(t.sourceIds||[])]),...(old.trackedSourceIds||[]),...(old.sourceIds||[]),...topic.sourceIds])];
  if(next.status==='pending'&&next.sourceIds.length>1)next.status='discussing';
  for(const matched of matching){const i=result.indexOf(matched);if(i>=0)result.splice(i,1);}
  const remaining=result.findIndex(t=>t.id===id||t===old);
  if(remaining>=0)result[remaining]=next;else result.push(next);
 }
 return records?result.map(t=>reopen(t,records)):result;
}
export function rememberedEvidence(records,topics=[],pendingIds=[]){
 const ids=new Set([...topics.flatMap(t=>t.sourceIds||[]),...pendingIds]);
 records.slice(-30).forEach(r=>ids.add(r.id));
 const byId=new Map(records.map(r=>[r.id,r]));
 for(const id of ids){const r=byId.get(id);if(r?.replyTo)ids.add(r.replyTo);if(r?.threadId)ids.add(r.threadId);}
 return records.filter(r=>ids.has(r.id));
}
const monthDays=x=>new Set((String(x||'').match(/\d{1,2}[\/-]\d{1,2}/g)||[]).map(d=>{const [m,dd]=d.split(/[\/-]/).map(Number);return `${m}/${dd}`;}));
// The reason says the card "still writes 11/05, 11/06" but none of those dates are on the card any more.
export function staleDates(reason,content){const said=monthDays(reason);if(!said.size||!/(仍|还)(写|是|在|停在|留着)/.test(String(reason||'')))return false;const has=monthDays(JSON.stringify(content));return ![...said].some(d=>has.has(d));}
function proposalOrder(state,p){
 const events=[...state.comments,...state.messages].filter(e=>(p.sourceIds||[]).includes(e.id));
 return Math.max(0,...events.map(e=>e.createdSequence||0))||p.originSequence||0;
}
function sourceCurrent(state,p){for(const ref of [p.fromParent,p.fromMission])if(ref){const c=state.cards[ref.id];if(!c||currentVersion(c).number!==ref.version)return false;}return true;}
export function queueProposals(state,scope,proposals){
 state.proposals??=[];
 for(const proposal of proposals.flatMap(p=>splitProposal(p,state.cards[p.cardId]?.versions.at(-1)?.content||{}))){
  // 新增/撤掉/恢复 Mission: its own card on the PO, one request each; the same request waiting is not filed twice.
  if(proposal.op){if(!state.cards[proposal.cardId])continue;const same=p=>p.op===proposal.op&&p.status==='pending'&&(proposal.missionId?p.missionId===proposal.missionId:p.mission?.title===proposal.mission?.title);if(state.proposals.some(same))continue;
   state.proposals.push({...structuredClone(proposal),patch:{},id:randomUUID(),scope,status:'pending',createdSequence:state.sequence+1,before:{},createdAt:new Date().toISOString()});continue;}
  const card=state.cards[proposal.cardId],version=card&&currentVersion(card);
  if(!sourceCurrent(state,proposal))continue;
  // 修订卡不重复、不过期 (陈溪南 2026-10-22 走查第 4 条). A 下级对齐 card is dropped when the card above moved on again,
  // or when this card was already revised after that upper change (another card — e.g. from a comment — handled it).
  if(proposal.fromParent){const up=state.cards[proposal.fromParent.id];if(!up||currentVersion(up).number!==proposal.fromParent.version)continue;if(version&&String(version.createdAt||'')>String(proposal.fromParent.at||''))continue;}
  // A card whose reason quotes dates the card no longer has was written against old content.
  if(version&&staleDates(proposal.reason,version.content))continue;
  if(!version||version.number!==proposal.baseVersion||Object.entries(proposal.patch).every(([k,v])=>JSON.stringify(version.content[k])===JSON.stringify(v)))continue;
  if(state.proposals.some(p=>p.cardId===proposal.cardId&&p.baseVersion===proposal.baseVersion&&JSON.stringify(p.patch)===JSON.stringify(proposal.patch)&&(p.status==='pending'||proposal.sourceIds.every(id=>p.sourceIds.includes(id)))))continue;
  // New evidence replaces overlapping pending paths, retaining their history and independent paths.
  const paths=patchPaths(version.content,proposal.patch),order=proposalOrder(state,proposal);
  const overlaps=state.proposals.filter(p=>p.cardId===proposal.cardId&&p.status==='pending'&&pathsOverlap(patchPaths(p.before,p.patch),paths));
  // Late results may never erase a newer decision, including one already handled.
  if(state.proposals.some(p=>p.cardId===proposal.cardId&&p.status!=='superseded'&&proposalOrder(state,p)>order&&pathsOverlap(patchPaths(p.before,p.patch),paths)))continue;
  const replacementId=randomUUID();
  for(const old of overlaps){
   const rest=remainingPatch(old.before,old.patch,paths);old.status='superseded';old.supersededBy=replacementId;old.supersededAt=new Date().toISOString();
   if(Object.keys(rest).length)state.proposals.push({...structuredClone(old),id:randomUUID(),patch:rest,before:Object.fromEntries(Object.keys(rest).map(k=>[k,structuredClone(old.before[k])])),status:'pending',requiresConfirmation:true,verdictChange:'verdict'in rest?old.verdictChange:undefined,supersededBy:undefined,supersededAt:undefined,carriedFrom:old.id,createdAt:new Date().toISOString()});
  }
  // 判定变化 (陈溪南 2026-10-22): named on the card — from what to what, who asked, on what basis — with its existing signer authority preserved.
  const verdictChange=card.kind==='review'&&'verdict'in proposal.patch&&proposal.patch.verdict!==version.content.verdict?{from:version.content.verdict||'',to:proposal.patch.verdict,by:[...new Set([...state.comments,...state.messages].filter(e=>proposal.sourceIds.includes(e.id)).map(e=>e.author))],basis:proposal.reason||''}:null;
  state.proposals.push({...structuredClone(proposal),originalPatch:structuredClone(proposal.patch),originalBaseVersion:proposal.baseVersion,originSequence:order,id:replacementId,scope,status:'pending',createdSequence:state.sequence+1,before:Object.fromEntries(Object.keys(proposal.patch).map(k=>[k,version.content[k]??''])),...(verdictChange?{verdictChange}:{}),createdAt:new Date().toISOString()});
 }
 state.sequence++;return state;
}

// Intent and target come from the owner's real source events, never a model's authorization label.
export function explicitOwnerEdit(event,card,state){
 const text=String(event.text||'').trim();
 if(event.answers||!ownerEditCommands(text).length)return false;
 const selected=event.context?.selection?.id||(!event.general&&event.cardId);
 if(selected)return selected===card.id;
 const title=currentVersion(card).content.title;
 const mentioned=Object.values(state.cards).filter(c=>c.kind===card.kind&&currentVersion(c).content.title&&text.includes(currentVersion(c).content.title));
 if(title&&mentioned.length===1)return mentioned[0].id===card.id;
 const numbers=[...text.matchAll(/Mission\s*(\d+)/gi)].map(m=>Number(m[1]));if(new Set(numbers).size!==1)return false;
 const numbered=Object.values(state.cards).filter(c=>c.kind===card.kind&&roomOf(c)===event.scope&&Number(String(c.id).match(/(?:^|-)m(\d+)$/)?.[1])===numbers[0]);
 return numbered.length===1&&numbered[0].id===card.id;
}
function sourceBaseVersion(event,card,proposal){
 const selected=event.context?.selection;return selected?.id===card.id?(selected.version??proposal.originalBaseVersion??proposal.baseVersion):!event.general&&event.cardId===card.id?(event.version??proposal.originalBaseVersion??proposal.baseVersion):proposal.originalBaseVersion??proposal.baseVersion;
}
function sourceVersionCurrent(state,card,event,proposal,actor){
 const version=sourceBaseVersion(event,card,proposal),current=currentVersion(card).number;
 if(version==null||version===current)return true;if(version>current)return false;
 // Only automatic versions produced by this exact source batch may advance its own baseline.
 // A manual edit, other evidence, signer, or unrelated proposal breaks this chain.
 return card.versions.filter(v=>v.number>version).every(v=>state.proposals.some(p=>p.status==='accepted'&&p.auto===true&&p.resultVersion===v.number&&p.handledBy===actor.id&&p.cardId===card.id&&p.sourceIds.length===proposal.sourceIds.length&&p.sourceIds.every(id=>proposal.sourceIds.includes(id))));
}
export function applyOwnerAnnotations(state,scope){
 let next=state;
 for(const p of (state.proposals||[]).filter(p=>p.scope===scope&&p.status==='pending')){
  if(p.requiresConfirmation||p.op||p.basis==='cascade'||p.fromParent||p.fromMission)continue;
  const card=next.cards[p.cardId],sources=[...next.comments,...next.messages].filter(e=>p.sourceIds.includes(e.id));
  const authors=new Set(sources.map(e=>e.author));
  if(!card||roomOf(card)!==scope||authors.size!==1||!sources.length||!sources.every(e=>e.channel==='group'&&e.scope===scope&&explicitOwnerEdit(e,card,next)))continue;
  const requested=sources.flatMap(event=>requestedEditPaths(event,card.versions.find(v=>v.number===sourceBaseVersion(event,card,p))?.content||currentVersion(card).content));
  if(!allChangesRequested(automaticChangePaths(p.before,p.patch),requested))continue;
  if(!automaticChangePaths(p.before,p.patch).every(path=>sources.some(event=>automaticValuesRequested(event,card.versions.find(v=>v.number===sourceBaseVersion(event,card,p))?.content||currentVersion(card).content,p.before,p.patch,[path]))))continue;
  let actor;try{actor=memberActor([...authors][0],next);}catch{continue;}const v=currentVersion(card);
  if(!mayRevise(actor,card)||!String(v.content.owner||'').split(/[、,，\s]+/).includes(actor.name)||v.signatures?.length||card.confirmedVersion===v.number)continue;
  if(sources.some(e=>!sourceVersionCurrent(next,card,e,p,actor)))continue;
  try{next=applyAction(next,actor,{type:'acceptProposal',cardId:p.cardId,proposalId:p.id,auto:true});}catch{}
 }
 return next;
}
