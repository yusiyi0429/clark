import React from 'react';
import {tierInfo,tierOf,supplyRows,unitShortName,workloadRows} from './v3-display.mjs';
// Mission and Task tier as written by the round (P0 / P1 / P2; older 前置 / 延伸 read as P0 / P2); the page never infers one.
export function TierTag({tier:raw}){
 if(!raw)return null;const tier=tierOf(raw),info=tierInfo[tier];
 return <span className={`tier-tag tier-${info?.[0]||'other'}`} title={info?`${tier}：${info[1]}`:tier}>{tier}</span>;
}
const countLine=rows=>{const c={};for(const r of rows)c[r.label]=(c[r.label]||0)+1;return [`${rows.length} 条`,...['接','部分接','接不了','未回应'].filter(k=>c[k]).map(k=>`${k} ${c[k]}`)].join(' · ');};
// Cross-unit demands on a PO: a battlefield sees what it asked for, a domain sees what was asked of it.
export function SupplyDemand({units,unit,onOpen}){
 const {asked,received}=supplyRows(units,unit);if(!asked.length&&!received.length)return null;
 const idOf=u=>String(u.key||u.id).toLowerCase(),nameOf=k=>unitShortName(units.find(u=>idOf(u)===k))||k;
 const missionOf=r=>r.missionTitle&&units.find(u=>idOf(u)===r.to)?.children?.find(m=>m.title===r.missionTitle);
 const block=(title,rows,who)=>rows.length>0&&<div className="supply-block"><h4>{title}<small>{countLine(rows)}</small></h4><ul>{rows.map(r=>{const m=missionOf(r);return <li key={r.id}><details><summary><span className="supply-who">{who(r)}</span><span className="supply-what">{r.what}</span>{r.by&&<span className="supply-by">{r.by}</span>}<span className={`supply-state is-${r.tone}`}>{r.label}</span></summary><dl>{r.use&&<><dt>用途</dt><dd>{r.use}</dd></>}{r.note&&<><dt>对方说明</dt><dd>{r.note}</dd></>}{r.missionTitle&&<><dt>承接</dt><dd>{m&&onOpen?<button className="doc-scope-title" onClick={()=>onOpen(m)}>{r.missionTitle}</button>:r.missionTitle}</dd></>}{!r.use&&!r.note&&!r.missionTitle&&<><dt>说明</dt><dd>对方还没有回应</dd></>}</dl></details></li>;})}</ul></div>;
 return <section className="document-next supply-demand"><h3>跨域供需</h3>{block('我要的',asked,r=>`要 ${nameOf(r.to)}`)}{block('要我的',received,r=>`${nameOf(r.from)} 要`)}</section>;
}
// Person-days measured when the round was generated, against each person's capacity line.
// Not shown on the CEO home (陈溪南 2026-10-17); kept for a later place that needs it.
export function WorkloadPanel({audit,units}){
 const w=workloadRows(audit,units);if(!w)return null;
 const over=w.list.filter(r=>r.over).length,pct=v=>`${Math.round(v/w.max*100)}%`;
 return <section className="workload-panel" aria-label="本月人日负荷">
  <div className="workload-head"><strong>本月人日负荷</strong>{over>0&&<span className="workload-over">{over} 人超出</span>}<small>按 Task 投入估算{w.note&&` · ${w.note}`}</small></div>
  <ul>{w.list.map(r=><li key={r.name} className={r.over?'is-over':undefined} title={r.limit?`${r.name}：${r.personDays} 人日 / 可用 ${r.limit}`:undefined}><span className="workload-name">{r.name}</span><span className="workload-bar"><span style={{width:pct(r.personDays)}}/>{r.limit>0&&<i style={{left:pct(r.limit)}}/>}</span><span className="workload-days">{r.personDays}</span></li>)}</ul>
 </section>;
}
