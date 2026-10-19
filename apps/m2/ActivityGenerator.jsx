import React,{useEffect,useRef,useState} from 'react';
import {Sparkles} from 'lucide-react';
import {m2Fetch as fetch} from './deployment-client.mjs';
// A round stops at Task. The Task's people can ask for an Activity Plan; the page shows progress and redraws when it lands.
export default function ActivityGenerator({task,memberId,allowed,onDone}){
 const [job,setJob]=useState(null),[error,setError]=useState(''),timer=useRef(null);
 async function poll(){
  try{const r=await fetch('/api/activities?taskId='+encodeURIComponent(task.id));const value=await r.json();setJob(value.job);
   if(value.job?.status==='running')timer.current=setTimeout(poll,3000);else if(value.job?.status==='done'&&value.job.count)onDone();}
  catch{timer.current=setTimeout(poll,5000);}
 }
 useEffect(()=>{poll();return()=>clearTimeout(timer.current);},[task.id]);
 async function start(){
  setError('');
  try{const r=await fetch('/api/activities',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId,taskId:task.id})});const value=await r.json();if(!r.ok)throw Error(value.error||'无法开始生成');setJob(value.job);clearTimeout(timer.current);timer.current=setTimeout(poll,3000);}
  catch(e){setError(e.message);}
 }
 const running=job?.status==='running';
 return <section className="document-next activity-generator" aria-live="polite"><h3>Activity Plan</h3>
  {running?<div className="activity-running"><span className="activity-spinner" aria-hidden="true"/><p>正在为这个 Task 生成 Activity Plan，一般需要 1–3 分钟。可以先看别的页面，生成完会自动显示。</p></div>
  :job?.status==='done'&&job.directlyExecutable?<p>模型判断这个 Task 交给执行人就能直接做，不需要再拆 Activity。{job.gaps?.[0]&&<span className="activity-note">理由：{job.gaps[0]}</span>}</p>
  :<><p>这个 Task 还没有 Activity Plan。能直接执行的 Task 不需要拆；需要把执行步骤、人和 Agent 的分工、人工检查点写清楚时，再生成。</p>
   {job?.status==='failed'&&<p className="error">上次生成没有成功：{job.error}</p>}
   {allowed?<button className="activity-start" onClick={start}><Sparkles size={15}/> 生成 Activity Plan</button>:<p className="activity-note">只有 Task 负责人、Mission 负责人、领域负责人或 CEO 可以生成。</p>}</>}
  {error&&<p className="error">{error}</p>}
 </section>;
}
