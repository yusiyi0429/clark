import React,{useState} from 'react';
import {Button} from '@heroui/react';
import {MessageCircle,Pencil,X} from 'lucide-react';
import Handshake from './Handshake.jsx';
import TodoPanel from './TodoPanel.jsx';
import {enterSubmit} from './enter-submit.mjs';
import {CommentBubble,CommentScope} from './DocumentContent.jsx';
import {verdictTone,targetParts,richParts,reviewLabel,reviewSlots,maySign,mineFirst,reviewTodos,reviewHomeGroups,answerOf,ownerNames,confirmState,unitShort,personId,personCards} from './review-display.mjs';
// 复盘 pages (陈溪南 2026-10-20/21): the plan's layout, five rows per review, same groups, comments and handshake.
const Verdict=({value,small})=><span className={`review-verdict tone-${verdictTone(value)}${small?' is-small':''}`}>{value||'待判定'}</span>;
function Rich({text,evidence}){return richParts(text).map((p,i)=>p.bold?<strong key={i}>{p.bold}</strong>:p.evidence?<sup key={i} className="review-evidence" title={evidence?.[p.evidence]?`${p.evidence} · ${evidence[p.evidence].date||''} · ${evidence[p.evidence].title||''}`:`${p.evidence}：证据来源见本轮输入`}>{p.evidence}</sup>:<React.Fragment key={i}>{p.text}</React.Fragment>);}
// 长期目标审视 is a suggestion to the CEO: 建议维持 / 建议修改 / 建议重开 (陈溪南 2026-10-21).
const ltoChoice=c=>String(c||'').startsWith('建议')?c:`建议${c||'维持'}`;
const typeTone={'欠账':'debt','待决策':'decide','继续验证':'verify','停止':'stop','约束':'limit','继续':'verify','调整':'limit'};
// One row of the two-column table, with the plan's comment bubble so field comments work the same.
function Row({node,field,label,comments,onDetail,children}){
 return <tr><th scope="row">{label}</th><td><section className="plan-doc-field" data-block-id={`${node.id}:${field}`}><div className="plan-doc-field-heading review-row-heading">{onDetail&&<CommentBubble node={node} field={field} label={label} comments={comments} onDetail={onDetail}/>}</div>{children}</section></td></tr>;
}
// One item of a list field can be commented on by itself; the bubble shows on hover, or always once it has comments.
// 复盘改版 (陈溪南与 CEO 2026-10-26): 判定 + 事实证据 on the card that is confirmed, one line per Task / Mission / unit.
// The reason often repeats the verdict at its start (未达成。…); the line already says it once.
const reasonAfter=(v,t)=>{const x=String(t||'');return v&&x.startsWith(v)?x.slice(v.length).replace(/^[\s，,。.：:；;]+/,''):x;};
// A clause read as a sentence: ends in 。 unless it already ends in punctuation (evidence marks aside).
const sentence=t=>{const x=String(t||'').trim(),core=x.replace(/(\s*\[E\d+\])+\s*$/,'');// A closing bracket ends a sentence only when a stop sits just inside it: 「…（见 Mission 复盘）」 still needs its 。.
 return /[。！？.!?]$/.test(core)||/[。！？.!?][」）)]$/.test(core)?x:core+'。'+x.slice(core.length).trim();};
const dueOf=review=>{const t=Date.parse(review?.dueAt||'');return Number.isFinite(t)?t:null;};
function Due({at}){const over=Date.now()>at,d=new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});return <span className={`review-due${over?' is-over':''}`} title="复盘生成后 48 小时">{over?'已超时':`${d} 前确认`}</span>;}
const signedAll=n=>{const slots=reviewSlots(n);return slots.length>0&&!n.upstreamChange&&slots.every(slot=>(n.signatures||[]).some(x=>x.slot===slot));};
const factTone=s=>verdictTone(s==='未开始'?'未达成':s);
const isFactsCard=n=>Array.isArray(n?.facts);
function Facts({node,comments,onDetail,evidence}){return <ol className="review-list review-facts">{node.facts.map((f,i)=><li key={f.ref||i} className={`review-item review-fact tone-${factTone(f.status)}`}>{onDetail&&<ItemBubble node={node} field="facts" index={i} label="事实证据" comments={comments} onDetail={onDetail}/>}
 <div className="review-fact-head"><strong>{f.item}</strong>{f.owner&&<span className="review-fact-owner">{f.owner}</span>}{f.status&&<span className="review-fact-status">{f.status}</span>}</div>
 {(f.evidence||f.gap)&&<p className="review-fact-evidence">{f.evidence&&<Rich text={sentence(f.evidence)} evidence={evidence}/>}{f.gap&&<>没做到的原因：<Rich text={sentence(f.gap)} evidence={evidence}/></>}</p>}</li>)}</ol>;}
// No owner in the ontology (ownerAssigned:false): the card says 未指派; owner stays the unit DRI, who signs it (M2 2026-10-26).
const unassigned=n=>n.level==='mission'&&n.ownerAssigned===false;
const personOf=n=>unassigned(n)?'未指派':n.owner;
const cardTag=(node,unitLabel)=>node.level==='mission'?`${unitShort(unitLabel(node))} · ${reviewLabel(node)}`:node.level==='company'?'公司复盘':`${unitLabel(node)} · ${reviewLabel(node)}`;
function NextInputs({node,comments,onDetail,evidence,profile,onAnswer}){return <ol className="review-list review-next-list">{node.nextInputs.map((n,i)=><li key={n.ref||n.id||i} className={`review-item review-next tone-${typeTone[n.type]||'limit'}`}>{onDetail&&<ItemBubble node={node} field="nextInputs" index={i} label="下期输入" comments={comments} onDetail={onDetail}/>}
 <span className="review-next-type">{n.type}</span><Rich text={sentence(n.text)} evidence={evidence}/>
 {n.ask?.question&&<Ask node={node} index={i} ask={n.ask.question} label={`问${n.ask.to?` ${n.ask.to}`:''}`} waitFor={n.ask.to||'负责人'} answer={answerOf(comments,i,'nextInputs')} canAnswer={!!profile&&n.ask.to===profile.name&&node.status!=='已确认'} onAnswer={(nd,idx,q,t)=>onAnswer(nd,idx,q,t,'nextInputs')}/>}</li>)}</ol>;}
function ItemBubble({node,field,index,label,comments,onDetail}){return <span className="review-item-bubble" data-block-id={`${node.id}:${field}#${index}`}><CommentBubble node={node} field={`${field}#${index}`} label={`${label} · 第 ${index+1} 条`} comments={comments} onDetail={onDetail}/></span>;}
function Ask({node,index,ask,answer,canAnswer,onAnswer,block='causes',label='追问',waitFor='负责人'}){
 const [text,setText]=useState(null),[busy,setBusy]=useState(false);
 if(answer)return <div className="review-ask is-answered"><span className="review-ask-q">{label}：{ask}</span><span className="review-ask-a">{answer.author}：{String(answer.text).replace(/^回答「[^」]*」：/,'')}</span></div>;
 return <div className="review-ask"><span className="review-ask-q">{label}：{ask}</span>
  {canAnswer?(text==null?<button className="review-ask-button" onClick={()=>setText('')}>回答</button>:null):<span className="review-ask-wait">待{waitFor}回答</span>}
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
function startValues(n){if(isFactsCard(n))return {verdict:n.verdict||'未达成',verdictReason:toEdit(plain(n.verdictReason)),facts:n.facts.map(f=>({status:f.status||'未达成',evidence:toEdit(f.evidence),gap:toEdit(f.gap)})),next:(n.nextInputs||[]).map(x=>({type:x.type||'继续',text:toEdit(x.text)}))};return {verdict:n.verdict||'未达成',verdictReason:toEdit(plain(n.verdictReason)),targets:(n.targets||[]).map(toEdit).join('\n'),causes:(n.causes||[]).map(c=>toEdit(c.text)).join('\n'),nextInputs:(n.nextInputs||[]).map(x=>toEdit(x.text)).join('\n'),...(n.ltoReview?{ltoChoice:String(n.ltoReview.choice).startsWith('建议')?n.ltoReview.choice:'建议'+n.ltoReview.choice,ltoReason:plain(n.ltoReview.reason)}:{})};}
function patchFrom(n,v){const lines=t=>String(t).split('\n').map(x=>x.trim()).filter(Boolean),out={};
 if(v.verdict!==n.verdict)out.verdict=v.verdict;if(v.verdictReason.trim()!==toEdit(plain(n.verdictReason)))out.verdictReason=fromEdit(v.verdictReason.trim(),n.verdictReason);
 if(isFactsCard(n)){const facts=n.facts.map((f,i)=>{const e=v.facts[i];return {...f,status:e.status,evidence:e.evidence.trim()===toEdit(f.evidence)?f.evidence:e.evidence.trim(),gap:e.gap.trim()===toEdit(f.gap)?f.gap||'':e.gap.trim()};});if(JSON.stringify(facts)!==JSON.stringify(n.facts))out.facts=facts;
  const next=(n.nextInputs||[]).map((x,i)=>({...x,type:v.next[i].type,text:v.next[i].text.trim()===toEdit(x.text)?x.text:v.next[i].text.trim()}));if(JSON.stringify(next)!==JSON.stringify(n.nextInputs||[]))out.nextInputs=next;return out;}
 const targets=lines(v.targets).map((t,i)=>fromEdit(t,(n.targets||[])[i]));if(JSON.stringify(targets)!==JSON.stringify(n.targets||[]))out.targets=targets;
 const causes=lines(v.causes).map((text,i)=>({text:fromEdit(text,(n.causes||[])[i]?.text),ask:(n.causes||[])[i]?.ask||''}));if(JSON.stringify(causes)!==JSON.stringify(n.causes||[]))out.causes=causes;
 const next=lines(v.nextInputs).map((text,i)=>({id:(n.nextInputs||[])[i]?.id||`${n.ref}-${i+1}`,type:(n.nextInputs||[])[i]?.type||'欠账',text:fromEdit(text,(n.nextInputs||[])[i]?.text)}));if(JSON.stringify(next)!==JSON.stringify(n.nextInputs||[]))out.nextInputs=next;
 if(n.ltoReview&&(v.ltoChoice!==n.ltoReview.choice||v.ltoReason.trim()!==plain(n.ltoReview.reason)))out.ltoReview={choice:v.ltoChoice,reason:v.ltoReason.trim()};
 return out;}
function EditRow({label,children}){return <tr><th scope="row">{label}</th><td>{children}</td></tr>;}
function ReviewEdit({node,onSave,onCancel}){
 const [v,setV]=useState(()=>startValues(node)),[busy,setBusy]=useState(false),set=k=>e=>setV(o=>({...o,[k]:e.target.value}));
 const save=async()=>{const patch=patchFrom(node,v);if(!Object.keys(patch).length)return onCancel();setBusy(true);try{await onSave(patch);}catch(e){if(e.code!=='CANCELLED')throw e;}finally{setBusy(false);}};
 const keys=e=>{if(e.key==='Escape')onCancel();else enterSubmit(e,save,!busy);};
 const setFact=(i,k)=>e=>setV(o=>({...o,facts:o.facts.map((f,j)=>j===i?{...f,[k]:e.target.value}:f)}));
 const factArea=(i,k,rows,hint)=><textarea className="inline-field-input" rows={Math.max(rows,String(v.facts[i][k]).split('\n').length)} value={v.facts[i][k]} placeholder={hint} onChange={setFact(i,k)} onKeyDown={keys} title="回车保存，Shift＋回车换行，Esc 取消"/>;
 const area=(k,rows)=><textarea className="inline-field-input" rows={Math.max(rows,String(v[k]).split('\n').length+1)} value={v[k]} onChange={set(k)} onKeyDown={keys} title="回车保存，Shift＋回车换行，Esc 取消"/>;
 return <div className="template-content card-simple review-edit"><table className="review-table"><tbody>
  <EditRow label="结果判定"><select value={v.verdict} onChange={set('verdict')}>{['达成','部分达成','未达成'].map(x=><option key={x}>{x}</option>)}</select>{area('verdictReason',2)}</EditRow>
  {isFactsCard(node)?<><EditRow label="事实证据"><ol className="review-list review-facts-edit">{node.facts.map((f,i)=><li key={f.ref||i}><div className="review-fact-head"><strong>{f.item}</strong>{f.owner&&<span className="review-fact-owner">{f.owner}</span>}<select value={v.facts[i].status} onChange={setFact(i,'status')}>{['达成','部分达成','未达成','未开始'].map(x=><option key={x}>{x}</option>)}</select></div>{factArea(i,'evidence',2,'现状和证据')}{factArea(i,'gap',1,'没做到的原因（可空）')}</li>)}</ol></EditRow>
  {(node.nextInputs||[]).length>0&&<EditRow label="下期输入"><ol className="review-list review-facts-edit">{node.nextInputs.map((x,i)=><li key={x.ref||i}><div className="review-fact-head"><select value={v.next[i].type} onChange={e=>setV(o=>({...o,next:o.next.map((y,j)=>j===i?{...y,type:e.target.value}:y)}))}>{['继续','调整','停止','待决策'].map(t=><option key={t}>{t}</option>)}</select></div><textarea className="inline-field-input" rows={Math.max(1,String(v.next[i].text).split('\n').length)} value={v.next[i].text} onChange={e=>setV(o=>({...o,next:o.next.map((y,j)=>j===i?{...y,text:e.target.value}:y)}))} onKeyDown={keys} title="回车保存，Shift＋回车换行，Esc 取消"/>{x.ask?.question&&<small className="proposal-same">问 {x.ask.to}：{x.ask.question}</small>}</li>)}</ol></EditRow>}</>:<>
  <EditRow label="目标对照">{area('targets',4)}<small className="proposal-same">每行一条，写成“短标题（判定）：正文”</small></EditRow>
  <EditRow label="原因">{area('causes',3)}<small className="proposal-same">每行一条</small></EditRow>
  <EditRow label="下月输入">{area('nextInputs',3)}<small className="proposal-same">每行一条，类型按原来的顺序保留</small></EditRow>
  </>}
  {node.ltoReview&&<EditRow label="长期目标审视"><select value={v.ltoChoice} onChange={set('ltoChoice')}>{['建议维持','建议修改','建议重开'].map(x=><option key={x}>{x}</option>)}</select>{area('ltoReason',2)}</EditRow>}
 </tbody></table><div className="proposal-actions"><Button className="proposal-confirm" isDisabled={busy} onPress={save}>{busy?'保存中…':'保存新版本'}</Button><Button className="proposal-reject" onPress={onCancel}>取消</Button></div></div>;
}
export function ReviewCard({node,profile,comments=[],onDetail,onAnswer,evidence,unitLabel,tone='domain',onRevise,footer=null,insight=null,insightState='',dueAt=null,transfer=null}){
 const mineToAnswer=ownerNames(node).includes(profile.name),[editing,setEditing]=useState(false),canEdit=!!onRevise&&!node.locked&&mayEdit(node,profile);
 return <article className={`plan-doc-node review-card doc-${node.level==='mission'?'mission':'po'} tone-${tone}`} data-document-node={node.id}>
  <div className="card-head"><span className="level-tag">{cardTag(node,unitLabel)}</span><span className="card-meta"><span className="person">{personOf(node)}</span><span>v{node.version}</span></span><span className="card-head-end">{transfer}{canEdit&&<Button className="icon review-edit-toggle" aria-label={editing?'收起编辑':'编辑复盘'} title={editing?'收起编辑':'编辑复盘'} onPress={()=>setEditing(x=>!x)}>{editing?<X size={15}/>:<Pencil size={15}/>}</Button>}{/* Same head as the home card: verdict and status on the right (陈溪南 2026-10-23). */}{dueAt&&node.status!=='已确认'&&<Due at={dueAt}/>}{node.verdict&&<Verdict value={node.verdict} small/>}{/* One word until it is confirmed (陈溪南 2026-10-27): 待确认, not 待某某确认. */}<span className="state" data-confirmed={node.status==='已确认'}>{node.status==='已确认'?'已确认':'待确认'}</span></span></div>
  <h2>{node.title}</h2>
  {/* Locked after the unit or company review is confirmed (陈溪南 2026-10-28): read and comment only. */}
  {node.locked&&<p className="review-locked">{node.lockedReason||'这份复盘已锁定，只能看和批注'}</p>}
  {editing?<ReviewEdit node={node} onCancel={()=>setEditing(false)} onSave={async patch=>{await onRevise(node,patch);setEditing(false);}}/>:<div className="template-content card-simple"><table className="review-table"><tbody>
   <Row node={node} field="verdict" label="结果判定" comments={comments} onDetail={onDetail}><p className="review-verdict-line">{node.verdictChange&&<span className="verdict-changed">由「{node.verdictChange.from}」改为「{node.verdictChange.to}」· {node.verdictChange.by} · v{node.verdictChange.version}</span>}{/* 结果判定 opens with the verdict itself, then the reasoning (陈溪南 2026-10-26). */}<span className="review-verdict-reason">{node.verdict&&<span className={`review-verdict-word tone-${verdictTone(node.verdict)}`}>{node.verdict}，</span>}<Rich text={reasonAfter(node.verdict,node.verdictReason)} evidence={evidence}/></span></p></Row>
   {isFactsCard(node)?<><Row node={node} field="facts" label="事实证据" comments={comments} onDetail={onDetail}>{node.facts.length?<Facts node={node} comments={comments} onDetail={onDetail} evidence={evidence}/>:<p className="review-none">这份复盘没有列出事实。</p>}</Row>
    {Array.isArray(node.nextInputs)&&node.nextInputs.length>0&&<Row node={node} field="nextInputs" label="下期输入" comments={comments} onDetail={onDetail}><NextInputs node={node} comments={comments} onDetail={onDetail} evidence={evidence} profile={profile} onAnswer={onAnswer}/></Row>}</>:<>
   <Row node={node} field="targets" label="目标对照" comments={comments} onDetail={onDetail}><ol className="review-list">{(node.targets||[]).map((t,i)=>{if(/^\*\*Mission 结果（无）/.test(String(t)))return null;const p=targetParts(t),tone=verdictTone(p.verdict);return <li key={i} className={`review-target tone-${tone} review-item`}>{onDetail&&<ItemBubble node={node} field="targets" index={i} label="目标对照" comments={comments} onDetail={onDetail}/>}{p.name&&<strong className="review-target-name">{p.name}：</strong>}{p.verdict&&<span className="review-target-verdict">{p.verdict}，</span>}<Rich text={p.text} evidence={evidence}/></li>;})}</ol></Row>
   <Row node={node} field="causes" label="原因" comments={comments} onDetail={onDetail}><ol className="review-list">{(node.causes||[]).map((c,i)=><li key={i} className="review-item">{onDetail&&<ItemBubble node={node} field="causes" index={i} label="原因" comments={comments} onDetail={onDetail}/>}<Rich text={c.text} evidence={evidence}/>{c.ask&&<Ask node={node} index={i} ask={c.ask} answer={answerOf(comments,i)} canAnswer={mineToAnswer} onAnswer={onAnswer}/>}</li>)}</ol></Row>
   <Row node={node} field="nextInputs" label="下月输入" comments={comments} onDetail={onDetail}><ol className="review-list">{(node.nextInputs||[]).map((n,i)=>{const m=String(n.text).match(/^\*\*(.+?)：?\*\*\s*([\s\S]*)$/);return <li key={n.id||i} className={`review-next-input tone-${typeTone[n.type]||'limit'} review-item`}>{onDetail&&<ItemBubble node={node} field="nextInputs" index={i} label="下月输入" comments={comments} onDetail={onDetail}/>}{m&&<strong>{m[1].replace(/：$/,'')}：</strong>}<span className="review-type-word">{n.type}，</span><Rich text={m?m[2]:n.text} evidence={evidence}/></li>;})}</ol></Row>
   </>}
   {node.ltoReview&&<Row node={node} field="ltoReview" label="长期目标审视" comments={comments} onDetail={onDetail}><p><strong>{ltoChoice(node.ltoReview.choice)}：</strong>{node.ltoReview.reason}</p></Row>}
   {insight&&<tr className="review-insight-row"><th scope="row">分析洞察{insightState&&<small>{insightState}</small>}</th><td>{insight}</td></tr>}
   {/* 共同确认 is the table's last row, a signature line per signer (陈溪南 2026-10-27). */}
   {footer&&<tr className="review-sign-row"><th scope="row" className={signedAll(node)?'is-agreed':undefined}>{signedAll(node)?'已达成共识':'共同确认'}</th><td>{footer}</td></tr>}
  </tbody></table></div>}
 </article>;
}
// 洞察 as a short list in the review card (陈溪南 2026-10-27, replacing the sticky-note wall): my lines (editable), how many
// others handed in, one ＋ to add a line. Before 公开 the list holds only my own (the server sends nobody else's); after,
// everyone's, signed, with Nexus 综合 first.
function InsightLine({item,mine,me,onEdit,onDelete}){
 const [editing,setEditing]=useState(false),[text,setText]=useState(item.text),[sure,setSure]=useState(false),[busy,setBusy]=useState(false);
 const save=async()=>{const t=text.trim();if(!t||busy)return;if(t===item.text)return setEditing(false);setBusy(true);try{await onEdit(item.id,t);setEditing(false);}catch{}finally{setBusy(false);}};
 if(editing)return <li className="insight-item is-editing"><textarea className="inline-field-input insight-input" rows={Math.max(2,text.split('\n').length)} value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setText(item.text);setEditing(false);}else enterSubmit(e,save,!busy);}} autoFocus aria-label="修改洞察" title="回车保存，Shift＋回车换行，Esc 取消"/><span className="insight-actions"><Button className="proposal-confirm" isDisabled={busy||!text.trim()} onPress={save}>{busy?'保存中…':'保存'}</Button><Button className="plain" onPress={()=>{setText(item.text);setEditing(false);}}>取消</Button></span></li>;
 return <li className="insight-item"><span className="insight-text"><strong className="insight-who">{item.author||me}：</strong>{item.source?.label&&<span className="insight-source">来自 {item.source.label} 复盘</span>}<Rich text={item.text}/></span>
  {mine&&<span className="insight-actions">{sure?<><Button className="plain insight-delete" isDisabled={busy} onPress={async()=>{setBusy(true);try{await onDelete(item.id);}catch{}finally{setBusy(false);setSure(false);}}}>确认删除</Button><Button className="plain" onPress={()=>setSure(false)}>取消</Button></>:<><Button className="plain" onPress={()=>setEditing(true)}>修改</Button><Button className="plain" onPress={()=>setSure(true)}>删除</Button></>}</span>}</li>;
}
export function InsightCard({node,data,profile,onInsight}){
 const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[open,setOpen]=useState(false);
 const d=data||{revealed:false,submitters:[],mine:[]},revealed=d.revealed===true;
 const run=async value=>{setError('');try{await onInsight(value);return true;}catch(e){setError(e.message||'没能保存，请重试');return false;}};
 const submit=async()=>{const t=text.trim();if(!t||busy)return;setBusy(true);if(await run({type:'insight',cardId:node.id,text:t})){setText('');setOpen(false);}setBusy(false);};
 const edit=(insightId,t)=>run({type:'editInsight',cardId:node.id,insightId,text:t}).then(ok=>{if(!ok)throw Error();});
 const remove=insightId=>run({type:'deleteInsight',cardId:node.id,insightId}).then(ok=>{if(!ok)throw Error();});
 const items=revealed?d.items||[]:[],isMine=i=>i.mine===true||i.mine==null&&i.author===profile.name,mine=revealed?items.filter(isMine):d.mine||[];
 const others=revealed?[]:(d.submitters||[]).filter(s=>s.name!==profile.name&&s.count>0);
 const canWrite=!Array.isArray(d.participants)||d.participants.includes(profile.name);
 const list=d.items||mine;
 return <div className="insight-row" data-insight-card={node.id}>
  {revealed&&<div className="insight-nexus"><strong>Nexus 综合</strong>{d.nexus?.text?<p className="insight-text"><Rich text={d.nexus.text}/></p>:<p className="review-none">{d.nexus?.error?'这次没综合成，会再试一次。':'正在读全部洞察，综合好后会出现在这里。'}</p>}</div>}
  {list.length>0&&<ul className="insight-list">{list.map(i=><InsightLine key={i.id} item={i} mine={isMine(i)&&!i.source} me={profile.name} onEdit={edit} onDelete={remove}/>)}</ul>}
  {others.length>0&&<ul className="insight-list insight-hidden">{others.map(o=><li key={o.name} className="insight-item"><span className="insight-text"><strong className="insight-who">{o.name}：</strong><span className="insight-sealed">已写 {o.count} 条，公开后可见</span></span></li>)}</ul>}
  {canWrite&&(open||text?<div className="insight-compose"><textarea className="inline-field-input insight-input" rows={2} value={text} autoFocus onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'&&!text.trim())setOpen(false);else enterSubmit(e,submit,!busy);}} placeholder="一个问题，加一条建议" aria-label="写洞察" title="回车提交，Shift＋回车换行"/>
    <span className="insight-actions"><Button className="proposal-confirm" isDisabled={busy||!text.trim()} onPress={submit}>{busy?'提交中…':'提交'}</Button><Button className="plain" onPress={()=>{setText('');setOpen(false);}}>取消</Button>{error&&<span className="admin-line is-failed" role="alert">{error}</span>}</span></div>
   :<button type="button" className="insight-add" onClick={()=>setOpen(true)}>＋ 添加洞察</button>)}
 </div>;
}
function PersonSummary({name,cards,me,months,unitLabel,onOpen}){
 const mineToSign=cards.filter(n=>ownerNames(n).includes(me)&&n.status!=='已确认').length,done=cards.filter(n=>n.status==='已确认').length;
 const state=mineToSign?`待你确认 ${mineToSign} 份`:done===cards.length?'已确认':`已确认 ${done}/${cards.length}`;
 return <article role="button" tabIndex={0} aria-label={`打开 ${name}的个人复盘`} onClick={onOpen} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen();}}} className="plan-doc-node doc-summary review-summary person-summary doc-mission tone-mission">
  <div className="card-head"><span className="level-tag">个人复盘</span><span className="card-meta"><span className="person">{name}</span><span>{cards.length} Mission{cards.length>1?'s':''}</span></span><span className="card-head-end"><span className={`state${mineToSign?' is-mine':''}`} data-confirmed={done===cards.length}>{state}</span></span></div>
  <h2>{name==='未指派'?`未指派负责人的 Mission 复盘`:name===me?'我的'+months.from+'个人复盘':`${name}的${months.from}个人复盘`}</h2>
  <ul className="person-summary-list">{cards.map(n=><li key={n.id}><span className="person-summary-tag">{unitShort(unitLabel(n))} · {reviewLabel(n)}</span>{n.title}</li>)}</ul>
 </article>;
}
export function ReviewSummary({node,onOpen,unitLabel,comments=[],tone='domain',stateOf}){
 const st=stateOf?stateOf(node):{text:node.status,mine:false};
 return <article role="button" tabIndex={0} aria-label={`打开 ${node.title}`} onClick={()=>onOpen(node)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen(node);}}} className={`plan-doc-node doc-summary review-summary doc-${node.level==='mission'?'mission':'po'} tone-${tone}`} data-document-node={node.id}>
  <div className="card-head"><span className="level-tag">{node.level==='mission'?`${unitShort(unitLabel(node))} · ${reviewLabel(node)}`:node.level==='company'?'公司复盘':unitLabel(node)}</span><span className="card-meta"><span className="person">{personOf(node)}</span>{node.level==='po'&&node.children?.length>0&&<span>{node.children.length} Mission{node.children.length>1?'s':''}</span>}{comments.length>0&&<span className="card-comments"><MessageCircle size={14}/> {comments.length}</span>}</span><span className="card-head-end">{node.verdict&&<Verdict value={node.verdict} small/>}<span className={`state${st.mine?' is-mine':''}`} data-confirmed={node.status==='已确认'}>{st.text}</span></span></div>
  <h2>{node.title}</h2><p className="doc-description"><Rich text={node.verdictReason}/></p>
 </article>;
}
export default function ReviewCanvas({transferFor,insights={},onInsight,ceoName='CEO',onRevise,tree,active,profile,comments,toneOf=()=>'domain',handoff=null,onShowHandoff,months={from:'',to:''},onOpen,onAction,onDetail,onAnswer,annotation,me,onDeleteComment,evidence,unitLabel,signerNames,review}){
 if(!tree.nodes.length)return <div className="plan-doc-canvas document-catalog"><div className="review-empty"><h3>还没有载入复盘</h3><p>本月复盘生成后会出现在这里。</p></div></div>;
 const stateOf=n=>{const po=tree.nodes.find(x=>x.level==='po'&&x.unit===n.unit),left=n.level==='company'&&n.status!=='已确认'?tree.nodes.filter(x=>x.level!=='company'&&x.status!=='已确认').length:0;if(left)return {text:`还有 ${left} 份复盘未确认`,mine:false};return confirmState({status:n.status,version:n.version,signatures:n.signatures,slots:reviewSlots(n),holder:s=>s==='ceo'?ceoName:s==='unitDri'?po?.owner:n.owner,mine:s=>maySign(n,s,profile)});};
 if(!active){
  // What waits for me comes first, then what I am part of, then the other units I can see (陈溪南 2026-10-23).
  const mine=[...mineFirst(tree.nodes,profile)].sort((a,b)=>(stateOf(b).mine?1:0)-(stateOf(a).mine?1:0));
  // Only the reviews someone is part of (陈溪南 2026-10-23): seeing a unit because of next month's plan is not a reason
  // to list its October review here. The CEO's list already holds every unit.
  const others=[];
  // 个人复盘 (陈溪南 2026-10-27): one entry per person for the Missions on my list; mine first.
  const people=[...new Set(mine.filter(n=>n.level==='mission').flatMap(n=>n.ownerAssigned===false?['未指派']:ownerNames(n).slice(0,1)))].sort((a,b)=>(b===profile.name)-(a===profile.name));
  // Reviews the run could not write (or wrote without background) are named here, never left silently missing.
  // Members see only what the data left out (陈溪南 2026-10-23); program-side issues (拒答、降级) are for 管理, not this page.
  const missing=review?.skipped||[],problems=(review?.problems||[]).filter(p=>p.kind==='missing'),refName=ref=>{const [unit,m]=String(ref).split('-m'),po=tree.nodes.find(n=>n.level==='po'&&(n.unit===unit||n.ref===unit));return `${po?unitLabel(po):unit}${m?` M${m.padStart(2,'0')}`:''}`;};
  return <div className="plan-doc-canvas document-catalog review-catalog" aria-label="复盘目录">
   {(missing.length>0||problems.length>0)&&<div className="review-problems" role="status"><p>本体里缺少材料，以下没有复盘：</p>{missing.map((t,i)=><p key={'s'+i}>{t}</p>)}{problems.map(p=><p key={p.ref}><strong>{refName(p.ref)}</strong>{p.reason}</p>)}</div>}
   {Object.entries(reviewHomeGroups(tree.nodes,profile)).map(([kind,entries])=>entries.length>0&&<section key={kind} className="catalog-group"><h3 className="review-home-heading">{kind==='confirm'?'需要我确认':'需要我关注'}</h3>{entries.map(e=>e.person?<PersonSummary key={e.key} name={e.person} cards={e.cards} me={profile.name} months={months} unitLabel={unitLabel} onOpen={()=>onOpen({id:e.key,level:'person',person:e.person,title:`${e.person}的个人复盘`})}/>:<ReviewSummary key={e.key} node={e.node} stateOf={stateOf} tone={toneOf(e.node)} onOpen={onOpen} unitLabel={unitLabel} comments={comments[e.key]}/>)}</section>)}
  </div>;
 }
 const fullCard=node=>{
  // Someone else's 个人复盘 is read-only here: no comments, no confirming, no editing (陈溪南 2026-10-27).
  const readOnly=node.level==='mission'&&!ownerNames(node).includes(profile.name);
  // The company review closes the month: it waits for every other review, and confirming it starts next month's plan.
  const open=node.level==='company'?tree.nodes.filter(n=>n.level!=='company'&&n.status!=='已确认'):node.level==='po'?tree.nodes.filter(n=>n.level==='mission'&&n.unit===node.unit&&n.status!=='已确认'):[];
  // 确认 needs one insight first (陈溪南 2026-10-27): the button still reads 确认; pressing it says so and opens a blank note.
  const owesInsight=isFactsCard(node)&&(insights[node.id]?.missing||[]).includes(profile.name);
  const goWrite=()=>{const box=document.querySelector(`[data-insight-card="${CSS.escape(node.id)}"]`);box?.scrollIntoView({block:'center',behavior:'smooth'});box?.querySelector('.insight-add')?.click();};
  const handshake=<Handshake compact gate={owesInsight?{text:'确认前至少贴一条洞察',onPress:goWrite}:null} node={node} locked={open.length?{text:`还有 ${open.length} 份${node.level==='po'?'个人':''}复盘未确认`,title:open.map(n=>n.level==='mission'?`${unitLabel(n)} ${reviewLabel(n)}`:unitLabel(n)).join('、')}:null} profile={{...profile,missions:ownerNames(node).includes(profile.name)?[...(profile.missions||[]),node.id]:profile.missions||[]}} slots={reviewSlots(node)} summary={isFactsCard(node)?(node.level==='company'?`确认判定和事实证据后，${months.from}复盘全部定稿，Nexus 开始生成 ${months.to}拆解。分析洞察不用确认。`:'确认的是上面的判定和事实证据；下面的分析洞察不用确认。确认不等于结果达成。'):node.level==='company'?`CEO 确认后，${months.from}复盘全部定稿，Nexus 开始生成 ${months.to}拆解。`:'确认复盘，也就确认了下方的下月输入，它们会作为下月拆解的输入。确认不等于结果达成。'} signerNames={signerNames(node)} onAction={value=>onAction({...value,cardId:node.id,baseVersion:node.version})}/>;
  return <ReviewCard key={node.id} transfer={transferFor?.(node)} node={node} tone={toneOf(node)} onRevise={onRevise} profile={profile} comments={comments[node.id]||[]} onDetail={readOnly?undefined:onDetail} onAnswer={onAnswer} evidence={evidence} unitLabel={unitLabel} dueAt={isFactsCard(node)?dueOf(node.dueAt?node:review):null} footer={handshake} insight={isFactsCard(node)?<InsightCard node={node} data={insights[node.id]} profile={profile} onInsight={onInsight}/>:null} insightState={isFactsCard(node)?(insights[node.id]?.revealed?'已公开':node.level==='mission'?'':'未公开'):''}/>
 };
 const page=(label,children)=><CommentScope me={me} onDeleteComment={onDeleteComment} annotation={annotation}>
  <div className="plan-doc-canvas document-page" aria-label={label}><div className="document-primary review-primary">{children}</div></div>
 </CommentScope>;
 // 个人复盘 page: every Mission this person owns that I can see, one full card each, each confirmed by its owner.
 // 未指派: only the unassigned Missions this viewer signs for (their own units), as on the home card.
 if(active.level==='person'){const cards=personCards(tree.nodes,active.person).filter(n=>active.person!=='未指派'||ownerNames(n).includes(profile.name));return page('个人复盘',<>{cards.length?cards.map(fullCard):<p className="review-none">这里没有你能看到的 Mission 复盘。</p>}</>);}
 const node=tree.byId.get(active.id)||active;
 // 参考：本单元的 Mission 复盘 (陈溪南 2026-10-27): read-only, one line each, each opens just that card.
 const refs=node.level==='po'?tree.nodes.filter(n=>n.level==='mission'&&n.unit===node.unit):[];
 return page('复盘文档',<>{fullCard(node)}{refs.length>0&&<section className="review-refs" aria-label="参考：本单元的 Mission 复盘"><h3>参考：本单元的 Mission 复盘<small> · {refs.length}</small></h3>
  <ul>{refs.map(n=><li key={n.id}><button type="button" onClick={()=>onOpen(n)}><span className="review-refs-tag">{reviewLabel(n)}</span><span className="review-refs-title">{n.title}</span><span className="review-refs-owner">{n.ownerAssigned===false?'未指派':ownerNames(n)[0]}</span><span className="review-refs-state" data-confirmed={n.status==='已确认'}>{n.status==='已确认'?'已确认':'待确认'}</span></button></li>)}</ul></section>}</>);
}
