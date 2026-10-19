// What a round read from the ontology, unit by unit and field by field:
// read, incomplete, missing, or deliberately not read because it is a reference answer.
// Measured from the round's own input, so it describes what the model actually saw.
const units=[['company','公司'],['bf01','灯塔项目'],['bf02','Token Ops'],['bf03','维信诺'],['rearch','Re-architecture'],['method','Method'],['agents','Agents'],['eo','E&O'],['tokenhub','TokenHub'],['talent','Talent & Organization'],['finance','Finance, Compliance & Operations'],['organization','组织']];
// September POs are labelled since manifest 17b; older rounds are recognised by the review's 原目标 wording.
const isSeptemberPO=f=>/^9 月 PO（上月/.test(f.title||'')||/含 9 月 PCO/.test(f.title||'')||/9 月 PCO：/.test(f.text||'')||f.kind==='review'&&/^(?:## 原目标|1\. \*\*原目标|但9月原定|9月原定|但是，9月原定)/.test(f.text||'');
// need: an empty field is a gap for these units; others are shown only when present.
const fields=[
 {key:'lto',label:'六个月目标（LTO）',pick:f=>f.kind==='lto',need:k=>k!=='organization'},
 {key:'strategy',label:'公司战略',pick:f=>f.kind==='strategy',need:k=>k==='company'},
 {key:'septemberPO',label:'9 月 PO（上月，历史）',pick:isSeptemberPO,need:k=>k!=='organization'},
 {key:'review',label:'9 月复盘',pick:f=>f.kind==='review'&&!isSeptemberPO(f),need:k=>k!=='organization'},
 {key:'state',label:'截至拆解日的现状',pick:f=>f.kind==='state'&&!isSeptemberPO(f),need:k=>k!=='organization'},
 {key:'resource',label:'人员、投入与关键日期',pick:f=>f.kind==='resource',need:k=>k!=='organization'},
 {key:'organization',label:'职责与分工',pick:f=>f.kind==='organization',need:k=>k==='organization'},
 {key:'dependency',label:'跨领域供需（核心支撑，不是全部）',pick:f=>f.kind==='dependency',need:()=>false},
 {key:'intent',label:'公司 10 月整体方向',pick:f=>f.kind==='intent',need:()=>false},
];
// Chinese names for the ontology object types counted as reference answers.
const typeLabels={PeriodGoal:'10 月 PO（周期目标）',Mission:'Mission',Task:'Task',Activity:'Activity'};
// "- 客户窗口：未知｜由刘明华补" → "客户窗口未知，由刘明华补". Unknown staffing is not a gap: everyone is full-time by default (2026-10-14).
function unknownsIn(text){
 return String(text||'').split('\n').map(line=>line.match(/^\s*-\s*([^：:]+)[：:]\s*未知(?:（([^）]*)）)?(?:｜(由.+补))?/)).filter(Boolean).map(m=>`${m[1].trim()}未知${m[2]?`（${m[2]}）`:''}${m[3]?`，${m[3]}`:''}`);
}
// A pending gap belongs to the field of the fact it points at; a gap about September POs belongs to that field everywhere.
function gapField(gap,facts){
 if(/9 月.{0,6}PO/.test(gap.reason||''))return 'septemberPO';
 const fact=facts.find(f=>f.sourceRef===gap.sourceRef);
 if(fact)return fields.find(x=>x.pick(fact))?.key||null;
 return /9月推进记录|复盘/.test(gap.reason||'')?'review':null;
}
export function sourceCoverage(input){
 if(input?.mode!=='ontology-selected-facts'||!Array.isArray(input.sources))return null;
 const facts=input.sources.flatMap(s=>(s.facts||[]).map(f=>({...f,unit:f.unit||s.key})));
 const pending=input.audit?.pending||[];
 const list=units.filter(([key])=>input.sources.some(s=>s.key===key)).map(([key,name])=>{
  const mine=facts.filter(f=>f.unit===key);
  const gaps=pending.filter(g=>g.unit===key||(/9 月 PO/.test(g.reason||'')&&key!=='organization'));
  const rows=fields.map(field=>{
   const items=mine.filter(field.pick);
   // The company-wide September PO gap is repeated on every unit in one short line.
   const notes=[...gaps.filter(g=>gapField(g,mine)===field.key).map(g=>/9 月 PO/.test(g.reason||'')?`本体还没有 9 月 PO 对象，这里用的是${key==='bf03'||key==='rearch'?'知识库摘录里的 9 月 PCO':'9 月复盘里的原目标'}；下周由于斯一补录`:g.reason),...(field.key==='resource'?items.flatMap(f=>unknownsIn(f.text)).filter(n=>!/^人员投入未知/.test(n)):[])];
   const status=!items.length?(field.need(key)?'missing':null):notes.length?'partial':'read';
   return status&&{key:field.key,label:field.label,status,count:items.length,notes:[...new Set(notes)],items:items.map(f=>({title:f.title||null,sourceRef:f.sourceRef,factThrough:f.factThrough||null,confirmation:f.confirmation||null,preview:String(f.text||'').replace(/\s+/g,' ').slice(0,80)}))};
  }).filter(Boolean);
  return {key,name,fields:rows,read:rows.filter(r=>r.status==='read').length,partial:rows.filter(r=>r.status==='partial').length,missing:rows.filter(r=>r.status==='missing').length};
 });
 const excluded=input.audit?.excludedAnswers||null;
 const total=k=>list.reduce((n,u)=>n+u[k],0);
 return {
  summary:`本体 ${facts.length} 条 · ${list.length} 个单元 · 不全 ${total('partial')} 处 · 缺 ${total('missing')} 处${excluded?` · 参考答案不读 ${excluded.objects} 个对象`:''}`,
  cutoff:input.cutoff||null,reviewVersion:input.audit?.reviewVersion||null,
  units:list,
  excluded:{rule:'各战场、能力域的 10 月 PO（周期目标和页面上的 PCO 段落）及其 Mission、Task 是参考答案，不进生成；公司整体的 10 月方向可读。',byType:excluded?.byType||null,typeLabels},
 };
}
