// Model content stays intact. Covers only selects the active delivery location.
const rank={mission:0,ru:1,po:1,company:2};
const signature=n=>JSON.stringify({ref:n.ref||'',type:n.type,text:String(n.text||''),ask:n.ask?.to?{to:String(n.ask.to),question:String(n.ask.question||'')}:null});
export function reviewQuestionRoutes(reviews){
 const byRef=Array.isArray(reviews)?Object.fromEntries(reviews.filter(Boolean).map((r,i)=>[r.ref||r.unit||`unknown-${i}`,r])):reviews||{},routes=new Map();
 for(const [to,upper] of Object.entries(byRef).sort(([a],[b])=>a.localeCompare(b)))for(const [toIndex,row] of (upper.nextInputs||[]).entries()){
  if(!row?.ask?.to||!row.ask.question)continue;
  for(const cover of Array.isArray(row.covers)?row.covers:[]){
   if(!Number.isInteger(cover?.index)||cover.index<0)continue;
   const lower=byRef[cover.ref],source=lower?.nextInputs?.[cover.index];
   if(!source?.ask?.to||!(rank[lower.level]<rank[upper.level]))continue;
   const key=JSON.stringify([cover.ref,cover.index]),old=routes.get(key);
   if(!old||rank[upper.level]>rank[byRef[old.to].level])routes.set(key,{from:cover.ref,index:cover.index,to,toIndex,source:signature(source)});
  }
 }
 return [...routes.values()].sort((a,b)=>a.from.localeCompare(b.from)||a.index-b.index);
}
export const routedQuestion=(row,route=row?.questionRoute)=>!!route&&route.source===signature(row);
export const activeReviewAsk=row=>routedQuestion(row)?null:row?.ask;
export function routeReviewQuestions(reviews){
 const routes=reviewQuestionRoutes(reviews);
 return Object.fromEntries(Object.entries(reviews||{}).map(([ref,review])=>[ref,{...review,nextInputs:review.nextInputs?.map((row,index)=>{const route=routes.find(r=>r.from===ref&&r.index===index);return route?{...row,questionRoute:route}:row;})}]));
}
