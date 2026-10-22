import {confirmState} from './review-display.mjs';
import React,{useState,useMemo} from 'react';
import {ChevronRight,MessageCircle,AlertCircle} from 'lucide-react';
import {canHandshake,allNodes} from './domain.mjs';
import {responsibilityDocuments,documentDepth,catalogGroups,nodePath,levelTone} from './document-navigation.mjs';
import {orderPlanUnits} from './plan-labels.mjs';
import {formatPlanDate} from './reader-view.mjs';
import {cardIssues} from './card-issues.mjs';
import {TaskPlan,IssueChip} from './PlanTimeline.jsx';
import {TierTag} from './V3Blocks.jsx';
const types={po:'PO',mission:'Mission',task:'Task',activity:'Activity'};
// Audit findings for this card and everything below it, so each owner sees them where they work.
function CardIssues({node,issues,display,onOpen}){
 const list=issues?.subtree(node)||[];if(!list.length)return null;
 const own=list.filter(x=>x.node.id===node.id).length,below=list.length-own;
 return <details className="card-issues"><summary><AlertCircle size={15}/>本轮检查发现 {list.length} 个问题{own&&below?`（本卡 ${own}，下级 ${below}）`:below?'（都在下级）':''}</summary><p className="card-issues-note">模型检查结果，需负责人核对，不代表已修订。</p><ol>{list.map(({issue,node:n},i)=><li key={i}><div className="card-issues-head"><span className="card-issues-type">{issue.type||'未分类'}</span>{n.id===node.id?<strong>本卡</strong>:<button className="doc-scope-title" onClick={()=>onOpen(n)}>{issues.pathFrom(node,n).map(x=>display(x).referenceLabel).filter(Boolean).join(' › ')}｜{display(n).title}</button>}</div><p>问题：{issue.problem}</p>{issue.impact&&<p>影响：{issue.impact}</p>}</li>)}</ol></details>;
}
// Same first line as inside a document: label, owner, children; the whole card opens it, so no arrow (陈溪南 2026-10-19).
// A unit the round could not write (e.g. 模型拒答) says so instead of showing an empty card (2026-10-22).
function GenerationFailed({reason}){return <p className="generation-failed" role="status">本轮没生成：{reason}。可以在群里 @Nexus 补写，或下一轮重新生成。</p>;}
function Summary({node,display,comments,onOpen,unitName,issues,showTime=false,stateOf}){
 const d=display(node),count=(comments[node.id]||[]).length;
 return <article role="button" tabIndex={0} aria-label={`打开 ${d.title}`} onClick={()=>onOpen(node)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen(node);}}} className={`plan-doc-node doc-summary doc-${node.level} tone-${levelTone(node)}`} data-document-node={node.id}>
  <div className="card-head"><span className="level-tag">{d.planLabel||types[node.level]}</span><TierTag tier={d.tier}/>{unitName&&<span className="card-context">{unitName}</span>}<span className="card-meta"><span className="person">{d.owner}</span>{node.children.length>0&&<span>{node.children.length} {types[node.children[0].level]}</span>}{count>0&&<span className="card-comments"><MessageCircle size={14}/> {count}</span>}</span><span className="card-head-end"><IssueChip count={issues?.subtree(node).length}/>{(()=>{const st=stateOf?stateOf(node):{text:d.status,mine:false};return <span className={`state${st.mine?' is-mine':''}`} data-confirmed={d.status==='已确认'}>{st.text}</span>;})()}</span></div>
  <h2>{d.title}</h2>{(d.generationFailed||node.generationFailed)?<GenerationFailed reason={d.generationFailed||node.generationFailed}/>:<p className="doc-description">{d.result||d.description}</p>}
  {showTime&&<p className="doc-summary-time">时间边界：{d.time||'待补充'}</p>}
 </article>;
}
export function DocPath({units,node,display,onOpen}){
 const path=nodePath(units,node.id),label=n=>n.level==='po'?display(n).planLabel:display(n).referenceLabel;
 return <span className="doc-path" role="navigation" aria-label="层级路径">{path.map((n,i)=>i<path.length-1?<React.Fragment key={n.id}><button className={`doc-path-step tone-${levelTone(n)}`} title={display(n).title} onClick={()=>onOpen(n)}>{label(n)}{n.level!=='po'&&<span>{display(n).title}</span>}</button><ChevronRight size={14} aria-hidden="true"/></React.Fragment>:<span key={n.id} className="doc-path-current" aria-current="page">{label(n)}</span>)}</span>;
}
function MissionPlan({children,display,onOpen,issues,onGantt,...rest}){
 return <TaskPlan children={children} display={display} onOpen={onOpen} issues={issues} onGantt={onGantt} {...rest} level="mission"/>;
}
export default function DocumentCanvas({ceoName='CEO',units,allUnits,profile,mine,display:sourceDisplay,comments,activeNode,onOpen,editor,activityPlan,audit,onShowInGantt,todo,me,onCommentCard,onDeleteCommentCard}){
 const rowComments={comments,me,onComment:onCommentCard,onDeleteComment:onDeleteCommentCard};
 const display=n=>{const d=sourceDisplay(n);return {...d,time:formatPlanDate(d.time)};};
 // Audit findings are the model's self-check for our own testing; members never see them unless ?audit is in the URL.
 const showAudit=typeof location!=='undefined'&&new URLSearchParams(location.search).has('audit');
 const issues=useMemo(()=>showAudit?cardIssues(allUnits,audit):null,[allUnits,audit,showAudit]);
 const stateOf=n=>{const d=display(n),slots=n.level==='po'?['ceo','unitDri']:n.level==='mission'?['unitDri','missionDri']:[],po=allUnits.find(u=>u.id===(n.unit||n.id));return confirmState({status:d.status,version:d.version,signatures:d.signatures,slots,holder:s=>s==='ceo'?ceoName:s==='unitDri'?(po&&display(po).owner):d.owner,mine:s=>s==='ceo'?!!profile.ceo:s==='unitDri'?(profile.unitDri||[]).includes(n.unit||n.id):(profile.missions||[]).includes(n.id)});};
 const nodes=allNodes(allUnits),parent=activeNode&&nodes.find(n=>n.children.some(c=>c.id===activeNode.id));
 let catalog=units;
 if(!activeNode&&profile.member)catalog=responsibilityDocuments(orderPlanUnits(allUnits),profile);
 if(mine)catalog=catalog.filter(n=>canHandshake(n,profile));
 // A plan always lists every direct child: "only mine" narrows the catalog, not what a card is made of.
 const children=activeNode?.children||[];
 const depth={po:0,mission:1,task:2,activity:3};
 return <div className={`plan-doc-canvas ${activeNode?'document-page':'document-catalog'}`} aria-label={activeNode?'独立计划文档':'计划文档目录'}>
  {activeNode?<>
   <article className={`plan-doc-node doc-${activeNode.level} document-primary tone-${levelTone(activeNode)}`} data-document-node={activeNode.id}>
    <div className="card-head"><span className="level-tag">{display(activeNode).planLabel||types[activeNode.level]}</span><TierTag tier={display(activeNode).tier}/><span className="card-meta"><span className="person">{display(activeNode).owner}</span>{display(activeNode).time&&<span className="doc-time">{display(activeNode).time}</span>}{!activeNode.placeholder&&<span>v{display(activeNode).version}</span>}</span><span className="card-head-end"><span className="state" data-confirmed={display(activeNode).status==='已确认'}>{display(activeNode).status}</span></span></div><h2>{editor?.title||display(activeNode).title}</h2>{(display(activeNode).generationFailed||activeNode.generationFailed)&&<GenerationFailed reason={display(activeNode).generationFailed||activeNode.generationFailed}/>}{editor?.notice}<CardIssues node={activeNode} issues={issues} display={display} onOpen={onOpen}/><div id={`document-body-${activeNode.id}`}>{editor?.card}
     {activeNode.level==='po'?<MissionPlan {...rowComments} children={children} display={display} onOpen={onOpen} issues={issues} onGantt={onShowInGantt&&(()=>onShowInGantt(activeNode))}/>:activeNode.level==='mission'&&depth[activeNode.level]<documentDepth(profile,activeNode)&&<TaskPlan {...rowComments} children={children} display={display} onOpen={onOpen} issues={issues} onGantt={onShowInGantt&&(()=>onShowInGantt(activeNode))}/>}
     {activeNode.level==='task'&&depth.task<documentDepth(profile,activeNode)&&(children.length>0?<TaskPlan {...rowComments} children={children} display={display} onOpen={onOpen} issues={issues} onGantt={onShowInGantt&&(()=>onShowInGantt(activeNode))} level="activity"/>:activityPlan?.(activeNode))}
     {editor?.workflow&&<section className="document-workflow card-confirm">{editor.workflow}</section>}
    </div>
   </article>
  </>:<>{todo}{catalogGroups(catalog,profile).map(g=><section key={g.key} className="catalog-group" aria-label={g.title||undefined}>{g.items.map(n=><Summary key={n.id} node={n} stateOf={stateOf} display={display} comments={comments} issues={issues} onOpen={onOpen} unitName={n.level==='mission'?display(allUnits.find(u=>u.id===n.unit)).planLabel:null}/>)}</section>)}</>}
  {!activeNode&&!catalog.length&&<p className="empty">当前筛选没有结果</p>}
 </div>;
}
