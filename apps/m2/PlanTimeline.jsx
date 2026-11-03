import {confirmInPage} from './page-confirmation.mjs';
import React,{useState,useRef,useEffect,useLayoutEffect} from 'react';
import {createPortal} from 'react-dom';
import {ChevronRight,ChevronDown,Check,MessageCircle} from 'lucide-react';
import {canHandshake,hasHandshake} from './domain.mjs';
import {documentDepth,levelTone} from './document-navigation.mjs';
import {taskDependencies} from './plan-deps.mjs';
import {milestoneParts,planSummary,plainCardTitle} from './reader-view.mjs';
import {planTrack,shortLabel,datePosition,clampNameCol} from './plan-track.mjs';
import {splitBoundary,shortEffort} from './v3-display.mjs';
import {TierTag} from './V3Blocks.jsx';
// One timeline for both places a plan is drawn: the Plan under a card (a few rows of the big chart)
// and the Gantt canvas (every visible row). Same weeks, bars, nodes, colours and labels in both.
const types={po:'PO',mission:'Mission',task:'Task',activity:'Activity'};
// Weeks of the plan month as calendar blocks (1–7, 8–14, …); enough to judge order and overlap at a glance.
// Shown times read "2026.10.9 – 10.26"; stored ones "2026-10-09—2026-10-26". Both become ISO dates here.
export function isoTime(t){const s=String(t||'');if(/\d{4}-\d{2}-\d{2}/.test(s))return s;const m=s.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\s*[–—-]\s*(?:(\d{4})\.)?(?:(\d{1,2})\.)?(\d{1,2}))?/);if(!m)return s;const pad=x=>String(x).padStart(2,'0'),a=`${m[1]}-${pad(m[2])}-${pad(m[3])}`;return m[6]?`${a}—${m[4]||m[1]}-${pad(m[5]||m[2])}-${pad(m[6])}`:a;}
export function planWeeks(nodes){
 const first=nodes.map(n=>isoTime(n.time).match(/(\d{4})-(\d{2})-\d{2}/)).find(Boolean);if(!first)return [];
 const [y,m]=[Number(first[1]),Number(first[2])],days=new Date(Date.UTC(y,m,0)).getUTCDate();
 return Array.from({length:Math.ceil(days/7)},(_,i)=>({from:Date.UTC(y,m-1,i*7+1),to:Date.UTC(y,m-1,Math.min(days,i*7+7)),label:`W${i+1}`,range:`${m}/${i*7+1}–${Math.min(days,i*7+7)}`}));
}
export const span=t=>{const d=isoTime(t).match(/\d{4}-\d{2}-\d{2}/g);return d?[Date.parse(d[0]),Date.parse(d.at(-1))]:null;};
// Key result gates: a Mission's dated milestones; a Task's end date.
export function gates(n,year){
 const list=(n.milestones||[]).map(entry=>{const {date,label}=milestoneParts(entry);const md=String(date).match(/(\d{1,2})[./月](\d{1,2})/);return md?{at:Date.UTC(year,Number(md[1])-1,Number(md[2])),label}:null;}).filter(Boolean);
 // Without milestones the end date is the gate; name it by what is achieved, not a bare "交付".
 if(list.length)return list;const s=span(n.time);return s?[{at:s[1],label:plainCardTitle(n)||'交付'}]:[];
}
// A parent plan shows each child in one short line; the full result is on the child card (and in the tooltip).
function PlanSummary({text}){const s=planSummary(text);return <p title={s.truncated?text:undefined}>{s.text||'待补充'}</p>;}
export function IssueChip({count}){return count>0?<span className="issue-chip" title="本轮模型检查发现的问题，需负责人核对">检查问题 {count}</span>:null;}
// One track per row: the light bar is the planned time, nodes sit on their dates and are joined in order — the path to the result.
function PlanTrack({weeks,span,gates}){
 const t=planTrack(weeks,span,gates);
 return <div className="plan-track" style={{'--weeks':weeks.length}}>
  {t.bar&&<span className="plan-track-bar" style={{left:`${t.bar.left}%`,width:`${t.bar.right-t.bar.left}%`}}/>}
  {t.path&&<span className="plan-track-path" style={{left:`${t.path.left}%`,width:`${t.path.right-t.path.left}%`}}/>}
  {t.points.map((p,i)=><span key={i} className={`plan-node ${p.lane}${p.last?' is-last':''}${p.align==='end'?' edge-right':p.align==='start'?' edge-left':''}`} style={{left:`${p.pct}%`}} title={`${p.date} ${p.label}`}><i/>{p.labeled&&<small><time>{p.date}</time><span className="plan-node-label">{p.label}</span></small>}</span>)}
 </div>;
}
// Comment on a Plan row without leaving the parent card: a hover icon on the row opens a full-width line below it.
function RowCommentTrigger({node,list=[],open,onToggle}){
 return <button data-row-comment={node.id} className={`row-comment-trigger${list.length?' has-comments':''}${open?' is-open':''}`} aria-label={`批注 ${node.title||node.id}`} aria-expanded={open} onClick={onToggle}><MessageCircle size={13}/>{list.length>0&&<span>{list.length}</span>}</button>;
}
// Floats over the page next to the row's comment button, like field comments; never pushes the table apart.
function RowCommentBox({node,list=[],me,onAdd,onDelete,onClose}){
 const [text,setText]=useState(''),[busy,setBusy]=useState(false),[pos,setPos]=useState(null);
 useLayoutEffect(()=>{const place=()=>{const r=document.querySelector(`[data-row-comment="${CSS.escape(node.id)}"]`)?.getBoundingClientRect();if(!r)return;const w=Math.min(380,window.innerWidth-24);setPos({top:Math.min(r.bottom+6,window.innerHeight-260),left:Math.max(12,Math.min(r.left-8,window.innerWidth-w-12)),width:w});};place();window.addEventListener('resize',place);document.addEventListener('scroll',place,true);return()=>{window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true);};},[node.id]);
 useEffect(()=>{const esc=e=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',esc);return()=>document.removeEventListener('keydown',esc);},[onClose]);
 async function add(){if(!text.trim()||busy)return;setBusy(true);try{await onAdd(node,text.trim());setText('');}finally{setBusy(false);}}
 if(!pos)return null;
 return createPortal(<div className="row-comment-box is-floating" role="dialog" aria-label="批注" style={pos}>
  {list.map(c=><div className="comment-preview" key={c.id}><small>{c.author}{me===c.author&&onDelete&&<button className="comment-delete" onClick={async()=>{if(await confirmInPage('删除这条批注？'))onDelete(node,c.id);}}>删除</button>}</small><p>{c.text}</p></div>)}
  <textarea rows={2} autoFocus value={text} placeholder="对这一项提出意见…" onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();add();}}}/>
  <div className="row-comment-actions"><button className="plain" onClick={onClose}>收起</button><button className="primary" disabled={!text.trim()||busy} onClick={add}>{busy?'发送中…':'添加批注'}</button></div>
 </div>,document.body);
}
// 3.x Tasks carry an effort estimate; the column only appears when some row has one.
const effortOf=d=>shortEffort(splitBoundary(d).effort);
export function TaskPlan({children,display,onOpen,issues,onGantt,comments,me,onComment,onDeleteComment,level='task'}){
 const [openRow,setOpenRow]=useState(null);
 // Dates come from the current version (display), so an accepted revision moves the bar (2026-10-19).
 const rows=children.map(n=>({n,d:display(n),raw:n})),weeks=planWeeks(rows.map(r=>r.d)),year=weeks.length?new Date(weeks[0].from).getUTCFullYear():0,effort=level==='task'&&rows.some(({d})=>effortOf(d));
 return <section className={`document-next task-plan work-plan plan-${level} ${level==='mission'?'mission-plan':''}`}><h3>{types[level]} Plan{onGantt&&<button className="plan-gantt-link" onClick={onGantt}>在甘特图中查看 ›</button>}</h3><div className="task-plan-scroll"><table><thead><tr><th>一句话成果</th><th>负责人</th>{effort&&<th className="plan-effort">投入</th>}{weeks.map(w=><th key={w.label} className="week"><span>{w.label}</span><small>{w.range}</small></th>)}</tr></thead><tbody>{rows.map(({n,d,raw})=>{const s=span(d.time),g=gates(d,year);return <React.Fragment key={n.id}><tr data-document-node={n.id}><td className="plan-name"><button className="doc-scope-title" title={d.result||undefined} onClick={()=>onOpen(n)}><span className="plan-ref">{shortLabel(d.referenceLabel)}</span><TierTag tier={d.tier}/>{d.title}</button>{onComment&&<RowCommentTrigger node={raw} list={comments?.[raw.id]} open={openRow===raw.id} onToggle={()=>setOpenRow(v=>v===raw.id?null:raw.id)}/>}<IssueChip count={issues?.subtree(raw).length}/></td><td className="plan-owner">{d.owner||'待补充'}{level==='activity'&&d.type&&<small className="plan-type">{{'Agent Activity':'Agent','Human Activity':'人','Human Checkpoint':'人工检查点'}[d.type]||d.type}</small>}</td>{effort&&<td className="plan-effort">{effortOf(d)}</td>}{weeks.length>0&&<td className="plan-track-cell" colSpan={weeks.length}><PlanTrack weeks={weeks} span={s} gates={g}/></td>}</tr>{openRow===n.id&&<RowCommentBox node={raw} list={comments?.[raw.id]} me={me} onAdd={onComment} onDelete={onDeleteComment} onClose={()=>setOpenRow(null)}/>}</React.Fragment>;})}</tbody></table></div><p className="plan-legend">浅色条是计划时间，圆点是关键结果节点，按时间连成实现路径；点名称看完整卡片。</p></section>;
}

// ── Gantt canvas: the same timeline for every row the viewer can see, as an expandable tree. ──
const ROW={po:40,mission:40,task:34,activity:30};
function todayIn(weeks){
 if(!weeks.length)return null;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).split('-').map(Number);
 const at=Date.UTC(parts[0],parts[1]-1,parts[2]);
 return at>=weeks[0].from&&at<=weeks.at(-1).to?{at,pct:datePosition(weeks,at,'mid'),label:`${parts[1]}/${parts[2]}`}:null;
}
// A PO row summarises its Missions: each Mission's final result is one node on the PO line.
function rowGates(n,year){
 if(n.level!=='po')return gates(n,year);
 return (n.children||[]).flatMap(m=>{const g=gates(m,year).at(-1);return g?[{at:g.at,label:plainCardTitle(m)}]:[];});
}
const NAME_COL_KEY='m2-gantt-name-col';
const nameHeadWidth=root=>root.querySelector('.gantt-name-head')?.getBoundingClientRect().width||240;
// The line between 名称 and the weeks can be dragged (or moved with ←/→); double-click restores the default.
function NameColumnResizer({rootRef,width,onChange}){
 function drag(e){
  const root=rootRef.current;if(!root||e.button!==0)return;e.preventDefault();
  const start=e.clientX,from=nameHeadWidth(root);let w=from;
  const move=ev=>{w=clampNameCol(from+ev.clientX-start,root.clientWidth);root.style.setProperty('--name-col',`${w}px`);};
  const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);document.body.classList.remove('is-col-resizing');onChange(w);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);document.body.classList.add('is-col-resizing');
 }
 function key(e){const step={ArrowRight:16,ArrowLeft:-16}[e.key];if(!step)return;e.preventDefault();onChange(clampNameCol(nameHeadWidth(rootRef.current)+step,rootRef.current.clientWidth));}
 return <div className="gantt-resizer" role="separator" aria-orientation="vertical" aria-label="拖动调整名称列宽度" aria-valuenow={Math.round(width||240)} tabIndex={0} title="拖动调整名称列宽度，双击恢复" onPointerDown={drag} onKeyDown={key} onDoubleClick={()=>onChange(null)}/>;
}
export function GanttCanvas({units,allUnits,profile,mine,search,expanded,onToggle,onOpen,display,updated=[]}){
 const rootRef=useRef(null);
 const [nameCol,setNameCol]=useState(()=>{try{return Number(localStorage.getItem(NAME_COL_KEY))||null;}catch{return null;}});
 function saveNameCol(w){setNameCol(w);if(!w)rootRef.current?.style.removeProperty('--name-col');try{w?localStorage.setItem(NAME_COL_KEY,String(w)):localStorage.removeItem(NAME_COL_KEY);}catch{}}
 // The 名称 column is sticky; when the canvas scrolls sideways the divider follows it.
 useEffect(()=>{const root=rootRef.current,sc=root?.closest('.canvas-scroll');if(!sc)return;const sync=()=>root.style.setProperty('--scroll-x',`${sc.scrollLeft}px`);sync();sc.addEventListener('scroll',sync,{passive:true});return()=>sc.removeEventListener('scroll',sync);});
 const weeks=planWeeks(allUnits),year=weeks.length?new Date(weeks[0].from).getUTCFullYear():0,today=todayIn(weeks);
 const rows=[];
 // "Only mine" = the cards this viewer must confirm, plus the Tasks under a Mission they own, plus the parents that
 // lead there. Owning a PO (as CEO) does not pull in every Mission below it; only the ones they confirm as DRI.
 const visit=(n,depth,ownMission)=>{
  const mineHere=canHandshake(n,profile),carry=ownMission||n.level==='mission'&&mineHere;
  const kids=(n.children||[]).filter(c=>!mine||carry||hasHandshake(c,profile)).filter(c=>!search||JSON.stringify(c).includes(search));
  const can=kids.length>0&&depth<documentDepth(profile,n),open=can&&(expanded.has(n.id)||mine&&!mineHere);
  rows.push({n,depth,can,open,y:0});
  if(open)kids.forEach(c=>visit(c,depth+1,carry));
 };
 units.forEach(u=>visit(u,0,false));
 let y=0;rows.forEach(r=>{r.y=y;r.h=ROW[r.n.level]||32;y+=r.h;});
 const byId=new Map(rows.map(r=>[r.n.id,r]));
 // Arrows: from each visible Task's nearest predecessor in the same Mission to where this Task starts.
 const arrows=rows.filter(r=>r.n.level==='task').flatMap(r=>{const parent=rows.find(p=>p.n.children?.includes(r.n));const dep=parent&&taskDependencies(r.n,parent.n.children);const from=dep?.nearest&&byId.get(dep.nearest.id);const a=span(r.n.time),b=from&&span(from.n.time);if(!from||!a||!b)return [];
  const start=datePosition(weeks,a[0],'start')+.6,end=datePosition(weeks,b[1],'mid');return [{x1:start>end?end:start,x2:start,y1:from.y+from.h/2+4,ymid:from.y+from.h/2,y2:r.y+r.h/2-5,elbow:start>end}];});
 const external=new Map(rows.filter(r=>r.n.level==='task').map(r=>{const parent=rows.find(p=>p.n.children?.includes(r.n));return [r.n.id,parent?taskDependencies(r.n,parent.n.children).external:0];}));
 if(!rows.length)return <p className="empty">当前筛选没有结果</p>;
 return <div className="gantt-canvas" ref={rootRef} style={{'--weeks':weeks.length,...(nameCol?{'--name-col':`${nameCol}px`}:{})}}>
  <NameColumnResizer rootRef={rootRef} width={nameCol} onChange={saveNameCol}/>
  <div className="gantt-head"><div className="gantt-name-head">名称</div><div className="gantt-weeks">{weeks.map(w=><span key={w.label}><b>{w.label}</b> {w.range}</span>)}{today&&<em className="gantt-today-label" style={{left:`${today.pct}%`}}>今天 {today.label}</em>}</div></div>
  <div className="gantt-body" style={{height:y}}>
   {rows.map(({n,depth,can,open,y:top,h})=>{const d=display(n),tone=levelTone(n),confirmed=d.status==='已确认',ext=external.get(n.id);
    return <div key={n.id} className={`gantt-line level-${n.level} tone-${tone}${updated.includes(n.id)?' nexus-updated':''}`} style={{top,height:h}} data-gantt-node={n.id} data-node={n.id}>
     <div className="gantt-name" style={{paddingLeft:8+depth*12}}>
      {can?<button className="gantt-fold" aria-label={`${open?'收起':'展开'} ${d.title}`} aria-expanded={open} onClick={()=>onToggle(n)}>{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>:<span className="gantt-fold-space"/>}
      <button className="gantt-title" title={`${d.planLabel||d.referenceLabel||''} ${d.title} · ${d.owner||''}`} onClick={()=>onOpen(n)}>
       {n.level==='po'?<span className="level-tag">{d.referenceLabel||d.planLabel}</span>:<span className="gantt-ref">{shortLabel(d.referenceLabel)}</span>}{(n.level==='mission'||n.level==='task')&&<TierTag tier={d.tier}/>}
       <span className="gantt-text">{d.title}</span>{confirmed&&<Check size={13} className="gantt-confirmed" aria-label="已确认"/>}
      </button>
      {ext>0&&<span className="gantt-ext" title={`还依赖 ${ext} 项其他 Mission 或领域的交付`}>外 {ext}</span>}<small className="gantt-owner">{d.owner}</small>
     </div>
     <div className={`gantt-track plan-${n.level==='po'?'po':n.level}`}><PlanTrack weeks={weeks} span={n.level==='po'?[weeks[0].from,weeks.at(-1).to]:span(d.time)} gates={rowGates(d,year)}/></div>
    </div>;})}
   <div className="gantt-overlay">
    {today&&<span className="gantt-today" style={{left:`${today.pct}%`}}/>}
    <svg className="gantt-deps" width="100%" height={y} aria-hidden="true"><defs><marker id="gantt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M2 1L8 5L2 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></marker></defs>
     {arrows.map((a,i)=><g key={i}>{a.elbow&&<line x1={`${a.x1}%`} y1={a.ymid} x2={`${a.x2}%`} y2={a.ymid}/>}<line x1={`${a.x2}%`} y1={a.elbow?a.ymid:a.y1} x2={`${a.x2}%`} y2={a.y2} markerEnd="url(#gantt-arrow)"/></g>)}
    </svg>
   </div>
  </div>
  <p className="plan-legend gantt-legend">浅色条是计划时间，圆点是关键结果节点，按时间连成实现路径；箭头是同一 Mission 内的前置依赖；红色虚线是今天。点名称打开卡片，点左侧箭头展开。</p>
 </div>;
}
