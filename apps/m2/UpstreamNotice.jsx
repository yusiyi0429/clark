import React from 'react';
import {Button} from '@heroui/react';
// Top of a card flagged by an upper revision: say what changed above and give the one-click "no change needed".
export default function UpstreamNotice({node,parent,profile,onAck,onOpenParent}){
 if(!node?.upstreamChange)return null;
 const canCheck=node.level==='po'?profile.unitDri.includes(node.unit||node.id):profile.missions.includes(node.level==='mission'?node.id:node.id.split('-t')[0])||profile.unitDri.includes(node.unit);
 return <div className="upstream-notice" role="status">
  <span>上级{parent?<>「<button className="upstream-link" onClick={onOpenParent}>{parent.title}</button>」</>:''}已改到 v{node.upstreamChange.version}。看一下这张卡要不要跟着改：要改就直接修订；不用改就点右边。</span>
  {canCheck?<Button className="plain upstream-ack" onPress={onAck}>核对完，不用改</Button>:<small>等这张卡的负责人核对</small>}
 </div>;
}
