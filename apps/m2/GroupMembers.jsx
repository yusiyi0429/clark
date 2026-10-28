import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import MemberAvatar,{memberIdFor} from './MemberAvatar.jsx';
import NexusOrb from './NexusOrb.jsx';
import BotAvatar from './BotAvatar.jsx';
// Who is in this unit's group (陈溪南 2026-10-27): one group avatar inside the group tab, a circle cut into four with the
// first members' faces, so it takes one face's room and plainly belongs to the group. Pressing it (on the open group
// tab) lists each person with their role. Read-only, built from the cards; it does not change who can see or do what.
export default function GroupMembers({members,active}){
 const [pos,setPos]=useState(null),ref=useRef(null),panel=useRef(null);
 useEffect(()=>{if(!pos)return;const close=e=>{if(!ref.current?.contains(e.target)&&!panel.current?.contains(e.target))setPos(null);},key=e=>{if(e.key==='Escape')setPos(null);};document.addEventListener('pointerdown',close,true);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',close,true);document.removeEventListener('keydown',key);};},[pos]);
 useEffect(()=>{if(!active)setPos(null);},[active]);
 if(!members.length)return null;
 const people=members.filter(m=>!m.nexus&&!m.limited&&!m.agent).slice(0,4);
 const toggle=e=>{if(!active)return;e.stopPropagation();e.preventDefault();if(pos)return setPos(null);const r=ref.current.getBoundingClientRect();setPos({top:r.bottom+8,right:Math.max(12,window.innerWidth-r.right-12)});};
 const face=m=>m.agent?<span className="group-member-face group-member-bot"><BotAvatar/></span>:m.nexus?<span className="avatar nexus-avatar group-member-face"><NexusOrb/></span>:<MemberAvatar name={m.name} className="group-member-face"/>;
 return <>
  <span ref={ref} className={`group-avatar n${people.length}${active?' is-active':''}`} role={active?'button':undefined} tabIndex={active?0:-1} aria-label={`群成员 ${members.length} 人`} title={active?`群成员 ${members.length} 人`:undefined}
   onPointerDown={e=>{if(active)e.stopPropagation();}} onClick={toggle} onKeyDown={e=>{if(active&&(e.key==='Enter'||e.key===' '))toggle(e);}}>
   {people.map(m=>{const id=memberIdFor(m.name);return <span key={m.name} className="group-avatar-cell">{id?<img src={`/avatars/${id}.png`} alt=""/>:<i>{m.name.slice(0,1)}</i>}</span>;})}
  </span>
  {pos&&createPortal(<div ref={panel} className="group-members-panel" style={{top:pos.top,right:pos.right}} role="dialog" aria-label="群成员"><strong className="group-members-title">群成员 · {members.length}</strong>
   <ul>{members.map(m=><li key={m.name} className={m.limited?'is-limited':undefined}>{face(m)}<span><b>{m.name}</b><small>{m.roles.join('、')}</small></span></li>)}</ul></div>,document.body)}
 </>;
}
