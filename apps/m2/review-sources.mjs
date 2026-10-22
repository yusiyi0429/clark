// 复盘 → 拆解 (陈溪南 2026-10-21): the reviews confirmed in the product become last month's results in next month's
// decomposition input. They are read as kind 'review' under their own unit (the skill reads review as 上月结果) and
// replace the ontology's reviews of the same month, so one month is never read twice.
import {createHash} from 'node:crypto';

const monthEnd=period=>{const [y,m]=String(period).split('-').map(Number);const d=new Date(Date.UTC(y,m,0));return `${d.toISOString().slice(0,10)}T23:59:59+08:00`;};
const monthLabel=period=>`${Number(String(period).split('-')[1])} 月`;
const bullets=(label,list)=>list?.length?[`**${label}：**`,...list.map(x=>`- ${typeof x==='string'?x:x.text||JSON.stringify(x)}`)]:[];

function reviewFact(review,unit,period){
 const lines=[
  review.verdict?`**结论：**${review.verdict}${review.verdictReason?`。${review.verdictReason}`:''}`:'',
  ...bullets('原因',review.causes),
  ...bullets('给下月的输入',review.nextInputs),
  ...(review.ltoReview?bullets('长期目标进展',Array.isArray(review.ltoReview)?review.ltoReview:[review.ltoReview]):[]),
 ].filter(Boolean);
 return {id:`${review.id}@v${review.version}`,unit,kind:'review',sourceRef:`review-card:${review.id}@v${review.version}`,
  title:`${monthLabel(period)}复盘（已确认第 ${review.version} 版）：${review.title}${review.owner?`（${review.owner}）`:''}`,
  text:lines.join('\n'),factThrough:monthEnd(period),confirmation:'confirmed',dateEvidence:'产品内确认的复盘卡'};
}

// Reviews the ontology already holds for the reviewed month (not last month's PO text, which is history, not a result).
const sameMonthReview=(fact,period)=>fact.kind==='review'&&String(fact.factThrough||'').startsWith(period)&&!/PO/.test(fact.title||'');

export function withReviewSources(input,pkg){
 if(!pkg?.fromPeriod)throw Error('复盘包缺少月份，不能接进拆解输入');
 const keys=new Set(input.sources.map(s=>s.key)),add=new Map(),unplaced=[];
 const put=(unit,review)=>{const key=keys.has(unit)?unit:'company';if(key!==unit)unplaced.push(unit);(add.get(key)||add.set(key,[]).get(key)).push(reviewFact(review,key,pkg.fromPeriod));};
 if(pkg.company)put('company',pkg.company);
 for(const u of pkg.units||[])for(const r of [u.po,...(u.missions||[])].filter(Boolean))put(u.unit,r);
 let replaced=0;
 const sources=input.sources.map(s=>{
  const kept=s.facts.filter(f=>{const drop=sameMonthReview(f,pkg.fromPeriod);if(drop)replaced++;return !drop;});
  const items=[...kept,...(add.get(s.key)||[])];
  if(items.length===s.facts.length&&!add.get(s.key))return s;
  const content=items.map(f=>`${f.kind==='intent'?'【本月意图】':''}${f.title||f.kind} · ${f.sourceRef} · ${f.confirmation}${f.factThrough?' · 事实截至'+f.factThrough:''}\n${f.text}`).join('\n\n');
  return {...s,content,hash:createHash('sha256').update(content).digest('hex'),factRefs:items.map(f=>f.sourceRef),facts:items};
 });
 const added=[...add.values()].reduce((n,l)=>n+l.length,0);
 return {...input,sources,audit:{...input.audit,reviewHandoff:{fromPeriod:pkg.fromPeriod,forPeriod:pkg.forPeriod,reviewRound:pkg.reviewRound,added,replacedOntologyReviews:replaced,...(unplaced.length?{placedInCompany:[...new Set(unplaced)]}:{})}}};
}
