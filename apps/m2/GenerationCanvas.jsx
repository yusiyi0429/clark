import React,{useEffect,useRef,useState} from 'react';
import NexusOrb from './NexusOrb.jsx';
import {generationProgress} from './generation-progress.mjs';
// Placeholders have no old result text, fabricated dates or confirmation state.
// Reuse the in-document Co-agent sweep, without overlaying old material.
export default function GenerationCanvas({profile,job}){
 const [now,setNow]=useState(Date.now);
 // Leaving and coming back must not look like a restart: the stage start and the highest percent shown are kept per job.
 const clock=useRef({key:null,start:Date.now(),percent:0});
 const key=`${job.id}:${job.stage}`;
 if(clock.current.key!==key){let saved={};try{saved=JSON.parse(localStorage.getItem('m2-gen:'+job.id)||'{}');}catch{}
  const start=Date.parse(job.stageAt)||(saved.stage===job.stage&&saved.start)||Date.now();
  clock.current={key,start,percent:Math.max(saved.percent||0,clock.current.key?.startsWith(job.id+':')?clock.current.percent:0)};}
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const progress=generationProgress(job,now,clock.current.start);
 if(progress.percent>clock.current.percent){clock.current.percent=progress.percent;}
 try{localStorage.setItem('m2-gen:'+job.id,JSON.stringify({stage:job.stage,start:clock.current.start,percent:clock.current.percent}));}catch{}
 const kinds=profile.ceo?['PO','PO','Mission']:profile.unitDri?.length?['PO','Mission','Task']:['Mission','Task','Task'];
 return <div className="canvas-scroll generation-canvas" aria-busy="true" aria-label="计划拆解中">
  <p className="generation-stage" role="status">计划拆解中{job.stage?` · ${job.stage}`:''} · 预估 {clock.current.percent}% · 已等待 {progress.wait}</p>
  {kinds.map((kind,i)=><article className="generation-card plan-doc-node" key={i} aria-label={`${kind} 计划拆解中`}>
   <div className="generation-heading"><span>{kind} Card</span><span>{profile.name}</span></div>
   <div className="generation-lines" aria-hidden="true"><i/><i/><i/><i/></div>
   <div className="ai-revision-overlay saving"><span className="ai-revision-sweep"/><span className="ai-revision-label"><NexusOrb/>计划拆解中 · 预估 {clock.current.percent}%</span></div>
  </article>)}
 </div>;
}
