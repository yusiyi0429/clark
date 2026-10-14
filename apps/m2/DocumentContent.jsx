import React,{createContext,useContext,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@heroui/react';
import {MessageCircle} from 'lucide-react';
import {templateFields,editableTemplateFields,listFields} from './document-template.mjs';
import {milestoneParts,formatPlanDate} from './reader-view.mjs';
const AnnotationContext=createContext(null);
const EditingContext=createContext(null);
function FieldAnnotation({field}){const a=useContext(AnnotationContext);return a?.anchor===field?a.content:null;}
function CommentBubble({node,field,label,comments,onDetail}){
 const a=useContext(AnnotationContext),active=a?.anchor===field;
 const entries=comments.filter(c=>c.block===field||field==='title'&&(!c.block||c.block==='card'));
 const [hover,setHover]=useState(false),[position,setPosition]=useState(null);
 const trigger=useRef(null),timer=useRef(null);
 function show(){clearTimeout(timer.current);const r=trigger.current?.getBoundingClientRect();if(r)setPosition({right:Math.max(12,window.innerWidth-r.right),top:Math.max(12,Math.min(r.bottom+8,window.innerHeight-300))});setHover(true);}
 function hide(){timer.current=setTimeout(()=>setHover(false),150);}
 return <span className="field-comment-bubble" onMouseEnter={show} onMouseLeave={hide}>
  <span ref={trigger}><Button className={`icon field-comment-trigger ${entries.length?'has-comments':''}`} aria-label={`批注 ${node.id} ${label}`} aria-expanded={Boolean(position&&(active||hover&&entries.length))} onFocus={show} onBlur={hide} onPress={()=>{show();onDetail(node,field);}}><MessageCircle size={15}/>{entries.length>0&&<span className="unread">{entries.length}</span>}</Button></span>
  {position&&(active||hover&&entries.length>0)&&createPortal(<section className="field-comment-popover" style={position} aria-label={`${label}的批注`} onMouseEnter={()=>{clearTimeout(timer.current);setHover(true);}} onMouseLeave={hide} onFocus={()=>clearTimeout(timer.current)}>
   {active?<FieldAnnotation field={field}/>:<><strong className="comment-preview-heading">{label} · {entries.length} 条批注</strong>{entries.map((c,i)=><div className="comment-preview" key={c.id||i}><small>{c.author} · v{c.version}</small><p>{c.text}</p></div>)}<button className="comment-add-button" onClick={()=>onDetail(node,field)}>添加批注</button></>}
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
 const shown=field==='time'?formatPlanDate(effective):effective;
 return <section className="plan-doc-field" data-block-id={`${node.id}:${field}`}>
  <div className="plan-doc-field-heading"><h3>{label}</h3>{onDetail&&<CommentBubble node={node} field={field} label={label} comments={comments} onDetail={onDetail}/>}</div>
  {editing?<textarea className="inline-field-input" aria-label={`修订${label}`} rows={Math.max(2,Math.min(8,String(edit.values[field]||'').split('\n').length))} value={edit.values[field]||''} placeholder={listFields.has(field)?'每行一项':undefined} onKeyDown={edit.onKeyDown} onChange={e=>edit.onChange(field,e.target.value)}/>:empty?<p className="template-missing">本轮字段为空，尚未补齐</p>:field==='milestones'?<MilestoneTimeline value={shown} original={value}/>:<FormattedValue value={shown}/>}
 </section>;
}
export function FieldTable({node,rows,comments=[],onDetail,childNodes=[],onOpen}){
 return <table><tbody>{rows.map(([field,label])=><tr key={field}><th scope="row">{label}</th><td>{field==='childList'?<ChildList node={node} label={label} childNodes={childNodes} onOpen={onOpen} onDetail={onDetail} comments={comments}/>:<><Field node={node} field={field} label={label} value={field==='unitName'?(node.unitName||node.name||node.unit):node[field]} comments={comments} onDetail={onDetail}/>{node.level==='po'&&field==='logic'&&node.handoffs&&<div className="legacy-handoffs"><Field node={node} field="handoffs" label="交付衔接" value={node.handoffs} comments={comments} onDetail={onDetail}/></div>}</>}</td></tr>)}</tbody></table>;
}
function MilestoneTimeline({value,original=value}){
 const entries=Array.isArray(value)?value:String(value||'').split('\n').filter(Boolean);
 return <ul className="milestone-timeline">{entries.map((entry,i)=>{const {date,label}=milestoneParts(entry);return <li key={i} title={Array.isArray(original)?original[i]:String(original)}>{date&&<time>{date}</time>}<span>{label}</span></li>;})}</ul>;
}
export default function DocumentContent(props){return <EditingContext.Provider value={props.editing}><AnnotationContext.Provider value={props.annotation}><Content {...props}/></AnnotationContext.Provider></EditingContext.Provider>;}
function Content({node,comments=[],onDetail,full=false,childNodes=node.children||[],onOpen,allowChildren=true}){
 const t=templateFields[node.level]||templateFields.activity;
 const fields=list=>list.map(([field,label])=><Field key={field} node={node} field={field} label={label} value={node[field]} comments={comments} onDetail={onDetail}/>);
 if(node.level==='mission'||node.level==='po'){
  const rows=[['title','名称'],['result','成果描述'],['owner',node.level==='po'?'RU DRI':'Mission DRI'],['unitName','所属责任单元'],['time','时间边界'],['why','存在必要性'],['checks','验收标准'],['boundary','责任边界'],...(allowChildren?[['childList',node.isCompany?'RU PO 清单':node.level==='po'?'Mission 清单':'Task 清单']]:[]),...t.plan];
  const hiddenFields=node.level==='po'?['title','owner','unitName','time','childList']:['title','owner','unitName','childList'];
  const visibleRows=rows.filter(([field])=>!hiddenFields.includes(field));
  return <div className="template-content mission-card" data-template-level={node.level}><h3 className="mission-card-title">{node.level==='po'?'PO Card':'Mission Card'}</h3><FieldTable node={node} rows={visibleRows} comments={comments} onDetail={onDetail} childNodes={childNodes} onOpen={onOpen}/></div>;
 }
 return <div className="template-content" data-template-level={node.level}>
  {fields(t.core)}
  {node.level==='po'&&<div className="template-identification"><span>时间边界：{node.time||'待补充'}</span><span>Parent LTO：{node.parentLtoReference||'版本引用待补充'}</span></div>}
  {node.level==='mission'&&<div className="template-identification">所属责任单元：{node.unitName||node.unit||'待补充'}</div>}
  {node.level==='task'&&full&&<div className="template-identification">所属 Mission：{node.parentTitle||'待补充'}</div>}
  {t.detail.length>0&&<details className="plan-doc-more" open={full||undefined}><summary>{node.level==='po'?'目标详情':node.level==='mission'?'Mission Card · 必要性与边界':'Task Card · 必要性与边界'}</summary>{fields(t.detail)}</details>}
  {t.plan&&<details className="plan-doc-more" open={full||undefined}><summary>Mission Plan</summary>{fields(t.plan)}<p className="template-identification">Task 全景与甘特图读取下方同一组 Task，不另建一份计划。</p></details>}
  {t.extra&&node.boundary&&<details className="plan-doc-more"><summary>责任边界</summary>{fields(t.extra)}</details>}
 </div>;
}
