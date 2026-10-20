import React,{useState} from 'react';
import {Button} from '@heroui/react';
import {AlertTriangle,Loader2,CheckCircle2} from 'lucide-react';
// One persistent line for the next round: progress while it runs; when it stopped, why, and "续跑" right there.
export default function RoundStatusBar({job,round,canAct,onResume,onLoad,onDetails}){
 const [busy,setBusy]=useState(false);
 // Signed in on the deployment there is no member picker, so the CEO or a round operator starts the next round from here.
 if(!job||!['running','failed','ready'].includes(job.status))return canAct&&onDetails?<div className="round-bar is-idle" role="status"><span>当前显示第 {round} 轮。</span><Button className="primary round-bar-action" onPress={onDetails}>生成新一轮</Button></div>:null;
 const progress=job.total?` · ${job.done||0}/${job.total}`:'';
 async function run(fn){if(busy)return;setBusy(true);try{await fn();}finally{setBusy(false);}}
 if(job.status==='running')return <div className="round-bar is-running" role="status"><Loader2 size={15} className="round-bar-spin" aria-hidden="true"/><span>计划拆解中：正在生成新一轮{job.skillSnapshot?.version?`（技能 ${job.skillSnapshot.version}）`:''} · {job.stage}{progress}。期间仍显示第 {round} 轮。</span><Button className="plain round-bar-link" onPress={onDetails}>详情</Button></div>;
 if(job.status==='ready')return <div className="round-bar is-ready" role="status"><CheckCircle2 size={15} aria-hidden="true"/><span>新一轮已生成，还没载入。</span>{canAct&&<Button className="primary round-bar-action" isDisabled={busy} onPress={()=>run(onLoad)}>载入新一轮</Button>}<Button className="plain round-bar-link" onPress={onDetails}>详情</Button></div>;
 return <div className="round-bar is-failed" role="alert"><AlertTriangle size={15} aria-hidden="true"/><span>新轮生成未完成{job.stage?`（停在“${job.stage}”${progress}）`:''}：{job.error||'原因未记录'}。当前仍显示第 {round} 轮。</span>{canAct&&job.canResume&&<Button className="primary round-bar-action" isDisabled={busy} onPress={()=>run(onResume)}>{busy?'正在续跑…':'续跑'}</Button>}<Button className="plain round-bar-link" onPress={onDetails}>详情</Button></div>;
}
