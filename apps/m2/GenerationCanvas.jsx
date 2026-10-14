import React,{useEffect,useRef,useState} from 'react';
import NexusOrb from './NexusOrb.jsx';
import {generationProgress} from './generation-progress.mjs';
// Placeholders have no old result text, fabricated dates or confirmation state.
// Reuse the in-document Co-agent sweep, without overlaying old material.
export default function GenerationCanvas({profile,job}){
 const [now,setNow]=useState(Date.now);
 const clock=useRef({key:null,start:Date.now(),percent:0});
 const key=`${job.id}:${job.stage}`;
 if(clock.current.key!==key){clock.current={key,start:Date.now(),percent:clock.current.key?.startsWith(job.id+':')?clock.current.percent:0};}
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const progress=generationProgress(job,now,clock.current.start);
 clock.current.percent=Math.max(clock.current.percent,progress.percent);
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
