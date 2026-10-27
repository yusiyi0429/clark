import React,{useEffect,useRef,useState} from 'react';
import MemberAvatar from './MemberAvatar.jsx';
import NexusOrb from './NexusOrb.jsx';
// Who is in this unit's group (陈溪南 2026-10-27): a row of small faces next to the group tab; pressing it lists each
// person with their role. Read-only, built from the cards; it does not change who can see or do what.
export default function GroupMembers({members}){
 const [open,setOpen]=useState(false),ref=useRef(null);
 useEffect(()=>{if(!open)return;const close=e=>{if(!ref.current?.contains(e.target))setOpen(false);},key=e=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('pointerdown',close,true);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',close,true);document.removeEventListener('keydown',key);};},[open]);
 if(!members.length)return null;
 const face=m=>m.nexus?<span className="avatar nexus-avatar group-member-face"><NexusOrb/></span>:<MemberAvatar name={m.name} className="group-member-face"/>;
 const shown=members.slice(0,3),more=members.length-shown.length;
 return <div className="group-members" ref={ref}>
  <button type="button" className="group-members-stack" aria-expanded={open} aria-label={`群成员 ${members.length} 人`} title="群成员" onClick={()=>setOpen(v=>!v)}>{shown.map(m=><span key={m.name} className="group-member-slot">{face(m)}</span>)}{more>0&&<span className="group-members-more">+{more}</span>}</button>
  {open&&<div className="group-members-panel" role="dialog" aria-label="群成员"><strong className="group-members-title">群成员 · {members.length}</strong>
   <ul>{members.map(m=><li key={m.name} className={m.limited?'is-limited':undefined}>{face(m)}<span><b>{m.name}</b><small>{m.roles.join('、')}</small></span></li>)}</ul></div>}
 </div>;
}
