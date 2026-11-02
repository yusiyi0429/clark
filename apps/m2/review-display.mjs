import {activeReviewAsk} from './review-question-routing.mjs';
import {openObjections} from './todo.mjs';
// 复盘 page logic (陈溪南 2026-10-20/21): which reviews each person sees first, the unit tree, and how fields read.
export const isReviewId=id=>String(id).startsWith('rv:');
export const verdictTone=v=>({'达成':'ok','部分达成':'part','未达成':'no'})[v]||'none';
export const ownerNames=r=>String(r?.owner||'').split(/[、,，\s]+/).filter(Boolean);
// The review cards a member can see, as nodes with parent and children (company → unit PO → Missions).
// unitOrder: the plan's unit order (battlefields first, then domains by number), so both stages list units alike.
export function reviewTree(drafts,unitOrder=[]){
 const nodes=Object.entries(drafts||{}).filter(([id])=>isReviewId(id)).map(([id,d])=>({...d,id,version:d.version||(d.history?.length||0)+1,children:[]}));
 const byId=new Map(nodes.map(n=>[n.id,n]));
 for(const n of nodes){n.parentId=n.level==='mission'?'rv:'+n.unit:n.level==='po'?'rv:company':null;byId.get(n.parentId)?.children.push(n);}
 const order=n=>n.level==='company'?0:n.level==='po'?1:2;
 for(const n of nodes)n.children.sort((a,b)=>String(a.ref).localeCompare(String(b.ref),'en',{numeric:true}));
 const pos=u=>{const i=unitOrder.indexOf(u);return i<0?999:i;};
 return {nodes:nodes.sort((a,b)=>order(a)-order(b)||pos(a.unit)-pos(b.unit)||String(a.ref).localeCompare(String(b.ref),'en',{numeric:true})),byId};
}
// Slots and who holds them, the same as the plan; a review Mission is held by whoever the review names.
// A Mission review (个人复盘) is confirmed by its owner alone; the unit DRI reads, comments and revises (陈溪南 2026-10-27).
export const reviewSlots=n=>n.level==='company'?['ceo']:n.level==='po'?['ceo','unitDri']:['missionDri'];
// 个人复盘: one document per person, holding the Missions they own (陈溪南 2026-10-27).
export const personId=name=>'rv:person:'+name;
// Missions with no owner in the ontology (ownerAssigned:false) gather under 未指派, not under the unit DRI who signs them.
export const personCards=(nodes,name)=>nodes.filter(n=>n.level==='mission'&&(name==='未指派'?n.ownerAssigned===false:n.ownerAssigned!==false&&ownerNames(n).includes(name)));
export function maySign(n,slot,p){return slot==='ceo'?p.ceo===true:slot==='unitDri'?(p.unitDri||[]).includes(n.unit):ownerNames(n).includes(p.name);}
// Directly mine: CEO → company and every unit PO; unit DRI → own unit PO and its Missions; Mission owner → own Mission and its unit PO.
export function mineFirst(nodes,p){
 const mine=new Set();
 for(const n of nodes){
  if(p.ceo&&(n.level==='company'||n.level==='po'))mine.add(n.id);
  if((p.unitDri||[]).includes(n.unit)&&n.level==='po')mine.add(n.id);
  if(n.level==='mission'&&ownerNames(n).includes(p.name)){mine.add(n.id);mine.add('rv:'+n.unit);}
  // Others' Mission reviews are reached from their unit review's reference list, not the home (陈溪南 2026-10-27).
 }
 return nodes.filter(n=>mine.has(n.id));
}
// What waits on this person: a slot to sign on the current version, and questions put to them not yet answered.
// Items in the same shape as the plan's 待我处理, so both stages share one panel.
export function reviewTodos(nodes,p,comments={},proposals=[]){
 const out=[];
 // A unit review's 下级有调整 is the CEO's to look at as well: the CEO signs it and is the one the notice names.
 for(const n of nodes)if(n.downstreamChange&&(ownerNames(n).includes(p.name)||n.level==='company'&&p.ceo||n.level==='po'&&((p.unitDri||[]).includes(n.unit)||p.ceo)))out.push({kind:'downstream',cardId:n.id,childId:n.downstreamChange.cardId});
 for(const n of nodes){const against=ownerNames(n).includes(p.name)?openObjections(comments[n.id],p.name):[];if(against.length)out.push({kind:'objection',cardId:n.id,id:against.at(-1).id,author:against.at(-1).author,text:against.at(-1).text,count:against.length});}
 for(const r of proposals)if(isReviewId(r.cardId)&&r.status==='pending'&&!r.stale&&r.canAccept)out.push({kind:'proposal',cardId:r.cardId,id:r.id});
 // 待提交洞察 (2026-10-26): a participant who has not written one yet, until the insights are revealed.
 for(const n of nodes)if(Array.isArray(n.facts)&&n.insights&&!n.insights.revealed&&(n.insights.missing||[]).includes(p.name))out.push({kind:'insight',cardId:n.id});
 for(const n of nodes){
  // One line per review for its open 追问, and none once the review is confirmed (陈溪南 2026-10-22).
  const asks=ownerNames(n).includes(p.name)&&n.status!=='已确认'?(n.causes||[]).map((c,i)=>c?.ask&&!answerOf(comments[n.id],i)?i:null).filter(i=>i!=null):[];
  if(asks.length)out.push({kind:'ask',cardId:n.id,index:asks[0],count:asks.length});
  // 下期输入 that name someone (2026-10-27): on the named person's list, whoever owns the review, until answered or confirmed.
  const named=n.status!=='已确认'?(n.nextInputs||[]).map((x,i)=>activeReviewAsk(x)?.to===p.name&&!answerOf(comments[n.id],i,'nextInputs')?i:null).filter(i=>i!=null):[];
  if(named.length)out.push({kind:'ask',cardId:n.id,index:named[0],count:named.length,block:'nextInputs'});
  const slots=reviewSlots(n),signed=slot=>(n.signatures||[]).some(s=>s.slot===slot),mine=slots.find(slot=>maySign(n,slot,p)&&!signed(slot));
  // The company review can only be confirmed once every other review is; until then it is not on anyone's list.
  const waiting=n.level==='company'&&nodes.some(x=>x.level!=='company'&&x.status!=='已确认');
  if(mine&&!waiting)out.push({kind:'sign',cardId:n.id,version:n.version,otherSigned:slots.some(s=>s!==mine&&signed(s))});
 }
 return out;
}
export const answerOf=(list=[],index,block='causes')=>[...list].reverse().find(c=>(c.answers?.block||c.block)===block&&c.answers?.index===index);
// 「**资料包交下游（部分达成）：**正文」→ {name, verdict, text}
export function targetParts(t){const m=String(t).match(/^\*\*(.+?)（(达成|部分达成|未达成)）：\*\*\s*([\s\S]*)$/);return m?{name:m[1],verdict:m[2],text:m[3]}:{name:'',verdict:'',text:String(t)};}
// Text pieces: **bold**, [E5] evidence marks, plain text.
// Evidence marks ([E5]) are for checking the generation, not for readers: they are dropped from the page.
export function richParts(text,referenceMap){const body=referenceMap===undefined?String(text||'').replace(/\s*\[E\d+\]/g,''):String(text||'').replace(/\s*(\[[^\[\]\r\n]+\])/g,(raw,marker)=>Object.hasOwn(referenceMap,marker)?'':raw);return body.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(s=>s.startsWith('**')&&s.endsWith('**')?{bold:s.slice(2,-2)}:{text:s});}
export function reviewSentence(text,referenceMap){
 const x=String(text||'').trim();let core=x;
 if(referenceMap===undefined)core=x.replace(/(\s*\[E\d+\])+\s*$/,'');
 else for(;;){const tail=/\s*(\[[^\[\]\r\n]+\])\s*$/.exec(core);if(!tail||!Object.hasOwn(referenceMap,tail[1]))break;core=core.slice(0,tail.index);}
 return /[。！？.!?]$/.test(core)||/[。！？.!?][」）)]$/.test(core)?x:core+'。'+x.slice(core.length).trim();
}
export function recordLine(f,cutoff='2026-10-15'){if(!f||!f.latestRecord)return {text:'本月没有进展记录',warn:true};const d=f.latestRecord.slice(5).replace('-','/').replace(/^0/,'').replace('/0','/');return {text:`记录截至 ${d} · ${f.progressRecords} 条`,warn:f.latestRecord<cutoff};}
export const reviewLabel=n=>n.level==='company'?'公司复盘':n.level==='po'?'PO 复盘':`Mission ${Number(String(n.ref).match(/-m(\d+)$/)?.[1])||''}`;
// 2026-10 → 2026-11, and how a month reads on the page (10 月).
export const nextPeriod=period=>{const m=String(period||'').match(/^(\d{4})-(\d{2})$/);if(!m)return null;const y=+m[1],mo=+m[2]+1;return mo>12?`${y+1}-01`:`${y}-${String(mo).padStart(2,'0')}`;};
export const monthOf=period=>{const m=String(period||'').match(/-(\d{2})$/);return m?`${Number(m[1])} 月`:'';};

// Home cards say whose confirmation is missing, from the viewer's side (陈溪南 2026-10-22): 待你确认 when it is yours,
// 待 某人 确认 when it is someone else's, and 已改到 vN when a new version is why it is open again.
export function confirmState({status,version,signatures=[],slots,holder,mine}){
 if(!slots?.length||status==='已确认'||/上级|下级/.test(String(status||'')))return {text:status,mine:false};
 const missing=slots.filter(s=>!signatures.some(x=>x.slot===s));if(!missing.length)return {text:status,mine:false};
 const ver=version>1?` · 已改到 v${version}`:'';
 if(missing.some(mine))return {text:`待你确认${ver}`,mine:true};
 const names=[...new Set(missing.map(holder).flatMap(n=>String(n||'').split(/[、,，]/)).map(x=>x.trim()).filter(Boolean))];
 return {text:`待 ${names.join('、')||'对方'} 确认${ver}`,mine:false};
}

// One tag for a Mission: its unit's short name and its number, e.g. “Agents · Mission 3” (陈溪南 2026-10-23).
export const unitShort=label=>String(label||'').replace(/^(Battlefield|Domain)\s*\d+\s*/,'').trim()||String(label||'');

// One home entry per object, grouped by actual signing responsibility.
export function reviewHomeGroups(nodes,profile){
 const visible=mineFirst(nodes,profile),entries=visible.filter(n=>n.level!=='mission').map(n=>({node:n,cards:[n],key:n.id}));
 for(const person of [...new Set(visible.filter(n=>n.level==='mission').map(n=>n.ownerAssigned===false?'未指派':ownerNames(n)[0]))]){
  const cards=personCards(visible,person);entries.push({person,cards,key:personId(person)});
 }
 const signs=e=>e.cards.some(n=>reviewSlots(n).some(slot=>maySign(n,slot,profile)));
 return {confirm:entries.filter(signs),watch:entries.filter(e=>!signs(e))};
}
