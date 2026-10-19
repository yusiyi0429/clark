import React,{useState,useEffect,useRef} from 'react';
import {Button} from '@heroui/react';
import {ChevronDown,MessageCircle} from 'lucide-react';
import ProposalCard from './ProposalCard.jsx';
import NexusOrb from './NexusOrb.jsx';
export {default as NexusOrb} from './NexusOrb.jsx';

// Reuses the persistent seed → lens interaction from the earlier Nexus demo.
export default function NexusIsland({scope,busy,answer,onAnalyze,onOpenGroup,proposal,proposalNode,onProposalAction,onProposalOpen}){
 const [open,setOpen]=useState(false);
 const bodyRef=useRef(null),shellRef=useRef(null);
 const [height,setHeight]=useState(180);
 const [width,setWidth]=useState(400);
 useEffect(()=>{
  const observer=new ResizeObserver(()=>{if(!shellRef.current?.parentElement||!bodyRef.current)return;setWidth(Math.min(400,shellRef.current.parentElement.clientWidth-32));setHeight(Math.ceil(bodyRef.current.getBoundingClientRect().height)+50);});
  observer.observe(bodyRef.current);observer.observe(shellRef.current.parentElement);return()=>observer.disconnect();
 },[]);
 // Public answers stay in the group. Never open an overlay on each analysis.
 useEffect(()=>{if(!open||busy||answer)return;const t=setTimeout(()=>setOpen(false),20000);return()=>clearTimeout(t);},[open,busy,answer]);
 return <section ref={shellRef} style={{height:open?height:50,'--island-width':`${width}px`}} className={`nexus-island ${open?'expanded':''} ${busy?'processing':''}`} aria-label="Nexus 协作助手">
  <Button className="island-toggle" aria-label={open?'收起 Nexus':'展开 Nexus'} aria-expanded={open} onPress={()=>setOpen(v=>!v)}><span className="island-label" aria-hidden={!open}><strong>Nexus</strong><ChevronDown size={17}/></span>{!open&&<NexusOrb/>}</Button>
  <div ref={bodyRef} className="island-body" inert={!open} aria-hidden={!open}>{proposal?<ProposalCard compact proposal={proposal} node={proposalNode} onAction={onProposalAction} onOpen={onProposalOpen}/>:<p>{busy?'正在核对本领域公开讨论与计划材料…':answer|| (scope?'我会静默整理公开意见，必要时参与讨论和修订候选。':'进入战场或 Domain 后，我会参与该领域的规划讨论。')}</p>}</div>
 </section>;
}
