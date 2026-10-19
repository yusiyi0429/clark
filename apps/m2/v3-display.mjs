// Display helpers for fields that skill 3.x adds (tier, unit plan, demands/responses, effort/stop, person-days).
// They only read what the round carries; 2.x rounds have none of these fields and keep their old layout.
// Tiers are P0 / P1 / P2 (陈溪南 2026-10-17); rounds written before keep 前置 (= P0) and 延伸 (= P2).
export const tierInfo={P0:['p0','做不成本月就算失败，含 P0 成立前必须先做成的'],P1:['p1','重要，但做不成不算本月失败'],P2:['p2','有余力才做']};
export const tierOf=t=>({'前置':'P0','延伸':'P2'})[t]||t;
const strip=s=>String(s??'').replace(/^\s*\*\*[^*]*\*\*\s*/,'').trim();
const filled=v=>v!=null&&(Array.isArray(v)?v.some(x=>String(x).trim()):String(v).trim()!=='');
const list=v=>Array.isArray(v)?v:filled(v)?String(v).split('\n').filter(Boolean):[];
// "**内部首验（10/14）：**白田田、孙铭泽支撑。真实议题可供首次体验。" → one gate. All entries must parse, else null.
export function gateEntries(value){
 // Two ways the round writes a milestone: "**名称（10/16）：**…" and (3.1.3+) "**10/16 名称：**…".
 const rows=list(value).map(entry=>{const a=String(entry).match(/^\s*\*\*(?:关口\s*)?(.+?)（(\d{1,2})[/.-](\d{1,2})）[：:]?\*\*[：:]?\s*(.*)$/),b=!a&&String(entry).match(/^\s*\*\*(\d{1,2})[/.-](\d{1,2})\s+(.+?)[：:]?\*\*[：:]?\s*(.*)$/);
  const m=a||(b&&[b[0],b[3],b[1],b[2],b[4]]);if(!m)return null;
  const rest=m[4].trim(),cut=rest.search(/[。；;]/),first=cut>=0?rest.slice(0,cut):rest;
  const name=m[1].trim(),support=/支撑|负责|牵头/.test(first)?first:'';
  // One short sentence per milestone, no quote marks or brackets (陈溪南 2026-10-19).
  const line=[name,support].filter(Boolean).join('，').replace(/[「」『』“”"（）()]/g,'');
  return {name,date:`${m[2].padStart(2,'0')}/${m[3].padStart(2,'0')}`,support,line,text:String(entry).replace(/\*\*/g,'')};});
 return rows.length>=2&&rows.every(Boolean)?rows:null;
}
// Task effort/stop travel inside 责任边界 as "**投入：**…"/"**停止：**…" (that is the field revisions edit).
export function splitBoundary(node){
 const rows=list(node.boundary),pick=re=>rows.filter(x=>re.test(x)).map(strip);
 const effort=pick(/^\s*\*\*投入[：:]?\*\*/),stop=pick(/^\s*\*\*停止(条件)?[：:]?\*\*/);
 const rest=rows.filter(x=>!/^\s*\*\*(投入|停止(条件)?)[：:]?\*\*/.test(x));
 return {effort:effort.length?effort.join('\n'):node.effort||'',stop:stop.length?stop.join('\n'):node.stop||'',rest};
}
export function shortEffort(value){
 const s=String(value||''),m=s.match(/(约)?\s*(\d+(?:\.\d+)?(?:\s*[–—~-]\s*\d+(?:\.\d+)?)?)\s*人日/);
 return m?`${m[1]?'约 ':''}${m[2].replace(/\s+/g,'')} 人日`:s.split(/[，,。；;]/)[0].slice(0,12);
}
const isV3Task=n=>n.level==='task'&&(filled(n.effort)||filled(n.stop)||list(n.boundary).some(x=>/^\s*\*\*(投入|停止)/.test(x)));
// Card layout for 3.x cards; null keeps the regular template layout.
export function v3Layout(node){
 if(node.level==='po'&&node.plan){
  // PO card (陈溪南 2026-10-19): 里程碑 and 风险 up front; 取舍 / 依赖 / 本月暂缓 / LTO 贡献 folded.
  const contribution=strip(list(node.why).join(''))===strip(node.expectedProgress),risks=planColumns(node)[2][2];
  return {node:{...node,risks},columns:true,
   key:[['result','成果'],...(filled(node.logic)?[['logic','里程碑']]:[]),['checks','验收标准'],...(risks.length?[['risks','风险']]:[]),...(filled(node.boundary)?[['boundary','责任边界']]:[])],
   more:[...(filled(node.expectedProgress)?[['expectedProgress','LTO 贡献']]:[]),...(filled(node.why)&&!contribution?[['why','存在必要性']]:[])]};
 }
 if(isV3Task(node)){
  const b=splitBoundary(node);
  return {node:{...node,effort:b.effort,stop:b.stop,boundary:b.rest},
   key:[['result','成果'],['checks','验收标准'],['effort','投入'],['stop','停止条件'],...(b.rest.length?[['boundary','责任边界']]:[])],more:null};
 }
 // Mission card mirrors the PO (陈溪南 2026-10-19): 风险 up front, the rest folded. Rounds without a risks field
 // kept their risks in 约束与依赖, so that list is shown as 风险.
 if(node.level==='mission'&&node.tier){
  const own=list(node.risks),risks=own.length?own:list(node.dependencies),deps=own.length?list(node.dependencies).filter(x=>!own.map(String).includes(String(x))):[];
  return {node:{...node,risks,dependencies:deps},key:[['result','成果'],['checks','验收标准'],...(risks.length?[['risks','风险']]:[]),...(filled(node.boundary)?[['boundary','责任边界']]:[])],
   more:[['why','存在必要性'],['path','核心路径'],['tradeoff','关键取舍'],['dependencies','依赖'],['milestones','里程碑']]};
 }
 return null;
}
// PO 取舍 / 依赖 / 风险. Rounds from 2026-10-17 keep risks in their own field; earlier 3.x rounds appended
// plan.risks to 约束与依赖, so those are told apart by the round's own plan.risks.
export function planColumns(node){
 const planRisks=new Set(list(node.plan?.risks).map(String)),deps=list(node.dependencies),mixed=deps.filter(x=>planRisks.has(String(x)));
 const risks=mixed.length?mixed:list(node.risks).length?list(node.risks):list(node.plan?.risks);
 return [['tradeoff','关键取舍',list(node.tradeoff)],['dependencies','依赖',deps.filter(x=>!mixed.includes(x))],['risks','风险',risks]];
}
export function responseTone(text){
 const s=String(text||'');if(!s.trim())return ['none','未回应'];
 if(/不了|不接|无法|拒/.test(s))return ['no','接不了'];
 if(/部分/.test(s))return ['partial','部分接'];
 // 3.1.5: the need serves one battlefield only, so it goes back there instead of into the domain.
 if(/转回/.test(s))return ['back','转回战场'];
 return /接/.test(s)?['ok','接']:['none',s];
}
// "Domain Finance, Compliance & Operations" → "Finance" ("E&O" stays whole): the row only needs to say which unit.
export const unitShortName=u=>String(u?.name||u?.key||u?.id||'').replace(/^(Battlefield|Domain)\s+/,'').split(/\s*[,，]\s*|\s+&\s+/)[0];
// Demands this unit raised, and demands raised to it, each joined with the answer from the receiving unit.
export function supplyRows(units,unit){
 const key=String(unit.key||unit.id).toLowerCase(),idOf=u=>String(u.key||u.id).toLowerCase();
 const responses=units.flatMap(u=>(u.responses||[]).map(r=>({...r,by:idOf(u)})));
 const all=units.flatMap(u=>(u.demands||[]).map(d=>({...d,from:String(d.from||idOf(u)).toLowerCase(),to:String(d.to||'').toLowerCase()})));
 // Only the unit the demand was addressed to can answer it.
 const join=d=>{const r=responses.find(x=>x.demandId===d.id&&x.by===d.to),[tone,label]=responseTone(r?.response);
  return {...d,by:String(d.by||'').replace(/^\d{4}-(\d{2})-(\d{2}).*$/,'$1/$2'),response:r?.response||'',note:r?.note||'',missionTitle:r?.missionTitle||'',tone,label};};
 return {asked:all.filter(d=>d.from===key).map(join),received:all.filter(d=>d.to===key).map(join)};
}
export function weekdaysIn(time){
 const m=String(time||'').match(/(\d{4})-(\d{2})-(\d{2})\s*[—–~-]+\s*(\d{4})-(\d{2})-(\d{2})/);if(!m)return 0;
 let n=0;for(let d=Date.UTC(+m[1],m[2]-1,+m[3]),end=Date.UTC(+m[4],m[5]-1,+m[6]);d<=end;d+=86400000){const w=new Date(d).getUTCDay();if(w&&w<6)n++;}
 return n;
}
// Person-days against capacity. The round's own measured capacity wins (per person, then default);
// without it the line falls back to the month's weekdays and says so.
export function workloadRows(audit,units){
 const rows=audit?.personDays;if(!Array.isArray(rows)||!rows.length)return null;
 const cap=Number(audit.capacity?.days)||0,week=weekdaysIn(units?.[0]?.time),base=cap||week;
 // capacityFacts.exactlyAtCapacity: planned days equal capacity, likely filled up to the budget.
 const exact=new Set((audit.capacityFacts||[]).filter(f=>f.exactlyAtCapacity).map(f=>f.name));
 const list=rows.map(r=>{const limit=Number(r.capacityDays)||base;return {...r,limit,over:limit>0&&r.personDays>limit,exact:exact.has(r.name)};});
 const note=cap?`竖线是可用容量 ${cap} 人日${audit.capacity.basis?`（${audit.capacity.basis}）`:''}`:week?`竖线是本月周一至周五 ${week} 天，未扣节假日`:'';
 return {list,note,max:Math.max(1,...list.map(r=>Math.max(r.limit,Number(r.personDays)||0)))};
}
