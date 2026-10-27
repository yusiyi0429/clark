import React,{useState} from 'react';
import {ChevronRight,ChevronDown} from 'lucide-react';
import {shortLabel} from './plan-track.mjs';
// "待我处理" on the home page: the few things only this member can move forward, most urgent first.
// Cards nobody has confirmed yet are the baseline of the month, so they fold into one line instead of crowding the list.
const verb={insight:'待提交洞察',objection:'有人反对，待你回应',downstream:'下级有调整，请核对',ask:'待你回答',proposal:'修订建议待你确认',upstream:'上级已调整，请核对',sign:'对方已确认，等你确认',mention:'在群里 @ 了你',comment:'有新批注'};
// The review stage uses the same panel; labelOf names its cards (复盘卡 are not plan nodes).
export default function TodoPanel({items,resolve,display,onGo,labelOf,expanded=false,onAck}){
 const [allState,setAll]=useState(false),[baselineState,setBaselineOpen]=useState(false),all=expanded||allState,baselineOpen=expanded||baselineState;
 const urgent=items.filter(i=>!(i.kind==='sign'&&!i.otherSigned)),baseline=items.filter(i=>i.kind==='sign'&&!i.otherSigned);
 if(!items.length)return null;
 const label=item=>{if(labelOf)return labelOf(item);const n=(item.count>1&&item.groupId?resolve(item.groupId):null)||item.cardId&&resolve(item.cardId);if(!n)return item.scope?display(resolve(item.scope)||{id:item.scope}).planLabel||item.scope:'';const d=display(n);return `${n.level==='po'?d.planLabel:shortLabel(d.referenceLabel)} ${d.title}`;};
 const text=item=>item.kind==='sign'?(item.otherSigned?verb.sign:`v${item.version} 待你确认`):item.kind==='upstream'?(item.count>1?`上级已调整，${item.count} 张卡待核对`:verb.upstream):item.kind==='objection'?`${item.author||'有人'} 反对${item.count>1?`（${item.count} 条）`:''}，待你回应`:item.kind==='downstream'?(item.staleDates?.length?`下级改了，你卡上还写着 ${item.staleDates.slice(0,2).join('、')}`:verb.downstream):item.kind==='mention'?`${item.author} ${verb.mention}`:item.kind==='comment'?`${item.count} 条新批注`:verb[item.kind];
 const row=(item,i)=><li key={item.kind+(item.id||item.cardId||item.scope)+i}><button className={`todo-item todo-${item.kind}${item.kind==='sign'&&!item.otherSigned?' todo-baseline':''}`} onClick={()=>onGo(item)}><i aria-hidden="true"/><span className="todo-text">{text(item)}</span><span className="todo-card">{label(item)}</span><ChevronRight size={15}/></button></li>;
 if(expanded){const flat=[...urgent,...baseline];return <section className="todo-panel todo-flat" aria-label="待我处理"><ul>{flat.map((item,i)=><li key={item.kind+(item.id||item.cardId||item.scope)+i} className={item.kind==='downstream'&&onAck?'has-ack':undefined}><button className="todo-item" onClick={()=>onGo(item)}><span className="todo-text">{item.kind==='sign'?'待你确认':text(item)}</span><span className="todo-card">{label(item)}</span><ChevronRight size={15}/></button>{/* 下级有调整 after the card was already confirmed: nothing left to confirm, so it is checked off here (M2 2026-10-27). */}{item.kind==='downstream'&&onAck&&<button type="button" className="todo-ack" onClick={()=>onAck(item)}>已核对</button>}</li>)}</ul></section>;}
 const shown=all?urgent:urgent.slice(0,5);
 return <section className="todo-panel" aria-label="待我处理">
  <h3>待我处理{urgent.length>0&&<span>{urgent.length}</span>}</h3>
  {shown.length>0&&<ul>{shown.map(row)}</ul>}
  {urgent.length>5&&!expanded&&<button className="todo-more" onClick={()=>setAll(v=>!v)}>{all?'收起':`还有 ${urgent.length-5} 项`}</button>}
  {baseline.length>0&&<>{expanded?<h4 className="todo-baseline-heading">{urgent.length?'另有':'有'} {baseline.length} 张卡待你确认</h4>:<button className="todo-baseline-toggle" aria-expanded={baselineOpen} onClick={()=>setBaselineOpen(v=>!v)}>{baselineOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}{urgent.length?'另有':'有'} {baseline.length} 张卡待你确认</button>}
   {baselineOpen&&<ul className="todo-baseline-list">{baseline.map(row)}</ul>}</>}
 </section>;
}
// 待我处理 in the title row (陈溪南 2026-10-21): one button with the count; the same list opens under it in both stages.
export function TodoMenu({items,resolve,display,onGo,labelOf,openKey,onAck}){
 const [open,setOpen]=useState(false),ref=React.useRef(null);
 // A notification link (?todo=1) opens the list.
 React.useEffect(()=>{if(openKey)setOpen(true);},[openKey]);
 React.useEffect(()=>{if(!open)return;const close=e=>{if(!ref.current?.contains(e.target))setOpen(false);},key=e=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('pointerdown',close,true);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',close,true);document.removeEventListener('keydown',key);};},[open]);
 if(!items.length)return null;
 // The count is the list: every item below is counted once (评测 2026-10-22: badge 8 vs twenty in the list).
 return <div className="todo-menu" ref={ref}>
  <button className={`toolbar-chip todo-menu-button${open?' is-open':''}`} aria-expanded={open} onClick={()=>setOpen(v=>!v)}>待我处理<span className="todo-menu-count">{items.length}</span></button>
  {open&&<div className="todo-menu-panel"><TodoPanel expanded items={items} resolve={resolve} display={display} labelOf={labelOf} onAck={onAck} onGo={item=>{setOpen(false);onGo(item);}}/></div>}
 </div>;
}
