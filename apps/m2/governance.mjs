// Actors are resolved server-side from the approved roster. Internal trial has no authentication.
// This module records application confirmations, not formal ontology writes.
import {recordTopic} from './topic-lifecycle.mjs';
import {confirmationProposal} from './proposal-confirmation.mjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{status:code});};
const editable=new Set(['title','result','time','why','boundary','path','dependencies','checks','logic','handoffs','parentLtoReference','tradeoff','expectedProgress','milestones']);
export function createCollaborationState(units){
 const cards={};
 const visit=(n,parentId=null)=>{const {children,missions,tasks,activities,...content}=n;cards[n.id]={...content,parentId,versions:[{number:1,content:structuredClone(content),author:'Nexus',signatures:[],createdAt:new Date().toISOString()}],confirmedVersion:null};children.forEach(c=>visit(c,n.id));};
 units.forEach(n=>visit(n));
 return {schemaVersion:1,sequence:0,cards,comments:[],messages:[],audit:[]};
}
export function unitOf(card){return card.unit||card.id;}
export function canRead(actor,card){return !!actor&&(actor.ceo===true||(actor.visibleUnits||[]).includes(unitOf(card)));}
export function confirmationSlots(card){return card.level==='po'?['ceo','unitDri']:card.level==='mission'?['unitDri','missionDri']:[];}
export function currentVersion(card){return card.versions.at(-1);}
export function cardStatus(card){const v=currentVersion(card),slots=confirmationSlots(card);return card.upstreamChange?'上级有调整 · 待核对':slots.length===0?'负责人自主修订':slots.every(slot=>v.signatures.some(s=>s.slot===slot))?'已确认':v.signatures.length?'待另一方确认':'待确认';}
export function mayRevise(actor,card){
 if(actor.kind==='coagent')return (actor.units||[]).includes(unitOf(card));
 if(card.level==='po')return (actor.unitDri||[]).includes(unitOf(card));
 const missionId=card.level==='mission'?card.id:card.id.split('-t')[0];
 return (actor.missionDri||[]).includes(missionId);
}
export function applyAction(previous,actor,action){
 if(['acceptProposal','rejectProposal'].includes(action.type)){
  const proposal=previous.proposals?.find(p=>p.id===action.proposalId&&p.cardId===action.cardId);
  const target=proposal&&previous.cards[proposal.cardId];
  if(!actor?.id||actor.kind==='coagent'||!target||!canRead(actor,target)||!mayRevise(actor,target))fail(403,'请由当前成果负责人处理修订建议');
  if(proposal.status!=='pending')fail(409,'这项建议已经处理');
  if(currentVersion(target).number!==proposal.baseVersion)fail(409,'材料已更新，请重新分析，不能覆盖新版本');
  if(action.type==='acceptProposal'){
   const objections=[...previous.comments,...previous.messages].filter(e=>e.channel==='group'&&e.scope===proposal.scope&&e.createdAt>=proposal.createdAt&&/(不同意|不赞同|不认可|反对|不能接受|尚有分歧)/.test(e.text));
   if(objections.some(e=>e.cardId===target.id||e.context?.selection?.id===target.id||e.replyTo===proposal.id||e.threadId===proposal.id||proposal.sourceIds.includes(e.replyTo)||proposal.sourceIds.includes(e.threadId)))fail(409,'建议提出后出现新分歧，请先核对讨论再修订');
  }
  const next=action.type==='acceptProposal'?applyAction(previous,actor,{type:'revise',cardId:proposal.cardId,baseVersion:proposal.baseVersion,patch:proposal.patch,evidenceIds:proposal.sourceIds}):structuredClone(previous);
  const saved=next.proposals.find(p=>p.id===proposal.id);saved.status=action.type==='acceptProposal'?'accepted':'rejected';saved.handledBy=actor.id;saved.handledAt=new Date().toISOString();
  if(saved.status==='accepted'){const v=currentVersion(next.cards[proposal.cardId]);v.proposedBy='Nexus';v.reason=proposal.reason;saved.resultVersion=v.number;}
  next.sequence++;next.audit.push({id:`audit-${next.sequence}`,actorId:actor.id,type:action.type,cardId:target.id,proposalId:proposal.id,createdAt:saved.handledAt});
  return next;
 }
 const state=structuredClone(previous),card=state.cards[action.cardId];
 if(!actor?.id)fail(401,'请选择试用成员');
 if(!card||!canRead(actor,card)&&actor.kind!=='coagent')fail(403,'不在当前领域可见范围内');
 const v=currentVersion(card),now=new Date().toISOString();
 if(action.type==='revise'){
  if(!mayRevise(actor,card))fail(403,'请由当前成果负责人修订');
  if(action.baseVersion!==v.number)fail(409,'内容已更新，请检查最新版本再修订');
  const patch=action.patch;
  if(!patch||!Object.keys(patch).length||Object.keys(patch).some(k=>!editable.has(k)))fail(400,'修订字段不允许');
  for(const [key,value]of Object.entries(patch)){
   if(['checks','milestones'].includes(key)? !Array.isArray(value)||value.length>50||value.some(x=>typeof x!=='string'||x.length>8000):typeof value!=='string'||value.length>16000)fail(400,'修订内容格式错误');
  }
  if('title'in patch&&!patch.title.trim())fail(400,'标题不能为空');
  if('result'in patch&&!patch.result.trim())fail(400,'成果不能为空');
  if('checks'in patch&&!patch.checks.length)fail(400,'验收标准至少保留一项');
  if(Object.entries(patch).every(([key,value])=>JSON.stringify(v.content[key])===JSON.stringify(value)))fail(400,'内容没有变化，不新增版本');
  if(actor.kind==='coagent'){
   if(!Array.isArray(action.evidenceIds)||!action.evidenceIds.length)fail(400,'Nexus 修订需要领域公开反馈证据');
   const evidence=[...state.comments,...state.messages].filter(x=>x.channel==='group'&&x.scope===unitOf(card));
   if(action.evidenceIds.some(id=>!evidence.some(x=>x.id===id)))fail(403,'不能使用私聊或其他领域的反馈');
  }
  // Old content and old signatures survive. A new draft never inherits approval.
  const content={...structuredClone(v.content),...structuredClone(patch),version:v.number+1};
  card.versions.push({number:v.number+1,content,author:actor.id,createdAt:now,signatures:[],evidenceIds:action.evidenceIds||[]});
  // Mark impact, do not rewrite descendants or silently erase their past confirmations.
  for(const child of Object.values(state.cards))if(child.parentId===card.id)child.upstreamChange={cardId:card.id,version:v.number+1};
 }else if(action.type==='acknowledgeImpact'){
  if(!mayRevise(actor,card))fail(403,'请由成果负责人核对上级调整');
  if(action.baseVersion!==v.number)fail(409,'内容已更新，请重新核对');
  delete card.upstreamChange;
 }else if(action.type==='confirm'){
  if(actor.kind==='coagent')fail(403,'Nexus 不能代替人确认');
  if(action.baseVersion!==v.number)fail(409,'只能确认当前版本');
  const slots=confirmationSlots(card);
  if(!slots.length)fail(400,'Task 与 Activity 不设握手');
  if(card.upstreamChange)fail(409,'上级成果有调整，请先核对影响再确认');
  const slot=action.slot;
  const authorized=slot==='ceo'?actor.ceo===true:slot==='unitDri'?(actor.unitDri||[]).includes(unitOf(card)):slot==='missionDri'?(actor.missionDri||[]).includes(card.id):false;
  if(!slots.includes(slot)||!authorized)fail(403,'没有这一确认职责');
  if(!v.signatures.some(s=>s.slot===slot))v.signatures.push({slot,actorId:actor.id,version:v.number,createdAt:now});
  if(slots.every(s=>v.signatures.some(x=>x.slot===s)))card.confirmedVersion=v.number;
 }else if(action.type==='comment'||action.type==='message'){
  if(actor.kind==='coagent')fail(403,'此入口仅用于成员反馈');
  if(typeof action.text!=='string'||!action.text.trim()||action.text.length>8000)fail(400,'请输入有效反馈');
  const target=action.type==='comment'&&action.baseVersion!==undefined?card.versions.find(x=>x.number===action.baseVersion):v;
  if(!target)fail(400,'批注关联的版本不存在');
  const entry={id:`event-${state.sequence+1}`,createdSequence:state.sequence+1,author:actor.id,scope:unitOf(card),cardId:card.id,version:target.number,text:action.text.trim(),block:typeof action.block==='string'?action.block.slice(0,80):'card',createdAt:now,channel:'group'};
  if(action.replyTo){
   const source=[...state.comments,...state.messages,...(state.proposals||[]).map(p=>({...p,channel:'group',author:'Nexus',cardId:p.cardId,version:p.baseVersion,block:'card',text:'拟修改确认：'+Object.entries(p.patch).map(([key,value])=>key+'：'+(Array.isArray(value)?value.join('；'):value)).join('；')}))].find(e=>e.id===action.replyTo&&e.channel==='group'&&e.scope===unitOf(card));
   if(!source)fail(400,'引用消息不在当前领域或已不可用');
   entry.replyTo=source.id;entry.replyToAuthor=source.author;entry.threadId=source.threadId||source.id;
   entry.context=source.context||{scope:source.scope,selection:source.cardId?{id:source.cardId,version:source.version}:null,block:source.block};
   entry.replyPreview={author:source.author,text:source.text.slice(0,120)};
  }
  if(action.type==='message'&&!entry.context&&action.block&&editable.has(action.block))entry.context={scope:entry.scope,selection:{id:card.id,version:v.number},block:action.block};
  state[action.type==='comment'?'comments':'messages'].push(entry);
  const proposal=confirmationProposal(state,entry);
  if(proposal&&mayRevise(actor,state.cards[proposal.cardId])){
   entry.acceptedProposalId=proposal.id;
   state.sequence++;state.audit.push({id:`audit-${state.sequence}`,actorId:actor.id,type:action.type,cardId:card.id,version:v.number,createdAt:now});
   return applyAction(state,actor,{type:'acceptProposal',cardId:proposal.cardId,proposalId:proposal.id});
  }
  state.nexus??={};const discussion=state.nexus[entry.scope]??={};discussion.topics??=[];
  recordTopic(discussion.topics,entry);
  if(/(不同意|不赞同|不认可|反对|不能接受|尚有分歧)/.test(entry.text))for(const t of state.nexus?.[entry.scope]?.topics||[]){
   const a=t.anchor,c=entry.context||{selection:{id:entry.cardId},block:entry.block};
   if(a&&(a.threadId&&(entry.threadId||entry.id)===a.threadId||a.cardId===c.selection?.id&&a.block===c.block)){t.status='discussing';t.conclusion='';t.sourceIds=[...new Set([...(t.sourceIds||[]),entry.id])];}
  }
 }else fail(400,'不支持此操作');
 state.sequence++;
 state.audit.push({id:`audit-${state.sequence}`,actorId:actor.id,type:action.type,cardId:card.id,version:currentVersion(card).number,createdAt:now});
 return state;
}
