import React,{useState} from 'react';
import {ChevronRight,ChevronDown,ChevronUp,MessageCircle} from 'lucide-react';
import {canHandshake,allNodes} from './domain.mjs';
import {responsibilityDocuments,documentDepth} from './document-navigation.mjs';
import {orderPlanUnits} from './plan-labels.mjs';
import {formatPlanDate} from './reader-view.mjs';
import {FormattedValue} from './DocumentContent.jsx';
const types={po:'PO',mission:'Mission',task:'Task',activity:'Activity'};
function TaskPlan({children,display,onOpen,level='task'}){
 return <section className={`document-next task-plan ${level==='mission'?'mission-plan':''}`}><h3>{level==='mission'?'Mission':'Task'} Plan</h3><div className="task-plan-scroll"><table><thead><tr>{[level==='mission'?'Mission':'Task','负责人','成果描述','时间边界','验收标准'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{children.map(n=>{const d=display(n);return <tr key={n.id} data-document-node={n.id}><td><button className="doc-scope-title" onClick={()=>onOpen(n)}>{d.referenceLabel}：{d.title}</button></td><td>{d.owner||'待补充'}</td><td>{d.result||'待补充'}</td><td>{d.time||'待补充'}</td><td><FormattedValue value={Array.isArray(d.checks)&&d.checks.length?d.checks:d.checks||'待补充'}/></td></tr>})}</tbody></table></div></section>;
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
export default function DocumentCanvas({units,allUnits,profile,mine,display:sourceDisplay,comments,activeNode,onOpen,editor}){
 const display=n=>{const d=sourceDisplay(n);return {...d,time:formatPlanDate(d.time)};};
 const [collapsed,setCollapsed]=useState({});
 const nodes=allNodes(allUnits),parent=activeNode&&nodes.find(n=>n.children.some(c=>c.id===activeNode.id));
 let catalog=units;
 if(!activeNode&&profile.member)catalog=responsibilityDocuments(orderPlanUnits(allUnits),profile);
 if(mine)catalog=catalog.filter(n=>canHandshake(n,profile));
 const children=activeNode?.children.filter(n=>!mine||canHandshake(n,profile))||[];
 const depth={po:0,mission:1,task:2,activity:3};
 if(mine&&activeNode&&!canHandshake(activeNode,profile))return <div className="plan-doc-canvas document-page"><p className="empty">当前材料不需要你握手。关闭“只看我负责”可继续查看。</p></div>;
 return <div className={`plan-doc-canvas ${activeNode?'document-page':'document-catalog'}`} aria-label={activeNode?'独立计划文档':'计划文档目录'}>
  {activeNode?<>
   {parent&&<button className="doc-parent-context" onClick={()=>onOpen(parent)}><span>{display(parent).planLabel||types[parent.level]}</span><strong>{display(parent).title}</strong><ChevronRight size={16}/></button>}
   <article className={`plan-doc-node doc-${activeNode.level} document-primary ${activeNode.level==='po'?(activeNode.name?.startsWith('Battlefield')?'unit-battlefield':'unit-domain'):''}`} data-document-node={activeNode.id}>
    <div className="plan-doc-heading"><div className="meta"><span className="type">{display(activeNode).planLabel||types[activeNode.level]}</span>{!activeNode.placeholder&&<span>v{display(activeNode).version}</span>}<span className="person">{display(activeNode).owner}</span><span className="state" data-confirmed={display(activeNode).status==='已确认'}>{display(activeNode).status}</span></div><button className="icon document-collapse" aria-label={collapsed[activeNode.id]?'展开卡片':'折叠卡片'} aria-expanded={!collapsed[activeNode.id]} aria-controls={`document-body-${activeNode.id}`} onClick={()=>setCollapsed(s=>({...s,[activeNode.id]:!s[activeNode.id]}))}>{collapsed[activeNode.id]?<ChevronDown size={18}/>:<ChevronUp size={18}/>}</button></div><h2>{editor?.title||display(activeNode).title}</h2><div id={`document-body-${activeNode.id}`} hidden={Boolean(collapsed[activeNode.id])}>{editor?.card}
     {activeNode.level==='po'?<MissionPlan children={children} display={display} onOpen={onOpen}/>:activeNode.level==='mission'&&depth[activeNode.level]<documentDepth(profile,activeNode)&&<TaskPlan children={children} display={display} onOpen={onOpen}/>}
    </div>
   </article>
   {!['po','mission'].includes(activeNode.level)&&depth[activeNode.level]<documentDepth(profile,activeNode)&&children.length>0&&<section className="document-next"><h3>{types[children[0].level]} · {children.length}</h3>{children.map(n=><Summary key={n.id} node={n} display={display} comments={comments} onOpen={onOpen}/>)}</section>}
   {editor?.workflow&&<section className="document-workflow">{editor.workflow}</section>}
  </>:catalog.map(n=><Summary key={n.id} node={n} display={display} comments={comments} onOpen={onOpen} unitName={n.level==='mission'?display(allUnits.find(u=>u.id===n.unit)).planLabel:null}/>)}
  {!activeNode&&!catalog.length&&<p className="empty">当前筛选没有结果</p>}
 </div>;
}
