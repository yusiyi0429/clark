import {m2Fetch as fetch} from './deployment-client.mjs';
import React,{useState,useEffect,useRef} from 'react';
import {Button} from '@heroui/react';
import {Check,ChevronRight,X} from 'lucide-react';
import {roundSteps,roundLine,roundPill,gapSummary,shortTime} from './round-steps.mjs';
// One status card about the next round; sources and versions stay folded.
export default function RoundPanel({memberId,ceo,onActivate,onClose,info={},entry=false}){
 const [job,setJob]=useState(null),[error,setError]=useState(''),[connection,setConnection]=useState(null);
 const startedId=useRef(null);
 const actor=entry?'member-01':memberId,canStart=entry||ceo;
 useEffect(()=>{fetch('/api/ontology/status').then(r=>r.json()).then(setConnection).catch(()=>setConnection({configured:false,message:'无法读取连接状态，请重试'}));},[]);
 useEffect(()=>{let active=true;const poll=()=>fetch('/api/rounds').then(r=>r.json()).then(v=>{if(active)setJob(v.job);}).catch(()=>{});poll();const timer=setInterval(poll,2000);return()=>{active=false;clearInterval(timer);};},[]);
 useEffect(()=>{if(job?.status==='activated'&&job.id===startedId.current){startedId.current=null;onActivate();}},[job,onActivate]);
 async function start(resume=false){setError('');try{const r=await fetch('/api/rounds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:actor,resume,sourceMode:'ontology',autoActivate:true})});const v=await r.json();if(!r.ok)throw Error(v.error);startedId.current=v.id;setJob(v);}catch(e){setError(e.message);}}
 async function activate(){setError('');try{const r=await fetch('/api/rounds/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:actor,jobId:job.id})});const v=await r.json();if(!r.ok)throw Error(v.error);await onActivate();}catch(e){setError(e.message);}}
 const [pill,tone]=roundPill(job),status=job?.status,skill=job?.skillSnapshot?.version||info.availableSkill;
 const resumable=status==='failed'&&job.canResume,offline=connection&&!connection.configured;
 const regenerate=<Button className={resumable?'plain':'primary'} isDisabled={status==='running'||status==='ready'||!connection?.configured} onPress={()=>start(false)}>重新读取本体并生成</Button>;
 return <div className="round-card">
  <header className="round-card-head"><h2>新一轮拆解</h2><span className={`round-pill ${tone}`}>{pill}</span>{skill&&<span className="round-skill">技能 {skill}</span>}{onClose&&<Button className="icon" aria-label="关闭数据来源" onPress={onClose}><X size={18}/></Button>}</header>
  <ol className="round-steps">{roundSteps(job).map(s=><li key={s.label} className={`is-${s.state}`}><span className="round-dot">{s.state==='done'&&<Check size={11} strokeWidth={3}/>}</span><span>{s.label}{s.count&&<small>{s.count}</small>}</span></li>)}</ol>
  <p className={`round-line ${tone}`} role={status==='failed'?'alert':'status'}>{roundLine(job,info.round)}</p>
  {offline&&<p className="round-warn">{connection.message}</p>}
  {canStart?status!=='running'&&<div className="round-actions">
   {resumable&&<Button className="primary" onPress={()=>start(true)}>续跑</Button>}
   {status==='ready'?<Button className="primary" onPress={activate}>载入新一轮</Button>:regenerate}
  </div>:<p className="round-note">开始、续跑和载入新一轮由公司负责人操作。</p>}
  {error&&<p className="round-warn" role="alert">{error}</p>}
  {job?.audit&&<details className="round-fold"><summary><ChevronRight size={14} aria-hidden="true"/>组合检查 · {(job.audit.issues||[]).length+(job.audit.gaps||[]).length} 项待核对</summary><p>{job.audit.summary}</p>{(job.audit.issues||[]).map((x,i)=><p key={i}>{x.cardTitle}：{x.problem} · {x.impact}</p>)}{(job.audit.gaps||[]).map((x,i)=><p key={`g${i}`}>{typeof x==='string'?x:JSON.stringify(x)}</p>)}</details>}
  <details className="round-fold"><summary><ChevronRight size={14} aria-hidden="true"/>来源与版本</summary><dl>
   <dt>本体</dt><dd>{connection?.message||'检查本体连接…'}</dd>
   {connection?.configured&&<><dt>资料</dt><dd>事实截至 {connection.cutoff?.slice(0,10)} · {connection.selectedFacts} 条已核对事实{connection.reviewVersion&&` · ${connection.reviewVersion}`}。只传入已核对事实，不含已有拆解答案；来源变化时停下提示重新核对。{connection.gaps?.length>0&&<span className="round-gaps">{gapSummary(connection.gaps)}</span>}</dd></>}
   {job?.skillSnapshot&&<><dt>新一轮技能</dt><dd>{job.skillSnapshot.version} · 规则快照 {job.skillSnapshot.hash?.slice(0,12)}</dd></>}
   <dt>当前显示</dt><dd>第 {info.round} 轮 · 资料快照 {shortTime(info.sourceTime)} · 技能 {info.skill}（服务已加载 {info.availableSkill}）</dd>
   <dt>模型</dt><dd>{info.model}</dd>
   <dt>保存</dt><dd>聊天、批注、修订与版本确认存在本机共享服务，不写飞书或本体。成员入口用于内部试用，不是登录鉴权。</dd>
  </dl></details>
  <p className="round-foot">旧轮内容、聊天和批注都保留；新轮不继承确认，不写本体。</p>
 </div>;
}
