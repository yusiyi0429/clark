import {createHash} from 'node:crypto';
const machine=new Set(['Nexus','nexus','Agent','system']);
export const topicId=anchor=>createHash('sha256').update(JSON.stringify(anchor)).digest('hex').slice(0,20);
export function recordTopic(topics,entry){
 if(entry.channel!=='group'||machine.has(entry.author)||!entry.text?.trim())return topics;
 if(topics.some(t=>t.sourceIds?.includes(entry.id)||t.trackedSourceIds?.includes(entry.id)))return topics;
 const selection=entry.context?.selection||{id:entry.cardId,version:entry.version};
 const block=entry.context?.block||entry.block;
 const anchor=selection?.id&&block&&block!=='card'?{cardId:selection.id,block,version:selection.version}:{threadId:entry.threadId||entry.id};
 let existing=topics.find(t=>t.anchor&&(anchor.threadId?t.anchor.threadId===anchor.threadId:t.anchor.cardId===anchor.cardId&&t.anchor.block===anchor.block&&(t.anchor.version??anchor.version)===anchor.version));
 existing??=topics.find(t=>t.sourceIds?.some(id=>id===entry.replyTo||id===entry.threadId));
 const quote={id:entry.id,text:entry.text};
 if(existing){
  // A fresh response reopens the question. Only validated model output may close it.
  existing.status='discussing';existing.conclusion='';
  existing.sourceIds=[...new Set([...(existing.sourceIds||[]),entry.id])];
  existing.quotes=[...(existing.quotes||[]),quote];existing.updatedAt=entry.createdAt;
 }else topics.push({id:topicId(anchor),anchor,title:entry.text.replace(/\s+/g,' ').slice(0,120),status:'pending',conclusion:'',sourceIds:[entry.id],quotes:[quote],updatedAt:entry.createdAt});
 return topics;
}
// Also expose unprocessed feedback from older saved states without rewriting it.
export function materializeTopics(previous=[],records=[]){
 const topics=structuredClone(previous);
 for(const entry of [...records].sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')))recordTopic(topics,entry);
 return topics;
}
