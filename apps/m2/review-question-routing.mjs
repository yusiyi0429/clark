// Model content stays intact. Covers only selects the active delivery location.
const rank={mission:0,ru:1,po:1,company:2};
const signature=n=>JSON.stringify({ref:n.ref||'',type:n.type,text:String(n.text||''),ask:n.ask?.to?{to:String(n.ask.to),question:String(n.ask.question||'')}:null});
const coverIdentity=row=>JSON.stringify(row.covers);
export function reviewQuestionRoutes(reviews){
 const byRef=Array.isArray(reviews)?Object.fromEntries(reviews.filter(Boolean).map((r,i)=>[r.ref||r.unit||`unknown-${i}`,r])):reviews||{},routes=new Map();
 for(const [to,upper] of Object.entries(byRef).sort(([a],[b])=>a.localeCompare(b)))for(const [toIndex,row] of (upper.nextInputs||[]).entries()){
  if(!row?.ask?.to||!row.ask.question)continue;
  for(const cover of Array.isArray(row.covers)?row.covers:[]){
   if(!Number.isInteger(cover?.index)||cover.index<0)continue;
   const lower=byRef[cover.ref],source=lower?.nextInputs?.[cover.index];
   if(!source?.ask?.to||!(rank[lower.level]<rank[upper.level]))continue;
   const binding=row.questionCoverBindings;
   if(binding?.identity===coverIdentity(row)&&binding.rows?.find(r=>r.from===cover.ref&&r.index===cover.index)?.source!==signature(source))continue;
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
 return Object.fromEntries(Object.entries(reviews||{}).map(([ref,review])=>[ref,{...review,nextInputs:review.nextInputs?.map((row,index)=>{
  const {questionRoute,questionCoverBindings,...original}=row,route=routes.find(r=>r.from===ref&&r.index===index);
  let bindings;
  if(Array.isArray(row.covers)&&row.covers.length){
   const identity=coverIdentity(row);bindings=questionCoverBindings?.identity===identity?questionCoverBindings:{identity,rows:row.covers.flatMap(c=>{const source=reviews?.[c?.ref]?.nextInputs?.[c?.index];return source?[{from:c.ref,index:c.index,source:signature(source)}]:[];})};
  }
  return {...original,...(bindings?{questionCoverBindings:structuredClone(bindings)}:{}),...(route?{questionRoute:route}:{})};
 })}]));
}

// Recompute from the whole current round before permission and display decisions.
// This is a read projection; persisted business text, versions and signatures stay intact.
export function currentReviewQuestionRows(state,card){
 const byRef=Object.fromEntries(Object.values(state?.cards||{}).filter(c=>c.kind==='review').map(c=>{const content=c.versions.at(-1).content;return [content.ref||c.id.replace(/^rv:/,''),content];}));
 const content=card?.versions?.at(-1)?.content,ref=content?.ref||card?.id?.replace(/^rv:/,'');
 return routeReviewQuestions(byRef)[ref]?.nextInputs||content?.nextInputs||[];
}
