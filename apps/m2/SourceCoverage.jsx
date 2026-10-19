import React from 'react';
import {coverageStatus,confirmationLabel,unitCounts,shortDate} from './entry-fields.mjs';
import {unitShortName} from './v3-display.mjs';
// What the ontology actually gave this round: one summary line, then unit → field → item, each folded.
export default function SourceCoverage({coverage}){
 const ex=coverage.excluded,types=Object.entries(ex?.byType||{});
 return <details className="coverage">
  <summary>{coverage.summary}</summary>
  <p className="coverage-meta">{coverage.cutoff&&`事实截至 ${shortDate(coverage.cutoff)}`}{coverage.reviewVersion&&` · 名单 ${coverage.reviewVersion}`}</p>
  <ul className="coverage-units">{coverage.units.map(u=><li key={u.key}><details>
   <summary><span className="coverage-name" title={u.name}>{unitShortName(u)}</span><span className="coverage-counts">{unitCounts(u).map(([k,text],i)=><React.Fragment key={k}>{i>0&&' · '}<span className={`is-${k}`}>{text}</span></React.Fragment>)}</span></summary>
   <ul className="coverage-fields">{u.fields.map(f=><li key={f.key}><details>
    <summary><span className={`coverage-state is-${coverageStatus[f.status]?.[1]||'read'}`}>{coverageStatus[f.status]?.[0]||f.status}</span><span className="coverage-label">{f.label}</span><span className="coverage-count">{f.count?`${f.count} 条`:'没有资料'}</span></summary>
    {f.notes?.length>0&&<ul className="coverage-notes">{f.notes.map((n,i)=><li key={i}>{n}</li>)}</ul>}
    {f.items?.length>0?<ol className="coverage-items">{f.items.map((x,i)=><li key={i}><strong>{x.title||`第 ${i+1} 条`}</strong><small>{[x.factThrough&&`事实截至 ${shortDate(x.factThrough)}`,confirmationLabel(x.confirmation),x.sourceRef].filter(Boolean).join(' · ')}</small>{x.preview&&<p>{x.preview}</p>}</li>)}</ol>:!f.notes?.length&&<p className="coverage-empty">这一项没有读到资料</p>}
   </details></li>)}</ul>
  </details></li>)}</ul>
  {ex&&<div className="coverage-excluded"><strong>参考答案，不读</strong><p>{ex.rule}</p><p>{types.length?types.map(([t,n])=>`${ex.typeLabels?.[t]||t} ${n} 个`).join(' · '):'本轮没有计数，下一轮生成后才有'}</p></div>}
 </details>;
}
