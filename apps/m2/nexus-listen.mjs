// Nexus listens before it acts (陈溪南 2026-10-19). Every new public line is first read with a small context:
// which topic it belongs to, what the speaker is doing, how far that topic has moved toward a handshake,
// and whether Nexus should step in now. Only "now" runs the full pass. Listening never posts anything.
import {directQuestion} from './nexus-participation.mjs';

// The road every topic travels; each time Nexus speaks it should move one topic one step along it.
export const TOPIC_STAGES=['提出','讨论','有方案','待确认','已定'];
export const INTENTS=['question','proposal','agree','disagree','answer','ack','info','offtopic'];

export const listenSystemPrompt=`你是 Nexus 的“倾听”环节。群里每来新消息，你先静静读懂，不发言。
人在群里说话很随意：常默认大家知道上下文，话很短；常忘了点“回复”；会站在自己的立场说话，有分歧和拉扯。你要像一个一直在场的同事那样理解他们。
对每条新消息判断：
1. topicId：它在接着哪个进行中的话题（看 anchor 指向的卡和字段、被回复的那条、Nexus 刚问过谁、最近在聊什么）。确实是新问题才用 "new"，并给 newTitle（一句大白话，不超过 20 字）。只是表态“同意/收到/不用改”的，归到它表态的那个话题。
2. intent：question 提问 / proposal 提方案或改法 / agree 同意 / disagree 反对或有顾虑 / answer 回答别人的问题 / ack 只是确认收到 / info 补充信息 / offtopic 与计划无关。
3. addressee：在对谁说（人名、"Nexus"、"all" 或 null）。
再判断这批消息之后，涉及到的每个话题推进到哪一步：提出 → 讨论 → 有方案 → 待确认 → 已定。
最后判断 Nexus 要不要现在出场（act）：
- "now"：有人在问 Nexus 或在回答 Nexus 刚提的问题；两人以上对同一件事意见相左且来回两轮没收敛；有人给出了具体改法，而提问的人或负责人表示认可（如“就按这个写”“就这么改”“可以，改吧”），或负责人说“我来改”——这时话题已到“有方案”，Nexus 要马上出修订卡，替负责人把字写好；出现和上级目标、日期、人手的明显冲突。
- "none"：其他情况。大家正常往前讨论、只是表态、补充信息、闲聊时，都不出场。宁可少说，不要打断。
如果出场需要本体原文里的事实（数据、日期、原话），needFacts 为 true；如果要看别的战场或能力域的卡，在 otherUnits 列出它们的 key。
只输出 JSON：{"events":[{"id":消息id,"topicId":话题id或"new","newTitle":string,"intent":string,"addressee":string|null}],"stages":{"话题id，或 new:新话题标题":"阶段"},"act":"now"|"none","reason":"一句话","needFacts":boolean,"otherUnits":[key]}`;

// Small input: the new lines with what they point at, the open topics, and Nexus's last line.
export function listenInput({scope,fresh,evidence,topics,cards,nexusLast,units=[]}){
 const byId=new Map(evidence.map(e=>[e.id,e])),cardById=new Map(cards.map(c=>[c.id,c]));
 const label=c=>c?`${c.aliases?.[0]||c.level} ${c.title}`:null;
 const field=(c,k)=>String(Array.isArray(c[k])?c[k].join('；'):c[k]??'').slice(0,240);
 return {scope,
  units:units.map(u=>({key:u.key||u.id,name:u.name})),
  openTopics:(topics||[]).filter(t=>t.status!=='agreement').slice(-8).map(t=>({id:t.id,title:t.title,stage:t.stage||'讨论',last:(t.quotes||[]).slice(-2).map(q=>String(q.text).slice(0,80))})),
  nexusLast:nexusLast?{text:String(nexusLast.text).slice(0,160),at:nexusLast.createdAt}:null,
  recent:evidence.filter(e=>!fresh.some(f=>f.id===e.id)).slice(-6).map(e=>({id:e.id,author:e.author,text:String(e.text).slice(0,120)})),
  fresh:fresh.map(e=>{const card=cardById.get(e.context?.selection?.id||e.cardId),replied=e.replyTo&&byId.get(e.replyTo),block=e.context?.block;
   return {id:e.id,author:e.author,text:e.text,
    anchor:card?{card:label(card),...(block&&block!=='card'?{field:block,content:field(card,block)}:{})}:null,
    replyTo:replied?{author:replied.author,text:String(replied.text).slice(0,160)}:null,
    answersNexus:e.answersNexus===true};})};
}

// A line that settles a change and asks for it to be written: time for Nexus to draft the card.
export const settles=text=>/(就按(这|那|你|上面|这个|这几|这三|这两)|就这么(写|改|定)|按这个(写|改)|照这个(写|改)|那就改成|改吧|可以这样改|我来改|我改一下|就这样定)/.test(String(text||''));
// Keep only what can be trusted; rules the model cannot overrule are applied here.
export function parseListen(value,{fresh,topics}){
 const ids=new Set(fresh.map(e=>e.id)),topicIds=new Set((topics||[]).map(t=>t.id));
 const events=(Array.isArray(value?.events)?value.events:[]).filter(e=>ids.has(e?.id)).map(e=>({id:e.id,
  topicId:topicIds.has(e.topicId)?e.topicId:'new',newTitle:String(e.newTitle||'').trim().slice(0,30),
  intent:INTENTS.includes(e.intent)?e.intent:'info',addressee:typeof e.addressee==='string'?e.addressee:null}));
 const stages=Object.fromEntries(Object.entries(value?.stages&&typeof value.stages==='object'?value.stages:{}).filter(([,s])=>TOPIC_STAGES.includes(s)));
 // Being asked, or answering what Nexus just asked, always brings Nexus in; so does a topic that now has an agreed
 // change ("就按这个写", "我来改"): that is the moment to draft the revision card. The model only adds reasons.
 const called=fresh.some(directQuestion),ripe=Object.values(stages).includes('有方案')||fresh.some(e=>settles(e.text));
 return {events,stages,act:called||ripe||value?.act==='now'?'now':'none',called,ripe,reason:String(value?.reason||'').slice(0,120),
  needFacts:value?.needFacts===true,otherUnits:(Array.isArray(value?.otherUnits)?value.otherUnits:[]).map(String).slice(0,3)};
}

// Re-file the new lines under the topics the listener chose; a line sits in exactly one topic.
export function applyListen(topics,decision,fresh,now=new Date().toISOString()){
 const out=structuredClone(topics||[]),byId=new Map(fresh.map(e=>[e.id,e]));
 for(const ev of decision.events){
  const e=byId.get(ev.id);if(!e)continue;
  if(['ack','offtopic'].includes(ev.intent)&&ev.topicId==='new'){for(const t of out){t.sourceIds=(t.sourceIds||[]).filter(id=>id!==e.id);t.quotes=(t.quotes||[]).filter(q=>q.id!==e.id);}continue;}
  for(const t of out){t.sourceIds=(t.sourceIds||[]).filter(id=>id!==e.id);t.quotes=(t.quotes||[]).filter(q=>q.id!==e.id);}
  let target=ev.topicId!=='new'&&out.find(t=>t.id===ev.topicId);
  if(!target){target={id:`t-${e.id}`,anchor:{threadId:e.id},title:ev.newTitle||String(e.text).slice(0,20),status:'pending',conclusion:'',sourceIds:[],quotes:[],stage:'提出'};out.push(target);}
  target.sourceIds=[...target.sourceIds,e.id];target.quotes=[...target.quotes,{id:e.id,text:e.text}];target.updatedAt=e.createdAt||now;
  if(target.status==='pending'&&target.sourceIds.length>1)target.status='discussing';
  if(ev.intent==='disagree'&&target.status==='agreement')target.status='discussing';
 }
 for(const t of out){const stage=decision.stages[t.id]??Object.entries(decision.stages).find(([k])=>k.startsWith('new:')&&k.slice(4)===t.title)?.[1];if(stage)t.stage=stage;}
 // Topics emptied by re-filing disappear; nothing else is dropped.
 return out.filter(t=>(t.sourceIds||[]).length);
}
