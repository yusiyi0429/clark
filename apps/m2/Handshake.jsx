import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@heroui/react';
import {Handshake as HandshakeIcon,Check} from 'lucide-react';
import MemberAvatar from './MemberAvatar.jsx';
const shortTime=iso=>{const t=new Date(iso);return Number.isNaN(t.getTime())?'':t.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});};
// Shared confirmation: every signer on one row, a quiet progress count, and one clear "达成共识" moment when the last one signs.
export default function Handshake({node,profile,onAction,signerNames={},openIssues=[]}){
 const slots=node.level==='po'?['ceo','unitDri']:node.level==='mission'?['unitDri','missionDri']:[];
 const labels={ceo:'CEO',unitDri:'领域 DRI',missionDri:'Mission DRI'};
 const allowed=slot=>slot==='ceo'?profile.ceo:slot==='unitDri'?profile.unitDri.includes(node.unit||node.id):profile.missions.includes(node.id);
 const signedCount=slots.filter(slot=>node.signatures?.some(s=>s.slot===slot)).length;
 const complete=!node.upstreamChange&&slots.length>0&&signedCount===slots.length;
 const previous=useRef(null),[celebrate,setCelebrate]=useState(false);
 useEffect(()=>{const key=node.id+':'+node.version;const justCompleted=previous.current?.key===key&&!previous.current.complete&&complete;previous.current={key,complete};setCelebrate(justCompleted);if(justCompleted){const timer=setTimeout(()=>setCelebrate(false),1600);return()=>clearTimeout(timer);}},[node.id,node.version,complete]);
 if(!slots.length&&!node.upstreamChange)return null;
 const mayCheck=node.level==='po'?profile.unitDri.includes(node.unit||node.id):profile.missions.includes(node.level==='mission'?node.id:node.id.split('-t')[0]);
 // One person can hold two slots (the CEO is also a domain DRI); name them once.
 const names=[...new Set(slots.map(slot=>signerNames[slot]||labels[slot]))];
 return <section className={`handshake ${complete?'is-complete':''} ${celebrate?'just-completed':''}`}>
  <div className="handshake-head">
   <h3><span className="handshake-mark" aria-hidden="true">{complete?<Check size={16} strokeWidth={2.6}/>:<HandshakeIcon size={16}/>}</span>{node.upstreamChange?'待核对上级调整':complete?'已达成共识':'共同确认'}</h3>
   {!node.upstreamChange&&slots.length>0&&<span className="handshake-progress" aria-label={`已确认 ${signedCount} / ${slots.length}`}>{slots.map((slot,i)=><i key={slot} data-on={i<signedCount}/>)}<small>{signedCount}/{slots.length}</small></span>}
  </div>
  {complete&&<p className="handshake-summary">{names.join('、')} {names.length>1?'已共同确认':'已确认'} v{node.version}，按此版本推进。</p>}
  {!complete&&!node.upstreamChange&&<p className="handshake-summary">双方都确认后，这一版即成为本月共同承诺。</p>}
  {node.upstreamChange&&<p>上级成果已更新至 v{node.upstreamChange.version}，请核对影响。<>{mayCheck?<Button className="plain" onPress={()=>onAction({type:'acknowledgeImpact'})}>已核对上级调整</Button>:<span>待成果负责人核对</span>}</></p>}
  {/* Before confirming, show what is still open on this card so nobody confirms past their own unresolved notes. */}
  {!complete&&!node.upstreamChange&&openIssues.length>0&&slots.some(slot=>allowed(slot)&&!node.signatures?.some(s=>s.slot===slot))&&<div className="handshake-warning"><strong>还有 {openIssues.length} 项意见未处理</strong><ul>{openIssues.slice(0,4).map((t,i)=><li key={i}>{t}</li>)}</ul></div>}
  {slots.map(slot=>{const signed=node.signatures?.find(s=>s.slot===slot),name=signerNames[slot]||labels[slot];return <div key={slot} className={`handshake-signer ${signed?'is-signed':''}`}>
   <span className="signer-line"><MemberAvatar name={name} className="handshake-avatar"/><span><strong>{name}</strong><small>{labels[slot]} · {signed?`已确认 v${node.version}`:'待确认'}</small></span></span>
   {allowed(slot)&&!signed?<Button className="handshake-confirm" isDisabled={!!node.upstreamChange} onPress={()=>onAction({type:'confirm',slot})}>{openIssues.length?'仍然确认':'确认'} v{node.version}</Button>:<span className="signature-status">{signed?<><Check size={14} aria-label="已确认"/>{shortTime(signed.createdAt)}</>:'待本人确认'}</span>}
  </div>;})}
 </section>;
}
