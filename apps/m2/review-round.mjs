// 复盘 (陈溪南 2026-10-20): a review result becomes review cards in the same units and groups as the plan.
// Card ids are rv:<ref> (rv:company, rv:eo, rv:eo-m1) so they never collide with plan cards; the review skill owns
// the content, the program only stores it, shows it and runs the same handshake.
import {broadcast} from './broadcasts.mjs';
const levelOf=l=>l==='ru'?'po':l==='company'?'company':'mission';
export const reviewId=ref=>'rv:'+ref;
// 2.0.2 wrote causes as strings with the question at the end; 2.0.3 writes {text, ask}.
export const causeOf=c=>typeof c==='string'?{text:c,ask:''}:{text:String(c?.text||''),ask:String(c?.ask||'')};
export function reviewCards(file,{now=new Date().toISOString()}={}){
 const reviews=Array.isArray(file.reviews)?file.reviews:Object.values(file.reviews||{});
 const cards={};
 for(const r of reviews){
  const id=reviewId(r.ref||r.unit),level=levelOf(r.level),parent=r.parent?reviewId(r.parent):r.level==='mission'?reviewId(r.unit):r.level==='ru'&&reviews.some(x=>x.level==='company')?reviewId('company'):null;
  const content={version:1,ref:r.ref||r.unit,unit:r.level==='company'?'company':r.unit,level,title:r.title,owner:r.owner,verdict:r.verdict,verdictReason:r.verdictReason,
   // 三段式 (2026-10-26): facts replace targets and causes; older runs keep their fields and show as before.
   // 下期输入 back on 2026-10-27 as {ref, type, text, ask?:{to, question}}; runs from 10/26 have none.
   ...(Array.isArray(r.facts)?{facts:r.facts.map(f=>({ref:f.ref||'',item:String(f.item||''),owner:f.owner||'',status:f.status,evidence:String(f.evidence||''),gap:String(f.gap||'')})),
    ...(Array.isArray(r.nextInputs)?{nextInputs:r.nextInputs.map(n=>({ref:n.ref||'',type:n.type,text:String(n.text||''),...(n.ask?.to?{ask:{to:String(n.ask.to),question:String(n.ask.question||'')}}:{})}))}:{})}:{targets:r.targets||[],causes:(r.causes||[]).map(causeOf),nextInputs:r.nextInputs||[],...(r.ltoReview?{ltoReview:r.ltoReview}:{})}),
   evidenceRefs:r.evidenceRefs||[],recordFacts:r.recordFacts||null,...(r.agreedOutcome?{agreedOutcome:structuredClone(r.agreedOutcome)}:{}),...(r.sourceBasis?{sourceBasis:structuredClone(r.sourceBasis)}:{}),...(r.childCommitments?{childCommitments:structuredClone(r.childCommitments)}:{}),...(r.objectId?{objectId:r.objectId}:{}),...(r.ownerAssigned===false?{ownerAssigned:false}:{})};
  cards[id]={...content,id,kind:'review',parentId:parent,versions:[{number:1,content:structuredClone(content),author:'Review',signatures:[],createdAt:now}],confirmedVersion:null};
 }
 return cards;
}
// Install a review round: earlier review cards move to reviewArchives with their talk; plan cards are untouched.
// 截止 (陈溪南 2026-10-27): confirmations are due 48 hours after the review is in; then the insights open by themselves.
export const REVIEW_DUE_HOURS=48;
export const dueFrom=loadedAt=>new Date(Date.parse(loadedAt)+REVIEW_DUE_HOURS*3600e3).toISOString();
export const reviewDueAt=round=>round?.dueAt||null;
// A round loaded before due times existed gets one only while it is still inside its 48 hours, so an old round does not open its insights the moment this ships.
export const withDueAt=(round,now=Date.now())=>!round||round.dueAt||!round.loadedAt||now>=Date.parse(dueFrom(round.loadedAt))?round:{...round,dueAt:dueFrom(round.loadedAt)};
export function installReviewRound(state,file,{label,source,sample=false,now=new Date().toISOString()}={}){
 const next=structuredClone(state),old=Object.values(next.cards).filter(c=>c.kind==='review');
 if(old.length){const ids=new Set(old.map(c=>c.id));
  // Comments on the old reviews go with them: the new round reuses the same card ids (rv:eo …).
  const comments=next.comments.filter(c=>ids.has(c.cardId));next.comments=next.comments.filter(c=>!ids.has(c.cardId));
  next.reviewArchives??=[];next.reviewArchives.push({round:next.reviewRound||null,cards:old,comments,archivedAt:now});for(const c of old)delete next.cards[c.id];
  // Revision cards on the old reviews go with them too: left in the room they read as if the new round were already revised.
  const proposals=(next.proposals||[]).filter(p=>ids.has(p.cardId));next.proposals=(next.proposals||[]).filter(p=>!ids.has(p.cardId));
  next.reviewArchives.at(-1).proposals=proposals;
  // Group talk about the old reviews: anything on those cards, and Nexus lines posted while that round was live.
  const from=next.reviewRound?.loadedAt||'',talk=m=>ids.has(m.cardId)||ids.has(m.context?.selection?.id)||m.author==='Nexus'&&from&&String(m.createdAt||'')>=from&&/复盘|修订卡/.test(String(m.text||''));
  next.reviewArchives.at(-1).messages=next.messages.filter(talk);next.messages=next.messages.filter(m=>!talk(m));}
 // Insights belong to the round they were written in: archived with it, and the new round opens with the window closed.
 if(next.insights||next.insightsRevealed){(next.reviewArchives??=[]).push({round:next.reviewRound||null,insights:next.insights||{},insightPublications:next.insightPublications||{},insightNexus:next.insightNexus||{},insightsRevealed:next.insightsRevealed||null,archivedAt:now});delete next.insights;delete next.insightPublications;delete next.insightNexus;delete next.insightsRevealed;}
 // 复盘和拆解是一整轮 (陈溪南 2026-10-22): a new month-end round opens with clean rooms. Everything said before it —
 // group and private chat, field comments, revision cards, Nexus minutes — goes to talkArchives, kept for tracing.
 if(next.messages.length||next.comments.length||(next.proposals||[]).length){(next.talkArchives??=[]).push({archivedAt:now,reason:'新一轮复盘',messages:next.messages,comments:next.comments,proposals:next.proposals||[],nexus:next.nexus||{}});next.messages=[];next.comments=[];next.proposals=[];next.nexus={};}
 Object.assign(next.cards,reviewCards(file,{now}));
 // 失败要看得见 (2026-10-22): reviews the run could not write, or wrote without their background, are named on the page.
 const problems=[...(file.failed||[]).map(f=>({ref:f.id,...(f.title?{title:f.title}:{}),kind:'failed',reason:f.finishReason==='refusal'?'生成失败：模型拒答':`生成失败：${String(f.error||'').slice(0,60)}`})),...(file.dropped||[]).map(d=>({ref:d.id,kind:'degraded',reason:'背景资料未读入（模型拒答后去掉背景资料重写）'}))];
 // Units left out because the ontology lacks their material (数据缺失) — the only gap members are told about.
 for(const warning of file.qualityWarnings||[])problems.push({ref:warning.ref,title:warning.title,kind:'unresolved',reason:[warning.problem,warning.impact].filter(Boolean).join('；')});
 const skipped=(file.skipped||[]).map(x=>typeof x==='string'?x:`${x.unit||''}${x.reason?`：${x.reason}`:''}`).filter(Boolean);
 next.reviewRound={...(file.basis?{basis:structuredClone(file.basis)}:{}),label:label||file.name||'复盘',...(problems.length?{problems}:{}),...(skipped.length?{skipped}:{}),skill:file.skill?.version||file.skillFormat||file.skill||null,period:file.period||null,cutoff:file.cutoff||null,evidence:file.evidence||null,source:source||null,sample,loadedAt:now,dueAt:dueFrom(now),
  // When the ontology was read and when the reviews were written (首页 shows both; 陈溪南 2026-10-23).
  readAt:file.readAt||null,generatedAt:file.generatedAt||null,startedAt:file.startedAt||null,durationMs:file.durationMs??null};
 // Every unit with reviews is told they are ready (and, on a re-run, that the old round's talk is archived).
 const month=(p=>{const m=String(p||'').match(/-(\d{2})$/);return m?`${Number(m[1])} 月`:'本月';})(file.period),units=[...new Set(Object.values(next.cards).filter(c=>c.kind==='review'&&c.unit!=='company').map(c=>c.unit))];
 for(const u of units)broadcast(next,u,old.length?`${month}复盘已换成新一轮（${next.reviewRound.label}），上一轮的讨论已归档。请各位重新看自己负责的那份。`:`${month}复盘已生成，请各位看自己负责的那份；有不同意见直接在卡上批注，没问题就在卡底部确认。`,{kind:old.length?'review-regenerated':'review-ready',now});
 next.sequence=(next.sequence||0)+1;
 return next;
}

// 复盘 and 拆解 are one month-end flow (陈溪南 2026-10-22): a new plan round keeps the reviews, their talk in the unit
// groups and the handoff. Only the previous plan's cards and plan talk go to the archive.
export function carryReviewLayer(old,next){
 const ids=new Set(Object.values(old.cards||{}).filter(c=>c.kind==='review').map(c=>c.id));
 if(!ids.size&&!old.planHandoff)return next;
 for(const id of ids)next.cards[id]=structuredClone(old.cards[id]);
 for(const k of ['reviewRound','reviewArchives','planHandoff','unitsDone','insights','insightNexus','insightPublications','insightsRevealed'])if(old[k]!==undefined)next[k]=structuredClone(old[k]);
 const from=old.reviewRound?.loadedAt||'';
 const talk=m=>ids.has(m.cardId)||ids.has(m.context?.selection?.id)||Boolean(m.broadcast)||m.author==='Nexus'&&from&&String(m.createdAt||'')>=from&&/复盘|修订卡/.test(String(m.text||''));
 next.messages=[...(old.messages||[]).filter(talk).map(m=>structuredClone(m)),...(next.messages||[])];
 next.comments=[...(old.comments||[]).filter(c=>ids.has(c.cardId)).map(c=>structuredClone(c)),...(next.comments||[])];
 next.proposals=[...(old.proposals||[]).filter(p=>ids.has(p.cardId)).map(p=>structuredClone(p)),...(next.proposals||[])];
 return next;
}
