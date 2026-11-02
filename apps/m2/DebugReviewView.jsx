import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@heroui/react';
import {X} from 'lucide-react';
import {m2Fetch as fetch} from './deployment-client.mjs';
import {memberProfiles} from './member-profiles.mjs';
import {ReviewCard} from './ReviewCanvas.jsx';

const fieldNames={verdict:'结果判定',verdictReason:'判定说明',facts:'事实证据',nextInputs:'下期输入',evidence:'证据',gap:'没做到的原因',item:'条目',owner:'负责人',status:'状态',text:'内容',type:'类型'};
const readable=value=>Array.isArray(value)?value.map(readable).join('；'):value&&typeof value==='object'?Object.entries(value).filter(([k])=>!['ref','id','sourceIds'].includes(k)).map(([k,v])=>(fieldNames[k]||k)+'：'+readable(v)).join('；'):String(value??'');
function DebugDialog({children,onClose}){const ref=useRef(null);useEffect(()=>{const dialog=ref.current;dialog.showModal();return()=>dialog.close();},[]);return <dialog ref={ref} className="debug-review-view" aria-label="只读调试" onCancel={e=>{e.preventDefault();onClose();}}>{children}</dialog>;}
export default function DebugReviewView(){
 const [target,setTarget]=useState('member-04'),[view,setView]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[group,setGroup]=useState('');
 async function open(){setBusy(true);setError('');setView(null);try{const r=await fetch('/api/debug-reviews?target='+encodeURIComponent(target));const value=await r.json();if(!r.ok)throw Error(value.error||'未能打开调试视图');setGroup(value.groups[0]?.scope||'');setView(value);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="debug-review-entry"><h3>切换用户 · 只读调试</h3><div className="debug-review-controls"><label htmlFor="debug-review-target">查看用户</label><select id="debug-review-target" value={target} disabled={busy} onChange={e=>setTarget(e.target.value)}>{Object.entries(memberProfiles).map(([id,p])=><option key={id} value={id}>{p.name}</option>)}</select><Button className="primary" isDisabled={busy} onPress={open}>{busy?'正在读取…':'查看'}</Button></div><p>只读复盘卡片和公开群。访问会记录，个人对话不开放。</p>{error&&<p role="alert">{error}</p>}
 {view&&<DebugDialog onClose={()=>setView(null)}><div className="admin-head"><h2>{memberProfiles[view.targetId]?.name}的视图 · 只读</h2><span>实际登录：{memberProfiles[view.actorId]?.name}</span><Button className="icon" aria-label="关闭只读调试" onPress={()=>setView(null)}><X size={18}/></Button></div><div className="debug-review-columns"><div className="debug-review-cards">{view.cards.length?view.cards.map(node=><ReviewCard key={node.id} node={node} profile={{name:''}} unitLabel={n=>n.unit||'公司'}/>):<p>该用户没有可见的复盘卡片。</p>}</div><aside className="debug-review-groups"><h3>公开群</h3>{view.groups.length?<><select aria-label="查看公开群" value={group} onChange={e=>setGroup(e.target.value)}>{view.groups.map(g=><option key={g.scope} value={g.scope}>{view.cards.find(n=>n.unit===g.scope&&n.level==='po')?.title||g.scope}</option>)}</select>{(view.groups.find(g=>g.scope===group)?.messages||[]).map(m=><article className="debug-review-message" key={m.id}><strong>{m.author}</strong><p>{m.text}</p>{m.kind==='revision-proposal'&&<><p>修订卡 · {m.status}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{readable(m.patch)}</pre></>}</article>)}</>:<p>暂无公开群消息。</p>}</aside></div></DebugDialog>}
 </section>;
}
