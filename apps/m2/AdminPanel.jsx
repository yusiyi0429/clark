import React,{useEffect,useState} from 'react';
import {m2Fetch as fetch} from './deployment-client.mjs';
import {Button} from '@heroui/react';
import {X} from 'lucide-react';
import {formatGenerationDuration} from './EntryMetadata.jsx';
// 管理 and the entry page show the same controls (陈溪南 2026-10-27): two lines, two buttons. Each stage says which skill made it and from which ontology read, then one
// button to generate it again. Confirming the company review starts the plan by itself, so the plan button is for redoing it.
const at=iso=>{const t=new Date(iso||'');return !iso||Number.isNaN(t.getTime())?'未记录':t.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});};
const took=ms=>Number.isFinite(ms)&&ms>0?formatGenerationDuration({durationMs:ms}):'未记录';
// Five facts per stage, nothing else (陈溪南 2026-10-27): model, skill, ontology read, generated, time taken.
function Stage({title,model,skill,readAt,generatedAt,durationMs,status,confirmText,button,busy,disabled,onConfirm,extra,side}){
 const [sure,setSure]=useState(false);
 return <section className="admin-block">
  <h3>{title}</h3>
  <dl className="admin-facts">
   <div><dt>模型</dt><dd>{model||'未记录'}</dd></div>
   <div><dt>技能版本</dt><dd>{skill||'未记录'}</dd></div>
   <div><dt>本体读取</dt><dd>{at(readAt)}</dd></div>
   <div><dt>生成时间</dt><dd>{at(generatedAt)}</dd></div>
   <div><dt>耗时</dt><dd>{took(durationMs)}</dd></div>
  </dl>
  {/* Same shape on both sides (陈溪南 2026-10-27): the facts, the buttons in one row, then anything unusual below. */}
  <div className="admin-actions">{sure?<div className="admin-confirm"><p className="admin-warn">{confirmText}</p><div className="proposal-actions"><Button className="primary" isDisabled={busy} onPress={async()=>{await onConfirm();setSure(false);}}>{busy?'正在开始…':'确认'+button}</Button><Button className="plain" onPress={()=>setSure(false)}>取消</Button></div></div>
   :<Button className="primary" isDisabled={disabled||busy} onPress={()=>setSure(true)}>{button}</Button>}{side}</div>
  {status}
  {extra}
 </section>;
}
// 公开洞察 (复盘改版约定 2026-10-26): until she reveals them, nobody sees anyone else's insights. The reply names who has not handed in.
function RevealInsights({memberId}){
 const [state,setState]=useState(null),[busy,setBusy]=useState(false),[sure,setSure]=useState(false);
 async function reveal(){setBusy(true);try{const r=await fetch('/api/reviews/reveal-insights',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId})});const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(r.status===404?'程序这边还没接上公开洞察':v.error||'没能公开');setState({ok:true,missing:v.missing||v.notSubmitted||[]});}catch(e){setState({error:e.message});}finally{setBusy(false);setSure(false);}}
 // The reply lists, per review, who has not handed in: {cardId, title, missing:[name]}.
 const names=(state?.missing||[]).map(m=>typeof m==='string'?m:Array.isArray(m.missing)?`${m.title||m.cardId}：${m.missing.join('、')}`:[m.name,m.title].filter(Boolean).join(' · '));
 return <div className="admin-reveal">
  {sure?<div className="admin-confirm"><p>公开后，所有人都能看到每份复盘下的全部洞察，Nexus 会为每份复盘写一条综合。</p><div className="proposal-actions"><Button className="primary" isDisabled={busy} onPress={reveal}>{busy?'正在公开…':'确认公开'}</Button><Button className="plain" onPress={()=>setSure(false)}>取消</Button></div></div>
   :<Button className="primary admin-secondary" isDisabled={busy} onPress={()=>setSure(true)}>公开洞察</Button>}
  {state?.error&&<p className="admin-line is-failed" role="alert">{state.error}</p>}
  {state?.ok&&<p className="admin-line">{names.length?'已公开。还没交洞察的：':'已公开，大家都交了洞察。'}</p>}
  {state?.ok&&names.length>0&&<ul className="admin-checks">{names.map((t,i)=><li key={i}>{t}</li>)}</ul>}
 </div>;
}
export function RoundControls({memberId,review,plan}){
 const [job,setJob]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let live=true,timer;const poll=async()=>{try{const r=await fetch('/api/reviews');if(!r.ok)return;const v=await r.json();if(!live)return;setJob(v.job||null);if(v.job?.status==='running')timer=setTimeout(poll,3000);}catch{}};poll();return()=>{live=false;clearTimeout(timer);};},[busy]);
 const running=job?.status==='running',has=!!review?.total;
 // Contract with the M2 session (2026-10-22): regenerate must be explicit; resume reuses the last input after a failure.
 async function start(extra={}){setBusy(true);setError('');try{const r=await fetch('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId,regenerate:has,...extra})});const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.code==='review-exists'?`已有 ${v.confirmed} / ${v.total} 份复盘被确认，请确认后再重新生成`:v.error||'没能开始生成复盘');}catch(e){setError(e.message);}finally{setBusy(false);}}
 const pj=plan.job,planRunning=pj?.status==='running',unconfirmed=has&&review.confirmed<review.total;
 return <div className="round-controls">
  <Stage title="复盘" skill={review?.skill} readAt={review?.readAt} generatedAt={review?.generatedAt||review?.loadedAt} model={review?.model||plan.currentModel} durationMs={review?.durationMs} button={has?'重新生成复盘':'生成复盘'} busy={busy} disabled={running} onConfirm={()=>start()}
   confirmText={has?`${review.confirmed>0?`已有 ${review.confirmed} 份复盘被确认。`:''}重新读取本体、生成新的复盘：现有复盘和所有讨论归档保存，聊天框从新一轮开始，大家要重新确认。`:'读取本体、生成本月复盘，生成好后各单元群会收到通知。'}
   status={<>{running&&<p className="admin-line is-running">正在生成复盘{job.total?`（${job.done||0}/${job.total}）`:''}</p>}{job?.status==='failed'&&<p className="admin-line is-failed">上次生成没完成：{job.error||'原因未记录'} <Button className="plain" isDisabled={busy} onPress={()=>start({resume:true})}>续跑</Button></p>}{error&&<p className="admin-line is-failed" role="alert">{error}</p>}</>}
   side={has&&<RevealInsights memberId={memberId}/>}/>
  <Stage title="拆解" skill={plan.skill} readAt={plan.readAt} generatedAt={plan.generatedAt} model={plan.model} durationMs={plan.durationMs} button="重新生成拆解" busy={plan.pending} disabled={planRunning} onConfirm={plan.onRestart}
   confirmText={`${unconfirmed?`复盘还有 ${review.total-review.confirmed} 份没确认，现在生成会用当前的复盘。`:''}重新读取本体、生成新的拆解，生成期间仍显示当前这一轮。`}
   extra={plan.checks} status={<>{planRunning&&<p className="admin-line is-running">正在生成拆解{pj.total?`（${pj.done||0}/${pj.total}）`:''}</p>}{pj?.status==='failed'&&<p className="admin-line is-failed">上次生成没完成：{pj.error||'原因未记录'}</p>}</>}/>
 </div>;
}
export default function AdminPanel({onClose,...props}){
 return <div className="overlay" onClick={onClose}><section className="document admin-panel" role="dialog" aria-modal="true" aria-label="管理" onClick={e=>e.stopPropagation()}>
  <div className="admin-head"><h2>管理</h2><Button className="icon" aria-label="关闭" onPress={onClose}><X size={18}/></Button></div>
  <RoundControls {...props}/>
 </section></div>;
}
