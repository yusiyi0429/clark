import React,{useState} from 'react';
import {Button} from '@heroui/react';
import {MessageCircle,Pencil,X} from 'lucide-react';
import Handshake from './Handshake.jsx';
import TodoPanel from './TodoPanel.jsx';
import {enterSubmit} from './enter-submit.mjs';
import {CommentBubble,CommentScope} from './DocumentContent.jsx';
import {verdictTone,targetParts,richParts,reviewLabel,reviewSlots,maySign,mineFirst,reviewTodos,answerOf,ownerNames,confirmState,unitShort} from './review-display.mjs';
// 复盘 pages (陈溪南 2026-10-20/21): the plan's layout, five rows per review, same groups, comments and handshake.
const Verdict=({value,small})=><span className={`review-verdict tone-${verdictTone(value)}${small?' is-small':''}`}>{value||'待判定'}</span>;
function Rich({text,evidence}){return richParts(text).map((p,i)=>p.bold?<strong key={i}>{p.bold}</strong>:p.evidence?<sup key={i} className="review-evidence" title={evidence?.[p.evidence]?`${p.evidence} · ${evidence[p.evidence].date||''} · ${evidence[p.evidence].title||''}`:`${p.evidence}：证据来源见本轮输入`}>{p.evidence}</sup>:<React.Fragment key={i}>{p.text}</React.Fragment>);}
// 长期目标审视 is a suggestion to the CEO: 建议维持 / 建议修改 / 建议重开 (陈溪南 2026-10-21).
const ltoChoice=c=>String(c||'').startsWith('建议')?c:`建议${c||'维持'}`;
const typeTone={'欠账':'debt','待决策':'decide','继续验证':'verify','停止':'stop','约束':'limit'};
// One row of the two-column table, with the plan's comment bubble so field comments work the same.
function Row({node,field,label,comments,onDetail,children}){
 return <tr><th scope="row">{label}</th><td><section className="plan-doc-field" data-block-id={`${node.id}:${field}`}><div className="plan-doc-field-heading review-row-heading">{onDetail&&<CommentBubble node={node} field={field} label={label} comments={comments} onDetail={onDetail}/>}</div>{children}</section></td></tr>;
}
// One item of a list field can be commented on by itself; the bubble shows on hover, or always once it has comments.
// 复盘改版 (陈溪南与 CEO 2026-10-26): 判定 + 事实证据 on the card that is confirmed, one line per Task / Mission / unit.
const factTone=s=>verdictTone(s==='未开始'?'未达成':s);
const isFactsCard=n=>Array.isArray(n?.facts);
function Facts({node,comments,onDetail,evidence}){return <ol className="review-list review-facts">{node.facts.map((f,i)=><li key={f.ref||i} className={`review-item review-fact tone-${factTone(f.status)}`}>{onDetail&&<ItemBubble node={node} field="facts" index={i} label="事实证据" comments={comments} onDetail={onDetail}/>}
 <div className="review-fact-head"><strong>{f.item}</strong>{f.owner&&<span className="review-fact-owner">{f.owner}</span>}{f.status&&<span className="review-fact-status">{f.status}</span>}</div>
 {f.evidence&&<p className="review-fact-evidence"><Rich text={f.evidence} evidence={evidence}/></p>}
 {f.gap&&<p className="review-fact-gap"><span>没做到的原因</span><Rich text={f.gap} evidence={evidence}/></p>}</li>)}</ol>;}
// No owner in the ontology (ownerAssigned:false): the card says 未指派; owner stays the unit DRI, who signs it (M2 2026-10-26).
const unassigned=n=>n.level==='mission'&&n.ownerAssigned===false;
const personOf=n=>unassigned(n)?'未指派':n.owner;
// 个人复盘 grouped by owner, 未指派 last.
function byOwner(list){const groups=new Map();for(const n of list){const k=unassigned(n)?'未指派':n.owner||'未指派';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);}return [...groups].sort(([a],[b])=>(a==='未指派')-(b==='未指派'));}
function ItemBubble({node,field,index,label,comments,onDetail}){return <span className="review-item-bubble" data-block-id={`${node.id}:${field}#${index}`}><CommentBubble node={node} field={`${field}#${index}`} label={`${label} · 第 ${index+1} 条`} comments={comments} onDetail={onDetail}/></span>;}
function Ask({node,index,ask,answer,canAnswer,onAnswer}){
 const [text,setText]=useState(null),[busy,setBusy]=useState(false);
 if(answer)return <div className="review-ask is-answered"><span className="review-ask-q">追问：{ask}</span><span className="review-ask-a">{answer.author}：{String(answer.text).replace(/^回答「[^」]*」：/,'')}</span></div>;
 return <div className="review-ask"><span className="review-ask-q">追问：{ask}</span>
  {canAnswer?(text==null?<button className="review-ask-button" onClick={()=>setText('')}>回答</button>:null):<span className="review-ask-wait">待负责人回答</span>}
  {text!=null&&<div className="review-ask-form"><textarea autoFocus rows={2} value={text} placeholder="回答会发到本单元群里，Nexus 会按你的回答核对复盘。" onChange={e=>setText(e.target.value)} title="回车发送，Shift＋回车换行" onKeyDown={e=>{if(e.key==='Escape'){setText(null);return;}enterSubmit(e,async()=>{setBusy(true);try{await onAnswer(node,index,ask,text.trim());setText(null);}finally{setBusy(false);}},!busy&&!!text.trim());}}/><div className="review-ask-actions"><Button className="proposal-confirm" isDisabled={busy||!text.trim()} onPress={async()=>{setBusy(true);try{await onAnswer(node,index,ask,text.trim());setText(null);}finally{setBusy(false);}}}>{busy?'发送中…':'发送'}</Button><Button className="proposal-reject" onPress={()=>setText(null)}>取消</Button></div></div>}
 </div>;
}
// The owner edits a review in place, like a plan card (陈溪南 2026-10-20: 复盘允许直接修订).
const mayEdit=(n,p)=>n.level==='company'?p.ceo===true:n.level==='po'?(p.unitDri||[]).includes(n.unit):ownerNames(n).includes(p.name);
const plain=t=>String(t||'');
// Editing reads like the page (评测 2026-10-22): no ** and no [E#] in the box. A line left as it was keeps its original
// text; a changed line gets its 短标题 bold again and keeps the evidence numbers it had.
const evidenceOf=t=>(String(t||'').match(/\[E\d+\]/g)||[]).join('');
const toEdit=t=>String(t||'').replace(/\*\*/g,'').replace(/\s*(\[E\d+\])+/g,'').trim();
const fromEdit=(line,orig)=>{if(orig!=null&&line===toEdit(orig))return orig;const m=line.match(/^([^：:]{1,24})[：:]\s*(.*)$/),body=m?`**${m[1]}：**${m[2]}`:line,ev=evidenceOf(orig);return ev?`${body} ${ev}`:body;};
function startValues(n){if(isFactsCard(n))return {verdict:n.verdict||'未达成',verdictReason:toEdit(plain(n.verdictReason)),facts:n.facts.map(f=>({status:f.status||'未达成',evidence:toEdit(f.evidence),gap:toEdit(f.gap)}))};return {verdict:n.verdict||'未达成',verdictReason:toEdit(plain(n.verdictReason)),targets:(n.targets||[]).map(toEdit).join('\n'),causes:(n.causes||[]).map(c=>toEdit(c.text)).join('\n'),nextInputs:(n.nextInputs||[]).map(x=>toEdit(x.text)).join('\n'),...(n.ltoReview?{ltoChoice:String(n.ltoReview.choice).startsWith('建议')?n.ltoReview.choice:'建议'+n.ltoReview.choice,ltoReason:plain(n.ltoReview.reason)}:{})};}
function patchFrom(n,v){const lines=t=>String(t).split('\n').map(x=>x.trim()).filter(Boolean),out={};
 if(v.verdict!==n.verdict)out.verdict=v.verdict;if(v.verdictReason.trim()!==toEdit(plain(n.verdictReason)))out.verdictReason=fromEdit(v.verdictReason.trim(),n.verdictReason);
 if(isFactsCard(n)){const facts=n.facts.map((f,i)=>{const e=v.facts[i];return {...f,status:e.status,evidence:e.evidence.trim()===toEdit(f.evidence)?f.evidence:e.evidence.trim(),gap:e.gap.trim()===toEdit(f.gap)?f.gap||'':e.gap.trim()};});if(JSON.stringify(facts)!==JSON.stringify(n.facts))out.facts=facts;return out;}
 const targets=lines(v.targets).map((t,i)=>fromEdit(t,(n.targets||[])[i]));if(JSON.stringify(targets)!==JSON.stringify(n.targets||[]))out.targets=targets;
 const causes=lines(v.causes).map((text,i)=>({text:fromEdit(text,(n.causes||[])[i]?.text),ask:(n.causes||[])[i]?.ask||''}));if(JSON.stringify(causes)!==JSON.stringify(n.causes||[]))out.causes=causes;
 const next=lines(v.nextInputs).map((text,i)=>({id:(n.nextInputs||[])[i]?.id||`${n.ref}-${i+1}`,type:(n.nextInputs||[])[i]?.type||'欠账',text:fromEdit(text,(n.nextInputs||[])[i]?.text)}));if(JSON.stringify(next)!==JSON.stringify(n.nextInputs||[]))out.nextInputs=next;
 if(n.ltoReview&&(v.ltoChoice!==n.ltoReview.choice||v.ltoReason.trim()!==plain(n.ltoReview.reason)))out.ltoReview={choice:v.ltoChoice,reason:v.ltoReason.trim()};
 return out;}
function EditRow({label,children}){return <tr><th scope="row">{label}</th><td>{children}</td></tr>;}
function ReviewEdit({node,onSave,onCancel}){
 const [v,setV]=useState(()=>startValues(node)),[busy,setBusy]=useState(false),set=k=>e=>setV(o=>({...o,[k]:e.target.value}));
 const save=async()=>{const patch=patchFrom(node,v);if(!Object.keys(patch).length)return onCancel();setBusy(true);try{await onSave(patch);}finally{setBusy(false);}};
 const keys=e=>{if(e.key==='Escape')onCancel();else enterSubmit(e,save,!busy);};
 const setFact=(i,k)=>e=>setV(o=>({...o,facts:o.facts.map((f,j)=>j===i?{...f,[k]:e.target.value}:f)}));
 const factArea=(i,k,rows,hint)=><textarea className="inline-field-input" rows={Math.max(rows,String(v.facts[i][k]).split('\n').length)} value={v.facts[i][k]} placeholder={hint} onChange={setFact(i,k)} onKeyDown={keys} title="回车保存，Shift＋回车换行，Esc 取消"/>;
 const area=(k,rows)=><textarea className="inline-field-input" rows={Math.max(rows,String(v[k]).split('\n').length+1)} value={v[k]} onChange={set(k)} onKeyDown={keys} title="回车保存，Shift＋回车换行，Esc 取消"/>;
 return <div className="template-content card-simple review-edit"><table className="review-table"><tbody>
  <EditRow label="判定"><select value={v.verdict} onChange={set('verdict')}>{['达成','部分达成','未达成'].map(x=><option key={x}>{x}</option>)}</select>{area('verdictReason',2)}</EditRow>
  {isFactsCard(node)?<EditRow label="事实证据"><ol className="review-list review-facts-edit">{node.facts.map((f,i)=><li key={f.ref||i}><div className="review-fact-head"><strong>{f.item}</strong>{f.owner&&<span className="review-fact-owner">{f.owner}</span>}<select value={v.facts[i].status} onChange={setFact(i,'status')}>{['达成','部分达成','未达成','未开始'].map(x=><option key={x}>{x}</option>)}</select></div>{factArea(i,'evidence',2,'现状和证据')}{factArea(i,'gap',1,'没做到的原因（可空）')}</li>)}</ol></EditRow>:<>
  <EditRow label="目标对照">{area('targets',4)}<small className="proposal-same">每行一条，写成“短标题（判定）：正文”</small></EditRow>
  <EditRow label="原因">{area('causes',3)}<small className="proposal-same">每行一条</small></EditRow>
  <EditRow label="下月输入">{area('nextInputs',3)}<small className="proposal-same">每行一条，类型按原来的顺序保留</small></EditRow>
  </>}
  {node.ltoReview&&<EditRow label="长期目标审视"><select value={v.ltoChoice} onChange={set('ltoChoice')}>{['建议维持','建议修改','建议重开'].map(x=><option key={x}>{x}</option>)}</select>{area('ltoReason',2)}</EditRow>}
 </tbody></table><div className="proposal-actions"><Button className="proposal-confirm" isDisabled={busy} onPress={save}>{busy?'保存中…':'保存新版本'}</Button><Button className="proposal-reject" onPress={onCancel}>取消</Button></div></div>;
}
export function ReviewCard({node,profile,comments=[],onDetail,onAnswer,evidence,unitLabel,tone='domain',onRevise}){
 const mineToAnswer=ownerNames(node).includes(profile.name),[editing,setEditing]=useState(false),canEdit=!!onRevise&&mayEdit(node,profile);
 return <article className={`plan-doc-node review-card doc-${node.level==='mission'?'mission':'po'} tone-${tone}`} data-document-node={node.id}>
  <div className="card-head"><span className="level-tag">{node.level==='mission'?`${unitShort(unitLabel(node))} · ${reviewLabel(node)}`:node.level==='company'?'公司复盘':`${unitLabel(node)} · ${reviewLabel(node)}`}</span><span className="card-meta"><span className="person">{personOf(node)}</span><span>v{node.version}</span></span><span className="card-head-end">{canEdit&&<Button className="icon review-edit-toggle" aria-label={editing?'收起编辑':'编辑复盘'} title={editing?'收起编辑':'编辑复盘'} onPress={()=>setEditing(x=>!x)}>{editing?<X size={15}/>:<Pencil size={15}/>}</Button>}{/* Same head as the home card: verdict and status on the right (陈溪南 2026-10-23). */}{node.verdict&&<Verdict value={node.verdict} small/>}<span className="state" data-confirmed={node.status==='已确认'}>{node.status}</span></span></div>
  <h2>{node.title}</h2>
  {editing?<ReviewEdit node={node} onCancel={()=>setEditing(false)} onSave={async patch=>{await onRevise(node,patch);setEditing(false);}}/>:<div className="template-content card-simple"><table className="review-table"><tbody>
   <Row node={node} field="verdict" label="判定" comments={comments} onDetail={onDetail}><p className="review-verdict-line">{node.verdictChange&&<span className="verdict-changed">由「{node.verdictChange.from}」改为「{node.verdictChange.to}」· {node.verdictChange.by} · v{node.verdictChange.version}</span>}<span className="review-verdict-reason"><Rich text={node.verdictReason} evidence={evidence}/></span></p></Row>
   {isFactsCard(node)?<Row node={node} field="facts" label="事实证据" comments={comments} onDetail={onDetail}>{node.facts.length?<Facts node={node} comments={comments} onDetail={onDetail} evidence={evidence}/>:<p className="review-none">这份复盘没有列出事实。</p>}</Row>:<>
   <Row node={node} field="targets" label="目标对照" comments={comments} onDetail={onDetail}><ol className="review-list">{(node.targets||[]).map((t,i)=>{if(/^\*\*Mission 结果（无）/.test(String(t)))return null;const p=targetParts(t),tone=verdictTone(p.verdict);return <li key={i} className={`review-target tone-${tone} review-item`}>{onDetail&&<ItemBubble node={node} field="targets" index={i} label="目标对照" comments={comments} onDetail={onDetail}/>}{p.name&&<strong className="review-target-name">{p.name}：</strong>}{p.verdict&&<span className="review-target-verdict">{p.verdict}，</span>}<Rich text={p.text} evidence={evidence}/></li>;})}</ol></Row>
   <Row node={node} field="causes" label="原因" comments={comments} onDetail={onDetail}><ol className="review-list">{(node.causes||[]).map((c,i)=><li key={i} className="review-item">{onDetail&&<ItemBubble node={node} field="causes" index={i} label="原因" comments={comments} onDetail={onDetail}/>}<Rich text={c.text} evidence={evidence}/>{c.ask&&<Ask node={node} index={i} ask={c.ask} answer={answerOf(comments,i)} canAnswer={mineToAnswer} onAnswer={onAnswer}/>}</li>)}</ol></Row>
   <Row node={node} field="nextInputs" label="下月输入" comments={comments} onDetail={onDetail}><ol className="review-list">{(node.nextInputs||[]).map((n,i)=>{const m=String(n.text).match(/^\*\*(.+?)：?\*\*\s*([\s\S]*)$/);return <li key={n.id||i} className={`review-next-input tone-${typeTone[n.type]||'limit'} review-item`}>{onDetail&&<ItemBubble node={node} field="nextInputs" index={i} label="下月输入" comments={comments} onDetail={onDetail}/>}{m&&<strong>{m[1].replace(/：$/,'')}：</strong>}<span className="review-type-word">{n.type}，</span><Rich text={m?m[2]:n.text} evidence={evidence}/></li>;})}</ol></Row>
   </>}
   {node.ltoReview&&<Row node={node} field="ltoReview" label="长期目标审视" comments={comments} onDetail={onDetail}><p><strong>{ltoChoice(node.ltoReview.choice)}：</strong>{node.ltoReview.reason}</p></Row>}
  </tbody></table></div>}
 </article>;
}
// 分析洞察 (陈溪南与 CEO 2026-10-26): a card of its own under the confirmed one, not confirmed. Everyone in the group writes at
// least one; before 公开 the page shows who handed in how many and my own lines only (the server sends nothing else).
function InsightLine({item,mine,onEdit,onDelete}){
 const [editing,setEditing]=useState(false),[text,setText]=useState(item.text),[sure,setSure]=useState(false),[busy,setBusy]=useState(false);
 const save=async()=>{const t=text.trim();if(!t||busy)return;if(t===item.text)return setEditing(false);setBusy(true);try{await onEdit(item.id,t);setEditing(false);}catch{}finally{setBusy(false);}};
 if(editing)return <li className="insight-line is-editing"><textarea className="inline-field-input" rows={Math.max(3,text.split('\n').length+1)} value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setText(item.text);setEditing(false);}else enterSubmit(e,save,!busy);}} autoFocus aria-label="修改洞察" title="回车保存，Shift＋回车换行，Esc 取消"/><div className="proposal-actions"><Button className="proposal-confirm" isDisabled={busy||!text.trim()} onPress={save}>{busy?'保存中…':'保存'}</Button><Button className="proposal-reject" onPress={()=>{setText(item.text);setEditing(false);}}>取消</Button></div></li>;
 return <li className="insight-line">{item.author&&<strong className="insight-author">{item.author}</strong>}<p className="insight-text"><Rich text={item.text}/></p>
  {mine&&<span className="insight-actions">{sure?<><Button className="plain insight-delete" isDisabled={busy} onPress={async()=>{setBusy(true);try{await onDelete(item.id);}catch{}finally{setBusy(false);setSure(false);}}}>确认删除</Button><Button className="plain" onPress={()=>setSure(false)}>取消</Button></>:<><Button className="plain" onPress={()=>setEditing(true)}>修改</Button><Button className="plain" onPress={()=>setSure(true)}>删除</Button></>}</span>}</li>;
}
export function InsightCard({node,data,profile,onInsight}){
 const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const d=data||{revealed:false,submitters:[],mine:[]},revealed=d.revealed===true;
 const run=async value=>{setError('');try{await onInsight(value);return true;}catch(e){setError(e.message||'没能保存，请重试');return false;}};
 const submit=async()=>{const t=text.trim();if(!t||busy)return;setBusy(true);if(await run({type:'insight',cardId:node.id,text:t}))setText('');setBusy(false);};
 const edit=(insightId,t)=>run({type:'editInsight',cardId:node.id,insightId,text:t}).then(ok=>{if(!ok)throw Error();});
 const remove=insightId=>run({type:'deleteInsight',cardId:node.id,insightId}).then(ok=>{if(!ok)throw Error();});
 const items=revealed?d.items||[]:[],isMine=i=>i.mine===true||i.mine==null&&i.author===profile.name,mine=revealed?items.filter(isMine):d.mine||[],submitters=d.submitters||[],missing=d.missing||[];
 const counted=revealed?Object.entries(items.reduce((a,i)=>({...a,[i.author]:(a[i.author]||0)+1}),{})).map(([name,count])=>({name,count})):submitters;
 return <article className="plan-doc-node insight-card" data-insight-card={node.id}>
  <div className="card-head"><span className="level-tag insight-tag">分析洞察</span><span className="card-meta">{counted.length?<span>{counted.length} 人交了 {counted.reduce((a,s)=>a+s.count,0)} 条</span>:<span>还没有人交</span>}</span><span className="card-head-end"><span className="state" data-confirmed={revealed}>{revealed?'已公开':'未公开'}</span></span></div>
  <p className="insight-guide">站在公司管理层和 CEO 的角度：这些原因合起来有什么共性，反映出公司在目标、理念、机制、流程上的什么问题，应该怎么解决。一个问题配一条建议。每人至少交 1 条，不用确认。</p>
  {!revealed&&counted.length>0&&<p className="insight-submitters">已交：{counted.map(s=>`${s.name} ${s.count} 条`).join('、')}<small>公开前大家只看得到谁交了几条</small></p>}
  {!revealed&&missing.length>0&&<p className="insight-submitters insight-missing">还没交：{missing.join('、')}</p>}
  {revealed&&<section className="insight-nexus"><h3>Nexus 综合</h3>{d.nexus?.text?<p className="insight-text"><Rich text={d.nexus.text}/></p>:d.nexus?.error?<p className="review-none">Nexus 这次没综合成，会再试一次。</p>:<p className="review-none">Nexus 正在读全部洞察，综合好后会出现在这里。</p>}</section>}
  {revealed?items.length>0&&<ol className="insight-list">{items.map(i=><InsightLine key={i.id} item={i} mine={isMine(i)} onEdit={edit} onDelete={remove}/>)}</ol>
   :mine.length>0&&<><h3 className="insight-mine-heading">我写的</h3><ol className="insight-list">{mine.map(i=><InsightLine key={i.id} item={i} mine onEdit={edit} onDelete={remove}/>)}</ol></>}
  {/* Only participants write (the server decides who: participants); others read. */}
  {(!Array.isArray(d.participants)||d.participants.includes(profile.name))&&<div className="insight-compose"><textarea className="inline-field-input" rows={3} value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>enterSubmit(e,submit,!busy)} placeholder={mine.length?'再写一条洞察':'写一条洞察：发现的问题，加上建议'} aria-label="写洞察" title="回车提交，Shift＋回车换行"/>
   <div className="proposal-actions"><Button className="proposal-confirm" isDisabled={busy||!text.trim()} onPress={submit}>{busy?'提交中…':'提交'}</Button>{error&&<span className="admin-line is-failed" role="alert">{error}</span>}</div></div>}
 </article>;
}
export function ReviewSummary({node,onOpen,unitLabel,comments=[],tone='domain',stateOf}){
 const st=stateOf?stateOf(node):{text:node.status,mine:false};
 return <article role="button" tabIndex={0} aria-label={`打开 ${node.title}`} onClick={()=>onOpen(node)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen(node);}}} className={`plan-doc-node doc-summary review-summary doc-${node.level==='mission'?'mission':'po'} tone-${tone}`} data-document-node={node.id}>
  <div className="card-head"><span className="level-tag">{node.level==='mission'?`${unitShort(unitLabel(node))} · ${reviewLabel(node)}`:node.level==='company'?'公司复盘':unitLabel(node)}</span><span className="card-meta"><span className="person">{personOf(node)}</span>{node.level==='po'&&node.children?.length>0&&<span>{node.children.length} Mission</span>}{comments.length>0&&<span className="card-comments"><MessageCircle size={14}/> {comments.length}</span>}</span><span className="card-head-end">{node.verdict&&<Verdict value={node.verdict} small/>}<span className={`state${st.mine?' is-mine':''}`} data-confirmed={node.status==='已确认'}>{st.text}</span></span></div>
  <h2>{node.title}</h2><p className="doc-description"><Rich text={node.verdictReason}/></p>
 </article>;
}
export default function ReviewCanvas({insights={},onInsight,ceoName='CEO',onRevise,tree,active,profile,comments,toneOf=()=>'domain',handoff=null,onShowHandoff,months={from:'',to:''},onOpen,onAction,onDetail,onAnswer,annotation,me,onDeleteComment,evidence,unitLabel,signerNames,review}){
 if(!tree.nodes.length)return <div className="plan-doc-canvas document-catalog"><div className="review-empty"><h3>还没有载入复盘</h3><p>本月复盘生成后会出现在这里。</p></div></div>;
 const stateOf=n=>{const po=tree.nodes.find(x=>x.level==='po'&&x.unit===n.unit),left=n.level==='company'&&n.status!=='已确认'?tree.nodes.filter(x=>x.level!=='company'&&x.status!=='已确认').length:0;if(left)return {text:`还有 ${left} 份复盘未确认`,mine:false};return confirmState({status:n.status,version:n.version,signatures:n.signatures,slots:reviewSlots(n),holder:s=>s==='ceo'?ceoName:s==='unitDri'?po?.owner:n.owner,mine:s=>maySign(n,s,profile)});};
 if(!active){
  // What waits for me comes first, then what I am part of, then the other units I can see (陈溪南 2026-10-23).
  const mine=[...mineFirst(tree.nodes,profile)].sort((a,b)=>(stateOf(b).mine?1:0)-(stateOf(a).mine?1:0));
  // Only the reviews someone is part of (陈溪南 2026-10-23): seeing a unit because of next month's plan is not a reason
  // to list its October review here. The CEO's list already holds every unit.
  const others=[];
  // Reviews the run could not write (or wrote without background) are named here, never left silently missing.
  // Members see only what the data left out (陈溪南 2026-10-23); program-side issues (拒答、降级) are for 管理, not this page.
  const missing=review?.skipped||[],problems=(review?.problems||[]).filter(p=>p.kind==='missing'),refName=ref=>{const [unit,m]=String(ref).split('-m'),po=tree.nodes.find(n=>n.level==='po'&&(n.unit===unit||n.ref===unit));return `${po?unitLabel(po):unit}${m?` M${m.padStart(2,'0')}`:''}`;};
  return <div className="plan-doc-canvas document-catalog review-catalog" aria-label="复盘目录">
   {(missing.length>0||problems.length>0)&&<div className="review-problems" role="status"><p>本体里缺少材料，以下没有复盘：</p>{missing.map((t,i)=><p key={'s'+i}>{t}</p>)}{problems.map(p=><p key={p.ref}><strong>{refName(p.ref)}</strong>{p.reason}</p>)}</div>}
   <section className="catalog-group">{mine.map(n=><ReviewSummary key={n.id} node={n} stateOf={stateOf} tone={toneOf(n)} onOpen={onOpen} unitLabel={unitLabel} comments={comments[n.id]}/>)}</section>
   {others.length>0&&<section className="catalog-group">{others.map(n=><ReviewSummary key={n.id} node={n} stateOf={stateOf} tone={toneOf(n)} onOpen={onOpen} unitLabel={unitLabel} comments={comments[n.id]}/>)}</section>}
  </div>;
 }
 const node=tree.byId.get(active.id)||active,below=node.children||[];
 // The company review closes the month: it waits for every other review, and confirming it starts next month's plan.
 const open=node.level==='company'?tree.nodes.filter(n=>n.level!=='company'&&n.status!=='已确认'):[];
 const handshake=<Handshake node={node} locked={open.length?{text:`还有 ${open.length} 份复盘未确认`,title:open.map(n=>n.level==='mission'?`${unitLabel(n)} ${reviewLabel(n)}`:unitLabel(n)).join('、')}:null} profile={{...profile,missions:ownerNames(node).includes(profile.name)?[...(profile.missions||[]),node.id]:profile.missions||[]}} slots={reviewSlots(node)} summary={isFactsCard(node)?(node.level==='company'?`确认判定和事实证据后，${months.from}复盘全部定稿，Nexus 开始生成 ${months.to}拆解。分析洞察不用确认。`:'确认的是上面的判定和事实证据；下面的分析洞察不用确认。确认不等于结果达成。'):node.level==='company'?`CEO 确认后，${months.from}复盘全部定稿，Nexus 开始生成 ${months.to}拆解。`:'确认复盘，也就确认了下方的下月输入，它们会作为下月拆解的输入。确认不等于结果达成。'} signerNames={signerNames(node)} onAction={value=>onAction({...value,cardId:node.id,baseVersion:node.version})}/>;
 return <CommentScope me={me} onDeleteComment={onDeleteComment} annotation={annotation}>
  <div className="plan-doc-canvas document-page" aria-label="复盘文档"><div className="document-primary review-primary">
   <ReviewCard node={node} tone={toneOf(node)} onRevise={onRevise} profile={profile} comments={comments[node.id]||[]} onDetail={onDetail} onAnswer={onAnswer} evidence={evidence} unitLabel={unitLabel}/>
   {isFactsCard(node)&&<>{handshake}<InsightCard node={node} data={insights[node.id]} profile={profile} onInsight={onInsight}/></>}
   {node.level==='po'&&<section className="document-next review-next"><h3>{node.level==='company'?'各单元 PO 复盘':'Mission 复盘'}{below.length>0&&<small> · {below.length}</small>}</h3>
    {below.length?byOwner(below).map(([owner,list],_,all)=><div key={owner} className="review-owner-group">{all.length>1&&<h4 className="review-owner-heading">{owner==='未指派'?'未指派负责人':owner}<small> · {list.length}</small></h4>}{list.map(n=><ReviewSummary key={n.id} node={n} stateOf={stateOf} tone={toneOf(n)} onOpen={onOpen} unitLabel={unitLabel} comments={comments[n.id]}/>)}</div>):<p className="review-none">{node.level==='po'?'这个单元本月计划里没有拆出 Mission，所以只有这一份 PO 复盘。':'还没有单元复盘。'}</p>}
   </section>}
   {!isFactsCard(node)&&handshake}
  </div></div>
 </CommentScope>;
}
