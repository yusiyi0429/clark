import {capturePageFocus} from './confirmation-focus.mjs';
import {confirmInPage} from './page-confirmation.mjs';
import React,{useState,useEffect} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@heroui/react';
import {Sparkles,Pencil,X} from 'lucide-react';
import {reviewFields,reviewChanges} from './review-workflow.mjs';
import {editableTemplateFields,listFields} from './document-template.mjs';
import {enterSubmit} from './enter-submit.mjs';
const print=value=>Array.isArray(value)?value.join('\n'):value||'（未填写）';
const editValue=value=>Array.isArray(value)?value.join('\n'):value||'';
export default function ReviewEditor({node,editable,history,onSave,onAssist,onDirtyChange,onEditingChange,actionsTarget}){
 const [editing,setEditing]=useState(false),[values,setValues]=useState(()=>Object.fromEntries(reviewFields.map(([key])=>[key,editValue(node[key])])));
 const [baseVersion,setBaseVersion]=useState(node.version);
 const [baseline,setBaseline]=useState(node);
 const patch=Object.fromEntries(editableTemplateFields(node.level,node).map(([key])=>[key,listFields.has(key)||Array.isArray(baseline[key])?(values[key]||'').split('\n').map(x=>x.trim()).filter(Boolean):values[key]||'']));
 const changes=reviewChanges(baseline,{...baseline,...patch});
 const dirty=editing&&changes.length>0;
 const [saving,setSaving]=useState(false);
 const canSave=!!values.title.trim()&&changes.length>0&&baseVersion===node.version&&!saving;
 async function save(event){if(!canSave)return;const confirmationFocus=capturePageFocus(event);setSaving(true);try{const edited=Object.fromEntries(changes.map(c=>[c.field,patch[c.field]]));if(await onSave(edited,baseVersion,{confirmationFocus})){setEditing(false);setBaseVersion(baseVersion+1);setBaseline({...node,...edited,version:baseVersion+1});}}finally{setSaving(false);}}
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false);},[dirty,onDirtyChange]);
 useEffect(()=>{onEditingChange?.({id:node.id,editing:editing&&editable,values,onChange:(key,value)=>setValues(v=>({...v,[key]:value})),onKeyDown:e=>enterSubmit(e,()=>save(e),canSave)});},[node.id,editing,editable,values,canSave,baseVersion,onEditingChange]);
 async function toggleEditing(){if(editing){if(dirty&&!await confirmInPage('丢弃尚未保存的修订？'))return;setEditing(false);return;}setValues(Object.fromEntries(reviewFields.map(([key])=>[key,editValue(node[key])])));setBaseline(node);setBaseVersion(node.version);setEditing(true);}
 // Icon buttons (陈溪南 2026-10-19); the label stays as tooltip and accessible name.
 const actions=<><Button className="icon toolbar-icon" aria-label="请 Agent 审阅" title="请 Agent 审阅" onPress={onAssist}><Sparkles size={16}/></Button>{editable&&<Button className={`icon toolbar-icon${editing?' is-active':''}`} aria-label={editing?'收起编辑':'编辑成果与计划'} title={editing?'收起编辑':'编辑成果与计划'} onPress={toggleEditing}>{editing?<X size={16}/>:<Pencil size={16}/>}</Button>}</>;
 return <section className="review-editor">{actionsTarget&&createPortal(actions,actionsTarget)}
 {editing&&editable&&<><small className="review-save-note">正在原文中编辑 · {changes.length} 处改动；保存不代表确认。</small>
 {baseVersion!==node.version&&<p role="alert">其他人已更新内容，你的输入仍保留。请核对最新内容后再保存。</p>}<Button className="primary" isDisabled={!canSave} onPress={save}>保存共享候选版本</Button>{baseVersion!==node.version&&<><details open><summary>最新内容</summary>{changes.map(c=><p key={c.field}>{c.label}：{print(node[c.field])}</p>)}</details><Button className="plain" onPress={()=>setBaseVersion(node.version)}>已核对最新版本，保留我的修订</Button></>}<p className="review-save-note">保存修订不等于确认；旧版本与修改记录保留。</p></>}
 {history?.length>0&&<details className="revision-history"><summary>修订记录 · {history.length}</summary>{history.slice().reverse().map(r=><section key={r.to}><strong>v{r.from} → v{r.to} · {r.author}</strong>{r.changes.map(c=><div className="revision-field-diff" key={c.field}><strong>{c.label}</strong><div><small>修改前</small><p>{print(c.before)}</p></div><div><small>修改后</small><p>{print(c.after)}</p></div></div>)}</section>)}</details>}
 </section>;
}
