// Actors are resolved server-side from the approved roster. Internal trial has no authentication.
// This module records application confirmations, not formal ontology writes.
import {recordTopic} from './topic-lifecycle.mjs';
import {broadcast,reviewMonth} from './broadcasts.mjs';
import {confirmationProposal} from './proposal-confirmation.mjs';
import {disagrees,agrees} from './stance.mjs';
import {memberProfiles} from './member-profiles.mjs';
import {addMission,withdrawMission,restoreMission,findInTree,missionDays} from './mission-structure.mjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{status:code});};
const editable=new Set(['title','owner','result','time','why','boundary','path','dependencies','checks','logic','handoffs','parentLtoReference','tradeoff','expectedProgress','milestones','tier','risks','effort','stop']);
export function createCollaborationState(units){
 const cards={};
 const visit=(n,parentId=null)=>{const {children,missions,tasks,activities,...content}=n;cards[n.id]={...content,parentId,versions:[{number:1,content:structuredClone(content),author:'Nexus',signatures:[],createdAt:new Date().toISOString()}],confirmedVersion:null};children.forEach(c=>visit(c,n.id));};
 units.forEach(n=>visit(n));
 return {schemaVersion:1,sequence:0,cards,comments:[],messages:[],audit:[]};
}
export function unitOf(card){return card.unit||card.id;}
// 复盘 (陈溪南 2026-10-20): each review is a card in the same unit and group as the plan, with the same handshake.
// Who answers for a review is whoever the review names, so Mission reviews are matched by owner name.
export const isReview=card=>card?.kind==='review';
const reviewOwners=card=>String(currentVersion(card).content.owner||'').split(/[、,，\s]+/).filter(Boolean);
const reviewEditable=new Set(['verdict','verdictReason','targets','causes','nextInputs','ltoReview']);
// Group notices keep everyone on the same page after a revision or a handshake; they are support, not discussion.
const nameOf=id=>memberProfiles[id]?.name||id;
const titleOf=card=>'「'+(currentVersion(card).content.title||card.title||card.id)+'」';
function slotHolder(state,card,slot){if(slot==='ceo')return Object.values(memberProfiles).find(p=>p.ceo)?.name;const c=slot==='unitDri'?state.cards[unitOf(card)]:card;return c&&currentVersion(c).content.owner;}
// Nexus's last question in this room was put to this person (or to no one by name) within two hours, and they have
// not spoken since: their next line is the answer.
export function answersNexus(state,scope,actorId,now=new Date().toISOString()){
 const name=nameOf(actorId);
 const room=(state.messages||[]).filter(m=>m.channel==='group'&&m.scope===scope);
 const asked=[...room].reverse().find(m=>m.author==='Nexus'&&m.kind!=='notice'&&m.kind!=='revision-proposal');
 if(!asked||!/[？?]|请回答|请确认|吗[。！]?$/.test(asked.text||''))return false;
 if(Date.parse(now)-Date.parse(asked.createdAt||0)>2*3600*1000)return false;
 const names=Object.values(memberProfiles).map(p=>p.name).filter(n=>String(asked.text).includes(n));
 if(names.length&&!names.includes(name))return false;
 return !room.some(m=>m.author===actorId&&Date.parse(m.createdAt||0)>Date.parse(asked.createdAt||0));
}
// Accepting a 新增/撤掉/恢复 Mission card changes the plan's shape, never the PO; the group hears what changed and who confirms.
function applyMissionCard(previous,actor,proposal){
 const state=structuredClone(previous),po=state.cards[proposal.cardId],me=nameOf(actor.id),now=new Date().toISOString();
 const label=id=>{const at=findInTree(state.round?.units,id);return at?`Mission ${at.index+1}`:'Mission';};
 const size=node=>{const k=(node.children||[]).length,d=missionDays(node);return `${k} 个 Task${d?`，约 ${+d.toFixed(1)} 人日`:''}`;};
 if(proposal.op==='add-mission'){const node=addMission(state,po.id,proposal.mission,{now});const signers=[...new Set([currentVersion(po).content.owner,node.owner].flatMap(o=>String(o||'').split(/[、,，]/)).filter(Boolean))];
  groupNotice(state,po,`${me}接受了新增 ${label(node.id)}「${node.title}」（${size(node)}）。请 ${mentionList(signers)} 确认这条 Mission。`);}
 else if(proposal.op==='withdraw-mission'){const node=withdrawMission(state,proposal.missionId,{by:actor.id,reason:proposal.reason,now});groupNotice(state,po,`${me}撤掉了「${node.title}」（下面 ${size(node)}）。需要恢复时在群里 @Nexus。`);}
 else if(proposal.op==='restore-mission'){const node=restoreMission(state,proposal.missionId);groupNotice(state,po,`${me}恢复了 ${label(node.id)}「${node.title}」（下面 ${size(node)}），确认状态和撤掉前一样。`);}
 else fail(400,'不认识的修订卡');
 return state;
}
function groupNotice(state,card,text){state.sequence++;state.messages.push({id:`notice-${state.sequence}`,createdSequence:state.sequence,author:'Nexus',kind:'notice',channel:'group',scope:unitOf(card),cardId:card.id,version:currentVersion(card).number,general:true,text,createdAt:new Date().toISOString()});}
// Who has confirmed the current version and whom it still waits for, by name (for Nexus progress answers).
// Who decides a changed verdict on a review: the signers other than those who asked for it.
export function verdictDeciders(state,card,proposal){
 const holders=[...new Set(confirmationSlots(card).map(slot=>slotHolder(state,card,slot)).flatMap(n=>String(n||'').split(/[、,，]/)).map(n=>n.trim()).filter(Boolean))];
 const askers=new Set((proposal?.verdictChange?.by||[]).map(nameOf));
 const others=holders.filter(n=>!askers.has(n));
 return others.length?others:holders;
}
// 下级对齐 cards written against an older version of this card are archived once it moves on or is confirmed:
// they no longer say anything about the plan people are signing (走查第 4 条).
function retireCascadeCards(state,parent,version){for(const p of state.proposals||[])if(p.status==='pending'&&p.fromParent?.id===parent.id&&p.fromParent.version!==version){p.status='superseded';p.supersededBy=`上级 v${version}`;}}
export function confirmationSummary(state,card){const v=currentVersion(card),slots=confirmationSlots(card);return {signed:[...new Set(v.signatures.map(s=>nameOf(s.actorId)))],waiting:slots.filter(slot=>!v.signatures.some(s=>s.slot===slot)).map(slot=>slotHolder(state,card,slot)).filter(Boolean)};}
const mentionList=names=>[...new Set(names.filter(Boolean))].map(n=>'@'+n).join('、');
export function mayChangeOwner(actor,card){return !!actor&&(card.level==='po'?actor.ceo===true:(actor.unitDri||[]).includes(unitOf(card)));}
export function canRead(actor,card){return !!actor&&(actor.ceo===true||(actor.visibleUnits||[]).includes(unitOf(card)));}
export function confirmationSlots(card){if(isReview(card))return card.level==='company'?['ceo']:card.level==='po'?['ceo','unitDri']:['unitDri','missionDri'];return card.level==='po'?['ceo','unitDri']:card.level==='mission'?['unitDri','missionDri']:[];}
export function currentVersion(card){return card.versions.at(-1);}
export function cardStatus(card){const v=currentVersion(card),slots=confirmationSlots(card);return card.upstreamChange?'上级有调整 · 待核对':card.downstreamChange?'下级有调整 · 待核对':slots.length===0?'负责人自主修订':slots.every(slot=>v.signatures.some(s=>s.slot===slot))?'已确认':v.signatures.length?'待另一方确认':'待确认';}
export function mayRevise(actor,card){
 if(actor.kind==='coagent')return (actor.units||[]).includes(unitOf(card));
 if(isReview(card))return card.level==='company'?actor.ceo===true:card.level==='po'?(actor.unitDri||[]).includes(unitOf(card)):reviewOwners(card).includes(actor.name);
 if(card.level==='po')return (actor.unitDri||[]).includes(unitOf(card));
 const missionId=card.level==='mission'?card.id:card.id.split('-t')[0];
 return (actor.missionDri||[]).includes(missionId);
}
export function applyAction(previous,actor,action){
 if(['acceptProposal','rejectProposal'].includes(action.type)){
  const proposal=previous.proposals?.find(p=>p.id===action.proposalId&&p.cardId===action.cardId);
  const target=proposal&&previous.cards[proposal.cardId];
  if(!actor?.id||actor.kind==='coagent'||!target||!canRead(actor,target))fail(403,'请由当前成果负责人处理修订建议');
  // 判定变化 is decided by the other signer: whoever holds a confirmation slot on the review and did not ask for it
  // (陈溪南 2026-10-22). Only when no one else signs (the company review) does the asker decide.
  if(proposal?.verdictChange&&action.type==='acceptProposal'){const holders=verdictDeciders(previous,target,proposal);if(!holders.includes(nameOf(actor.id)))fail(403,`判定改动要由${holders.join('、')||'对方签字人'}确认`);}
  else if(!mayRevise(actor,target)&&!(proposal?.verdictChange&&verdictDeciders(previous,target,proposal).includes(nameOf(actor.id))))fail(403,'请由当前成果负责人处理修订建议');
  if(proposal.status==='superseded')fail(409,'材料已更新，这条建议已归档，只作溯源');
  if(proposal.status!=='pending')fail(409,'这项建议已经处理');
  // A Mission card (新增/撤掉/恢复) does not change the PO, so a newer PO version does not make it stale.
  if(!proposal.op&&currentVersion(target).number!==proposal.baseVersion)fail(409,'材料已更新，请重新分析，不能覆盖新版本');
  if(action.type==='acceptProposal'){
   const objections=[...previous.comments,...previous.messages].filter(e=>e.channel==='group'&&e.scope===proposal.scope&&e.createdAt>=proposal.createdAt&&e.author!=='Nexus'&&disagrees(e.text));
   if(objections.some(e=>e.cardId===target.id||e.context?.selection?.id===target.id||e.replyTo===proposal.id||e.threadId===proposal.id||proposal.sourceIds.includes(e.replyTo)||proposal.sourceIds.includes(e.threadId)))fail(409,'建议提出后出现新分歧，请先核对讨论再修订');
  }
  let patch=proposal.patch;
  if(action.type==='acceptProposal'&&action.patch&&!proposal.op){
   if(typeof action.patch!=='object'||Array.isArray(action.patch)||Object.keys(action.patch).some(k=>!(k in proposal.patch)))fail(400,'只能修改这条建议涉及的字段');
   patch={...proposal.patch,...action.patch};
  }
  const next=action.type==='acceptProposal'&&proposal.op?applyMissionCard(previous,actor,proposal):action.type==='acceptProposal'?applyAction(previous,actor,{type:'revise',cardId:proposal.cardId,baseVersion:proposal.baseVersion,patch,evidenceIds:proposal.sourceIds,viaProposal:proposal.id,auto:action.auto===true}):structuredClone(previous);
  const saved=next.proposals.find(p=>p.id===proposal.id);saved.status=action.type==='acceptProposal'?'accepted':'rejected';saved.handledBy=actor.id;saved.handledAt=new Date().toISOString();if(action.auto===true)saved.auto=true;if(patch!==proposal.patch){saved.edited=true;saved.acceptedPatch=patch;}
  if(saved.status==='accepted'&&!proposal.op){const v=currentVersion(next.cards[proposal.cardId]);v.proposedBy='Nexus';v.reason=proposal.reason;saved.resultVersion=v.number;
   // The topics this card answered are settled: close them in the minutes so 共同确认 stops listing them (2026-10-19).
   // …unless someone's latest word on that topic is still an objection: two opposite views are not settled.
   const said=[...next.comments,...next.messages],objecting=t=>{const ids=new Set([...(t.sourceIds||[]),...(t.trackedSourceIds||[])]),last=new Map();for(const r of said)if(ids.has(r.id)&&r.author!=='Nexus')last.set(r.author,r);return [...last.values()].some(r=>disagrees(r.text)&&!agrees(r.text));};
   for(const t of next.nexus?.[proposal.scope]?.topics||[])if((t.sourceIds||[]).some(id=>proposal.sourceIds.includes(id))&&!objecting(t)){t.status='agreement';t.stage='已定';t.conclusion=`已按修订改到 v${v.number}`;}}
  next.sequence++;next.audit.push({id:`audit-${next.sequence}`,actorId:actor.id,type:action.type,cardId:target.id,proposalId:proposal.id,createdAt:saved.handledAt});
  // 拒绝 comes with a reason (陈溪南 2026-10-19): it goes to the group as the owner's reply to the card, so everyone sees
  // why and Nexus can come back with a version that meets it.
  const reason=action.type==='rejectProposal'&&typeof action.reason==='string'?action.reason.trim().slice(0,2000):'';
  // Without a reason the group still hears it was turned down; with one, the owner's own line says so.
  if(!reason&&action.type==='rejectProposal'&&action.auto!==true)groupNotice(next,next.cards[proposal.cardId],`${nameOf(actor.id)}没有采用 Nexus 对${titleOf(next.cards[proposal.cardId])}的修订。`);
  if(reason){saved.rejectReason=reason;const after=applyAction(next,actor,{type:'message',cardId:proposal.cardId,replyTo:proposal.id,text:`不采用这张修订卡：${reason}`});after.messages.at(-1).rejectsProposal=proposal.id;return after;}
  return next;
 }
 const state=structuredClone(previous),card=state.cards[action.cardId];
 if(!actor?.id)fail(401,'请选择试用成员');
 if(!card||!canRead(actor,card)&&actor.kind!=='coagent')fail(403,'不在当前领域可见范围内');
 const v=currentVersion(card),now=new Date().toISOString();
 if(action.type==='revise'){
  const verdictCard=action.viaProposal&&(state.proposals||[]).find(p=>p.id===action.viaProposal&&p.verdictChange);
  if(!mayRevise(actor,card)&&!(verdictCard&&verdictDeciders(state,card,verdictCard).includes(nameOf(actor.id))))fail(403,'请由当前成果负责人修订');
  if(action.baseVersion!==v.number)fail(409,'内容已更新，请检查最新版本再修订');
  const patch=action.patch;
  // 换负责人 (陈溪南 2026-10-22): only to people on the roster, and only by the unit DRI (a PO's by the CEO); Nexus never applies it itself.
  if(patch&&'owner'in patch&&!isReview(card)){if(actor.kind==='coagent')fail(400,'修订字段不允许');if(!mayChangeOwner(actor,card))fail(403,'换负责人要由领域 DRI 确认');if(!String(patch.owner||'').split(/[、,，]/).map(x=>x.trim()).filter(Boolean).every(n=>Object.values(memberProfiles).some(m=>m.name===n)))fail(400,'负责人只能是名单里的人');}
  if(!patch||!Object.keys(patch).length||Object.keys(patch).some(k=>!(isReview(card)?reviewEditable:editable).has(k)))fail(400,'修订字段不允许');
  // 档位 only on Missions and Tasks, and only P0 / P1 / P2 (陈溪南 2026-10-19).
  if('tier'in patch&&(!['mission','task'].includes(card.level)||!['P0','P1','P2'].includes(patch.tier)))fail(400,'档位只能是 P0、P1、P2，且只用于 Mission 和 Task');
  for(const [key,value]of Object.entries(patch)){
   // Review lists hold objects: causes {text, ask}, nextInputs {id, type, text}; ltoReview {choice, reason}.
   if(isReview(card)&&(key==='causes'?!Array.isArray(value)||value.length>5||value.some(x=>!x||typeof x.text!=='string'||typeof (x.ask??'')!=='string'):key==='nextInputs'?!Array.isArray(value)||value.length>5||value.some(x=>!x||typeof x.text!=='string'||!['欠账','继续验证','停止','约束','待决策'].includes(x.type)):key==='ltoReview'?!value||!['维持','修改','重开','建议维持','建议修改','建议重开'].includes(value.choice):key==='verdict'?!['达成','部分达成','未达成'].includes(value):false))fail(400,'修订内容格式错误');
   if(isReview(card)&&['causes','nextInputs','ltoReview','verdict'].includes(key))continue;
   if(Array.isArray(value)?value.length>50||value.some(x=>typeof x!=='string'||x.length>8000):['checks','milestones'].includes(key)||typeof value!=='string'||value.length>16000)fail(400,'修订内容格式错误');
  }
  if('title'in patch&&!patch.title.trim())fail(400,'标题不能为空');
  if('result'in patch&&!patch.result.trim())fail(400,'成果不能为空');
  if('checks'in patch&&!patch.checks.length)fail(400,'验收标准至少保留一项');
  if(Object.entries(patch).every(([key,value])=>JSON.stringify(v.content[key])===JSON.stringify(value)))fail(400,'内容没有变化，不新增版本');
  // 判定变化一律走修订卡 (陈溪南 2026-10-22): a person changing a review's verdict files a card for the other signer instead.
  if(isReview(card)&&actor.kind!=='coagent'&&!action.viaProposal&&'verdict'in patch&&patch.verdict!==v.content.verdict){
   state.proposals??=[];state.sequence++;
   const proposal={id:`verdict-${state.sequence}`,cardId:card.id,scope:unitOf(card),baseVersion:v.number,patch:structuredClone(patch),reason:String(action.reason||patch.verdictReason||'').slice(0,2000),sourceIds:[],status:'pending',createdSequence:state.sequence,createdAt:now,
    before:Object.fromEntries(Object.keys(patch).map(k=>[k,v.content[k]??''])),verdictChange:{from:v.content.verdict||'',to:patch.verdict,by:[actor.id],basis:String(action.reason||patch.verdictReason||'').slice(0,2000)}};
   state.proposals.push(proposal);
   groupNotice(state,card,`${nameOf(actor.id)}提出把${titleOf(card)}的判定由「${proposal.verdictChange.from}」改为「${proposal.verdictChange.to}」，请 ${mentionList(verdictDeciders(state,card,proposal))} 看修订卡后决定。`);
   return state;
  }
  if(actor.kind==='coagent'){
   if(!Array.isArray(action.evidenceIds)||!action.evidenceIds.length)fail(400,'Nexus 修订需要领域公开反馈证据');
   const evidence=[...state.comments,...state.messages].filter(x=>x.channel==='group'&&x.scope===unitOf(card));
   if(action.evidenceIds.some(id=>!evidence.some(x=>x.id===id)))fail(403,'不能使用私聊或其他领域的反馈');
  }
  // Old content and old signatures survive. A new draft never inherits approval.
  const content={...structuredClone(v.content),...structuredClone(patch),version:v.number+1};
  card.versions.push({number:v.number+1,content,author:actor.id,createdAt:now,signatures:[],evidenceIds:action.evidenceIds||[]});
  // The owner revising this card after an upper change has looked at that change (陈溪南 2026-10-19).
  if(actor.kind!=='coagent'&&card.upstreamChange&&mayRevise(actor,card))delete card.upstreamChange;
  // Revising this card is looking at what changed below it.
  if(card.downstreamChange)delete card.downstreamChange;
  // Mark impact, do not rewrite descendants or silently erase their past confirmations.
  const children=Object.values(state.cards).filter(child=>child.parentId===card.id);
  // A review below or above changing is shown to people, not pushed down as 上级有调整 (reviews are judged bottom-up).
  if(!isReview(card))for(const child of children)if(!(actor.kind!=='coagent'&&mayRevise(actor,child)))child.upstreamChange={cardId:card.id,version:v.number+1};
  // Other pending proposals on this card: still valid if they touch different fields (carried to the new version);
  // otherwise archived — the card now shows the new version and the old proposal stays only for tracing.
  const changed=Object.keys(patch).filter(k=>JSON.stringify(v.content[k])!==JSON.stringify(patch[k]));
  retireCascadeCards(state,card,v.number+1);
  for(const p of state.proposals||[])if(p.cardId===card.id&&p.status==='pending'&&p.id!==action.viaProposal){if(Object.keys(p.patch).some(k=>changed.includes(k))){p.status='superseded';p.supersededBy=v.number+1;}else p.baseVersion=v.number+1;}
  // 上级跟着看 (陈溪南 2026-10-22 走查第 3 条): a lower card's dates, checks, result or verdict changing can leave what the
  // card above wrote out of date (a PO milestone still on the old day, an RU review still saying "all three missed").
  // Its owner is told and the card shows 下级有调整 until they look; dates the upper card still quotes are named.
  const watched=changed.filter(k=>['time','checks','milestones','result','verdict','verdictReason','targets','tier'].includes(k)),parent=card.parentId&&state.cards[card.parentId];
  if(watched.length&&parent){
   // Dates compared as month/day (11/06 = 11-6); the upper card's own spelling is what the notice quotes.
   const dates=x=>new Map((JSON.stringify(x||'').match(/\d{1,2}[\/-]\d{1,2}/g)||[]).map(d=>{const [m,dd]=d.split(/[\/-]/).map(Number);return [`${m}/${dd}`,d];}));
   const was=dates(watched.map(k=>v.content[k])),now2=dates(watched.map(k=>patch[k])),gone=[...was.keys()].filter(d=>!now2.has(d));
   const upper=currentVersion(parent).content,inUpper=dates(upper),quoted=gone.filter(d=>inUpper.has(d)).map(d=>inUpper.get(d));
   parent.downstreamChange={cardId:card.id,version:v.number+1,fields:watched,staleDates:quoted,at:now};
   const owners=[...new Set(confirmationSlots(parent).map(slot=>slotHolder(state,parent,slot)).concat(upper.owner).flatMap(n=>String(n||'').split(/[、,，]/)).map(n=>n.trim()).filter(n=>n&&n!==nameOf(actor.id)))];
   const what=watched.map(k=>({time:'时间',checks:'验收',milestones:'里程碑',result:'成果',verdict:'判定',verdictReason:'判定理由',targets:'目标对照',tier:'档位'})[k]).join('、');
   if(owners.length)groupNotice(state,parent,`${titleOf(card)}改了${what}，上级${titleOf(parent)}${quoted.length?`还写着 ${quoted.join('、')}，`:'写到的内容'}可能要跟着改，请 ${mentionList(owners)} 看一下。`);
  }
  if(actor.kind!=='coagent'){
   const me=nameOf(actor.id),signers=confirmationSlots(card).map(slot=>slotHolder(state,card,slot)).filter(n=>n&&n!==me);
   const lower=children.map(c=>currentVersion(c).content.owner).filter(n=>n&&n!==me);
   groupNotice(state,card,(action.auto?`Nexus 已按 ${me} 的批注修改${titleOf(card)}，已更新到 v${v.number+1}，可在修订记录里查看或改回。`:`${me}${action.viaProposal?`接受了 Nexus 对${titleOf(card)}的修订`:`修订了${titleOf(card)}`}，已更新到 v${v.number+1}。`)+(signers.length?`请 ${mentionList(signers)} 确认新版本。`:'')+(children.length&&!isReview(card)?`Nexus 正在按拆解规则对照下级 ${children.length} 张卡，有明显冲突的才出修订卡，其余在群里提示。`:''));
   // 下级对齐: the server checks the cards below against this version (nexus-cascade.mjs).
   if(children.length&&!isReview(card)){state.cascadeQueue??=[];state.cascadeQueue=state.cascadeQueue.filter(j=>j.cardId!==card.id);state.cascadeQueue.push({cardId:card.id,from:v.number,to:v.number+1,noticeId:`notice-${state.sequence}`,at:now});}
  }
 }else if(action.type==='acknowledgeImpact'){
  if(!mayRevise(actor,card))fail(403,'请由成果负责人核对上级调整');
  if(action.baseVersion!==v.number)fail(409,'内容已更新，请重新核对');
  delete card.upstreamChange;delete card.downstreamChange;
 }else if(action.type==='confirm'){
  if(actor.kind==='coagent')fail(403,'Nexus 不能代替人确认');
  if(action.baseVersion!==v.number)fail(409,'只能确认当前版本');
  const slots=confirmationSlots(card);
  if(!slots.length)fail(400,'Task 与 Activity 不设握手');
  if(card.upstreamChange)fail(409,'上级成果有调整，请先核对影响再确认');
  // The company review closes the month: every unit and Mission review must be confirmed first (陈溪南 2026-10-21).
  if(isReview(card)&&card.level==='company'){const open=Object.values(state.cards).filter(c=>isReview(c)&&c.level!=='company'&&c.confirmedVersion!==currentVersion(c).number);if(open.length)fail(409,`还有 ${open.length} 份复盘未确认，全部确认后才能确认公司复盘`);}
  const slot=action.slot;
  const authorized=slot==='ceo'?actor.ceo===true:slot==='unitDri'?(actor.unitDri||[]).includes(unitOf(card)):slot==='missionDri'?(isReview(card)?reviewOwners(card).includes(actor.name):(actor.missionDri||[]).includes(card.id)):false;
  if(!slots.includes(slot)||!authorized)fail(403,'没有这一确认职责');
  if(!v.signatures.some(s=>s.slot===slot))v.signatures.push({slot,actorId:actor.id,version:v.number,createdAt:now});
  // Signing after the 下级有调整 notice is having looked at it.
  if(card.downstreamChange&&(actor.ceo||mayRevise(actor,card)))delete card.downstreamChange;
  if(slots.every(s=>v.signatures.some(x=>x.slot===s))){card.confirmedVersion=v.number;retireCascadeCards(state,card,v.number);
   // Confirming the company review starts next month's decomposition; the server picks this up.
   if(isReview(card)&&card.level==='company')state.planHandoff={status:'requested',requestedAt:now,reviewVersion:v.number};
   // The whole unit is done: everyone in its group hears it once.
   const unit=unitOf(card),done=c=>c.confirmedVersion===currentVersion(c).number;
   if(unit!=='company'){const same=c=>unitOf(c)===unit&&(isReview(c)?isReview(card):!isReview(card)&&confirmationSlots(c).length>0);const set=Object.values(state.cards).filter(same);
    const key=isReview(card)?`review:${state.reviewRound?.loadedAt||''}`:`plan:${state.round?.id||''}`;state.unitsDone??={};
    if(set.length&&set.every(done)&&!state.unitsDone[unit+'|'+key]){state.unitsDone[unit+'|'+key]=now;broadcast(state,unit,isReview(card)?`本领域 ${reviewMonth(state)}复盘已全部确认。`:`本领域的计划已全部确认，按此执行。`,{kind:isReview(card)?'review-unit-done':'plan-unit-done',now});}}const names=[...new Set(v.signatures.map(x=>nameOf(x.actorId)))];groupNotice(state,card,`${names.join('、')} 已就${titleOf(card)} v${v.number} 达成共识，按此版本推进。`);}
 }else if(action.type==='deleteComment'){
  const i=state.comments.findIndex(c=>c.id===action.commentId&&c.cardId===card.id);
  if(i<0)fail(404,'批注不存在或已删除');
  if(state.comments[i].author!==actor.id)fail(403,'只能删除自己的批注');
  state.comments.splice(i,1);
 }else if(action.type==='comment'||action.type==='message'){
  if(actor.kind==='coagent')fail(403,'此入口仅用于成员反馈');
  if(typeof action.text!=='string'||!action.text.trim()||action.text.length>8000)fail(400,'请输入有效反馈');
  const target=action.type==='comment'&&action.baseVersion!==undefined?card.versions.find(x=>x.number===action.baseVersion):v;
  if(!target)fail(400,'批注关联的版本不存在');
  const entry={id:`event-${state.sequence+1}`,createdSequence:state.sequence+1,author:actor.id,scope:unitOf(card),cardId:card.id,version:target.number,text:action.text.trim(),block:typeof action.block==='string'?action.block.slice(0,80):'card',createdAt:now,channel:'group'};
  // A comment can sit on one item of a list field (陈溪南 2026-10-23); it keeps which item and that item's text,
  // so whoever reads it (Nexus first) sees exactly what was pointed at.
  if(action.type==='comment'){const val=target.content[entry.block],pick=Array.isArray(val)&&Number.isInteger(action.item)&&action.item>=0&&action.item<val.length?val[action.item]:undefined;
   if(pick!==undefined)entry.item=action.item;
   const raw=pick!==undefined?pick:Array.isArray(val)?undefined:val,txt=typeof raw==='string'?raw:raw&&typeof raw==='object'?(raw.text??[raw.choice,raw.reason].filter(Boolean).join('：')):'';
   if(txt)entry.quote=String(txt).replace(/\*\*/g,'').replace(/\s*(\[E\d+\])+/g,'').trim().slice(0,400);}
  if(action.replyTo){
   const source=[...state.comments,...state.messages,...(state.proposals||[]).map(p=>({...p,channel:'group',author:'Nexus',cardId:p.cardId,version:p.baseVersion,block:'card',text:'拟修改确认：'+Object.entries(p.patch).map(([key,value])=>key+'：'+(Array.isArray(value)?value.join('；'):value)).join('；')}))].find(e=>e.id===action.replyTo&&e.channel==='group'&&e.scope===unitOf(card));
   if(!source)fail(400,'引用消息不在当前领域或已不可用');
   entry.replyTo=source.id;entry.replyToAuthor=source.author;entry.threadId=source.threadId||source.id;
   entry.context=source.context||{scope:source.scope,selection:source.cardId?{id:source.cardId,version:source.version}:null,block:source.block};
   entry.replyPreview={author:source.author,text:source.text.slice(0,120)};
  }
  // Sent from a card page (走查第 2 条): the open card is what the line is about, so Nexus counts it as the basis.
  else if(action.type==='message'&&typeof (action.viewing||action.context?.selection)?.id==='string'){const open=state.cards[(action.viewing||action.context.selection).id];if(open&&unitOf(open)===unitOf(card)&&canRead(actor,open))entry.context={scope:unitOf(card),selection:{id:open.id,version:currentVersion(open).number}};}
  // Answering a question Nexus just asked (without pressing 回复) still counts as talking to Nexus, so it replies
  // promptly instead of waiting out its cooldown (陈溪南 2026-10-19).
  if(!entry.replyTo&&action.type==='message'&&answersNexus(state,entry.scope,actor.id,now))entry.answersNexus=true;
  // A group line typed without replying is about the discussion, not about whichever card happened to be open.
  if(action.type==='message'&&action.general===true&&!entry.replyTo)entry.general=true;
  // Answering a review's 追问 is a comment on its 原因 row that names which question it answers.
  if(action.type==='comment'&&isReview(card)&&action.answers&&Number.isInteger(action.answers.index)&&String(currentVersion(card).content.causes?.[action.answers.index]?.ask||''))entry.answers={index:action.answers.index,ask:String(currentVersion(card).content.causes[action.answers.index].ask).slice(0,300)};
  if(action.type==='message'&&!entry.context&&!entry.general&&action.block&&editable.has(action.block))entry.context={scope:entry.scope,selection:{id:card.id,version:v.number},block:action.block};
  state[action.type==='comment'?'comments':'messages'].push(entry);
  const proposal=confirmationProposal(state,entry);
  if(proposal&&mayRevise(actor,state.cards[proposal.cardId])){
   entry.acceptedProposalId=proposal.id;
   state.sequence++;state.audit.push({id:`audit-${state.sequence}`,actorId:actor.id,type:action.type,cardId:card.id,version:v.number,createdAt:now});
   return applyAction(state,actor,{type:'acceptProposal',cardId:proposal.cardId,proposalId:proposal.id});
  }
  state.nexus??={};const discussion=state.nexus[entry.scope]??={};discussion.topics??=[];
  recordTopic(discussion.topics,entry);
  if(disagrees(entry.text))for(const t of state.nexus?.[entry.scope]?.topics||[]){
   const a=t.anchor,c=entry.context||{selection:{id:entry.cardId},block:entry.block};
   if(a&&(a.threadId&&(entry.threadId||entry.id)===a.threadId||a.cardId===c.selection?.id&&a.block===c.block)){t.status='discussing';t.conclusion='';t.sourceIds=[...new Set([...(t.sourceIds||[]),entry.id])];}
  }
 }else fail(400,'不支持此操作');
 state.sequence++;
 state.audit.push({id:`audit-${state.sequence}`,actorId:actor.id,type:action.type,cardId:card.id,version:currentVersion(card).number,createdAt:now});
 return state;
}
