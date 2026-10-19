import React,{useState} from 'react';
import {ChevronRight,ChevronDown} from 'lucide-react';
import {shortLabel} from './plan-track.mjs';
// "待我处理" on the home page: the few things only this member can move forward, most urgent first.
// Cards nobody has confirmed yet are the baseline of the month, so they fold into one line instead of crowding the list.
const verb={proposal:'修订建议待你确认',upstream:'上级已调整，请核对',sign:'对方已确认，等你确认',mention:'在群里 @ 了你',comment:'有新批注'};
export default function TodoPanel({items,resolve,display,onGo}){
 const [all,setAll]=useState(false),[baselineOpen,setBaselineOpen]=useState(false);
 const urgent=items.filter(i=>!(i.kind==='sign'&&!i.otherSigned)),baseline=items.filter(i=>i.kind==='sign'&&!i.otherSigned);
 if(!items.length)return null;
 const label=item=>{const n=(item.count>1&&item.groupId?resolve(item.groupId):null)||item.cardId&&resolve(item.cardId);if(!n)return item.scope?display(resolve(item.scope)||{id:item.scope}).planLabel||item.scope:'';const d=display(n);return `${n.level==='po'?d.planLabel:shortLabel(d.referenceLabel)} ${d.title}`;};
 const text=item=>item.kind==='sign'?(item.otherSigned?verb.sign:`v${item.version} 待你确认`):item.kind==='upstream'?(item.count>1?`上级已调整，${item.count} 张卡待核对`:verb.upstream):item.kind==='mention'?`${item.author} ${verb.mention}`:item.kind==='comment'?`${item.count} 条新批注`:verb[item.kind];
 const row=(item,i)=><li key={item.kind+(item.id||item.cardId||item.scope)+i}><button className={`todo-item todo-${item.kind}${item.kind==='sign'&&!item.otherSigned?' todo-baseline':''}`} onClick={()=>onGo(item)}><i aria-hidden="true"/><span className="todo-text">{text(item)}</span><span className="todo-card">{label(item)}</span><ChevronRight size={15}/></button></li>;
 const shown=all?urgent:urgent.slice(0,5);
 return <section className="todo-panel" aria-label="待我处理">
  <h3>待我处理{urgent.length>0&&<span>{urgent.length}</span>}</h3>
  {shown.length>0&&<ul>{shown.map(row)}</ul>}
  {urgent.length>5&&<button className="todo-more" onClick={()=>setAll(v=>!v)}>{all?'收起':`还有 ${urgent.length-5} 项`}</button>}
  {baseline.length>0&&<><button className="todo-baseline-toggle" aria-expanded={baselineOpen} onClick={()=>setBaselineOpen(v=>!v)}>{baselineOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}{urgent.length?'另有':'有'} {baseline.length} 张卡待你确认</button>
   {baselineOpen&&<ul className="todo-baseline-list">{baseline.map(row)}</ul>}</>}
 </section>;
}
