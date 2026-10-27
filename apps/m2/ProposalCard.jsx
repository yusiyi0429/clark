import React,{useState} from 'react';
import {Button} from '@heroui/react';
import {documentFieldLabel} from './document-template.mjs';
import {proposalRows,stripMarks as stripBold,inlineChange,changeSummary} from './proposal-diff.mjs';
// Evidence numbers [E#] are hidden on the card as on the page (评测 2026-10-22).
const stripMarks=t=>stripBold(t).replace(/\s*(\[E\d+\])+/g,'');
import NexusOrb from './NexusOrb.jsx';
import {Pencil,CheckCircle2,X} from 'lucide-react';
import {memberProfiles} from './member-profiles.mjs';
import {enterSubmit} from './enter-submit.mjs';
// Each change reads as 原来 / 改成 (or 新增 / 删去); unchanged items fold into one line (陈溪南 2026-10-19).
// 事实证据 rows {item, status, evidence, gap} read as one line each, named by the item (复盘改版 2026-10-26).
// Split by part, so a change reads 事实证据 · 项 · 状态：未达成 → 部分达成, not one long line rewritten (陈溪南 2026-10-27).
const factLines=x=>[['状态',x.status],['证据',x.evidence],['没做到的原因',x.gap]].filter(([,v])=>v).map(([k,v])=>`**${x.item} · ${k}：**${v}`);
// Review fields hold objects: 原因 {text, ask}, 下月输入 {type, text}, 长期目标审视 {choice, reason}; compare them as lines.
const nextLine=x=>`**${x.type}：**${x.text}${x.ask?.question?`（问 ${x.ask.to}：${x.ask.question}）`:''}`;
const asLines=v=>Array.isArray(v)&&v.some(x=>x?.item!=null&&x?.evidence!==undefined)?v.flatMap(factLines):Array.isArray(v)&&v.some(x=>x?.type&&'ref'in(x||{}))?v.map(nextLine):Array.isArray(v)?v.map(x=>typeof x==='string'?x:x?.type?`［${x.type}］${x.text}`:x?.text!=null?x.text+(x.ask?`（追问：${x.ask}）`:''):JSON.stringify(x)):v&&typeof v==='object'?`${v.choice||''}：${v.reason||''}`:v;
// One change per line, only the change (陈溪南 2026-10-22): which field (and which item), then the old words struck → the
// new words. A rewrite shows the new text whole with 看原来; an added or removed item says so in its label.
const itemTitle=t=>String(t||'').match(/^\*\*(.+?)[：:]\*\*/)?.[1]||'';
// The value without its **短标题：** (the title is already in the label).
const bodyOf=t=>stripMarks(String(t??'').replace(/^\*\*(.+?)[：:]\*\*\s*/,''));
// Changes read in place (陈溪南 2026-10-27): a short value as 旧 → 新 in whole words; a sentence whole, with the removed words
// struck and the new words marked where they sit; only a near-total rewrite shows the new text with 看原来.
function ChangeRow({label,row,part}){
 const [open,setOpen]=useState(false);
 const before=bodyOf(row.before),after=bodyOf(row.after),item=itemTitle(row.before??row.after);
 const head=t=><small className={part?'proposal-part':'proposal-field'}>{part||`${label}${item?` · ${item}`:''}`}{t?` · ${t}`:''}</small>;
 if(row.kind==='added')return <div className="proposal-diff">{head('新增')}<p className="change-full">{after}</p></div>;
 if(row.kind==='removed')return <div className="proposal-diff">{head('删去')}<p className="change-full"><s className="change-old">{before}</s></p></div>;
 if(before.length<=14&&after.length<=20)return <div className="proposal-diff">{head('')}<p className="change-pair">{before&&<><s className="change-old">{before}</s><span className="change-arrow">→</span></>}<mark className="diff-mark">{after}</mark></p></div>;
 const c=inlineChange(before,after),kept=c.head.length+c.tail.length;
 if(kept<Math.min(before.length,after.length)*0.3)return <div className="proposal-diff">{head('改写')}<p className="change-full">{after} <button type="button" className="see-before" onClick={()=>setOpen(!open)}>{open?'收起原来':'看原来'}</button></p>{open&&<del className="change-before">{before}</del>}</div>;
 return <div className="proposal-diff">{head('')}<p className="change-inline">{c.head}{c.removed&&<s className="change-old">{c.removed}</s>}{c.added&&<mark className="diff-mark">{c.added}</mark>}{c.tail}</p></div>;
}
function FieldChange({label,before,after}){
 const rows=proposalRows(asLines(before),asLines(after)).filter(r=>r.kind!=='same');
 // 事实证据 lines are “项 · 状态 / 证据 / 没做到的原因”: name the item once, then one line per part.
 const split=rows.map(r=>{const t=itemTitle(r.before??r.after),i=t.lastIndexOf(' · ');return i>0?{item:t.slice(0,i),part:t.slice(i+3)}:null;});
 if(rows.length&&split.every(Boolean)){const groups=[];rows.forEach((r,i)=>{const g=groups.at(-1);if(g?.item===split[i].item)g.rows.push([r,split[i].part]);else groups.push({item:split[i].item,rows:[[r,split[i].part]]});});
  return <>{groups.map((g,i)=><div key={i} className="proposal-diff-group"><small className="proposal-field">{label} · {g.item}</small>{g.rows.map(([r,p],j)=><ChangeRow key={j} label={label} row={r} part={p}/>)}</div>)}</>;}
 return <>{rows.map((r,i)=><ChangeRow key={i} label={label} row={r}/>)}</>;
}
// The header names what changes: 改 标题、成果、验收（+2 条）.
const fieldNote=(label,before,after)=>{const rows=proposalRows(asLines(before),asLines(after)),add=rows.filter(r=>r.kind==='added').length,del=rows.filter(r=>r.kind==='removed').length,extra=[add&&`+${add} 条`,del&&`−${del} 条`].filter(Boolean).join(' ');return extra?`${label}（${extra}）`:label;};
// 新增 / 撤掉 / 恢复 Mission (陈溪南 2026-10-22): same card, same two answers; the body says which Mission and what comes with it.
const opLabel={'add-mission':'新增 Mission','withdraw-mission':'撤掉 Mission','restore-mission':'恢复 Mission'};
const md=t=>String(t||'').replace(/(\d{4})-(\d{2})-(\d{2})/g,'$2/$3').replace(/^(\d{2}\/\d{2})—/,'$1—');
// The title already names the Mission; the body gives what someone needs to say yes: who, when, the result, the bar, the Tasks.
function MissionChange({proposal}){
 if(proposal.op==='add-mission'){const m=proposal.mission||{},tasks=m.tasks||[];
  return <div className="proposal-mission">
   <div className="proposal-diff"><small className="proposal-field">{[m.tier,m.owner,md(m.time)].filter(Boolean).join(' · ')}</small><p className="change-now">{stripMarks(m.result)}</p></div>
   {(m.checks||[]).length>0&&<div className="proposal-diff"><small className="proposal-field">验收</small>{m.checks.map((c,i)=><p key={i} className="change-now">{stripMarks(c)}</p>)}</div>}
   {tasks.length>0&&<div className="proposal-diff"><small className="proposal-field">Task 草稿 · {tasks.length}</small>{tasks.map((t,i)=><p key={i} className="change-now">{stripMarks(t.title)}<span className="proposal-mission-meta"> · {t.owner} · {md(t.time)}</span></p>)}</div>}
  </div>;}
 const m=proposal.missionSummary||{},withdraw=proposal.op==='withdraw-mission';
 return <div className="proposal-mission"><div className="proposal-diff"><small className="proposal-field">{[m.tier,m.owner].filter(Boolean).join(' · ')}</small><p className="change-now">下面 {m.tasks??0} 个 Task {withdraw?'一起撤掉，数据保留，需要时可以在群里 @Nexus 恢复':'一起恢复，确认状态和撤掉前一样'}。</p></div></div>;
}
// On a PO the unit plan's gates are the 里程碑; when both lists change, show them once.
const fieldLabel=(level,key)=>level==='po'&&key==='logic'?'里程碑':documentFieldLabel(level,key);
const shownFields=patch=>Object.entries(patch).filter(([key])=>!(key==='milestones'&&'logic' in patch));
// Only the changes and the two answers; who decides is in the header, the reason is in the group (陈溪南 2026-10-19).
// Two answers only, 确认 or 拒绝; 拒绝 asks why, and the reason goes to the group for everyone and Nexus (陈溪南 2026-10-19).
const shortTime=iso=>{const t=new Date(iso);return Number.isNaN(t.getTime())?'':t.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});};
// The card's title says what changes in one sentence; the old "接受后需双方重新确认" tail is the handshake's job.
// Older cards wrote who asked; the title only states what changed (陈溪南 2026-10-22).
const headline=t=>String(t||'').replace(/\s*(\[E\d+\])+/g,'').replace(/[；;，,。]?\s*接受后需[^。]*。?$/,'').replace(/^(负责人批注|负责人报告)[：:]\s*/,'').replace(/^[^，。；：:]{0,12}?(要求|提出|建议|指出|明确要求)[，,]?\s*(在|把|将)?/,'').split('。')[0].replace(/[；;，,]\s*(只改|其他|其余|原其他|原三条|原样)[^。]*$/,'').replace(/[；;，,]\s*[^；;，,。]*(保持不变|不变)。?$/,'').replace(/[。；;，,]$/,'').trim();
// A task card (陈溪南 2026-10-22): a header that says what this is and where it stands (its colour is the state),
// a one-sentence title of the change, the changes themselves, and the two answers at the bottom.
export default function ProposalCard({proposal,node,onAction,onOpen,compact=false}){
 const [busy,setBusy]=useState(false),[rejecting,setRejecting]=useState(null),[showAll,setShowAll]=useState(false);
 async function handle(type,extra){if(busy)return;setBusy(true);try{await onAction({type,cardId:proposal.cardId,proposalId:proposal.id,...(extra||{})});setRejecting(null);}finally{setBusy(false);}}
 const reviewer=proposal.reviewerName||node?.owner||'成果负责人';
 const ref=node?.referenceLabel||'当前文档',refText=ref;
 const refButton=onOpen&&!compact?<button type="button" className="proposal-head-ref" title={node?.title} onClick={()=>onOpen(proposal.cardId)}>{refText}</button>:<span className="proposal-head-ref" title={node?.title}>{refText}</span>;
 const shownPatch=proposal.edited&&proposal.acceptedPatch?proposal.acceptedPatch:proposal.patch;
 // A verdict change has its own line on top: from → to, who raised it, on what basis (M2 2026-10-22).
 const vc=proposal.verdictChange,vcWho=vc?(vc.by||[]).map(id=>memberProfiles[id]?.name||id).join('、'):'';
 const verdictLine=vc&&<div className="proposal-diff proposal-verdict"><small className="proposal-field">判定</small><p className="change-pair"><s className="change-old">{vc.from}</s><span className="change-arrow">→</span><mark className="diff-mark">{vc.to}</mark></p>{(vcWho||vc.basis)&&<p className="proposal-verdict-who">{vcWho&&`${vcWho} 提出`}{vcWho&&vc.basis?' · ':''}{vc.basis&&`依据：${stripMarks(vc.basis)}`}</p>}</div>;
 const fields=shownFields(shownPatch||{}).filter(([key])=>!(vc&&key==='verdict')),label=key=>fieldLabel(node?.level,key);
 // At most three fields open; the rest fold into one line that names them.
 const open=showAll?fields:fields.slice(0,3),folded=fields.slice(open.length);
 const changes=proposal.op?<MissionChange proposal={proposal}/>:<>{verdictLine}{open.map(([key,value])=><FieldChange key={key} label={label(key)} before={proposal.before?.[key]} after={value}/>)}{folded.length>0&&<button type="button" className="proposal-more" onClick={()=>setShowAll(true)}>还改了 {folded.map(([key])=>label(key)).join('、')} · 展开</button>}</>;
 const notes=fields.map(([key,value])=>fieldNote(label(key),proposal.before?.[key],value));
 const title=proposal.op==='add-mission'?`新增「${proposal.mission?.title||''}」`:proposal.op?`${proposal.op==='withdraw-mission'?'撤掉':'恢复'}「${proposal.missionSummary?.title||proposal.missionId}」`:headline(proposal.reason)||`改 ${notes.slice(0,3).join('、')}`;
 // Once the card moved on, the old proposal is an archive for tracing, not something to act on.
 const state=proposal.status==='superseded'||proposal.status==='pending'&&proposal.stale?'archived':proposal.status==='pending'?'pending':proposal.status==='accepted'?'accepted':'rejected';
 const when=proposal.handledAt?shortTime(proposal.handledAt):'';
 const Icon=state==='accepted'?CheckCircle2:state==='rejected'?X:Pencil;
 // One short header: the state on the left, who and when on the right (陈溪南 2026-10-22: no card name, no icon up here).
 const head={pending:`待 ${reviewer} 确认`,accepted:`已修改${proposal.resultVersion?` · v${proposal.resultVersion}`:''}`,rejected:'未采用',archived:'已归档'}[state];
 const who=state==='pending'||state==='archived'?'':`${String(reviewer).split(/[、,，]/)[0]}${when?' '+when.replace(/^\d+\/\d+\s*/,''):''}`;
 const card=<section id={compact?undefined:'proposal-'+proposal.id} className={`${compact?'island-proposal-card':'revision-message-card'} proposal-task is-${state}`} aria-label={`Nexus 修订卡 · ${head}`}>
  <div className="proposal-head"><strong>{head}</strong>{who&&<span className="proposal-head-who">{who}</span>}</div>
  <div className="proposal-body">
   <p className="proposal-title">{title}</p>
   {state==='rejected'&&proposal.rejectReason&&<p className="proposal-reason">理由：{proposal.rejectReason}</p>}
   {state==='pending'&&changes}
   <p className="proposal-card-ref">{refButton}</p>
  </div>
  {state==='pending'?proposal.canAccept?(rejecting!=null?<div className="proposal-foot proposal-reject-form">
   <textarea autoFocus rows={3} value={rejecting} placeholder="说说为什么不采用、想怎么改。群里的人和 Nexus 都会看到，Nexus 会按你的意思再出一版。" aria-label="不采用的理由" onChange={e=>setRejecting(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setRejecting(null);return;}enterSubmit(e,()=>handle('rejectProposal',{reason:rejecting.trim()}),!busy&&!!rejecting.trim());}} title="回车发送，Shift＋回车换行"/>
   <div className="proposal-actions"><Button className="proposal-confirm" isDisabled={busy||!rejecting.trim()} onPress={()=>handle('rejectProposal',{reason:rejecting.trim()})}>{busy?'发送中…':'发送理由'}</Button><Button className="proposal-reject" isDisabled={busy} onPress={()=>setRejecting(null)}>取消</Button></div>
  </div>:<div className="proposal-foot proposal-actions">
   <Button className="proposal-confirm" isDisabled={busy} onPress={()=>handle('acceptProposal')}>{busy?'处理中…':'确认修改'}</Button>
   <Button className="proposal-reject" isDisabled={busy} onPress={()=>setRejecting('')}>不采用</Button>
  </div>):null:<details className="proposal-foot proposal-handled"><summary>{state==='accepted'?'查看改动':'查看原建议'}</summary>{changes}</details>}
 </section>;
 return compact?card:<div className="message nexus-revision-message"><span className="avatar nexus-avatar"><NexusOrb/></span><div><small>Nexus</small>{card}</div></div>;
}
