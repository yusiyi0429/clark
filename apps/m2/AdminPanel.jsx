import React,{useEffect,useState} from 'react';
import {m2Fetch as fetch} from './deployment-client.mjs';
import {Button} from '@heroui/react';
import {X} from 'lucide-react';
// 管理 (陈溪南 2026-10-22): one place, on her account (and the CEO's), to start or restart the month-end round.
// 复盘 starts here; once every review is confirmed and the CEO confirms the company review, the plan generates by itself.
// Starting again opens a new round: the earlier talk is kept in the archive, the chat panes start empty.
export default function AdminPanel({memberId,review,onClose,plan}){
 const [job,setJob]=useState(null),[missing,setMissing]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let live=true,timer;const poll=async()=>{try{const r=await fetch('/api/reviews');if(r.status===404){if(live)setMissing(true);return;}const v=await r.json();if(!live)return;setJob(v.job||null);if(v.job?.status==='running')timer=setTimeout(poll,3000);}catch{}};poll();return()=>{live=false;clearTimeout(timer);};},[busy]);
 const running=job?.status==='running',has=!!review?.total;
 // Contract with the M2 session (2026-10-22): regenerate must be explicit; resume reuses the last input after a failure.
 async function start(extra={}){setBusy(true);setError('');try{const r=await fetch('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId,regenerate:has,...extra})});const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.code==='review-exists'?`已有 ${v.confirmed} / ${v.total} 份复盘被确认，请确认后再重新生成`:v.error||'没能开始生成复盘');setConfirm(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
 const cutoff=String(review?.cutoff||'').slice(5,10).replace('-','/');
 return <div className="overlay" onClick={onClose}><section className="document admin-panel" role="dialog" aria-modal="true" aria-label="管理" onClick={e=>e.stopPropagation()}>
  <div className="admin-head"><h2>管理</h2><Button className="icon" aria-label="关闭" onPress={onClose}><X size={18}/></Button></div>
  <section className="admin-block">
   <h3>复盘</h3>
   <p className="admin-line">{has?`${review.label} · 资料截至 ${cutoff} · 共 ${review.total} 份，已确认 ${review.confirmed}${review.problems?` · ${review.problems} 份没生成`:''}`:'本月还没有复盘'}</p>
   {running&&<p className="admin-line is-running">正在生成复盘{job.stage?` · ${job.stage}`:''}{job.total?`（${job.done||0}/${job.total}）`:''}</p>}
   {job?.status==='failed'&&<><p className="admin-line is-failed">上次生成没完成：{job.error||'原因未记录'}</p>{(job.checks||[]).length>0&&<ul className="admin-checks">{job.checks.map((c,i)=><li key={i}><strong>{c.unit||'全局'}</strong>{c.problem}</li>)}</ul>}<Button className="plain" isDisabled={busy} onPress={()=>start({resume:true})}>用上次的资料续跑</Button></>}
   {job?.inputCutoff&&<p className="admin-note">本体数据读到 {String(job.inputCutoff).slice(5,16).replace('T',' ')}</p>}
   {missing?<p className="admin-note">生成服务还没接上，接上后这里就能直接生成。</p>:confirm?<div className="admin-confirm"><p className={has&&review.confirmed>0?'admin-warn':undefined}>{has?`${review.confirmed>0?`已有 ${review.confirmed} 份复盘被确认，`:''}重新生成会开始新的一轮复盘：现有复盘和所有讨论都归档保存，聊天框从新一轮开始，大家要重新确认。`:'生成本月复盘，生成好后各单元群会收到通知。'}</p><div className="proposal-actions"><Button className="primary" isDisabled={busy} onPress={start}>{busy?'正在开始…':has?'确认重新生成':'开始生成'}</Button><Button className="plain" onPress={()=>setConfirm(false)}>取消</Button></div></div>:<Button className="primary" isDisabled={running||busy} onPress={()=>setConfirm(true)}>{running?'生成中…':has?'重新生成复盘':'生成复盘'}</Button>}
   {error&&<p className="admin-line is-failed" role="alert">{error}</p>}
   <p className="admin-note">复盘全部确认、CEO 确认公司复盘后，会自动生成下月拆解。</p>
  </section>
  <section className="admin-block"><h3>拆解</h3>{plan}</section>
 </section></div>;
}
