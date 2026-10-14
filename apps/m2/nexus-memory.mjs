import {createHash,randomUUID} from 'node:crypto';
import {currentVersion} from './governance.mjs';
export function mergeTopics(previous=[],updates=[]){
 const result=structuredClone(previous);
 for(const topic of updates){
  const key=topic.anchor?JSON.stringify(topic.anchor):topic.title;
  const id=createHash('sha256').update(key).digest('hex').slice(0,20);
  const index=result.findIndex(t=>t.id===id||(!t.id&&t.title===topic.title));
  const matching=result.filter(t=>t.anchor&&topic.anchor&&JSON.stringify(t.anchor)===JSON.stringify(topic.anchor)||t.sourceIds?.some(s=>topic.sourceIds.includes(s)));
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
  state.proposals.push({...structuredClone(proposal),id:randomUUID(),scope,status:'pending',createdSequence:state.sequence+1,before:Object.fromEntries(Object.keys(proposal.patch).map(k=>[k,version.content[k]??''])),createdAt:new Date().toISOString()});
 }
 state.sequence++;return state;
}
