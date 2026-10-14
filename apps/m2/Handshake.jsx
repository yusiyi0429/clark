import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@heroui/react';
import {Handshake as HandshakeIcon,Check} from 'lucide-react';
export default function Handshake({node,profile,onAction,signerNames={}}){
 const slots=node.level==='po'?['ceo','unitDri']:node.level==='mission'?['unitDri','missionDri']:[];
 const labels={ceo:'CEO',unitDri:'领域 DRI',missionDri:'Mission DRI'};
 const allowed=slot=>slot==='ceo'?profile.ceo:slot==='unitDri'?profile.unitDri.includes(node.unit||node.id):profile.missions.includes(node.id);
 const complete=!node.upstreamChange&&slots.length>0&&slots.every(slot=>node.signatures?.some(s=>s.slot===slot));
 const previous=useRef(null),[celebrate,setCelebrate]=useState(false);
 useEffect(()=>{const key=node.id+':'+node.version;const justCompleted=previous.current?.key===key&&!previous.current.complete&&complete;previous.current={key,complete};setCelebrate(justCompleted);if(justCompleted){const timer=setTimeout(()=>setCelebrate(false),1100);return()=>clearTimeout(timer);}},[node.id,node.version,complete]);
 if(!slots.length&&!node.upstreamChange)return null;
 const mayCheck=node.level==='po'?profile.unitDri.includes(node.unit||node.id):profile.missions.includes(node.level==='mission'?node.id:node.id.split('-t')[0]);
 return <section className={`handshake ${complete?'is-complete':''} ${celebrate?'just-completed':''}`}><h3><span className="handshake-mark" aria-hidden="true"><HandshakeIcon size={18}/></span>{node.upstreamChange?'待核对上级调整':complete?'握手成功':'共同确认'}</h3>{node.upstreamChange&&<p>上级成果已更新至 v{node.upstreamChange.version}，请核对影响。<>{mayCheck?<Button className="plain" onPress={()=>onAction({type:'acknowledgeImpact'})}>已核对上级调整</Button>:<span>待成果负责人核对</span>}</></p>}{slots.map(slot=>{const signed=node.signatures?.find(s=>s.slot===slot);return <div key={slot}><span className="signer-line"><strong>{signerNames[slot]||labels[slot]}</strong><small>{labels[slot]} · {signed?`已确认 v${node.version}`:'待确认'}</small></span>{allowed(slot)&&!signed?<Button className="plain" isDisabled={!!node.upstreamChange} onPress={()=>onAction({type:'confirm',slot})}>确认 v{node.version}</Button>:<span className="signature-status">{signed?<Check size={15} aria-label="已确认"/>:'待本人确认'}</span>}</div>})}</section>;
}
