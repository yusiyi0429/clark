import {m2Fetch as fetch} from './deployment-client.mjs';
import React,{useState,useEffect} from 'react';
import AuditStatus from './AuditStatus.jsx';
import {workloadRows} from './v3-display.mjs';
import {modelLine,skillLine,ceoDecisions} from './entry-fields.mjs';
import SourceCoverage from './SourceCoverage.jsx';
const sourceNames={
 'published-independent-foundation-only':'飞书基础材料独立快照',
 'ontology-selected-facts':'本体经核对事实快照',
 'feishu':'飞书基础材料快照',
};
// MM/DD HH:mm in Beijing time, or 未记录.
const at=iso=>{const t=new Date(iso||'');return Number.isNaN(t.getTime())||!iso?'未记录':t.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).replace(/\//g,'/');};
// “（用时 33 分 13 秒）” when the run's duration is known.
const took=t=>{const ms=Number.isFinite(t?.durationMs)?t.durationMs:Date.parse(t?.generatedAt||t?.finishedAt||'')-Date.parse(t?.startedAt||'');return Number.isFinite(ms)&&ms>0?`（用时 ${formatGenerationDuration({durationMs:ms})}）`:'';};
// checksOnly: just 本轮检查 (with its retry), for the 拆解 line of the shared controls (2026-10-27).
export default function EntryMetadata({data:incoming,checksOnly=false}){
 const [updated,setUpdated]=useState(null);
 useEffect(()=>setUpdated(null),[incoming]);
 const data=updated?.roundId===incoming.roundId?updated:incoming;
 const audit=data.roundAudit;
 // Business findings and field-length findings answer different questions; show them apart.
 const issues=audit?.issues||[],readerIssues=issues.filter(x=>x.fieldPath),businessIssues=issues.filter(x=>!x.fieldPath);
 const groups=Object.entries(businessIssues.reduce((g,x)=>{(g[x.type||'未分类']??=[]).push(x);return g;},{}));
 const issueSummary=audit?.status==='completed'?`${businessIssues.length} 项业务问题、${readerIssues.length} 处字数超限`:undefined;
 const layerName={po:'PO 层',mission:'Mission 层',task:'Task 层',final:'总校验',format:'精简'};
 const iterationText=Object.entries((audit?.iterations||[]).reduce((g,x)=>{const r=(g[x.layer]??={rounds:0,revised:new Set()});r.rounds=Math.max(r.rounds,x.round);x.revised.forEach(k=>r.revised.add(k));return g;},{})).map(([layer,r])=>`${layerName[layer]||layer}验证 ${r.rounds} 轮${r.revised.size?`，修改 ${r.revised.size} 个领域`:''}`).join('；');
 const unitLabel=key=>data.units?.find(u=>u.key===key||u.id===key)?.name||(key==='company'?'公司':key);
 const unitName=key=>data.units?.find(u=>u.key===key||u.id===key)?.name||key||'跨领域计划';
 async function refresh(){const r=await fetch('/api/data');if(!r.ok)throw Error('无法刷新审核结果，请重试');const value=await r.json();if(value.roundId===incoming.roundId)setUpdated(value);}
 const time=data.sourceTime&&new Date(data.sourceTime);
 const date=time&&!Number.isNaN(time.getTime())?time.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';
 const load=workloadRows(audit,data.units),over=load?.list.filter(r=>r.over)||[],exact=load?.list.filter(r=>r.exact)||[],capacity=audit?.capacity?.days;
 const done=audit?.status==='completed'&&data.auditStatus==='completed',notices=data.versionNotices||[],decisions=ceoDecisions(audit);
 // Every row is one field and its value; the check row splits into data / decomposition / workload.
 return <section className="entry-metadata" aria-label="本轮数据与版本">
  <dl>
   {!checksOnly&&<>
   {/* 复盘 and 拆解 read the same way (陈溪南 2026-10-23): ontology read time · skill · generated at (time taken) · then counts. */}
   {data.review&&<div><dt>本月复盘</dt><dd>本体数据读于 {at(data.review.readAt)} · 复盘技能 {data.review.skill||'未记录'} · 生成于 {at(data.review.generatedAt||data.review.loadedAt)}{took(data.review)} · 资料截至 {String(data.review.cutoff||'').slice(5,10).replace('-','/')} · 共 {data.review.total} 份，已确认 {data.review.confirmed}{data.review.skipped>0&&` · ${data.review.skipped} 个单元缺本体材料没复盘`}{/* Program-side issues, for whoever runs the round: they point at what to fix, not at the members. */}{data.review.failed>0&&` · ${data.review.failed} 份没生成，程序要排查`}{data.review.degraded>0&&` · ${data.review.degraded} 份被模型拒答后降级重写，敏感信息过滤要加强`}{data.review.problems>0&&!Number.isInteger(data.review.failed)&&` · ${data.review.problems} 份生成时有问题，程序要排查`}</dd></div>}
   <div><dt>本月拆解</dt><dd>本体数据读于 {at(data.sourceTime)} · 拆解技能 {data.skill||'未记录'} · 生成于 {at(data.generationTiming?.finishedAt)}{took(data.generationTiming)} · 第 {data.round} 轮{data.review&&!(String(data.generationTiming?.finishedAt||'')>String(data.review.loadedAt||''))&&' · 早于本月复盘，复盘确认后会重新生成'}{data.availableSkill&&data.availableSkill!==data.skill&&` · 最新可用 ${data.availableSkill}（重开后使用）`}</dd></div>
   <div><dt>当前模型</dt><dd>{modelLine(data)}</dd></div>
   <div><dt>数据来源</dt><dd>{sourceNames[data.sourceMode]||data.sourceMode||'旧轮未记录'}{data.sourceCoverage?<SourceCoverage coverage={data.sourceCoverage}/>:data.sourceTitles?.length>0&&<span className="entry-source-titles">{data.sourceTitles.join('、')}</span>}</dd></div>
   </>}
   {data.auditStatus&&<div><dt>本轮检查</dt><dd>{done?<ul className="entry-checks">
     <li><b>数据</b>{audit.gaps?.length||0} 项待补资料{notices.length>0&&`，${notices.length} 份资料有新版本`}</li>
     <li><b>分解</b>{issueSummary}</li>
     <li><b>人员负荷</b>{!load?'本轮未测算':over.length?`${over.length} 人超出${capacity?`容量 ${capacity} 人日`:'本月工作日'}（${over.map(r=>`${r.name} ${r.personDays}`).join('、')}）`:`都在${capacity?`容量 ${capacity} 人日`:'本月工作日'}以内`}{exact.length>0&&`；${exact.length} 人正好等于容量，可能是按容量凑的`}{decisions.length>0&&`；${decisions.length} 项人手问题待 CEO 拍板`}</li>
    </ul>:<AuditStatus status={data.auditStatus} issueCount={data.auditIssueCount} issueSummary={issueSummary} gapCount={data.auditGapCount} roundId={data.roundId} memberId="member-01" ceo onComplete={refresh}/>}
    {audit?.status==='completed'&&<details className="entry-audit-details"><summary>查看需要修改的计划和待补资料</summary>
     <p>需要修改：计划之间有冲突、重复，或责任不清。待补资料：现有材料不足，还不能核实。以下是模型检查结果，需负责人确认，不代表已修订。</p>
     {iterationText&&<p>逐层验证与修改：{iterationText}。下面是验证轮数用完后仍未解决的问题。</p>}
     <h3>业务问题（{businessIssues.length}）</h3>
     {!businessIssues.length&&<p>本次未发现业务问题，不代表所有计划已确认。</p>}
     {groups.map(([type,list])=><details key={type} className="entry-audit-group"><summary>{type}（{list.length}）</summary>
      {list.map((x,i)=><article key={i}><strong>{i+1}. {x.layer&&`[${layerName[x.layer]||x.layer}] `}{unitName(x.unitKey)} · {x.cardTitle||'计划组合'}</strong><p>问题：{x.problem}</p><p>影响：{x.impact}</p>{x.exceptionReason&&<p>模型给出的保留理由：{x.exceptionReason}。仍需人工核对，不算达标。</p>}</article>)}
     </details>)}
     {readerIssues.length>0&&<details className="entry-audit-reader"><summary>字数超限（{readerIssues.length} 处）</summary><ol>{readerIssues.map((x,i)=><li key={i}>{unitName(x.unitKey)} · {x.cardTitle} · {x.fieldLabel}：{x.actual}/{x.limit} 字</li>)}</ol></details>}
     <h3>待补资料（{audit.gaps?.length||0}）</h3>
     <ol>{(audit.gaps||[]).map((x,i)=><li key={i}>{typeof x==='string'?x:x.description||x.problem||x.detail||x.reason||'资料内容未说明，请重新核对'}</li>)}</ol>
     {notices.length>0&&<><h3>资料新版本（{notices.length}）</h3><ol>{notices.map((n,i)=><li key={i}>{unitLabel(n.unit)}「{n.title}」：本轮用第 {n.usedVersion} 版，本体已有第 {n.latestVersion} 版。要换成新版，请更新资料清单后重开。</li>)}</ol></>}
     {load&&<><h3>人员负荷</h3><p>按 Task 投入估算{load.note&&`；${load.note}`}。</p><ol className="entry-load">{load.list.map(r=><li key={r.name} className={r.over?'is-over':undefined}>{r.name}：{r.personDays} 人日{r.limit?` / 可用 ${r.limit}`:''}{r.exact&&'（正好等于容量，可能是按容量凑的）'}</li>)}</ol></>}
     {decisions.length>0&&<><h3>待 CEO 拍板的人手问题（{decisions.length}）</h3><ol>{decisions.map((x,i)=><li key={i}><strong>{x.name}</strong>：{x.text}</li>)}</ol></>}
    </details>}
   </dd></div>}
  </dl>
 </section>;
}
export function formatGenerationDuration(timing){
 if(!timing||!Number.isFinite(timing.durationMs)||timing.durationMs<0)return '本轮未记录';
 const seconds=Math.floor(timing.durationMs/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
 return `${timing.lowerBound?'至少 ':''}${hours?`${hours} 小时 `:''}${minutes?`${minutes} 分 `:''}${seconds%60} 秒${timing.lowerBound?'（旧轮审核结束时间未记录）':''}`;
}
