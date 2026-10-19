import {createHash,randomUUID} from 'node:crypto';
import {currentVersion,applyAction,mayRevise} from './governance.mjs';
import {memberActor} from './shared-projection.mjs';
export function mergeTopics(previous=[],updates=[]){
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
 return result;
}
export function rememberedEvidence(records,topics=[],pendingIds=[]){
 const ids=new Set([...topics.flatMap(t=>t.sourceIds||[]),...pendingIds]);
 records.slice(-30).forEach(r=>ids.add(r.id));
 const byId=new Map(records.map(r=>[r.id,r]));
 for(const id of ids){const r=byId.get(id);if(r?.replyTo)ids.add(r.replyTo);if(r?.threadId)ids.add(r.threadId);}
 return records.filter(r=>ids.has(r.id));
}
export function queueProposals(state,scope,proposals){
 state.proposals??=[];
 for(const proposal of proposals){
  const card=state.cards[proposal.cardId],version=card&&currentVersion(card);
  if(!version||version.number!==proposal.baseVersion||Object.entries(proposal.patch).every(([k,v])=>JSON.stringify(version.content[k])===JSON.stringify(v)))continue;
  if(state.proposals.some(p=>p.cardId===proposal.cardId&&p.baseVersion===proposal.baseVersion&&JSON.stringify(p.patch)===JSON.stringify(proposal.patch)&&(p.status==='pending'||proposal.sourceIds.every(id=>p.sourceIds.includes(id)))))continue;
  // One card waiting per card and version: a second pass does not stack a near-copy of the same fields on top (2026-10-19 replay); other fields still get their own card.
  if(state.proposals.some(p=>p.cardId===proposal.cardId&&p.baseVersion===proposal.baseVersion&&p.status==='pending'&&Object.keys(p.patch).some(k=>k in proposal.patch)))continue;
  state.proposals.push({...structuredClone(proposal),id:randomUUID(),scope,status:'pending',createdSequence:state.sequence+1,before:Object.fromEntries(Object.keys(proposal.patch).map(k=>[k,version.content[k]??''])),createdAt:new Date().toISOString()});
 }
 state.sequence++;return state;
}

// Proposals that come only from a card owner's own comments on that card are applied at once, as that owner.
export function applyOwnerAnnotations(state,scope){
 let next=state;
 for(const p of (state.proposals||[]).filter(p=>p.scope===scope&&p.status==='pending')){
  const card=next.cards[p.cardId],sources=[...next.comments,...next.messages].filter(e=>p.sourceIds.includes(e.id));
  const authors=new Set(sources.map(e=>e.author));
  if(!card||authors.size!==1||!sources.length||!sources.every(e=>next.comments.includes(e)&&e.cardId===card.id))continue;
  const actor=memberActor([...authors][0],next);
  if(!mayRevise(actor,card)||currentVersion(card).content.owner!==actor.name)continue;
  try{next=applyAction(next,actor,{type:'acceptProposal',cardId:p.cardId,proposalId:p.id,auto:true});}catch{}
 }
 return next;
}
