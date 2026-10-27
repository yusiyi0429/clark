import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@heroui/react';
import {Handshake as HandshakeIcon,Check} from 'lucide-react';
import MemberAvatar from './MemberAvatar.jsx';
const shortTime=iso=>{const t=new Date(iso);return Number.isNaN(t.getTime())?'':t.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});};
// Shared confirmation: every signer on one row, a quiet progress count, and one clear "达成共识" moment when the last one signs.
// Reviews pass their own slots (公司复盘 = CEO only) and a summary that says the handshake is about the review being right.
// compact (复盘卡, 陈溪南 2026-10-27): signers on one row, a name and either a check with the time or the 确认 button; no role
// line, no 待确认, no version on the button (the card head already shows it), no progress dashes.
export default function Handshake({node,profile,onAction,signerNames={},openIssues=[],slots:given,summary,locked,compact=false,gate=null}){
 const slots=given||(node.level==='po'?['ceo','unitDri']:node.level==='mission'?['unitDri','missionDri']:[]);
 const labels={ceo:'CEO',unitDri:'领域 DRI',missionDri:'Mission DRI'};
 const allowed=slot=>slot==='ceo'?profile.ceo:slot==='unitDri'?profile.unitDri.includes(node.unit||node.id):profile.missions.includes(node.id);
 const signedCount=slots.filter(slot=>node.signatures?.some(s=>s.slot===slot)).length;
 const complete=!node.upstreamChange&&slots.length>0&&signedCount===slots.length;
 const previous=useRef(null),[celebrate,setCelebrate]=useState(false),[pending,setPending]=useState(null),[hint,setHint]=useState(false),hintTimer=useRef(null);
 useEffect(()=>()=>clearTimeout(hintTimer.current),[]);
 // The button answers at once; the saved signature replaces it when the server is done.
 const confirm=slot=>{if(pending)return;setPending(slot);Promise.resolve(onAction({type:'confirm',slot})).finally(()=>setPending(null));};
 useEffect(()=>{const key=node.id+':'+node.version;const justCompleted=previous.current?.key===key&&!previous.current.complete&&complete;previous.current={key,complete};setCelebrate(justCompleted);if(justCompleted){const timer=setTimeout(()=>setCelebrate(false),1600);return()=>clearTimeout(timer);}},[node.id,node.version,complete]);
 if(!slots.length&&!node.upstreamChange)return null;
 // 下级有调整 may also be checked by whoever signs this card (CEO on a unit or company review, the unit DRI on a unit review; M2 2026-10-27).
 const signsHere=slots.some(slot=>allowed(slot));
 const mayCheck=node.level==='po'?profile.unitDri.includes(node.unit||node.id):profile.missions.includes(node.level==='mission'?node.id:node.id.split('-t')[0]);
 // One person can hold two slots (the CEO is also a domain DRI); name them once.
 const names=[...new Set(slots.map(slot=>signerNames[slot]||labels[slot]))];
 return <section className={`handshake ${complete?'is-complete':''} ${celebrate?'just-completed':''}`}>
  {!compact&&<div className="handshake-head">
   <h3><span className="handshake-mark" aria-hidden="true">{complete?<Check size={16} strokeWidth={2.6}/>:<HandshakeIcon size={16}/>}</span>{node.upstreamChange?'待核对上级调整':complete?'已达成共识':'共同确认'}</h3>
   {!compact&&!node.upstreamChange&&slots.length>0&&<span className="handshake-progress" aria-label={`已确认 ${signedCount} / ${slots.length}`}>{slots.map((slot,i)=><i key={slot} data-on={i<signedCount}/>)}<small>{signedCount}/{slots.length}</small></span>}
  </div>}
  {!compact&&complete&&<p className="handshake-summary">{names.join('、')} {names.length>1?'已共同确认':'已确认'} v{node.version}，按此版本推进。</p>}
  {!compact&&!complete&&!node.upstreamChange&&<p className="handshake-summary">{summary||'双方都确认后，这一版即成为本月共同承诺。'}</p>}
  {/* 下级有调整 does not block confirming; the same 已核对 clears it (M2 2026-10-22). */}
  {!node.upstreamChange&&node.downstreamChange&&<p>下级卡已更新{node.downstreamChange.staleDates?.length?`，本卡还写着 ${node.downstreamChange.staleDates.join('、')}`:''}，请核对是否要跟着改。<>{mayCheck||signsHere?<Button className="plain" onPress={()=>onAction({type:'acknowledgeImpact'})}>已核对下级调整</Button>:<span>待成果负责人核对</span>}</></p>}
  {node.upstreamChange&&<p>上级成果已更新至 v{node.upstreamChange.version}，请核对影响。<>{mayCheck?<Button className="plain" onPress={()=>onAction({type:'acknowledgeImpact'})}>已核对上级调整</Button>:<span>待成果负责人核对</span>}</></p>}
  {/* Before confirming, show what is still open on this card so nobody confirms past their own unresolved notes. */}
  {!complete&&!node.upstreamChange&&openIssues.length>0&&slots.some(slot=>allowed(slot)&&!node.signatures?.some(s=>s.slot===slot))&&<div className="handshake-warning"><strong>还有 {openIssues.length} 项意见未处理</strong><ul>{openIssues.slice(0,4).map((t,i)=><li key={i}>{t}</li>)}</ul></div>}
  {compact?<div className="handshake-signers">{[...new Set(slots.map(slot=>signerNames[slot]||labels[slot]))].map(name=>{
   // One entry per person (陈溪南 2026-10-27): someone holding two slots (unit DRI and Mission DRI) shows once and confirms both.
   const held=slots.filter(slot=>(signerNames[slot]||labels[slot])===name),sigs=held.map(slot=>node.signatures?.find(s=>s.slot===slot));
   const signed=sigs.every(Boolean)?sigs.reduce((a,s)=>String(s.createdAt)>String(a.createdAt)?s:a):null,open=held.filter((slot,i)=>!sigs[i]&&allowed(slot)),mine=!signed&&open.length>0;
   const confirmAll=async()=>{if(pending)return;setPending(name);try{for(const slot of open)await onAction({type:'confirm',slot});}finally{setPending(null);}};
   // Like signing, but one click (陈溪南 2026-10-27): who, then a clear 已确认 seal with the time, 未确认, or my 确认 button.
   return <div key={name} className={`sign-line${signed?' is-signed':mine?' is-mine':''}`}>
    <MemberAvatar name={name} className="handshake-avatar"/><strong>{name}</strong>
    {/* A fixed slot, so 确认 turning into 已确认 + time does not push the next person along (陈溪南 2026-10-27). */}
    <span className="sign-slot">{signed?<span className="sign-seal"><Check size={13} strokeWidth={2.6} aria-hidden="true"/>已确认 {shortTime(signed.createdAt)}</span>
     :mine&&gate?<><Button className="handshake-confirm" onPress={()=>{setHint(true);clearTimeout(hintTimer.current);hintTimer.current=setTimeout(()=>setHint(false),3200);gate.onPress();}}>确认</Button>{hint&&<small className="sign-hint" role="status">{gate.text}</small>}</>
     :mine?<>{locked&&<small className="handshake-locked" title={locked.title}>{locked.text||locked}</small>}<Button className="handshake-confirm" isDisabled={!!node.upstreamChange||!!locked||!!pending} onPress={confirmAll}>{pending===name?'确认中…':openIssues.length?'仍然确认':'确认'}</Button></>
     :<span className="sign-seal is-open">未确认</span>}</span>
   </div>;})}</div>:slots.map(slot=>{const signed=node.signatures?.find(s=>s.slot===slot),name=signerNames[slot]||labels[slot];return <div key={slot} className={`handshake-signer ${signed?'is-signed':''}`}>
   <span className="signer-line"><MemberAvatar name={name} className="handshake-avatar"/><span><strong>{name}</strong><small>{labels[slot]} · {signed?`已确认 v${node.version}`:'待确认'}</small></span></span>
   {allowed(slot)&&!signed?<span className="handshake-confirm-wrap">{locked&&<small className="handshake-locked" title={locked.title}>{locked.text||locked}</small>}<Button className="handshake-confirm" isDisabled={!!node.upstreamChange||!!locked||!!pending} onPress={()=>confirm(slot)}>{pending===slot?'确认中…':`${openIssues.length?'仍然确认':'确认'} v${node.version}`}</Button></span>:<span className="signature-status">{signed?<><Check size={14} aria-label="已确认"/>{shortTime(signed.createdAt)}</>:'待本人确认'}</span>}
  </div>;})}
 </section>;
}
