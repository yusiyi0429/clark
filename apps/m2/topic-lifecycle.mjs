import {createHash} from 'node:crypto';
import {agrees,declinesChange} from './stance.mjs';
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
 // Any line that is not a field comment or a reply (a general line, or a message sent on a card) usually continues
 // the live discussion, like 「至少 3 天吧？」after a question; it does not open a new item in the minutes.
 // Only a field comment raises a new question. Nexus can still split or merge topics when it analyses.
 const fieldComment=Boolean(anchor.cardId);
 // What was just settled counts as live too: 「PO 这张我接受了」「M02 也照这个改」right after an agreement follow it, not a new item.
 const latest=[...topics].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
 const recentAgreement=latest.find(t=>t.status==='agreement'&&Date.parse(entry.createdAt)-Date.parse(t.updatedAt)<=30*60*1000);
 const open=latest.find(t=>t.status!=='agreement');
 if(!existing&&!fieldComment&&!entry.replyTo)existing=recentAgreement&&(!open||String(recentAgreement.updatedAt)>String(open.updatedAt))?recentAgreement:open;
 // A bare 「同意」「已核对，不用改」with nothing open is not a question to discuss (陈溪南 2026-10-19).
 if(!existing&&!fieldComment&&(agrees(entry.text)||declinesChange(entry.text))&&entry.text.length<=80)return topics;
 const quote={id:entry.id,text:entry.text};
 if(existing){
  // A fresh response reopens the question (only validated model output may close it); a bare 「好」「接受了」on a settled one does not.
  const ack=existing.status==='agreement'&&!fieldComment&&(agrees(entry.text)||declinesChange(entry.text))&&entry.text.length<=80;
  if(!ack){existing.status='discussing';existing.conclusion='';}
  existing.sourceIds=[...new Set([...(existing.sourceIds||[]),entry.id])];
  existing.quotes=[...(existing.quotes||[]),quote];existing.updatedAt=entry.createdAt;
 }else topics.push({id:topicId(anchor),anchor,title:shortTitle(entry.text),status:'pending',conclusion:'',sourceIds:[entry.id],quotes:[quote],updatedAt:entry.createdAt});
 return topics;
}
// Minutes list a topic by its first sentence, not a whole paragraph.
export function shortTitle(text){const s=String(text||'').replace(/\s+/g,' ').trim(),first=s.split(/(?<=[。？！?!；;])/)[0]||s;return first.length>40?first.slice(0,38)+'…':first;}
// Also expose unprocessed feedback from older saved states without rewriting it.
export function materializeTopics(previous=[],records=[]){
 const topics=structuredClone(previous);
 for(const entry of [...records].sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')))recordTopic(topics,entry);
 return topics;
}
