import {nowContext} from './time-context.mjs';
// What Nexus is given when it does step in: layered, not everything at once (陈溪南 2026-10-19).
//  1. Always: the unit at a glance — PO and Missions, owners, tiers, who still has to confirm, open topics and how far each has got.
//  2. Where people pointed: the card a field comment sits on (whole card, plus its parent and siblings by title),
//     and the line someone pressed 回复 on, with the thread it belongs to.
//  3. Only when needed: source facts from the ontology, and other units' cards.
const parentOf=id=>String(id).replace(/-[a-z]+\d+$/,'');
const isChild=(id,parent)=>parentOf(id)===parent&&id!==parent;

export function unitOverview(cards,nodes=[]){
 const tierOf=new Map(nodes.map(n=>[n.id,n.tier]));
 return cards.filter(c=>c.kind!=='review'&&(c.level==='po'||c.level==='mission')).map(c=>({ref:c.aliases?.[0]||(c.level==='po'?'PO':c.id),title:c.title,owner:c.owner,
  ...(tierOf.get(c.id)?{tier:tierOf.get(c.id)}:{}),status:c.status,version:c.version,waitingFor:c.confirmation?.waiting||[],
  ...(c.level==='mission'?{tasks:cards.filter(t=>t.level==='task'&&isChild(t.id,c.id)).length}:{})}));
}

// Cards people pointed at: field comments, the card behind a replied line, cards named in the text, topic anchors.
export function focusCardIds(cards,fresh,evidence,topics=[]){
 const byId=new Map(evidence.map(e=>[e.id,e])),ids=new Set();
 for(const e of fresh){
  if(e.context?.selection?.id)ids.add(e.context.selection.id);
  const replied=e.replyTo&&byId.get(e.replyTo);if(replied?.context?.selection?.id)ids.add(replied.context.selection.id);
  for(const c of cards)if(String(e.text).includes(c.title)||(c.aliases||[]).some(a=>a.length>=3&&String(e.text).includes(a)))ids.add(c.id);
  const topic=topics.find(t=>(t.sourceIds||[]).includes(e.id));if(topic?.anchor?.cardId)ids.add(topic.anchor.cardId);
  // 「PO 复盘」「Mission 01 的复盘」「M02 复盘」: talk about a review brings that review card in (reviews carry no aliases).
  if(/复盘/.test(String(e.text))){const m=String(e.text).match(/(?:Mission|M)\s*0?(\d+)/i),reviews=cards.filter(c=>c.kind==='review');const hit=m?reviews.find(c=>c.id.endsWith('-m'+m[1])):reviews.find(c=>c.level==='po');if(hit)ids.add(hit.id);}
 }
 return [...ids].filter(id=>cards.some(c=>c.id===id));
}

export function focusCards(cards,ids){
 const byId=new Map(cards.map(c=>[c.id,c])),title=c=>c&&{ref:c.aliases?.[0]||c.level,title:c.title,owner:c.owner};
 // Children come in full too, so a change to this card can be carried down in the same pass.
 const whole=c=>{const {aliases,confirmation,...rest}=c;return {...rest,ref:aliases?.[0]||c.level};};
 return ids.map(id=>{const c=byId.get(id),parent=byId.get(parentOf(id));
  return {...c,parent:parent&&parent.id!==id?title(parent):null,siblings:cards.filter(s=>s.id!==id&&parentOf(s.id)===parentOf(id)&&s.level===c.level).map(title),
   children:c.level==='task'?[]:cards.filter(k=>isChild(k.id,id)&&!ids.includes(k.id)).slice(0,6).map(whole)};});
}

// The lines that matter for this turn: the new ones, what they replied to, the rest of each touched topic, and a little recent talk.
export function focusThread(evidence,fresh,topics=[]){
 const byId=new Map(evidence.map(e=>[e.id,e])),keep=new Set(fresh.map(e=>e.id));
 for(const e of fresh){
  if(e.replyTo&&byId.has(e.replyTo))keep.add(e.replyTo);
  for(const t of topics)if((t.sourceIds||[]).includes(e.id))(t.sourceIds||[]).slice(-8).forEach(id=>keep.add(id));
 }
 evidence.slice(-4).forEach(e=>keep.add(e.id));
 return evidence.filter(e=>keep.has(e.id)).map(e=>({id:e.id,author:e.author,text:String(e.text).slice(0,400),
  ...(e.context?.block&&e.context.block!=='card'?{on:`${e.context.selection?.id}:${e.context.block}`}:{}),...(e.replyTo?{replyTo:e.replyTo}:{}),...(e.answersNexus?{answersNexus:true}:{}),createdAt:e.createdAt}));
}

export function actContext({cards,nodes=[],evidence,fresh,topics,decision={},foundation=[],otherUnitCards=[],capacity=null,extraIds=[],now=Date.now()}){
 // Nothing pointed at (a general line): the PO itself is the card in focus.
 let ids=[...new Set([...extraIds.filter(id=>cards.some(c=>c.id===id)),...focusCardIds(cards,fresh,evidence,topics)])];
 // …and in a person's own review room, which has no PO, their review cards are (2026-10-27 drill: Nexus said it could not see Mission 1).
 if(!ids.length){const po=cards.find(c=>c.level==='po');if(po)ids=[po.id];else ids=cards.filter(c=>c.kind==='review').map(c=>c.id).slice(0,8);}
 return {
  now:nowContext(now),
  goal:'让这个单元的计划尽快定下来：每个话题从“提出”走到“已定”（负责人确认）。你每次开口都要把某个话题往前推一格。',
  unit:unitOverview(cards,nodes),
  // The unit's reviews (月底复盘) at a glance, when there are any.
  ...(cards.some(c=>c.kind==='review')?{reviews:cards.filter(c=>c.kind==='review').map(c=>({id:c.id,level:c.level,title:c.title,owner:c.owner,verdict:c.verdict,status:c.status}))}:{}),
  topics:(topics||[]).filter(t=>t.status!=='agreement'||(t.stage&&t.stage!=='已定')).slice(-8).map(t=>({id:t.id,title:t.title,status:t.status,stage:t.stage||'讨论',conclusion:t.conclusion||''})),
  focus:{cards:focusCards(cards,ids),thread:focusThread(evidence,fresh,topics)},
  ...(capacity?{capacity}:{}),
  ...(decision.needFacts&&foundation.length?{facts:foundation}:{}),
  ...(otherUnitCards.length?{otherUnits:otherUnitCards}:{}),
  focusCardIds:ids,
 };
}
