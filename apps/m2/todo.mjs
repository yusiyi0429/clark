// Display-only: what needs this member's attention now, so a review afternoon has a clear queue.
// Order: proposals to accept → upper-level changes to check → versions the other side already signed →
// @mentions → new comments on my cards → versions nobody has signed yet.
import {disagrees,agrees} from './stance.mjs';
// 签字方反对要有出路 (陈溪南 2026-10-22 走查第 2 条): someone else objecting on my card, with no word from me since, waits on me.
export function openObjections(list=[],name){
 const sorted=[...list].sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
 const lastMine=sorted.filter(c=>c.author===name).at(-1)?.createdAt||'';
 return sorted.filter(c=>c.author!==name&&c.author!=='Nexus'&&String(c.createdAt||'')>lastMine&&disagrees(c.text)&&!agrees(c.text));
}
const flat=units=>{const out=[];const walk=(n,parent)=>{out.push({n,parent});(n.children||[]).forEach(c=>walk(c,n));};(units||[]).forEach(u=>walk(u,null));return out;};
const slotsOf=n=>n.level==='po'?['ceo','unitDri']:n.level==='mission'?['unitDri','missionDri']:[];
const time=v=>Date.parse(v||'')||0;
// One upper revision seen on a lower card: opening the card counts as having seen that change (陈溪南 2026-10-19).
export const upstreamKey=n=>n?.upstreamChange?`upstream:${n.id}@${n.upstreamChange.cardId}v${n.upstreamChange.version}`:null;
export function todoItems({units,drafts={},records={},comments={},profile,name,seen={}}){
 if(!profile)return [];
 const card=n=>({...n,...drafts[n.id]});
 const allowed=(slot,n)=>slot==='ceo'?!!profile.ceo:slot==='unitDri'?(profile.unitDri||[]).includes(n.unit||n.id):(profile.missions||[]).includes(n.id);
 const mayCheck=n=>n.level==='po'?(profile.unitDri||[]).includes(n.unit||n.id):(profile.missions||[]).includes(n.level==='mission'?n.id:String(n.id).split('-t')[0]);
 const mine=n=>n.owner===name||n.level==='po'&&(profile.unitDri||[]).includes(n.id)||(profile.missions||[]).includes(n.id);
 const items=[],nodes=flat(units).map(({n,parent})=>({n:card(n),parent}));
 for(const [room,list] of Object.entries(records))if(room.startsWith('group:'))for(const m of list||[])
  if(m.kind==='revision-proposal'&&m.status==='pending'&&!m.stale&&m.canAccept)items.push({kind:'proposal',rank:0,cardId:m.cardId,scope:room.slice(6),id:m.id,at:time(m.createdAt)});
 // Lower cards flagged after an upper revision: one item per parent so six Tasks do not become six lines.
 const upstream=new Map();
 for(const {n,parent} of nodes)if(n.upstreamChange&&mayCheck(n)&&!seen[upstreamKey(n)]){const key=n.level==='task'&&parent?parent.id:n.id;if(!upstream.has(key))upstream.set(key,{kind:'upstream',rank:1,cardId:n.id,groupId:key,count:0});upstream.get(key).count++;}
 items.push(...upstream.values());
 // A card below mine changed what mine may quote (dates, checks, verdict): one line per card (2026-10-22).
 for(const {n} of nodes)if(n.downstreamChange&&mine(n))items.push({kind:'downstream',rank:1,cardId:n.id,childId:n.downstreamChange.cardId,staleDates:n.downstreamChange.staleDates||[],at:time(n.downstreamChange.at)});
 for(const {n} of nodes){const slots=slotsOf(n);if(!slots.length||n.upstreamChange)continue;const signed=s=>(n.signatures||[]).some(x=>x.slot===s);
  for(const slot of slots)if(allowed(slot,n)&&!signed(slot)){const other=slots.some(s=>s!==slot&&signed(s));items.push({kind:'sign',rank:other?2:5,cardId:n.id,version:n.version,otherSigned:other});break;}}
 for(const [room,list] of Object.entries(records))if(room.startsWith('group:'))for(const m of list||[])
  // Only lines that name this member; notices to everyone (@所有人) stay in the group, not the queue (陈溪南 2026-10-22).
  if(m.author!==name&&m.kind!=='notice'&&!m.broadcast&&String(m.text||'').includes('@'+name)&&time(m.createdAt)>(seen[room]||0))items.push({kind:'mention',rank:3,scope:room.slice(6),id:m.id,author:m.author,text:m.text,at:time(m.createdAt)});
 for(const {n} of nodes){const against=mine(n)?openObjections(comments[n.id],name):[];if(against.length)items.push({kind:'objection',rank:1,cardId:n.id,id:against.at(-1).id,author:against.at(-1).author,text:against.at(-1).text,count:against.length,at:time(against.at(-1).createdAt)});}
 for(const {n} of nodes){const fresh=(comments[n.id]||[]).filter(c=>c.author!==name&&time(c.createdAt)>(seen['card:'+n.id]||0));if(fresh.length&&mine(n))items.push({kind:'comment',rank:4,cardId:n.id,count:fresh.length,at:Math.max(...fresh.map(c=>time(c.createdAt)))});}
 return items.sort((a,b)=>a.rank-b.rank||(b.at||0)-(a.at||0));
}
// Messages in a room the member has not seen yet (others' only).
export function unreadCount(list,name,seenAt){return (list||[]).filter(m=>m.author!==name&&(Date.parse(m.createdAt||'')||0)>(seenAt||0)).length;}
// Nexus shows "thinking" only when someone addressed it (@Nexus or a reply to Nexus). Otherwise it listens quietly,
// like a person in the room, and simply posts if it decides to speak (陈溪南 2026-10-19).
export function nexusAddressed(list=[]){
 const human=list.filter(m=>m.author!=='Nexus'&&m.kind!=='notice').at(-1);
 return !!human&&(human.answersNexus===true||/@\s*Nexus/i.test(human.text||'')||list.some(m=>m.id===human.replyTo&&m.author==='Nexus'));
}
// Private Agent chat quotes like the group (陈溪南 2026-10-19): a question quotes the card it was asked on,
// an answer quotes the question it answers — so a long running conversation still says what each line is about.
export function privateQuote(list,i,{name,cardLabel}){
 const m=list[i],sel=m?.context?.selection;if(!m||!sel?.id)return null;
 const card=cardLabel(sel.id);
 if(m.author!=='Agent')return card?{card:true,label:`${card.ref} · v${sel.version}`,text:card.title}:null;
 const asked=list.slice(0,i).reverse().find(x=>x.author!=='Agent');if(!asked)return null;
 const text=String(asked.text||'').replace(/\s+/g,' ');
 return {author:name,text:`${card?`${card.ref}｜`:''}${text.length>40?text.slice(0,40)+'…':text}`};
}
