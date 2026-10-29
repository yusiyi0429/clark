import React,{useState} from 'react';
import {createPortal} from 'react-dom';
import {FileInput,X} from 'lucide-react';
import {m2Fetch} from './deployment-client.mjs';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {readableValue} from './readable-markdown.mjs';
import {documentFieldLabel} from './document-template.mjs';
export default function MarkdownTransfer({stage,rootId,person,memberId,onApplied}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState(null);
 const selection={stage,rootId,person};
 const show=(key,value)=><ReactMarkdown remarkPlugins={[remarkGfm]}>{readableValue(key,value)}</ReactMarkdown>;
 const read=async r=>{const v=await r.json();if(!r.ok)throw Error(v.error||'操作失败');return v;};
 async function download(blank){setError('');try{const q=new URLSearchParams(Object.entries({...selection,blank}).filter(([,v])=>v!=null));const value=await read(await m2Fetch('/api/markdown/export?'+q));const a=document.createElement('a'),url=URL.createObjectURL(new Blob([value.markdown],{type:'text/markdown;charset=utf-8'}));a.href=url;a.download=(stage==='review'?'复盘':'拆解')+(blank?'空白模板':'')+'.md';a.click();URL.revokeObjectURL(url);}catch(e){setError(e.message);}}
 async function upload(file){if(!file)return;setBusy(true);setError('');setPreview(null);try{if(file.size>512000)throw Error('文件过大，最多500 KB');const value=await read(await m2Fetch('/api/markdown/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...selection,memberId,text:await file.text()})}));setPreview(value);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function apply(){setBusy(true);setError('');try{const value=await read(await m2Fetch('/api/markdown/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId,token:preview.token})}));onApplied(value);setOpen(false);setPreview(null);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <><button type="button" className="icon" aria-label="Markdown 导入导出" onClick={()=>{setOpen(true);setError('');setPreview(null);}}><FileInput size={17}/></button>{open&&createPortal(<div className="md-transfer-backdrop"><section role="dialog" aria-modal="true" aria-label="Markdown 导入导出" className="md-transfer"><header><strong>{preview?'导入预览':'Markdown'}</strong><button type="button" aria-label="关闭" disabled={busy} onClick={()=>setOpen(false)}><X size={18}/></button></header>{preview?<><div className="md-transfer-diff">{preview.changes.map(c=><section key={c.cardId}><h3>{c.title}{c.outcome==='proposal'&&<small> · 生成修订卡</small>}</h3>{Object.entries(c.patch).map(([k,value])=><div key={k}><b>{documentFieldLabel(c.level,k)}</b><div className="md-before"><small>原来</small>{show(k,c.before[k])}</div><div><small>改为</small>{show(k,value)}</div></div>)}</section>)}</div><footer><button type="button" disabled={busy} onClick={apply}>{busy?'保存中…':'确认导入'}</button><button type="button" disabled={busy} onClick={()=>setPreview(null)}>取消</button></footer></>:<div className="md-transfer-options"><button type="button" disabled={busy} onClick={()=>download(false)}>导出当前内容</button><button type="button" disabled={busy} onClick={()=>download(true)}>导出空白模板</button><label>导入 Markdown<input type="file" accept=".md,.markdown,text/markdown,text/plain" disabled={busy} onChange={e=>upload(e.target.files?.[0])}/></label>{busy&&<p role="status">正在整理…</p>}</div>}{error&&<p role="alert">{error}</p>}</section></div>,document.body)}</>;
}
