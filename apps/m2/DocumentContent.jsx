import React,{createContext,useContext,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@heroui/react';
import {MessageCircle} from 'lucide-react';
import {cardFields,editableTemplateFields,listFields} from './document-template.mjs';
import {milestoneParts,formatPlanDate,trimTrailingPunct} from './reader-view.mjs';
import {v3Layout,gateEntries,planColumns} from './v3-display.mjs';
const AnnotationContext=createContext(null);
const EditingContext=createContext(null);
// Who is reading and how to remove their own comment; comments have no edit, only delete.
const CommentActions=createContext(null);
function FieldAnnotation({field}){const a=useContext(AnnotationContext);return a?.anchor===field?a.content:null;}
// field may name one item of a list ("nextInputs#1" = 第 2 条, 陈溪南 2026-10-23); the field's own bubble holds the rest.
export const anchorParts=f=>{const [block,i]=String(f||'').split('#');return {block,item:i===undefined?null:Number(i)};};
// When I last looked at the open card (set by the page each render): comments by others after that are unread (陈溪南 2026-10-27).
let commentSeen={id:null,at:0};
export function setCommentSeen(value){commentSeen=value;}
export function CommentBubble({node,field,label,comments,onDetail}){
 const a=useContext(AnnotationContext),active=a?.anchor===field,actions=useContext(CommentActions);
 const {block,item}=anchorParts(field);
 const entries=comments.filter(c=>(c.block===block&&(item===null?!Number.isInteger(c.item):c.item===item))||field==='title'&&(!c.block||c.block==='card'));
 const [hover,setHover]=useState(false),[position,setPosition]=useState(null);
 const trigger=useRef(null),timer=useRef(null);
 function show(){clearTimeout(timer.current);const r=trigger.current?.getBoundingClientRect();if(r)setPosition({right:Math.max(12,window.innerWidth-r.right),top:Math.max(12,Math.min(r.bottom+8,window.innerHeight-300))});setHover(true);}
 function hide(){timer.current=setTimeout(()=>setHover(false),150);}
 return <span className="field-comment-bubble" onMouseEnter={show} onMouseLeave={hide}>
  <span ref={trigger}><Button className={`icon field-comment-trigger ${entries.length?'has-comments':''}${entries.some(c=>c.author!==actions?.me&&commentSeen.id===node.id&&Date.parse(c.createdAt||'')>commentSeen.at)?' is-unread':''}`} aria-label={`批注 ${node.id} ${label}`} aria-expanded={Boolean(position&&(active||hover&&entries.length))} onFocus={show} onBlur={hide} onPress={()=>{show();onDetail(node,field);}}><MessageCircle size={15}/>{entries.length>0&&<span className="comment-count">{entries.length}</span>}</Button></span>
  {position&&(active||hover&&entries.length>0)&&createPortal(<section className="field-comment-popover" style={position} aria-label={`${label}的批注`} onMouseEnter={()=>{clearTimeout(timer.current);setHover(true);}} onMouseLeave={hide} onFocus={()=>clearTimeout(timer.current)}>
   {active?<FieldAnnotation field={field}/>:<><strong className="comment-preview-heading">{label} · {entries.length} 条批注</strong>{entries.map((c,i)=><div className="comment-preview" key={c.id||i}><small>{c.author} · v{c.version}{actions?.me===c.author&&actions.onDelete&&<button className="comment-delete" onClick={()=>{if(window.confirm('删除这条批注？'))actions.onDelete(c.id);}}>删除</button>}</small><p>{c.text}</p></div>)}<button className="comment-add-button" onClick={()=>onDetail(node,field)}>添加批注</button></>}
  </section>,document.body)}
 </span>;
}
function InlineText({text}){
 const s=String(text);
 return s.split(/(\*\*[^*]+\*\*)/g).map((part,i)=>part.startsWith('**')&&part.endsWith('**')?<strong key={i}>{part.slice(2,-2)}</strong>:part);
}
export function FormattedValue({value}){
 return Array.isArray(value)?<ol>{value.map((text,i)=><li key={i}><InlineText text={text}/></li>)}</ol>:<div className="formatted-value">{String(value).split('\n').map((line,i)=><p key={i} className={/^\s*G\d+\s*[:：|｜]/.test(line)?'path-stage':undefined}><InlineText text={line}/></p>)}</div>;
}
function ChildList({node,label,childNodes,onOpen,onDetail,comments}){
 return <section className="plan-doc-field" data-block-id={`${node.id}:childList`}><div className="plan-doc-field-heading"><h3>{label}</h3>{onDetail&&<CommentBubble node={node} field="childList" label={label} comments={comments} onDetail={onDetail}/>}</div><ol className="card-child-list">{childNodes.length?childNodes.map((n,i)=><li key={n.id}>{onOpen?<button onClick={()=>onOpen(n)}><strong>{n.referenceLabel||String(i+1).padStart(2,'0')}：{n.title}</strong><span>｜负责人：{n.owner||'待补充'}</span></button>:<strong>{n.referenceLabel||String(i+1).padStart(2,'0')}：{n.title}｜负责人：{n.owner||'待补充'}</strong>}</li>):<li className="template-missing">当前数据未提供 · 待补充</li>}</ol></section>;
}
function Field({node,field,label,value,onDetail,comments=[]}){
 const edit=useContext(EditingContext),editing=edit?.editing&&editableTemplateFields(node.level,node).some(([key])=>key===field);
 const effective=value;
 const empty=effective==null||typeof effective==='string'&&!effective.trim()||Array.isArray(effective)&&!effective.some(x=>String(x).trim());
 const shown=field==='time'?formatPlanDate(effective):effective,gates=field==='logic'&&node.plan?gateEntries(shown):null;
 return <section className="plan-doc-field" data-block-id={`${node.id}:${field}`}>
  <div className="plan-doc-field-heading"><h3>{label}</h3>{onDetail&&<CommentBubble node={node} field={field} label={label} comments={comments} onDetail={onDetail}/>}</div>
  {editing?<textarea className="inline-field-input" aria-label={`修订${label}`} rows={Math.max(2,Math.min(8,String(edit.values[field]||'').split('\n').length))} value={edit.values[field]||''} placeholder={listFields.has(field)?'每行一项':undefined} onKeyDown={edit.onKeyDown} onChange={e=>edit.onChange(field,e.target.value)}/>:empty?<p className="template-missing">本轮字段为空，尚未补齐</p>:field==='milestones'?<MilestoneTimeline value={shown} original={value}/>:gates?<GateLine entries={gates}/>:<FormattedValue value={shown}/>}
 </section>;
}
export function FieldTable({node,rows,comments=[],onDetail,childNodes=[],onOpen}){
 return <table><tbody>{rows.map(([field,label])=><tr key={field}><th scope="row">{label}</th><td>{field==='childList'?<ChildList node={node} label={label} childNodes={childNodes} onOpen={onOpen} onDetail={onDetail} comments={comments}/>:<><Field node={node} field={field} label={label} value={field==='unitName'?(node.unitName||node.name||node.unit):node[field]} comments={comments} onDetail={onDetail}/>{node.level==='po'&&field==='logic'&&node.handoffs&&<div className="legacy-handoffs"><Field node={node} field="handoffs" label="交付衔接" value={node.handoffs} comments={comments} onDetail={onDetail}/></div>}</>}</td></tr>)}</tbody></table>;
}
// 3.x unit plan as 里程碑: the date and the milestone's short name on one line (about ten characters); full sentence in the tooltip.
function GateLine({entries}){
 return <ol className="gate-line">{entries.map((g,i)=><li key={i} title={g.text}><time>{g.date}</time><span>{g.name}</span></li>)}</ol>;
}
// 3.x PO fold: 取舍 / 依赖 / 风险 side by side, each with its own comments.
function PlanColumns({node,columns,comments,onDetail}){
 return <div className="plan-columns">{columns.map(([field,label,rows])=><section key={field} className="plan-column" data-block-id={`${node.id}:${field}`}><div className="plan-doc-field-heading"><h3>{label}<small>{rows.length}</small></h3>{onDetail&&<CommentBubble node={node} field={field} label={label} comments={comments} onDetail={onDetail}/>}</div><FormattedValue value={rows}/></section>)}</div>;
}
function MilestoneTimeline({value,original=value}){
 const entries=Array.isArray(value)?value:String(value||'').split('\n').filter(Boolean);
 return <ul className="milestone-timeline">{entries.map((entry,i)=>{const {date,label}=milestoneParts(entry);return <li key={i} title={Array.isArray(original)?original[i]:String(original)}>{date&&<time>{date}</time>}<span>{label}</span></li>;})}</ul>;
}
// The comment and annotation contexts, for pages that lay out their own fields (the review card).
export function CommentScope({me,onDeleteComment,annotation,children}){return <CommentActions.Provider value={{me,onDelete:onDeleteComment}}><AnnotationContext.Provider value={annotation}>{children}</AnnotationContext.Provider></CommentActions.Provider>;}
export default function DocumentContent(props){return <CommentActions.Provider value={{me:props.me,onDelete:props.onDeleteComment}}><EditingContext.Provider value={props.editing}><AnnotationContext.Provider value={props.annotation}><Content {...props}/></AnnotationContext.Provider></EditingContext.Provider></CommentActions.Provider>;}
const filled=v=>v!=null&&(Array.isArray(v)?v.some(x=>String(x).trim()):String(v).trim()!=='');
// Upstream elements this RU listed as not taken on this month, read from the round's own list.
function Deferred({list}){
 return <table className="card-deferred"><tbody><tr><th scope="row">本月暂缓</th><td>{list.length?<ol>{list.map((x,i)=><li key={x.id||i}><strong>{x.note?trimTrailingPunct(x.element):x.element}</strong>{x.note&&<span>：{x.note}</span>}</li>)}</ol>:<p className="template-missing">本月没有暂缓的上级要求</p>}</td></tr></tbody></table>;
}
function Content({node:source,comments=[],onDetail,deferred}){
 const edit=useContext(EditingContext),anchor=useContext(AnnotationContext)?.anchor;
 // 3.x cards get their own field order; editing always uses the template fields.
 const v3=edit?.editing?null:v3Layout(source),node=v3?.node||source,base=cardFields[node.level]||cardFields.activity;
 const spec={key:v3?.key||base.key,more:(v3?.more||base.more).map(([f,l])=>[f,v3?.relabel?.[f]||l])};
 const columns=v3?.columns?planColumns(node).slice(0,2).filter(([,,rows])=>rows.length):[],deferredRow=node.level==='po'&&deferred?[['deferred','本月暂缓']]:[];
 // Folded fields stay one click away; while editing or annotating one of them the fold opens.
 const more=spec.more.filter(([field])=>edit?.editing?editableTemplateFields(node.level,node).some(([key])=>key===field):filled(node[field]));
 const open=Boolean(edit?.editing||[...more,...columns].some(([field])=>field===anchor||comments.some(c=>c.block===field)));
 const foldLabels=[...columns,...deferredRow,...more].map(([,label])=>label.replace(/（.*）/,''));
 return <div className="template-content card-simple mission-card" data-template-level={node.level}>
  <FieldTable node={node} rows={spec.key} comments={comments} onDetail={onDetail}/>
  {foldLabels.length>0&&<details className="plan-doc-more card-more" open={open||undefined}><summary>更多信息 · {foldLabels.join('、')}</summary>{columns.length>0&&<PlanColumns node={node} columns={columns} comments={comments} onDetail={onDetail}/>}{deferredRow.length>0&&<Deferred list={deferred}/>}{more.length>0&&<FieldTable node={node} rows={more} comments={comments} onDetail={onDetail}/>}</details>}
 </div>;
}
