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
 if(/(?:别|不要|不能|不应|不想|不建议).{0,30}(?:改|修改|调整|删|补|加)|假如|如果|例如|比如|举例|讨论|能否|可否|想听/.test(text))return false;
 if(!text||event.answers||/[?？]|是否|要不要|能不能|可不可以|(?:吗|呢|么)[。！!\s]*$|(?:不要|不用|无需|不必|没必要).{0,4}(?:改|修改|调整|删)/.test(text))return false;
 if(!/(?:改成|改为|修改为|调整为|换成|设为|写成|删掉|删除|去掉|补上|增加|新增|补充|加上|加一句|补一句)\s*[^，。；;\s]+/.test(text))return false;
 const selected=event.context?.selection?.id||(!event.general&&event.cardId);
 if(selected)return selected===card.id;
 const title=currentVersion(card).content.title;
 const mentioned=Object.values(state.cards).filter(c=>c.kind===card.kind&&currentVersion(c).content.title&&text.includes(currentVersion(c).content.title));
 return !!title&&mentioned.length===1&&mentioned[0].id===card.id;
}
function ownerRequestedPaths(event,card,state){
 const text=String(event.text||''),map={verdict:'结果判定|判定(?!理由)',verdictReason:'判定理由',facts:'事实证据|证据|原因',nextInputs:'下期输入',title:'标题|名称',result:'成果|结果',checks:'验收|标准|经济性',time:'日期|时间',tier:'档位',owner:'负责人',dependencies:'依赖',path:'路径',boundary:'边界',milestones:'里程碑'};
 const fields=new Set(Object.entries(map).filter(([,pattern])=>new RegExp(pattern).test(text)).map(([key])=>key));
 const block=event.context?.block||event.block;if(block&&block!=='card')fields.add(block);
 const v=currentVersion(card).content,index=event.context?.item??event.item;
 return [...fields].flatMap(field=>{if(['facts','nextInputs'].includes(field)&&Number.isInteger(index)){const row=v[field]?.[index],ref=row?.ref||row?.id;return ref?[field+'/'+ref]:[];}return [field];});
}
export function applyOwnerAnnotations(state,scope){
 let next=state;
 for(const p of (state.proposals||[]).filter(p=>p.scope===scope&&p.status==='pending')){
  if(p.requiresConfirmation||p.op||p.basis==='cascade'||p.fromParent||p.fromMission)continue;
  const card=next.cards[p.cardId],sources=[...next.comments,...next.messages].filter(e=>p.sourceIds.includes(e.id));
  const authors=new Set(sources.map(e=>e.author));
  if(!card||roomOf(card)!==scope||authors.size!==1||!sources.length||!sources.every(e=>e.channel==='group'&&e.scope===scope&&explicitOwnerEdit(e,card,next)))continue;
  const requested=sources.flatMap(event=>ownerRequestedPaths(event,card,next));
  if(patchPaths(p.before,p.patch).some(path=>!pathsOverlap([path],requested)))continue;
  let actor;try{actor=memberActor([...authors][0],next);}catch{continue;}const v=currentVersion(card);
  if(!mayRevise(actor,card)||!String(v.content.owner||'').split(/[、,，\s]+/).includes(actor.name)||v.signatures?.length||card.confirmedVersion===v.number)continue;
  if(sources.some(e=>(e.context?.selection?.version??e.version)!=null&&(e.context?.selection?.version??e.version)!==v.number))continue;
  try{next=applyAction(next,actor,{type:'acceptProposal',cardId:p.cardId,proposalId:p.id,auto:true});}catch{}
 }
 return next;
}
