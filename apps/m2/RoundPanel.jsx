import {m2Fetch as fetch} from './deployment-client.mjs';
import React,{useState,useEffect,useRef} from 'react';
import {Button} from '@heroui/react';
export default function RoundPanel({memberId,ceo,onActivate,entry=false}){
 const [job,setJob]=useState(null),[error,setError]=useState(''),[connection,setConnection]=useState(null);
 const startedId=useRef(null);
 const actor=entry?'member-01':memberId,canStart=entry||ceo;
 useEffect(()=>{fetch('/api/ontology/status').then(r=>r.json()).then(setConnection).catch(()=>setConnection({configured:false,message:'无法读取连接状态，请重试'}));},[]);
 useEffect(()=>{let active=true;const poll=()=>fetch('/api/rounds').then(r=>r.json()).then(v=>{if(active)setJob(v.job);}).catch(()=>{});poll();const timer=setInterval(poll,2000);return()=>{active=false;clearInterval(timer);};},[]);
 useEffect(()=>{if(job?.status==='activated'&&job.id===startedId.current){startedId.current=null;onActivate();}},[job,onActivate]);
 async function start(resume=false){setError('');try{const r=await fetch('/api/rounds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:actor,resume,sourceMode:'ontology',autoActivate:true})});const v=await r.json();if(!r.ok)throw Error(v.error);startedId.current=v.id;setJob(v);}catch(e){setError(e.message);}}
 async function activate(){try{const r=await fetch('/api/rounds/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:actor,jobId:job.id})});const v=await r.json();if(!r.ok)throw Error(v.error);await onActivate();}catch(e){setError(e.message);}}
 return <section>
  <h3>重开拆解</h3>
  <p>重新读取本体 → 按最新技能生成 PO、Mission、Task → 显示在当前产品画布。</p>
  <p>旧轮内容、聊天和批注保留。新轮不继承确认，不写本体。</p>
  <p role="status">{connection?.message||'检查本体连接…'}</p>
  {connection&&<p>当前测试资料：事实截至 {connection.cutoff?.slice(0,10)}；{connection.selectedFacts} 条已核对事实。排除已有拆解答案。来源发生变化时停止并提示重新核对，不复用旧缓存。</p>}
  {job&&<p>{job.stage}{job.done!==undefined?` · ${job.done}/${job.total}`:''}{job.error?` · ${job.error}`:''}</p>}
  {job?.skillSnapshot&&<p>实际技能 {job.skillSnapshot.version} · 规则快照 {job.skillSnapshot.hash.slice(0,12)}</p>}
  {canStart&&<Button className="primary" isDisabled={job?.status==='running'||job?.status==='ready'||!connection?.configured} onPress={()=>start(false)}>重新读取本体并生成</Button>}
  {canStart&&job?.status==='failed'&&job.canResume&&<Button className="plain" onPress={()=>start(true)}>续跑未完成部分（沿用该次输入）</Button>}
  {canStart&&job?.status==='ready'&&<Button className="primary" onPress={activate}>载入候选，保留旧轮</Button>}
  {job?.counts&&<p>{job.counts.po} PO · {job.counts.mission} Mission · {job.counts.task} Task</p>}
  {job?.audit&&<details><summary>组合检查与待核对事项</summary><p>{job.audit.summary}</p>{(job.audit.issues||[]).map((x,i)=><p key={i}>{x.cardTitle}：{x.problem} · {x.impact}</p>)}{(job.audit.gaps||[]).map((x,i)=><p key={i}>{typeof x==='string'?x:JSON.stringify(x)}</p>)}</details>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
