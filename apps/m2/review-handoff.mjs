// 复盘 → 拆解 (陈溪南 2026-10-21): when the CEO confirms the company review — the end of the review and the start of
// the plan — every confirmed review becomes context for next month's decomposition. The plan page stays as it is;
// the reviews only travel as input. Until the full run is wanted, the server prepares this package without generating.
import {currentVersion} from './governance.mjs';
import {broadcast} from './broadcasts.mjs';
import {nextPeriod,monthOf} from './review-display.mjs';
export {nextPeriod,monthOf};
export const isReviewCard=c=>c?.kind==='review';
export function unconfirmedReviews(state){
 return Object.values(state.cards).filter(c=>isReviewCard(c)&&c.level!=='company'&&c.confirmedVersion!==currentVersion(c).number);
}
// What the decomposition reads: each confirmed review's judgment, causes and next-month inputs, by unit.
export function handoffPackage(state){
 const reviews=Object.values(state.cards).filter(isReviewCard).map(c=>{const v=currentVersion(c).content;
  return {id:c.id,ref:v.ref,unit:v.unit,level:c.level,title:v.title,owner:v.owner,version:currentVersion(c).number,verdict:v.verdict,verdictReason:v.verdictReason,
   causes:(v.causes||[]).map(x=>typeof x==='string'?x:x.text),nextInputs:v.nextInputs||[],...(v.ltoReview?{ltoReview:v.ltoReview}:{})};});
 const company=reviews.find(r=>r.level==='company')||null,units=[...new Set(reviews.filter(r=>r.level!=='company').map(r=>r.unit))];
 return {fromPeriod:state.reviewRound?.period||null,forPeriod:nextPeriod(state.reviewRound?.period),reviewRound:state.reviewRound?.label||null,
  company,units:units.map(u=>({unit:u,po:reviews.find(r=>r.unit===u&&r.level==='po')||null,missions:reviews.filter(r=>r.unit===u&&r.level==='mission')}))};
}

// The new round is in: tell each unit group its draft is out.
export function handoffGenerated(s){
 if(s.planHandoff?.status!=='generating')return s;const pkg=s.planHandoff.package,to=monthOf(pkg?.forPeriod),now=new Date().toISOString();
 s.planHandoff={...s.planHandoff,status:'generated',generatedAt:now,roundNumber:s.round?.number};
 for(const u of pkg?.units||[]){const owner=u.po?.owner?.split(/[、,，]/)[0];broadcast(s,u.unit,`${to}拆解草稿已出，请各位看自己负责的部分${owner?`，${'@'+owner} 先看 PO`:''}。`,{kind:'plan-ready',now});}
 s.sequence++;return s;
}

// The entry page's review line: which review is in, from what data, how far confirmation has got (2026-10-22).
export function reviewSummary(state){
 const r=state.reviewRound;if(!r)return null;
 const cards=Object.values(state.cards).filter(isReviewCard);
 return {label:r.label,skill:r.skill,period:r.period,cutoff:r.cutoff,loadedAt:r.loadedAt,readAt:r.readAt||null,generatedAt:r.generatedAt||null,startedAt:r.startedAt||null,durationMs:r.durationMs??null,total:cards.length,confirmed:cards.filter(c=>c.confirmedVersion===currentVersion(c).number).length,problems:(r.problems||[]).length,failed:(r.problems||[]).filter(p=>p.kind==='failed').length,degraded:(r.problems||[]).filter(p=>p.kind==='degraded').length,skipped:(r.skipped||[]).length};
}
