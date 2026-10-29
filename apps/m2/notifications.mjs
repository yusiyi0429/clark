// 通知卡片 (陈溪南 2026-10-26/27): what Tianshu's notification centre shows for one member, merged so a person sees one
// or two cards, not a stream. Four kinds only:
//   stage:review / stage:plan — one stable card for the stage in progress: the review until the company review is confirmed, then the plan (生成中 → 进行中 → 全部确认);
//   todo:review / todo:plan — 我的待办 for that stage (sign, revision cards, review questions, objections, checks); the review card carries dueAt;
//   mention:<unit>          — @我 in one unit group (Nexus answering my question counts too);
//   failure:round / failure:review — a generation that failed, for the M2 admin only (M2_FAILURE_NOTIFY, default 陈溪南).
// Read-only over the collaboration state. Read marks live in their own small file, so this never touches plans or
// reviews, and M2 works the same whether or not anyone calls it.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sharedProjection,memberActor} from './shared-projection.mjs';
import {memberProfiles} from './member-profiles.mjs';
import {currentVersion,confirmationSlots} from './governance.mjs';
import {todoItems} from './todo.mjs';
import {reviewTree,reviewTodos} from './review-display.mjs';
import {reviewDueAt} from './review-round.mjs';

const time=v=>Date.parse(v||'')||0;
const iso=v=>v?new Date(v).toISOString():null;
const latest=list=>list.reduce((a,b)=>Math.max(a,b),0);
// Links are relative to the M2 page (Tianshu prefixes /m2/); the page reads these parameters to open the right place.
const link=params=>'?'+new URLSearchParams(params).toString();
const FAILURE_TO=(process.env.M2_FAILURE_NOTIFY||'陈溪南').split(/[、,，]/).map(x=>x.trim()).filter(Boolean);
const TODO_WORDS={insight:'份复盘待写洞察',sign:'份待确认',proposal:'张修订卡待决定',ask:'个追问待回答',objection:'处反对待回应',upstream:'处上级调整待核对',downstream:'处下级调整待核对'};

function todoCard(stage,items,label){
 if(!items.length)return null;
 const counts={};for(const i of items){const k=i.kind;counts[k]=(counts[k]||0)+(k==='ask'?i.count||1:1);}
 const order=['sign','insight','proposal','ask','objection','upstream','downstream'];
 const text=order.filter(k=>counts[k]).map(k=>`${counts[k]} ${TODO_WORDS[k]}`).join('、');
 const first=items[0];
 return {id:`todo:${stage}`,type:'todo',stage,title:`${label}：你有待办`,text,count:items.length,breakdown:counts,
  link:link({stage,todo:'1',...(first?.cardId?{card:first.cardId}:{})}),updatedAt:iso(latest(items.map(i=>i.at||0)))};
}

export function notificationsFor(state,memberId,{reads={},jobs={},now=Date.now()}={}){
 const profile=memberProfiles[memberId];if(!profile)return [];
 const actor=memberActor(memberId,state),view=sharedProjection(state,actor),name=actor.name;
 const p={...profile,name,ceo:actor.ceo===true,unitDri:actor.unitDri||[],missions:actor.missionDri||[],units:actor.visibleUnits};
 const drafts=view.drafts||{},comments=view.comments||{},records=view.records||{};
 const cards=[];
 // 环节卡: one per stage, the start notice turning into the done notice (陈溪南 2026-10-27; comments no longer get a card).
 const hm=v=>{const d=new Date(Date.parse(v)+8*3600e3);return `${d.getUTCMonth()+1}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;};
 const signedAt=list=>latest(list.flatMap(c=>c.versions.flatMap(v=>v.signatures.map(x=>time(x.createdAt)))));
 const reviewCards=Object.values(state.cards).filter(c=>c.kind==='review'),seesReview=Object.keys(drafts).some(id=>id.startsWith('rv:'));
 // 一张稳定的环节卡 (陈溪南 2026-10-28): the review card stays until the company review is confirmed; then it gives way to the
 // plan card, which shows from 「生成中」 until the whole plan is confirmed. One stage card at a time.
 const company=reviewCards.find(c=>c.level==='company'),reviewDone=!!company&&company.confirmedVersion===currentVersion(company).number;
 if(state.reviewRound&&seesReview&&!reviewDone){const month=(m=>m?`${Number(m[1])} 月`:'')(String(state.reviewRound.period||'').match(/-(\d{2})$/)),due=reviewDueAt(state.reviewRound);
  cards.push({id:'stage:review',type:'stage',stage:'review',status:'open',title:`${month}复盘进行中`,text:due&&now>Date.parse(due)?`已过截止时间（${hm(due)}），还没确认的请尽快确认`:`点这里去复盘，${due?hm(due)+' 前确认':'按时确认'}`,count:1,link:link({stage:'review'}),updatedAt:iso(time(state.reviewRound.loadedAt)),...(due?{dueAt:due}:{})});}
 // 我的待办 · 复盘
 const review=state.reviewRound,month=(p=>{const m=String(p||'').match(/-(\d{2})$/);return m?`${Number(m[1])} 月`:'';})(review?.period);
 if(review){
  const tree=reviewTree(drafts,(state.round?.units||[]).map(u=>u.id));
  const proposals=Object.values(records).flat().filter(r=>r.kind==='revision-proposal');
  const items=reviewTodos(tree.nodes,p,comments,proposals).map(i=>({...i,at:time(drafts[i.cardId]?.history?.at?.(-1)?.at)||time(review.loadedAt)}));
  // The earliest due time among my items: a 个人复盘 is due at 24 hours, the rest at 48 (2026-10-27).
  const dues=items.map(i=>drafts[i.cardId]?.dueAt).filter(Boolean).sort();
  const card=todoCard('review',items,`${month}复盘`);if(card)cards.push({...card,dueAt:dues[0]||reviewDueAt(review)});
 }
 // 我的待办 · 拆解: only once the plan after this review is out (before that the plan page is closed).
 const job=state.roundJob,planOpen=!review?.loadedAt||state.planHandoff?.status==='generated'||job?.id===state.round?.id&&String(job?.finishedAt||'')>review.loadedAt;
 if(state.round&&planOpen){
  const units=(state.round.units||[]).filter(u=>drafts[u.id]);
  const items=todoItems({units,drafts,records,comments,profile:p,name}).filter(i=>['proposal','upstream','downstream','sign','objection'].includes(i.kind)&&!String(i.cardId||'').startsWith('rv:'));
  const card=todoCard('plan',items,'拆解');if(card)cards.push(card);
 }
 const nextMonth=(m=>m?`${Number(m[1])%12+1} 月`:'')(String(state.reviewRound?.period||'').match(/-(\d{2})$/));
 if(state.round&&planOpen&&Object.keys(drafts).some(id=>!id.startsWith('rv:'))){const planCards=Object.values(state.cards).filter(c=>c.kind!=='review'&&confirmationSlots(c).length),done=planCards.length&&planCards.every(c=>c.confirmedVersion===currentVersion(c).number);
  const to=(m=>m?`${Number(m[1])} 月`:'')(String(state.round.input?.period||'').match(/-(\d{2})$/));
  cards.push({id:'stage:plan',type:'stage',stage:'plan',status:done?'done':'open',title:done?`${to}计划已全部确认`:`${to}拆解进行中`,text:done?'按此执行':'点这里去拆解，看自己负责的部分',count:1,link:link({stage:'plan'}),updatedAt:iso(done?signedAt(planCards):time(job?.finishedAt)||time(state.planHandoff?.generatedAt))});}
 else if(reviewDone&&seesReview){const failed=state.planHandoff?.status==='failed';
  // The review is done and the plan is not out yet: the stage card already says the plan is next, so nothing goes missing in between.
  cards.push({id:'stage:plan',type:'stage',stage:'plan',status:'generating',title:`${nextMonth}拆解${failed?'生成遇到问题':'生成中'}`,text:failed?'管理员在处理，好了这里就能进去':'生成好后点这里进去看；复盘在页面里还能切回去看',count:1,link:link({stage:'plan'}),updatedAt:iso(signedAt([company])||time(state.planHandoff?.requestedAt))});}
 // @我, one card per unit group: lines naming me, and Nexus answering a line of mine.
 const mineIds=new Set(state.messages.filter(m=>m.author===memberId).map(m=>m.id));
 for(const [room,list] of Object.entries(records)){
  if(!room.startsWith('group:'))continue;const scope=room.slice(6),seen=time(reads[`mention:${scope}`]);
  // In my own 个人复盘 room every Nexus reply is to me (评测 2026-10-27: Nexus answered there and no card showed).
  const ownRoom=scope==='person:'+memberId;
  const hits=(list||[]).filter(m=>m.kind!=='revision-proposal'&&m.kind!=='notice'&&!m.broadcast&&m.author!==name&&time(m.createdAt)>seen&&(String(m.text||'').includes('@'+name)||m.author==='Nexus'&&(mineIds.has(m.replyTo)||ownRoom)));
  if(!hits.length)continue;
  const last=hits.reduce((a,b)=>time(b.createdAt)>time(a.createdAt)?b:a);
  const unit=scope.startsWith('person:')?'个人复盘':drafts[scope]?.title||(scope==='company'?'公司':scope);
  cards.push({id:`mention:${scope}`,type:'mention',unit:scope,title:`${unit}${scope.startsWith('person:')?'':'群'}：${hits.length} 条消息与你有关`,text:`${last.author}：${String(last.text||'').replace(/\s+/g,' ').slice(0,30)}`,count:hits.length,
   link:link({scope,message:last.id}),updatedAt:iso(time(last.createdAt))});
 }
 // A failed generation goes to the M2 admin only (陈溪南 2026-10-27), not the CEO or other operators.
 if(FAILURE_TO.includes(name)){
  if(job?.status==='failed')cards.push({id:'failure:round',type:'failure',stage:'plan',title:'拆解生成失败',text:String(job.error||'可在管理里续跑').slice(0,80),count:1,link:link({admin:'1'}),updatedAt:iso(time(job.finishedAt||job.createdAt))});
  const r=jobs.review;if(r?.status==='failed')cards.push({id:'failure:review',type:'failure',stage:'review',title:'复盘生成失败',text:String(r.error||'可在管理里续跑').slice(0,80),count:1,link:link({admin:'1'}),updatedAt:iso(time(r.finishedAt||r.startedAt))});
 }
 // Unread: changed since this member last marked the card read (todo and failure cards still clear themselves when done).
 return cards.map(c=>({...c,unread:time(c.updatedAt)>time(reads[c.id])}));
}

// Read marks: {memberId: {cardId: isoTime}}, in a file next to the collaboration state, written one at a time.
export function createReadMarks(statePath){
 const file=join(dirname(statePath),'notification-reads.json');let cache=null,queue=Promise.resolve();
 const load=async()=>{if(cache)return cache;try{cache=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;cache={};}return cache;};
 return {
  async of(memberId){return (await load())[memberId]||{};},
  mark(memberId,ids,at=new Date().toISOString()){
   const task=queue.then(async()=>{const all=await load(),mine=all[memberId]??={};for(const id of ids)if(typeof id==='string'&&id.length<=120)mine[id]=at;
    await mkdir(dirname(file),{recursive:true,mode:0o700});const temp=join(dirname(file),`.reads-${randomUUID()}.tmp`);await writeFile(temp,JSON.stringify(all),{mode:0o600});await rename(temp,file);return mine;});
   queue=task.catch(()=>{});return task;
  },
 };
}
