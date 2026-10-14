import {m2Fetch as fetch} from './deployment-client.mjs';
import React,{useState,useEffect} from 'react';
import AuditStatus from './AuditStatus.jsx';
const sourceNames={
 'published-independent-foundation-only':'飞书基础材料独立快照',
 'ontology-selected-facts':'本体经核对事实快照',
 'feishu':'飞书基础材料快照',
};
export default function EntryMetadata({data:incoming}){
 const [updated,setUpdated]=useState(null);
 useEffect(()=>setUpdated(null),[incoming]);
 const data=updated?.roundId===incoming.roundId?updated:incoming;
 const audit=data.roundAudit;
 async function refresh(){const r=await fetch('/api/data');if(!r.ok)throw Error('无法刷新审核结果，请重试');const value=await r.json();if(value.roundId===incoming.roundId)setUpdated(value);}
 const model=data.generationModel;
 const time=data.sourceTime&&new Date(data.sourceTime);
 const date=time&&!Number.isNaN(time.getTime())?time.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';
 return <section className="entry-metadata" aria-label="本轮数据与版本">
  <p>第 {data.round} 轮 · 资料读取于 {date}（北京时间）</p>
  <dl>
   <div><dt>生成耗时</dt><dd>{formatGenerationDuration(data.generationTiming)}</dd></div>
   {data.auditStatus&&<div><dt>本轮检查</dt><dd><AuditStatus status={data.auditStatus} issueCount={data.auditIssueCount} gapCount={data.auditGapCount} roundId={data.roundId} memberId="member-01" ceo={data.auditStatus!=='completed'} onComplete={refresh}/>
    {audit?.status==='completed'&&<details className="entry-audit-details"><summary>查看需要修改的计划和待补资料</summary>
     <p>需要修改：计划之间有冲突、重复，或责任不清。待补资料：现有材料不足，还不能核实。以下是模型检查结果，需负责人确认，不代表已修订。</p>
     <h3>需要修改的计划（{audit.issues?.length||0}）</h3>
     {!(audit.issues?.length)&&<p>本次未发现需要修改的计划，不代表所有计划已确认。</p>}
     {(audit.issues||[]).map((x,i)=><article key={i}><strong>{i+1}. {data.units?.find(u=>u.key===x.unitKey||u.id===x.unitKey)?.name||x.unitKey||'跨领域计划'} · {x.cardTitle||'计划组合'}</strong><p>问题：{x.problem}</p><p>影响：{x.impact}</p>{x.exceptionReason&&<p>模型给出的保留理由：{x.exceptionReason}。仍需人工核对，不算达标。</p>}</article>)}
     <h3>待补资料（{audit.gaps?.length||0}）</h3>
     <ol>{(audit.gaps||[]).map((x,i)=><li key={i}>{typeof x==='string'?x:x.description||x.problem||x.detail||x.reason||'资料内容未说明，请重新核对'}</li>)}</ol>
    </details>}
   </dd></div>}
   <div><dt>数据来源</dt><dd>{sourceNames[data.sourceMode]||data.sourceMode||'旧轮未记录'}{data.sourceTitles?.length>0&&<span className="entry-source-titles">{data.sourceTitles.join('、')}</span>}</dd></div>
   <div><dt>技能版本</dt><dd>本轮 {data.skill} · 当前可用 {data.availableSkill}</dd></div>
   <div><dt>生成模型</dt><dd>{model?.model||model?.id||'本轮未记录'}{model?.reasoningEffort&&` · 推理强度 ${model.reasoningEffort}`}</dd></div>
   <div><dt>当前模型</dt><dd>{data.modelReady?`${data.modelStatus.provider} · ${data.modelStatus.model}`:'待配置'}</dd></div>
  </dl>
 </section>;
}
export function formatGenerationDuration(timing){
 if(!timing||!Number.isFinite(timing.durationMs)||timing.durationMs<0)return '本轮未记录';
 const seconds=Math.floor(timing.durationMs/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
 return `${timing.lowerBound?'至少 ':''}${hours?`${hours} 小时 `:''}${minutes?`${minutes} 分 `:''}${seconds%60} 秒${timing.lowerBound?'（旧轮审核结束时间未记录）':''}`;
}
