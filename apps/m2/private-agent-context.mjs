import {canRead,currentVersion,cardStatus,mayRevise,confirmationSlots,insightView} from './governance.mjs';
import {nowContext} from './time-context.mjs';
import {memberProfiles} from './member-profiles.mjs';
const name=id=>memberProfiles[id]?.name||id;
const fail=message=>{throw Object.assign(Error(message),{status:403});};
const fields=['id','level','name','unit','owner','title','result','time','why','boundary','path','dependencies','checks','logic','handoffs','parentLtoReference','tradeoff','expectedProgress','milestones',
 // Review cards (评测 2026-10-26: the Agent on a review page could not see the review itself).
 'kind','ref','verdict','verdictReason','facts','targets','causes','nextInputs','ltoReview'];
export function privateAgentContext(state,actor,requested={},sourceFallback=[],now=Date.now()){
 const readable=Object.values(state.cards).filter(c=>canRead(actor,c)),byId=new Map(readable.map(c=>[c.id,c]));
 const selected=requested.selection?.id?byId.get(requested.selection.id):null;
 if(requested.selection?.id&&!selected)fail('当前页面不在成员可见范围内');
 const scope=selected?(selected.unit||selected.id):requested.scope||null;
 // The company review has no plan card named 'company'; a scope is visible when any readable card belongs to it.
 if(scope&&!byId.has(scope)&&!readable.some(c=>(c.unit||c.id)===scope))fail('当前领域不在成员可见范围内');
 const selection=selected?{id:selected.id,version:currentVersion(selected).number,level:selected.level}:null;
 const view={scope,selection,canvasView:requested.canvasView==='gantt'?'gantt':'document',expanded:(Array.isArray(requested.expanded)?requested.expanded:[]).filter(id=>byId.has(id)).slice(0,100)};
 const pageCards=selected?[selected,...readable.filter(c=>c.parentId===selected.id)]:scope?readable.filter(c=>(c.unit||c.id)===scope):view.canvasView==='document'&&!actor.ceo?readable.filter(c=>!c.parentId&&actor.unitDri?.includes(c.id)||c.level==='mission'&&actor.missionDri?.includes(c.id)&&!actor.unitDri?.includes(c.unit)):readable.filter(c=>!c.parentId);
 const ids=new Set(pageCards.map(c=>c.id));
 // Insights as this member may see them: their own before the reveal, everyone's after.
 const project=c=>{const v=currentVersion(c),ins=c.kind==='review'?insightView(state,c,actor):undefined;return {...Object.fromEntries(fields.filter(k=>v.content[k]!==undefined).map(k=>[k,v.content[k]])),...(c.kind==='review'?{kind:'review'}:{}),version:v.number,status:cardStatus(c),mayRevise:mayRevise(actor,c),upstreamChange:c.upstreamChange,...(ins?{insights:ins.revealed?{revealed:true,items:ins.items.map(({author,text})=>({author,text})),nexus:ins.nexus?.text||null}:{revealed:false,mine:ins.mine.map(x=>x.text),submitters:ins.submitters}}:{})};};
 const ancestors=[];for(let c=selected;c?.parentId&&byId.has(c.parentId);){c=byId.get(c.parentId);ancestors.unshift(project(c));}
 const relevantPrivate=e=>{const v=e.context||{};return selection?v.selection?.id===selection.id||!v.selection?.id&&v.scope===scope:scope?v.scope===scope:!v.scope&&!v.selection?.id;};
 const relevantPublic=e=>e.scope===scope&&(!e.context?.selection?.id||!e.context?.block||e.context.block==='card'||ids.has(e.context.selection.id));
 const show=(e,kind)=>{const id=e.context?.selection?.id||e.cardId,version=e.context?.selection?.version||e.version;return {id:e.id,author:name(e.author),kind,text:String(e.text).slice(0,5000),createdAt:e.createdAt,replyTo:e.replyTo,threadId:e.threadId,selection:id?{id,version}:null,block:e.context?.block||e.block,stale:!!id&&byId.has(id)&&version!==undefined&&version!==currentVersion(byId.get(id)).number};};
 const privateHistory=state.messages.filter(e=>e.channel==='private'&&e.memberId===actor.id&&relevantPrivate(e)).slice(-20).map(e=>show(e,'private-chat'));
 const groupChat=state.messages.filter(e=>e.channel==='group'&&relevantPublic(e)).slice(-30).map(e=>show(e,'group-chat'));
 const annotations=state.comments.filter(e=>e.channel==='group'&&ids.has(e.cardId)).slice(-40).map(e=>show(e,'document-comment'));
 const allowedScopes=new Set(scope?[scope]:readable.filter(c=>!c.parentId).map(c=>c.id));
 const rawSources=(state.round?.input?.sources||sourceFallback).filter(s=>['company','organization'].includes(s.key)||allowedScopes.has(s.key)).sort((a,b)=>Number(allowedScopes.has(b.key))-Number(allowedScopes.has(a.key)));
 let budget=24000;
 const sources=rawSources.map(s=>{const raw=String(s.content||s.response?.data?.document?.content||'');const content=raw.slice(0,Math.min(6000,budget));budget-=content.length;return {title:s.title,key:s.key,revision:s.revision,content,truncated:content.length<raw.length};}).filter(s=>s.content);
 // Where confirmations stand across everything this member can see, whatever page is open:
 // "which ones have I confirmed / are waiting on me" must not depend on the current page.
 const progress=confirmationProgress(state,actor,readable);
 return {now:nowContext(now),view,progress,member:{id:actor.id,name:actor.name||name(actor.id),ceo:actor.ceo,unitDri:actor.unitDri,missionDri:actor.missionDri},page:{cards:pageCards.map(project),ancestors,clientVersion:requested.selection?.version,staleClient:!!selection&&requested.selection?.version!==undefined&&selection.version!==requested.selection.version},privateHistory,groupChat,annotations,sources,limits:{privateHistory:20,groupChat:30,annotations:40,backgroundCharacters:24000},round:state.round?.number||6};
}

export function confirmationProgress(state,actor,readable){
 const confirmable=readable.filter(c=>confirmationSlots(c).length);
 const unitTitle=c=>currentVersion(state.cards[c.unit||c.id]||c).content.title;
 const label=c=>{const v=currentVersion(c);return {title:v.content.title,level:c.level,domain:c.level==='po'?undefined:unitTitle(c),version:v.number,status:cardStatus(c)};};
 const mine=c=>confirmationSlots(c).filter(slot=>slot==='ceo'?actor.ceo===true:slot==='unitDri'?(actor.unitDri||[]).includes(c.unit||c.id):(actor.missionDri||[]).includes(c.id));
 const signedBy=c=>currentVersion(c).signatures.map(s=>name(s.actorId));
 const counts={};for(const c of confirmable){const level=counts[c.level]??={};const st=cardStatus(c);level[st]=(level[st]||0)+1;}
 const cap=list=>list.slice(0,30);
 const scopes=new Set(readable.filter(c=>!c.parentId).map(c=>c.id));
 return {
  counts,
  confirmedByMe:cap(confirmable.filter(c=>currentVersion(c).signatures.some(s=>s.actorId===actor.id)).map(c=>({...label(c),signedBy:signedBy(c)}))),
  waitingForMe:cap(confirmable.filter(c=>!c.upstreamChange&&mine(c).some(slot=>!currentVersion(c).signatures.some(s=>s.slot===slot))).map(c=>({...label(c),otherSideConfirmed:currentVersion(c).signatures.length>0,signedBy:signedBy(c)}))),
  waitingForOthers:cap(confirmable.filter(c=>cardStatus(c)==='待另一方确认'&&currentVersion(c).signatures.some(s=>s.actorId===actor.id)).map(label)),
  recentConsensus:state.messages.filter(m=>m.kind==='notice'&&scopes.has(m.scope)&&/达成共识|已确认「/.test(m.text)).slice(-10).map(m=>({text:m.text,createdAt:m.createdAt})),
 };
}
