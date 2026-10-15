import {m2Fetch as fetch} from './deployment-client.mjs';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@heroui/react';
export default function AuditStatus({roundId,memberId,ceo,onComplete,status,issueCount=0,gapCount=0,issueSummary,onReview}){
 const [job,setJob]=useState(null),[error,setError]=useState(''),[starting,setStarting]=useState(false),seen=useRef(null);
 const callback=useRef(onComplete);callback.current=onComplete;
 useEffect(()=>{let active=true;const poll=async()=>{try{const r=await fetch('/api/rounds');if(!r.ok)throw Error('无法读取审核状态，请刷新重试');const value=await r.json();if(!active)return;const j=value.auditJob?.roundId===roundId?value.auditJob:null;setJob(j);if(j?.status==='completed'&&seen.current!==j.id){await callback.current();seen.current=j.id;}}catch(e){if(active)setError(e.message);}};poll();const timer=setInterval(poll,1500);return()=>{active=false;clearInterval(timer);};},[roundId]);
 async function retry(){if(starting||job?.status==='running')return;setStarting(true);setError('');try{const r=await fetch('/api/rounds/retry-audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId,roundId})});const v=await r.json();if(!r.ok)throw Error(v.error);setJob({...v,roundId});}catch(e){setError(e.message);}finally{setStarting(false);}}
 const running=job?.status==='running';
 const completed=status==='completed'&&job?.status!=='stale'&&job?.status!=='failed';
 return <div className="audit-notice"><span role="status">{running?`正在检查计划之间的冲突与资料是否齐全${job.retry?` · 自动重试 ${job.retry.attempt}/${job.retry.attempts}`:''}`:completed?`检查完成 · ${issueSummary||`${issueCount} 项计划问题`}，${gapCount} 项待补资料`:'检查未完成 · 当前计划是候选，尚未确认'}</span>{completed&&onReview&&<Button className="plain" onPress={onReview}>查看检查结果</Button>}{ceo&&<Button className="plain" isDisabled={starting||running} onPress={retry}>{running?'审核中…':completed?'重新审核':'重试跨领域审核'}</Button>}{(error||job?.error)&&<span role="alert">{error||job.error}</span>}</div>;
}
