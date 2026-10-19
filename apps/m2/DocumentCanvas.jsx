import React,{useState} from 'react';
import {ChevronRight,ChevronDown,ChevronUp,MessageCircle} from 'lucide-react';
import {canHandshake,allNodes} from './domain.mjs';
import {responsibilityDocuments,documentDepth} from './document-navigation.mjs';
import {orderPlanUnits} from './plan-labels.mjs';
import {formatPlanDate,milestoneParts} from './reader-view.mjs';
const types={po:'PO',mission:'Mission',task:'Task',activity:'Activity'};
// Weeks of the plan month as calendar blocks (1–7, 8–14, …); enough to judge order and overlap at a glance.
function planWeeks(nodes){
 const first=nodes.map(n=>String(n.time||'').match(/(\d{4})-(\d{2})-\d{2}/)).find(Boolean);if(!first)return [];
 const [y,m]=[Number(first[1]),Number(first[2])],days=new Date(Date.UTC(y,m,0)).getUTCDate();
 return Array.from({length:Math.ceil(days/7)},(_,i)=>({from:Date.UTC(y,m-1,i*7+1),to:Date.UTC(y,m-1,Math.min(days,i*7+7)),label:`W${i+1}`,range:`${m}/${i*7+1}–${Math.min(days,i*7+7)}`}));
}
const span=t=>{const d=String(t||'').match(/\d{4}-\d{2}-\d{2}/g);return d?[Date.parse(d[0]),Date.parse(d.at(-1))]:null;};
// Key result gates: a Mission's dated milestones; a Task's end date.
function gates(n,year){
 const list=(n.milestones||[]).map(entry=>{const {date,label}=milestoneParts(entry);const md=String(date).match(/(\d{1,2})[./月](\d{1,2})/);return md?{at:Date.UTC(year,Number(md[1])-1,Number(md[2])),label}:null;}).filter(Boolean);
 if(list.length)return list;const s=span(n.time);return s?[{at:s[1],label:'交付'}]:[];
}
function TaskPlan({children,display,onOpen,level='task'}){
 const rows=children.map(n=>({n,d:display(n),raw:n})),weeks=planWeeks(children),year=weeks.length?new Date(weeks[0].from).getUTCFullYear():0;
 return <section className={`document-next task-plan work-plan ${level==='mission'?'mission-plan':''}`}><h3>{types[level]} Plan</h3><div className="task-plan-scroll"><table><thead><tr><th>{types[level]} · 一句话成果</th><th>负责人</th>{weeks.map(w=><th key={w.label} className="week"><span>{w.label}</span><small>{w.range}</small></th>)}</tr></thead><tbody>{rows.map(({n,d,raw})=>{const s=span(raw.time),g=gates(raw,year);return <tr key={n.id} data-document-node={n.id}><td className="plan-name"><button className="doc-scope-title" onClick={()=>onOpen(n)}>{d.referenceLabel}｜{d.title}</button><p>{d.result||'待补充'}</p></td><td className="plan-owner">{d.owner||'待补充'}{level==='activity'&&d.type&&<small className="plan-type">{{'Agent Activity':'Agent','Human Activity':'人','Human Checkpoint':'人工检查点'}[d.type]||d.type}</small>}</td>{weeks.map(w=>{const on=s&&s[0]<=w.to&&s[1]>=w.from,here=g.filter(x=>x.at>=w.from&&x.at<=w.to);return <td key={w.label} className={`week${on?' active':''}`}>{here.map((x,i)=><span key={i} className="gate" title={x.label}>△<small>{x.label}</small></span>)}</td>;})}</tr>;})}</tbody></table></div><p className="plan-legend">色块是计划时间，△ 是关键结果节点；点名称看完整卡片。</p></section>;
}
function Summary({node,display,comments,onOpen,unitName,showTime=false}){
 const d=display(node),count=(comments[node.id]||[]).length;
 return <article role="button" tabIndex={0} aria-label={`打开 ${d.title}`} onClick={()=>onOpen(node)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen(node);}}} className={`plan-doc-node doc-summary doc-${node.level} ${node.level==='po'?(node.name?.startsWith('Battlefield')?'unit-battlefield':'unit-domain'):''}`} data-document-node={node.id}>
  <div className="plan-doc-heading"><div className="meta"><span className="type">{d.planLabel||types[node.level]}</span>{unitName&&<span>{unitName}</span>}<span className="person">{d.owner}</span><span className="state" data-confirmed={d.status==='已确认'}>{d.status}</span></div></div>
  <h2>{d.title}</h2><p className="doc-description">{d.result||d.description}</p>
  {showTime&&<p className="doc-summary-time">时间边界：{d.time||'待补充'}</p>}
  <div className="doc-summary-footer"><span>{node.children.length>0?`${node.children.length} ${types[node.children[0].level]}`:null}{count>0&&<><MessageCircle size={14}/> {count}</>}</span><ChevronRight size={16}/></div>
 </article>;
}
function MissionPlan({children,display,onOpen}){
 return <TaskPlan children={children} display={display} onOpen={onOpen} level="mission"/>;
}
export default function DocumentCanvas({units,allUnits,profile,mine,display:sourceDisplay,comments,activeNode,onOpen,editor,activityPlan}){
 const display=n=>{const d=sourceDisplay(n);return {...d,time:formatPlanDate(d.time)};};
 const [collapsed,setCollapsed]=useState({});
 const nodes=allNodes(allUnits),parent=activeNode&&nodes.find(n=>n.children.some(c=>c.id===activeNode.id));
 let catalog=units;
 if(!activeNode&&profile.member)catalog=responsibilityDocuments(orderPlanUnits(allUnits),profile);
 if(mine)catalog=catalog.filter(n=>canHandshake(n,profile));
 // A plan always lists every direct child: "only mine" narrows the catalog, not what a card is made of.
 const children=activeNode?.children||[];
 const depth={po:0,mission:1,task:2,activity:3};
 return <div className={`plan-doc-canvas ${activeNode?'document-page':'document-catalog'}`} aria-label={activeNode?'独立计划文档':'计划文档目录'}>
  {activeNode?<>
   {parent&&<button className="doc-parent-context" onClick={()=>onOpen(parent)}><span>{display(parent).planLabel||types[parent.level]}</span><strong>{display(parent).title}</strong><ChevronRight size={16}/></button>}
   <article className={`plan-doc-node doc-${activeNode.level} document-primary ${activeNode.level==='po'?(activeNode.name?.startsWith('Battlefield')?'unit-battlefield':'unit-domain'):''}`} data-document-node={activeNode.id}>
    <div className="plan-doc-heading"><div className="meta"><span className="type">{display(activeNode).planLabel||types[activeNode.level]}</span>{!activeNode.placeholder&&<span>v{display(activeNode).version}</span>}<span className="person">{display(activeNode).owner}</span>{display(activeNode).time&&<span className="doc-time">{display(activeNode).time}</span>}<span className="state" data-confirmed={display(activeNode).status==='已确认'}>{display(activeNode).status}</span></div><button className="icon document-collapse" aria-label={collapsed[activeNode.id]?'展开卡片':'折叠卡片'} aria-expanded={!collapsed[activeNode.id]} aria-controls={`document-body-${activeNode.id}`} onClick={()=>setCollapsed(s=>({...s,[activeNode.id]:!s[activeNode.id]}))}>{collapsed[activeNode.id]?<ChevronDown size={18}/>:<ChevronUp size={18}/>}</button></div><h2>{editor?.title||display(activeNode).title}</h2><div id={`document-body-${activeNode.id}`} hidden={Boolean(collapsed[activeNode.id])}>{editor?.card}
     {activeNode.level==='po'?<MissionPlan children={children} display={display} onOpen={onOpen}/>:activeNode.level==='mission'&&depth[activeNode.level]<documentDepth(profile,activeNode)&&<TaskPlan children={children} display={display} onOpen={onOpen}/>}
    </div>
   </article>
   {activeNode.level==='task'&&depth.task<documentDepth(profile,activeNode)&&(children.length>0?<TaskPlan children={children} display={display} onOpen={onOpen} level="activity"/>:activityPlan?.(activeNode))}
   {editor?.workflow&&<section className="document-workflow">{editor.workflow}</section>}
  </>:catalog.map(n=><Summary key={n.id} node={n} display={display} comments={comments} onOpen={onOpen} unitName={n.level==='mission'?display(allUnits.find(u=>u.id===n.unit)).planLabel:null}/>)}
  {!activeNode&&!catalog.length&&<p className="empty">当前筛选没有结果</p>}
 </div>;
}
