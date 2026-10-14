import React,{useLayoutEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,Sparkles,AlertCircle} from 'lucide-react';

// Follow the rendered material, not a second copy of document/Gantt data.
export default function RevisionOverlay({revision,canvas,view}){
 const [rects,setRects]=useState([]);
 useLayoutEffect(()=>{
  if(!revision){setRects([]);return;}
  const root=canvas.current;if(!root)return;
  const id=CSS.escape(revision.cardId);
  function measure(){
   const card=root.querySelector(view==='gantt'?`[data-node="${id}"]`:`[data-document-node="${id}"]`);
   const fields=view==='document'?(revision.fields||[]).map(field=>root.querySelector(`[data-block-id="${CSS.escape(revision.cardId+':'+field)}"]`)).filter(Boolean).map(e=>e.closest('tr')||e):[];
   const targets=[...new Set(fields.length?fields:card?[card]:[])],clip=root.getBoundingClientRect();
   setRects(targets.map(e=>{const r=e.getBoundingClientRect(),left=Math.max(r.left,clip.left),top=Math.max(r.top,clip.top),right=Math.min(r.right,clip.right),bottom=Math.min(r.bottom,clip.bottom);return {left,top,width:right-left,height:bottom-top};}).filter(r=>r.width>0&&r.height>0));
  }
  measure();const observer=new ResizeObserver(measure);observer.observe(root);
  const mutations=new MutationObserver(measure);mutations.observe(root,{subtree:true,childList:true,characterData:true});
  root.addEventListener('scroll',measure,{passive:true});window.addEventListener('resize',measure);
  return()=>{observer.disconnect();mutations.disconnect();root.removeEventListener('scroll',measure);window.removeEventListener('resize',measure);};
 },[revision,canvas,view]);
 if(!revision)return null;
 const failed=revision.phase==='failed',done=revision.phase==='done',Icon=failed?AlertCircle:done?Check:Sparkles;
 const label=failed?'修订未保存，请重试':done?`CoAgent 已更新 · v${revision.version}`:revision.phase==='presenting'?'CoAgent 正在更新画布':'CoAgent 正在修改';
 return createPortal(<><span className="sr-only" role="status" aria-live="polite">{label}</span>{rects.map((rect,i)=><div key={i} className={`ai-revision-overlay ${revision.phase}`} style={rect} data-revision-card={revision.cardId} data-revision-phase={revision.phase} aria-label={label}><span className="ai-revision-sweep"/><span className="ai-revision-label"><Icon size={14}/>{label}</span></div>)}</>,document.body);
}
