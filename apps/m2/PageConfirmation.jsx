import React,{useId,useLayoutEffect,useRef,useSyncExternalStore} from 'react';
import {getPageConfirmation,subscribePageConfirmation} from './page-confirmation.mjs';
export default function PageConfirmation(){
 const pending=useSyncExternalStore(subscribePageConfirmation,getPageConfirmation,()=>null),dialog=useRef(null),cancel=useRef(null),id=useId();
 useLayoutEffect(()=>{
  if(!pending)return;
  const element=dialog.current,previous=document.activeElement;
  element.showModal();cancel.current?.focus();
  return()=>{element.close();if(previous?.isConnected)previous.focus({preventScroll:true});};
 },[pending]);
 // Do not settle via close events: an old close event must never decide a new request.
 return <dialog ref={dialog} className="page-confirmation" aria-labelledby={id+'-title'} aria-describedby={id+'-message'} onCancel={event=>{event.preventDefault();pending?.choose(false);}} onClick={event=>{if(event.target!==dialog.current)return;const r=dialog.current.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)pending?.choose(false);}}>
  <h2 id={id+'-title'}>{pending?.title}</h2><p id={id+'-message'}>{pending?.message}</p>
  <div className="page-confirmation-actions"><button ref={cancel} type="button" onClick={()=>pending?.choose(false)}>取消</button><button type="button" className="primary" onClick={()=>pending?.choose(true)}>{pending?.continueLabel||'继续'}</button></div>
 </dialog>;
}
