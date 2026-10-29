import MarkdownTransfer from './MarkdownTransfer.jsx';
import {m2Fetch as fetch} from './deployment-client.mjs';
import React,{useState,useEffect,useRef,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Button} from '@heroui/react';
import {ArrowLeft,ChevronDown,ChevronRight,MessageCircle,X,Check,Paperclip,Sparkles} from 'lucide-react';
import {profiles,isMine,visibleUnits,canHandshake,hasHandshake,defaultExpanded,viewContext,allNodes} from './domain.mjs';
import NexusIsland,{NexusOrb} from './NexusIsland.jsx';
import DocumentCanvas,{DocPath} from './DocumentCanvas.jsx';
import {GanttCanvas} from './PlanTimeline.jsx';
import TodoPanel from './TodoPanel.jsx';
import RoundStatusBar from './RoundStatusBar.jsx';
import {todoItems,unreadCount,upstreamKey,nexusAddressed,privateQuote} from './todo.mjs';
import ActivityGenerator from './ActivityGenerator.jsx';
import RevisionOverlay from './RevisionOverlay.jsx';
import {documentDepth,nodePath} from './document-navigation.mjs';
import ChatComposer from './ChatComposer.jsx';
import MemberAvatar from './MemberAvatar.jsx';
import BotAvatar from './BotAvatar.jsx';
import ChatMessage from './ChatMessage.jsx';
import {readChatStream} from './chat-stream.mjs';
import Handshake from './Handshake.jsx';
import UpstreamNotice from './UpstreamNotice.jsx';
import RoundPanel from './RoundPanel.jsx';
import GenerationCanvas from './GenerationCanvas.jsx';
import AdminPanel,{RoundControls} from './AdminPanel.jsx';
import GroupMembers from './GroupMembers.jsx';
import EntryMetadata from './EntryMetadata.jsx';
import {enterSubmit} from './enter-submit.mjs';
import {fieldCommentTarget,fieldCommentAction} from './field-comment.mjs';
import {ownerName} from './owner-name.mjs';
import {ownerNames} from './review-display.mjs';
import ProposalCard from './ProposalCard.jsx';
import DiscussionMinutes from './DiscussionMinutes.jsx';
import {memberProfiles} from './member-profiles.mjs';
const entryProfiles={...profiles,...memberProfiles};
import DocumentContent,{setCommentSeen} from './DocumentContent.jsx';
import {documentFieldLabel} from './document-template.mjs';
import {planLabels,orderPlanUnits} from './plan-labels.mjs';

import ReviewEditor from './ReviewEditor.jsx';
import {canPreviewRevise,draftRevision,applyNexusProposals,reviewFields} from './review-workflow.mjs';
import ReviewCanvas from './ReviewCanvas.jsx';
import {reviewTree,isReviewId,reviewLabel,reviewTodos,reviewSlots,maySign} from './review-display.mjs';
import {TodoMenu} from './TodoPanel.jsx';
import {levelTone} from './document-navigation.mjs';
import {monthOf,nextPeriod} from './review-display.mjs';
import './style.css';
const types={po:'PO',mission:'Mission',task:'Task',activity:'Activity'};
// The group guide follows the stage: month-end starts with the review, the plan comes after the CEO confirms it.
// The personal room says what it is for (陈溪南 2026-10-27).
const personGuide=`这里是你的个人复盘对话，只有你、你的 Agent 和我。\n\n1. 对哪一条有不同看法，直接说或在卡上批注，最好带上证据；你的 Agent 可以帮你找。\n2. 我会站在公司的角度按证据判断：成立就出修订卡，由你决定；不成立我会说还缺什么。\n3. 内容定了，在每张卡底部点确认，卡片右上角写着截止时间。`;
const nexusGuide=(stage,{from,to})=>stage==='review'?`我是 Nexus，负责整理大家的讨论、提出修订建议。现在先做 ${from}复盘，这样走：\n\n1. 先看自己负责的复盘，有疑问就在字段上批注；下期输入里问到你的，直接点“回答”。\n2. 在“分析洞察”里写下你看到的共性问题和建议，确认前每人至少一条。\n3. 在规划群里讨论，需要我总结或出修订时 @Nexus。\n4. 内容定了，在卡片底部点确认，卡片右上角写着截止时间。复盘都确认后，CEO 确认公司复盘，就开始生成${to}拆解。`:`我是 Nexus，负责整理大家的讨论、提出修订建议。${to}拆解这样走：\n\n1. 先看自己负责的卡，有疑问就在字段上批注（鼠标移到字段上会出现批注按钮）。\n2. 在规划群里讨论，需要我总结或出修订时 @Nexus。\n3. 内容定了，在卡片底部点确认；上下级都确认，就达成共识。`;
function App(){
 const [listening,setListening]=useState(true),[topics,setTopics]=useState({}),[nexusTick,setNexusTick]=useState(0),[updated,setUpdated]=useState([]);
 const recordsRef=useRef({}),draftsRef=useRef({}),processed=useRef({}),nexusFlight=useRef(null),listenRef=useRef(true);
 const [canvasView,setCanvasView]=useState('document'),[commentAnchor,setCommentAnchor]=useState(null);
 const viewPositions=useRef({}),navigation=useRef([]),restorePosition=useRef(null);
 function rememberPage(){navigation.current.push({view:canvasView,detail,scope,selected,tab,expanded:new Set(expanded),x:scroll.current?.scrollLeft||0,y:scroll.current?.scrollTop||0});}
 function back(){if(!leaveDocument())return;const previous=navigation.current.pop();if(previous){restorePosition.current={x:previous.x,y:previous.y};setCanvasView(previous.view);setDetail(previous.detail);setScope(previous.scope);setSelected(previous.selected);setExpanded(previous.expanded);setCommentAnchor(null);setTab(previous.scope?previous.tab||'agent':'agent');}else if(scope){setScope(null);setDetail(null);setSelected(null);setTab('agent');}else if(data?.session?.homeHref){window.location.assign(data.session.homeHref);}else{const url=new URL(window.location.href);url.searchParams.delete('member');window.history.replaceState(null,'',url.href);setRole(null);}}
 const [data,setData]=useState(null),[role,setRole]=useState(null),[expanded,setExpanded]=useState(new Set()),[scope,setScope]=useState(null),[mine,setMine]=useState(false),[search,setSearch]=useState(''),[tab,setTab]=useState('agent'),[detail,setDetail]=useState(null),[selected,setSelected]=useState(null),[text,setText]=useState(''),[typing,setTyping]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[records,setRecords]=useState({}),[comments,setComments]=useState({}),[comment,setComment]=useState(''),[drafts,setDrafts]=useState({}),[revision,setRevision]=useState(''),[evidence,setEvidence]=useState(false),[recording,setRecording]=useState(false);
 const [nexusBusy,setNexusBusy]=useState(false);
 const [pendingAgent,setPendingAgent]=useState(null);
 const [roundJob,setRoundJob]=useState(undefined);
 const completedJob=useRef(null),roundRunning=useRef(false),actionCursor=useRef(0),badgePress=useRef(0);
 // The first press switches tabs and re-renders the badge, so the browser never sees a dblclick: time the two presses here.
 const restartFlight=useRef(false);
 const [restartPending,setRestartPending]=useState(false),[confirmRestart,setConfirmRestart]=useState(false);
 // Background polls fail when the server briefly restarts; show a notice that clears itself, not a sticky error.
 const [offline,setOffline]=useState(false);
 const [ganttAllOpen,setGanttAllOpen]=useState(false);
 // Each conversation keeps its own unsent draft, so text written to the private Agent never goes to the group by accident.
 const draftRoom=tab==='agent'?`private:${role}`:`group:${scope}`,roomDrafts=useRef({}),draftRoomRef=useRef(draftRoom);
 useEffect(()=>{if(draftRoomRef.current===draftRoom)return;roomDrafts.current[draftRoomRef.current]=text;setText(roomDrafts.current[draftRoom]||'');draftRoomRef.current=draftRoom;},[draftRoom]);
 // One error toast that clears itself; a stale message must not sit under every later action.
 useEffect(()=>{if(!error)return;const t=setTimeout(()=>setError(''),6000);return()=>clearTimeout(t);},[error]);
 // What this member has already seen (per browser): drives unread counts and the "待我处理" list.
 const [seen,setSeen]=useState({}),[guideSeen,setGuideSeen]=useState(true);
 const guideKey=()=>(stage==='review'?'m2-guide-review:':'m2-guide:')+role,closeGuide=()=>{setGuideSeen(true);try{localStorage.setItem(guideKey(),'1');}catch{}};
 useEffect(()=>{if(!role)return;try{setSeen(JSON.parse(localStorage.getItem('m2-seen:'+role)||'{}'));}catch{setSeen({});}},[role]);
 const markSeen=key=>setSeen(old=>{const next={...old,[key]:Date.now()};try{localStorage.setItem('m2-seen:'+role,JSON.stringify(next));}catch{}return next;});
 const openRoomLength=tab==='group'&&scope?(records['group:'+scope]||[]).length:-1,openCardComments=detail?(comments[detail.id]||[]).length:-1;
 useEffect(()=>{if(role&&openRoomLength>=0){markSeen('group:'+scope);markNotice(['mention:'+scope]);}},[role,scope,openRoomLength]);
 // Unread comment bubbles compare with when I last looked at this card before opening it now.
 const [cardSeenBefore,setCardSeenBefore]=useState({id:null,at:0});
 if(detail&&cardSeenBefore.id!==detail.id)setCardSeenBefore({id:detail.id,at:seen['card:'+detail.id]||0});
 setCommentSeen(cardSeenBefore);
 useEffect(()=>{if(role&&detail){markSeen('card:'+detail.id);if(openCardComments>0&&myCard(detail.id))markNotice(['comments']);}},[role,detail?.id,openCardComments]);
 // Opening a card flagged by an upper revision (and its Tasks) clears the red "待你处理" for that change.
 useEffect(()=>{if(!role||!detail)return;const live=allNodes(data.units).find(n=>n.id===detail.id);for(const n of [live,...(live?.children||[])])if(upstreamKey(n))markSeen(upstreamKey(n));},[role,detail?.id]);
 // Resume or load the next round straight from the status bar (only the CEO may start rounds).
 async function roundCall(path,body){setError('');try{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||'操作失败，请重试');if(v.id||v.status)setRoundJob(old=>({...old,...v}));}catch(e){setError(e.message);}}
 const roundActor=()=>role&&(entryProfiles[role]?.ceo||data?.canRunRounds)?role:'member-01';
 const resumeRound=()=>roundCall('/api/rounds',{memberId:roundActor(),resume:true,sourceMode:'ontology',autoActivate:true});
 const loadRound=()=>roundCall('/api/rounds/activate',{memberId:roundActor(),jobId:roundJob?.id});
 async function restartRound(){if(restartFlight.current||roundJob?.status==='running')return;setConfirmRestart(false);restartFlight.current=true;setRestartPending(true);setError('');try{const r=await fetch('/api/rounds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:'member-01',sourceMode:'ontology',autoActivate:true})});const value=await r.json();if(!r.ok)throw Error(value.error);setRoundJob({...value,stage:'准备实时读取本体并核对来源'});}catch(e){setError(e.message);}finally{restartFlight.current=false;setRestartPending(false);}}
 useEffect(()=>{let active=true;const poll=async()=>{try{const r=await fetch('/api/rounds');if(!r.ok)throw Error('无法读取生成状态，请刷新重试');const value=await r.json();if(!active)return;setOffline(false);setRoundJob(value.job);roundRunning.current=value.job?.status==='running'||value.auditJob?.status==='running';if(value.job?.status==='activated'&&completedJob.current!==value.job.id){const d=await fetch('/api/data');if(d.ok&&active){setData(await d.json());completedJob.current=value.job.id;}}}catch{if(active)setOffline(true);}};let timer;const loop=async()=>{await poll();if(active)timer=setTimeout(loop,roundRunning.current?1500:10000);};loop();return()=>{active=false;clearTimeout(timer);};},[]);
 const [canvasRevision,setCanvasRevision]=useState(null);
 const revisionFlight=useRef(null),revisionTimer=useRef(null),seenAccepted=useRef(null);
 useEffect(()=>()=>clearTimeout(revisionTimer.current),[]);
 function showRevision(value){clearTimeout(revisionTimer.current);setCanvasRevision(value);if(!['saving','presenting'].includes(value.phase))revisionTimer.current=setTimeout(()=>setCanvasRevision(current=>current?.token===value.token?null:current),value.phase==='failed'?2600:2600);}
 // Nexus at work stays on screen long enough to be seen working (陈溪南 2026-10-27): about 3 s working, then 2.6 s 已更新.
 function finishRevision(value){showRevision({...value,phase:'presenting'});revisionTimer.current=setTimeout(()=>showRevision({...value,phase:'done'}),Math.max(0,3000-(performance.now()-(value.started||performance.now()))));}
 function observeRevisions(value){
  const accepted=Object.values(value.records||{}).flat().filter(m=>m.kind==='revision-proposal'&&m.status==='accepted');
  const next=new Set(accepted.map(m=>m.id));
  if(seenAccepted.current&& !revisionFlight.current){const recent=accepted.filter(m=>!seenAccepted.current.has(m.id)).at(-1);if(recent)finishRevision({token:recent.id,cardId:recent.cardId,fields:Object.keys(recent.patch),version:recent.resultVersion});}
  seenAccepted.current=next;
 }
 const [groupView,setGroupView]=useState('chat');
 useEffect(()=>{seenAccepted.current=null;revisionFlight.current=null;clearTimeout(revisionTimer.current);setCanvasRevision(null);},[role,data?.roundId]);
 useEffect(()=>{if(sharedSequence.current>=0)observeRevisions({records});},[records]);
 const [replyTarget,setReplyTarget]=useState(null);
 useEffect(()=>setReplyTarget(null),[scope,role,data?.roundId]);
 useEffect(()=>{setGroupView('chat');if(!scope)setTab('agent');},[scope,role,data?.roundId]);
 const [docDirty,setDocDirty]=useState(false);
 const [documentEdit,setDocumentEdit]=useState(null);
 const [reviewActionsTarget,setReviewActionsTarget]=useState(null);
 function leaveDocument(){if((docDirty||comment.trim())&&!window.confirm('修订或批注尚未保存，确定离开这份文档吗？'))return false;setDocDirty(false);setComment('');return true;}
 const [sharedMissions,setSharedMissions]=useState(null);
 // 复盘 / 拆解 (陈溪南 2026-10-20): the same units, groups and people; the review stage has no 文档 / 甘特图 switch.
 const [stage,setStageState]=useState(()=>{try{return localStorage.getItem('m2-stage')==='review'?'review':'plan';}catch{return 'plan';}}),[reviewMeta,setReviewMeta]=useState(null),[operator,setOperator]=useState(false),[adminOpen,setAdminOpen]=useState(false),[planHandoff,setPlanHandoff]=useState(null),[notice,setNotice]=useState('');
 useEffect(()=>{if(!role)return;try{setGuideSeen(localStorage.getItem(guideKey())==='1');}catch{setGuideSeen(false);}},[role,stage]);
 // A short notice (e.g. the plan has started) that clears itself.
 useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(''),8000);return()=>clearTimeout(t);},[notice]);
 const [sharedUnits,setSharedUnits]=useState(undefined);
 const [insights,setInsights]=useState({});
 const [commentTarget,setCommentTarget]=useState(null);
 const roleRef=useRef(role);roleRef.current=role;
 const scopeRef=useRef(scope);scopeRef.current=scope;
 const [nexusErrors,setNexusErrors]=useState({});
 const sharedSequence=useRef(-1);
 const roundRef=useRef(null);
 function syncShared(value){if(value.memberId&&roleRef.current&&value.memberId!==roleRef.current){window.location.reload();return;}if(value.memberId!==roleRef.current)return;setListening(!value.pausedUnits?.includes(scopeRef.current));if(value.sequence<=sharedSequence.current)return;sharedSequence.current=value.sequence;setSharedMissions(value.missions);setSharedUnits(value.visibleUnits);setReviewMeta(value.review||null);setOperator(value.operator===true);setPlanHandoff(value.planHandoff||null);setUpdated(Object.entries(value.drafts).filter(([id,d])=>draftsRef.current[id]&&d.version>draftsRef.current[id].version&&d.history?.at(-1)?.author==='Nexus').map(([id])=>id));setDrafts(value.drafts);setComments(value.comments);setInsights(value.insights||Object.fromEntries(Object.entries(value.drafts).filter(([,d])=>d.insights).map(([id,d])=>[id,d.insights])));setRecords(value.records);setTopics(Object.fromEntries(Object.entries(value.nexus||{}).map(([id,n])=>[id,n.topics||[]])));setNexusBusy(value.nexus?.[scopeRef.current]?.running?scopeRef.current:false);setNexusErrors(Object.fromEntries(Object.entries(value.nexus||{}).map(([id,n])=>[id,n.error])));if(value.round){if(roundRef.current!==value.round.id){roundRef.current=value.round.id;navigation.current=[];setExpanded(new Set(defaultExpanded(value.round.units,{...entryProfiles[roleRef.current],units:value.visibleUnits,missions:value.missions})));setScope(null);setDetail(null);setSelected(null);}setData(old=>({...old,units:value.round.units,round:value.round.number,roundId:value.round.id,sourceTime:value.round.sourceTime,generatedAt:value.round.generatedAt,readerViews:value.round.readerViews}));}}
 async function refreshShared(){const r=await fetch('/api/collaboration?member='+encodeURIComponent(role));const value=await r.json();if(!r.ok)throw Error(value.error);syncShared(value);}
 useEffect(()=>{if(!role)return;sharedSequence.current=-1;setSharedMissions(null);setRecords({});setDrafts({});setComments({});setInsights({});let active=true;const poll=()=>document.hidden&&sharedSequence.current>=0?Promise.resolve():fetch('/api/collaboration?member='+encodeURIComponent(role)).then(r=>r.json()).then(value=>{if(active){setOffline(false);syncShared(value);}}).catch(()=>{if(active)setOffline(true);});poll();const timer=setInterval(poll,1500);return()=>{active=false;clearInterval(timer);};},[role]);
 async function action(value){
  // A 新增/撤掉/恢复 Mission card changes the tree, not a field: no field animation, the new tree arrives with the next sync.
  const accepting=value.type==='acceptProposal'&&!Object.values(recordsRef.current).flat().find(m=>m.id===value.proposalId)?.op;
  if(accepting&&revisionFlight.current)throw Error('上一处修订正在保存，请稍后');
  let animation;
  if(accepting){
   const proposal=Object.values(recordsRef.current).flat().find(m=>m.id===value.proposalId),node=allNodes(data.units).find(n=>n.id===value.cardId);
   if(canvasView==='document'&&node&&detail?.id!==node.id){if(docDirty||comment.trim())throw Error('请先保存当前编辑，再接受修订');openDetail(node);}
   if(canvasView==='gantt'&&node){setMine(false);setSearch('');setExpanded(old=>{const next=new Set(old);const find=(nodes,path=[])=>{for(const n of nodes){if(n.id===node.id)return path;const found=find(n.children,[...path,n.id]);if(found)return found;}return null;};for(const id of find(data.units)||[])next.add(id);return next;});}
   animation={token:value.proposalId,cardId:value.cardId,fields:Object.keys(proposal?.patch||{}),phase:'saving',started:performance.now()};revisionFlight.current=animation;showRevision(animation);
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const selector=canvasView==='gantt'?`[data-node="${CSS.escape(value.cardId)}"]`:`[data-block-id="${CSS.escape(value.cardId+':'+(animation.fields[0]||'title'))}"]`;
   scroll.current?.querySelector(selector)?.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
  }
  try{const r=await fetch('/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:role,roundId:data.roundId||null,action:value})});const result=await r.json();if(!r.ok)throw Error(result.error);syncShared(result);if(animation)finishRevision({...animation,version:result.drafts[value.cardId].version});return result;}
  catch(e){if(animation)showRevision({...animation,phase:'failed'});throw e;}
  finally{if(animation)revisionFlight.current=null;}
 }
 recordsRef.current=records;draftsRef.current=drafts;listenRef.current=listening;

 useEffect(()=>{if(!listening)nexusFlight.current?.abort();},[listening]);
 useEffect(()=>{if(!updated.length)return;const timer=setTimeout(()=>setUpdated([]),4000);return()=>clearTimeout(timer);},[updated]);
 useEffect(()=>()=>nexusFlight.current?.abort(),[]);
 const scroll=useRef(),speech=useRef();const p=role?{...entryProfiles[role],units:sharedUnits===undefined?entryProfiles[role].units:sharedUnits,missions:sharedMissions??entryProfiles[role].missions}:null;
 function switchView(next){if(next===canvasView)return;if(canvasView==='document'&&!leaveDocument())return;viewPositions.current[canvasView]={x:scroll.current?.scrollLeft||0,y:scroll.current?.scrollTop||0};setCanvasView(next);}
 useLayoutEffect(()=>{const pos=restorePosition.current||viewPositions.current[canvasView]||{x:0,y:0};scroll.current?.scrollTo(pos.x,pos.y);restorePosition.current=null;},[canvasView,detail?.id,scope]);
 useEffect(()=>{fetch('/api/data').then(r=>r.json()).then(setData).catch(()=>setError('数据读取失败'));return()=>speech.current?.abort();},[]);
 const lastEntry=useRef(null),commentFlight=useRef(false);
 const choose=r=>{lastEntry.current=r;setSharedMissions(null);setSharedUnits(undefined);roundRef.current=null;navigation.current=[];viewPositions.current={};restorePosition.current={x:0,y:0};setCanvasView('document');setRole(r);setExpanded(new Set(defaultExpanded(data.units,entryProfiles[r])));setScope(null);setSelected(null);setTab('agent');setMine(!entryProfiles[r].ceo&&r!=='ceo');setDetail(null);setError('');};
 const openedMember=useRef(false);
 // Links from Tianshu's notification centre (2026-10-26): ?stage, todo, card, scope+message, card+comment, admin. Read once, then
 // dropped from the address bar so a refresh does not jump again. Anything that does not resolve is ignored.
 const deepLink=useRef(undefined);
 if(deepLink.current===undefined)deepLink.current=(()=>{try{const q=new URLSearchParams(window.location.search),keys=['stage','todo','card','scope','message','comment','admin'],v={};for(const k of keys){const x=q.get(k);if(x)v[k]=x.slice(0,200);q.delete(k);}if(!Object.keys(v).length)return null;const rest=q.toString();window.history.replaceState(window.history.state,'',window.location.pathname+(rest?'?'+rest:'')+window.location.hash);return v;}catch{return null;}})();
 const [todoOpenKey,setTodoOpenKey]=useState(0);
 // Read marks for the notification centre; failures are silent, the page works the same without them.
 const noticeMarks=useRef({});
 const markNotice=list=>{if(!memberProfiles[role])return;const now=Date.now(),ids=list.filter(id=>now-(noticeMarks.current[role+'|'+id]||0)>3000);if(!ids.length)return;for(const id of ids)noticeMarks.current[role+'|'+id]=now;fetch('/api/notifications/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:role,ids})}).catch(()=>{});};
 useEffect(()=>{if(!data||openedMember.current)return;openedMember.current=true;const member=data.session?.memberId;if(memberProfiles[member])choose(member);},[data]);
 function openMember(member){const url=new URL(window.location.href);url.searchParams.set('member',member);window.open(url.href,'_blank','noopener,noreferrer');}
 const enter=u=>{if(canvasView==='document'){openDetail(u);return;}rememberPage();restorePosition.current={x:0,y:0};setScope(u.id);setExpanded(new Set([u.id]));setSelected(u);setDetail(null);};
 // Gantt rows open and close independently, so two Missions can be compared side by side.
 // From a card's Plan to the same rows on the Gantt canvas: open the path, keep it visible, scroll to it.
 function showInGantt(node){const path=nodePath(data.units,node.id);if(mine&&!hasHandshake(node,p)&&!path.some(n=>canHandshake(n,p)))setMine(false);setExpanded(old=>new Set([...old,...path.map(n=>n.id)]));switchView('gantt');setTimeout(()=>{const row=document.querySelector(`[data-gantt-node="${CSS.escape(node.id)}"]`);if(!row)return;row.scrollIntoView({block:'center'});row.classList.add('gantt-focus');setTimeout(()=>row.classList.remove('gantt-focus'),1600);},80);}
 const toggleRow=n=>setExpanded(old=>{const next=new Set(old);if(next.has(n.id))next.delete(n.id);else next.add(n.id);return next;});

 // 公司复盘 has its own group like every unit, with the CEO and Nexus in it (陈溪南 2026-10-22: one architecture;
 // Nexus revises in a group, not inside someone's private Agent).
 const room=tab==='agent'?`private:${role}`:`group:${scope}`;const messages=records[room]||[];
 useEffect(()=>{if(!pendingAgent&&!nexusBusy)return;const frame=requestAnimationFrame(()=>document.querySelector('.messages .message-thinking')?.scrollIntoView({block:'nearest'}));return()=>cancelAnimationFrame(frame);},[pendingAgent,nexusBusy]);
 const push=(key,m)=>action(key.startsWith('group:')?{type:'message',cardId:key.slice(6),text:m.text}:{type:'privateMessage',text:m.text}).catch(e=>setError(e.message));
 async function send(value=text,channel=tab){if(!value.trim()||busy===channel)return;// The composer sends the trimmed text (plus any attachment), so a trailing space after an @name used to leave the box full.
 const typed=text.trim();if(value===text||typed&&(value===typed||value.startsWith(typed+'\n\n')))setText('');setError('');const ctx=viewContext(role,scope,selected?display(selected):null,expanded,{x:scroll.current?.scrollLeft||0,y:scroll.current?.scrollTop||0});ctx.canvasView=canvasView;ctx.candidate=selected?display(selected):null;
  if(channel==='agent')setPendingAgent({room:`private:${role}`,lastAgentId:(records[`private:${role}`]||[]).filter(m=>m.author==='Agent').at(-1)?.id});
  setBusy(channel);try{// A group line carries the card open on the page, so “这个判定” has a subject (M2 2026-10-22). The company room's card is rv:company.
 if(channel==='group'){const open=detail&&drafts[detail.id]?{id:detail.id}:undefined;await action({type:'message',cardId:scope==='company'?'rv:company':String(scope).startsWith('person:')?'rv:person:'+p.name:scope,text:value,replyTo:replyTarget?.id,general:!replyTarget,...(open?{viewing:open}:{})});setReplyTarget(null);return;}const r=await fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:role,text:value,context:ctx,stream:true})});await readChatStream(r,text=>setPendingAgent(old=>old?{...old,text}:old));await refreshShared();}catch(e){setError(e.message);setText(value);}finally{setBusy(b=>b===channel?false:b);if(channel==='agent')setPendingAgent(null);}
 }
 async function analyzePublic(target=scope,manual=true){if(!target||nexusFlight.current)return;const controller=new AbortController();nexusFlight.current=controller;setNexusBusy(target);setError('');const key='group:'+target;processed.current[key]=(recordsRef.current[key]||[]).filter(m=>m.author!=='Nexus').at(-1)?.id;try{const r=await fetch('/api/nexus',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:role,text:'核对公开讨论与批注，识别共识和待决问题，必要时更新候选。',trigger:manual?'manual':'automatic',context:{scope:target}})});const value=await r.json();if(!r.ok)throw Error(value.error);syncShared(value.collaboration);setTopics(old=>({...old,[target]:value.topics||[]}));setUpdated(value.applied||[]);}catch(e){if(e.name!=='AbortError')setError(e.message);}finally{nexusFlight.current=null;setNexusBusy(false);setNexusTick(x=>x+1);}}
 function voice(){if(recording){speech.current?.stop();setRecording(false);return;}const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){setTyping(true);setError('此浏览器不支持语音转写，请使用文字输入。');return;}const s=new SR();speech.current=s;s.lang='zh-CN';s.continuous=false;s.onresult=e=>{setText(e.results[0][0].transcript);setTyping(true);};s.onend=()=>setRecording(false);s.onerror=()=>{setRecording(false);setError('语音未能启动，请检查麦克风权限。');};s.start();setRecording(true);}
 function openDetail(n,block=null){if(detail?.id!==n.id&&!leaveDocument())return;if({po:0,mission:1,task:2,activity:3}[n.level]>documentDepth(p,n)){setError('当前视角在 Mission 层查看与反馈。');return;}if(canvasView!=='document'||detail?.id!==n.id)rememberPage();restorePosition.current={x:0,y:0};setCanvasView('document');
 // Entering a unit opens its group first: that is where the work happens (陈溪南 2026-10-22). The company review has no group.
 // A 个人复盘 spans units, so it has no group of its own: the private Agent sits beside it.
 if(n.level==='person'){const own=n.person===p.name||n.person==='未指派';setTab(own?'group':'agent');setGroupView('chat');setScope(own?'person:'+role:null);setDetail({...n,children:n.children||[]});setSelected(null);setCommentAnchor(null);setComment('');setCommentTarget(null);return;}
 const room=n.level==='mission'&&isReviewId(n.id)&&ownerNames(n).includes(p.name)?'person:'+role:(n.unit||n.id);
 if(room!==scope){setTab('group');setGroupView('chat');}
 setScope(room);setDetail(n);setSelected(n);setCommentAnchor(block==='card'?'title':block);setComment('');setCommentTarget(null);}
 useEffect(()=>{if(!detail||!commentAnchor)return;let target,timer;const frame=requestAnimationFrame(()=>{target=document.querySelector('[data-block-id="'+(commentTarget?.id||detail.id)+':'+commentAnchor+'"]');if(target){target=target.closest('.review-item')||target.closest('tr')||target;target.scrollIntoView({block:'center',behavior:'smooth'});target.classList.add('comment-anchor-highlight');timer=setTimeout(()=>target?.classList.remove('comment-anchor-highlight'),1800);}});return()=>{cancelAnimationFrame(frame);clearTimeout(timer);target?.classList.remove('comment-anchor-highlight');};},[detail?.id,commentTarget?.id,commentAnchor]);
 const orderedUnits=orderPlanUnits(data?.units||[]);
 const labels=planLabels(orderedUnits);
 const reviews=reviewTree(drafts,orderedUnits.map(u=>u.id)),unitLabel=n=>n.unit==='company'?'公司':labels.get(n.unit)?.planLabel||n.unit;
 function setStage(next){if(next===stage)return;if(detail&&!leaveDocument())return;try{localStorage.setItem('m2-stage',next);}catch{}navigation.current=[];setStageState(next);setDetail(null);setSelected(null);setScope(null);setCommentAnchor(null);setCanvasView('document');setTab('agent');}
 function openReview(n,block=null){openDetail({...n,level:n.level==='company'?'po':n.level,unit:n.unit});if(block)setTimeout(()=>document.querySelector(`[data-block-id="${n.id}:${block}"]`)?.scrollIntoView({block:'center',behavior:'smooth'}),200);}
 function goReviewProposal(n,id){openReview(n);setTab(n.unit==='company'?'agent':'group');setGroupView('chat');setTimeout(()=>document.getElementById('proposal-'+id)?.scrollIntoView({block:'center',behavior:'smooth'}),300);}
 const reviewSigners=n=>({ceo:Object.values(memberProfiles).find(m=>m.ceo)?.name||'CEO',unitDri:data.units.find(u=>u.id===n.unit)?.owner||'领域 DRI',missionDri:n.owner});
 async function answerAsk(n,index,ask,text,block='causes'){await action({type:'comment',cardId:n.id,baseVersion:n.version,block,text:`回答「${ask}」：${text}`,answers:{index}});if(n.unit!=='company'){setTab('group');setGroupView('chat');}}
 // One 待我处理 for both stages, in the title row.
 const unitMembers=(()=>{if(!scope||!data)return [];
   if(String(scope).startsWith('person:'))return [{name:p.name,roles:['本人']},{name:`${p.name}的 Agent`,roles:['帮你找证据、把意见说清楚'],agent:true},{name:'Nexus',roles:['站在公司角度中立判断，出修订卡'],nexus:true}];const roles=new Map(),add=(name,role,limited=false)=>{for(const n of String(name||'').split(/[、,，\s]+/).filter(Boolean)){const m=roles.get(n)||{name:n,roles:[],limited:true};if(!m.roles.includes(role))m.roles.push(role);m.limited=m.limited&&limited;roles.set(n,m);}};
   const ceo=Object.values(memberProfiles).find(m=>m.ceo)?.name;if(ceo)add(ceo,'CEO');
   if(scope==='company'){for(const u of data.units)add(u.owner,`${labels.get(u.id)?.planLabel||u.title} DRI`);}
   else{const unit=data.units.find(u=>u.id===scope);add(unit?.owner||drafts['rv:'+scope]?.owner,'单元 DRI');
    const missions=Object.entries(drafts).filter(([id,d])=>id.startsWith('rv:'+scope+'-m')&&d.level==='mission'&&d.ownerAssigned!==false);
    for(const [,d] of missions)add(d.owner,`${reviewLabel(d)} 负责人`);
    if(!missions.length)for(const n of allNodes(data.units).filter(n=>n.level==='mission'&&String(n.id).startsWith(scope+'-')))add(n.owner,`${n.referenceLabel||'Mission'} 负责人`);
    for(const [id,d] of Object.entries(drafts).filter(([id])=>id===('rv:'+scope)||id.startsWith('rv:'+scope+'-m')))for(const x of d.nextInputs||[])if(x.ask?.to)add(x.ask.to,`被提问 · 只看 ${d.level==='mission'?reviewLabel(d):'PO'} 复盘`,true);}
   const byNumber=(a,b)=>a.localeCompare(b,'zh',{numeric:true});
   const list=[...roles.values()].map(m=>({...m,roles:(m.limited?m.roles:m.roles.filter(r=>!r.startsWith('被提问'))).sort((a,b)=>(a==='CEO'?-1:b==='CEO'?1:byNumber(a,b)))}));
   return [...list.filter(m=>!m.limited),...list.filter(m=>m.limited),{name:'Nexus',roles:['Co-agent，整理讨论、出修订建议'],nexus:true}];})();
 const reviewProposals=Object.values(records).flat().filter(r=>r.kind==='revision-proposal');
 // No member yet (the entry page after 返回): nothing to compute for anyone.
 const reviewTodoItems=stage==='review'&&p?reviewTodos(reviews.nodes,p,comments,reviewProposals):[];
 const reviewTodoLabel=item=>{const n=reviews.byId.get(item.cardId);return n?`${n.level==='mission'?reviewLabel(n):n.level==='company'?'公司复盘':unitLabel(n)} ${n.title}${item.count>1?` · ${item.count} 条追问`:''}`:'';};
 const goReviewTodo=item=>{const n=reviews.byId.get(item.cardId);if(!n)return;if(item.kind==='proposal')return goReviewProposal(n,item.id);
 // 待提交洞察 lands in the insight box under the facts card.
 if(item.kind==='insight'){openReview(n);return setTimeout(()=>{const box=document.querySelector(`[data-insight-card="${CSS.escape(n.id)}"]`);box?.scrollIntoView({block:'center',behavior:'smooth'});const t=box?.querySelector('textarea');if(t)t.focus({preventScroll:true});else box?.querySelector('.insight-add')?.click();},300);}openReview(n,item.kind==='ask'?(item.block||'causes'):null);
 // 有人反对 opens the group at that line.
 if(item.kind==='objection'){setTab('group');setGroupView('chat');setTimeout(()=>document.querySelector(`[data-message-id="${item.id}"]`)?.scrollIntoView({block:'center',behavior:'smooth'}),300);}
 // 待你确认 lands on the handshake at the bottom of the card, not the top of the page.
 if(item.kind==='sign'||item.kind==='downstream')setTimeout(()=>{const h=document.querySelector('.handshake');h?.scrollIntoView({block:'center',behavior:'smooth'});h?.classList.add('is-pointed');setTimeout(()=>h?.classList.remove('is-pointed'),1600);},300);};
 const reviewTone=n=>n.level==='company'?'company':n.level==='mission'?'mission':levelTone(data.units.find(u=>u.id===n.unit)||{level:'po'});
 // Months come from the data: the reviewed month and the month the plan is for.
 // 拆解 opens once this month's reviews have produced it (陈溪南 2026-10-22): a plan older than the review round in play is last month's work.
 const planOpen=!reviewMeta?.loadedAt||planHandoff?.status==='generating'||roundJob?.status==='running'||String(data?.generatedAt||data?.generationTiming?.finishedAt||'')>reviewMeta.loadedAt;
 useEffect(()=>{if(!planOpen&&stage==='plan'&&reviewMeta)setStage('review');},[planOpen,stage,reviewMeta]);
 const myCard=id=>{const d=drafts[id];if(!d||!p)return false;return id.startsWith('rv:')?ownerNames(d).includes(p.name)||d.level==='company'&&p.ceo||d.level==='po'&&(p.unitDri||[]).includes(d.unit||id.slice(3)):ownerName(d.owner)===p.name||d.level==='po'&&(p.unitDri||[]).includes(id)||(p.missions||[]).includes(id);};
 // Apply the notification link once the member's cards are in. Declared before the first-visit landing so the link wins.
 useEffect(()=>{const link=deepLink.current;if(!link||!role||!data||!Object.keys(drafts).length)return;deepLink.current=null;
  try{
   if(data.roundId)try{localStorage.setItem('m2-plan-landed:'+role+':'+data.roundId,'1');}catch{}
   const pointAt=(selector,tries=12)=>{const el=document.querySelector(selector);if(el){el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.add('is-pointed');setTimeout(()=>el.classList.remove('is-pointed'),1600);}else if(tries>0)setTimeout(()=>pointAt(selector,tries-1),250);};
   const asReview=n=>({...n,level:n.level==='company'?'po':n.level,unit:n.unit});
   const go=(id,block=null)=>{const r=reviews.byId.get(id);if(r){setStage('review');openDetail(asReview(r),block);return true;}const n=findNode(id);if(n&&planOpen){setStage('plan');openDetail(n,block);return true;}return false;};
   const ids=[];
   if(link.stage==='review'||link.stage==='plan')setStage(link.stage==='plan'&&!planOpen?'review':link.stage);
   if(link.scope&&link.message&&String(link.scope).startsWith('person:')){setStage('review');openDetail({id:'rv:person:'+p.name,level:'person',person:p.name});pointAt(`[data-message-id="${CSS.escape(link.message)}"]`);ids.push('mention:'+link.scope);}
   else if(link.scope&&link.message){const first=link.stage==='plan'||stage==='plan'&&!link.stage?[link.scope,'rv:'+link.scope]:['rv:'+link.scope,link.scope];if(first.some(id=>go(id))){setTab('group');setGroupView('chat');pointAt(`[data-message-id="${CSS.escape(link.message)}"]`);ids.push('mention:'+link.scope);}}
   else if(link.card&&link.comment){const c=(comments[link.card]||[]).find(c=>c.id===link.comment);const field=c?.block&&c.block!=='card'?(Number.isInteger(c.item)?`${c.block}#${c.item}`:c.block):'title';if(go(link.card,field))ids.push('comments');}
   else if(link.todo==='1'){
     // With a card, go straight to its first to-do (the proposal, the confirm block, the question); otherwise open the list.
     const reviewItem=link.card&&reviews.byId.has(link.card)&&p?reviewTodos(reviews.nodes,p,comments,reviewProposals).find(i=>i.cardId===link.card):null;
     const planItem=link.card&&!reviewItem&&planOpen&&p?todoItems({units:data.units,drafts,records,comments,profile:p,name:p.name,seen}).find(i=>i.cardId===link.card):null;
     if(reviewItem){setStage('review');goReviewTodo(reviewItem);}else if(planItem){setStage('plan');goTodo(planItem);}else if(!(link.card&&go(link.card)))setTodoOpenKey(Date.now());}
   else if(link.card)go(link.card);
   if(link.admin==='1'&&operator)setAdminOpen(true);
   if(ids.length)markNotice(ids);
  }catch{}
 },[role,data,drafts,operator]);
 // Once the plan these reviews produced is in, the first visit lands on it (评测 2026-10-22); later visits keep the person's choice.
 useEffect(()=>{if(!planOpen||!reviewMeta?.loadedAt||!data?.roundId||!role)return;const key='m2-plan-landed:'+role+':'+data.roundId;try{if(localStorage.getItem(key))return;localStorage.setItem(key,'1');}catch{return;}if(String(data.generatedAt||data.generationTiming?.finishedAt||'')>reviewMeta.loadedAt&&stage!=='plan')setStage('plan');},[planOpen,reviewMeta,data?.roundId,role]);
 // 管理: the round controls the entry page used to hold, for the operator once members sign in directly (陈溪南 2026-10-22).
 const adminPanel=adminOpen&&operator&&<AdminPanel memberId={role} review={data?.review} onClose={()=>setAdminOpen(false)} plan={{skill:data?.skill,readAt:data?.sourceTime,generatedAt:data?.generationTiming?.finishedAt,durationMs:data?.generationTiming?.lowerBound?undefined:data?.generationTiming?.durationMs,stale:!!data?.review&&!(String(data?.generationTiming?.finishedAt||'')>String(data?.review?.loadedAt||'')),job:roundJob,pending:restartPending,onRestart:restartRound,model:[data?.generationModel?.model,data?.generationModel?.reasoningEffort].filter(Boolean).join(' · ')||undefined,currentModel:[data?.modelStatus?.model,data?.generationModel?.reasoningEffort].filter(Boolean).join(' · ')||undefined,checks:data?.auditStatus&&data.auditStatus!=='completed'&&<EntryMetadata data={data} checksOnly/>}}/>;
 const reviewMonths={from:monthOf(reviewMeta?.period)||'本月',to:monthOf(nextPeriod(reviewMeta?.period))||'下月'};
 const reviewDetail=stage==='review'&&detail&&isReviewId(detail.id)?(detail.level==='person'?detail:reviews.byId.get(detail.id)||null):null;
 const display=n=>{const value={...n,...drafts[n.id],...labels.get(n.id)};return {...value,children:(value.children||[]).map(c=>({...c,...drafts[c.id]})),humanView:null,displayTitle:value.title};};
 // A comment line in the group jumps to the very spot it was written on and lights it briefly (陈溪南 2026-10-27).
 function goComment(m){const id=m.context?.selection?.id,item=Number.isInteger(m.context?.item)?m.context.item:Number.isInteger(m.answers?.index)?m.answers.index:null,field=m.context?.block&&m.context.block!=='card'?(item!==null?`${m.context.block}#${item}`:m.context.block):'title';
  const r=reviews.byId.get(id),n=r?{...r,level:r.level==='company'?'po':r.level,unit:r.unit}:allNodes(data.units).find(x=>x.id===id);if(!n)return;if(r&&stage!=='review')setStage('review');else if(!r&&stage!=='plan')setStage('plan');
  setCommentAnchor(null);requestAnimationFrame(()=>openDetail(n,field));}
 function commentLocation(m){const level=allNodes(data.units).find(n=>n.id===m.context.selection.id)?.level||m.context.selection.level;const item=Number.isInteger(m.context.item)?` · 第 ${m.context.item+1} 条`:'',quote=m.context.quote?`「${m.context.quote.slice(0,16)}${m.context.quote.length>16?'…':''}」`:'';const rv=String(m.context.selection.id).startsWith('rv:')&&drafts[m.context.selection.id],rvName=rv?(rv.level==='company'?'公司复盘':rv.level==='po'?'PO 复盘':`${reviewLabel(rv)} 复盘`):null;return `${labels.get(m.context.selection.id)?.referenceLabel||rvName||'文档'} ${documentFieldLabel(level,m.context.block||'title')}${item}${quote}`;}
 async function saveRevision(patch,baseVersion){try{await action({type:'revise',cardId:detail.id,baseVersion,patch});return true;}catch(e){setError(e.message);return false;}}
 async function addComment(){if(!comment.trim()||commentFlight.current)return;commentFlight.current=true;try{await action(fieldCommentAction(commentTarget||fieldCommentTarget(display(detail),commentAnchor||'card'),comment));setComment('');setCommentTarget(null);setCommentAnchor(null);}catch(e){setError(e.message);}finally{commentFlight.current=false;}}
 if(!data||roundJob===undefined||(!role&&data.session?.memberId))return <div className="loading">{error||'读取计划材料与生成状态…'}</div>;
 const evidenceModal=evidence&&<div className="overlay" onClick={()=>setEvidence(false)}><section className="document round-modal" role="dialog" aria-modal="true" aria-label="新一轮拆解" onClick={e=>e.stopPropagation()}><RoundPanel entry={!role} memberId={role||lastEntry.current} ceo={!!entryProfiles[role||lastEntry.current]?.ceo||!!data.canRunRounds} onClose={()=>setEvidence(false)} info={{round:data.round,sourceTime:data.sourceTime,skill:data.skill,availableSkill:data.availableSkill,model:data.modelReady?`已配置 · ${data.modelStatus?.provider} · ${data.modelStatus?.model}`:"待配置服务地址、模型和服务器密钥"}} onActivate={async()=>{if(role)await refreshShared();else{const r=await fetch('/api/data');setData(await r.json());}setScope(null);setSelected(null);setDetail(null);setExpanded(new Set());setEvidence(false);}}/></section></div>;
function entrySummary(profile){if(roundJob?.status==='running')return '计划拆解中';if(profile.ceo)return 'CEO · 公司整体';const units=data.units.filter(u=>ownerName(u.owner)===profile.name).length,missions=allNodes(data.units).filter(n=>n.level==='mission'&&ownerName(n.owner)===profile.name).length;return `${units?`${units} 个领域 DRI · `:''}${missions} 个 Mission${missions>1?'s':''}`;}
if(!role)return <><main className="entry"><span className="eyebrow">NEXUS · M2</span><h1>词元云集 · 月度复盘与拆解</h1><RoundStatusBar job={roundJob} round={data.round} canAct onResume={resumeRound} onLoad={loadRound} onDetails={()=>setEvidence(true)}/><p>选择你的成员入口</p><div className="profiles member-profiles">{Object.entries(memberProfiles).map(([id,v])=><Button key={id} className="profile" aria-label={`以 ${v.name} 进入`} onPress={()=>openMember(id)}><MemberAvatar name={v.name} className="member-avatar"/><strong>{v.name}</strong><span>{entrySummary(v)}<ChevronRight size={18}/></span></Button>)}</div>{error&&<p role="alert">{error}</p>}{offline&&<p className="connection-notice" role="status">连接中断，正在自动重连…</p>}<section className="entry-controls" aria-label="生成"><RoundControls memberId="member-01" review={data.review} plan={{skill:data?.skill,readAt:data?.sourceTime,generatedAt:data?.generationTiming?.finishedAt,durationMs:data?.generationTiming?.lowerBound?undefined:data?.generationTiming?.durationMs,stale:!!data?.review&&!(String(data?.generationTiming?.finishedAt||'')>String(data?.review?.loadedAt||'')),job:roundJob,pending:restartPending,onRestart:restartRound,model:[data?.generationModel?.model,data?.generationModel?.reasoningEffort].filter(Boolean).join(' · ')||undefined,currentModel:[data?.modelStatus?.model,data?.generationModel?.reasoningEffort].filter(Boolean).join(' · ')||undefined,checks:data?.auditStatus&&data.auditStatus!=='completed'&&<EntryMetadata data={data} checksOnly/>}}/></section></main>{evidenceModal}{adminPanel}</>;
 // While the plan generates, the review stays readable: the switch is here too (陈溪南 2026-10-22).
 // Also while the plan handoff is generating but the run has not reported yet: never show last month's plan as if it were new (M2 2026-10-28).
 if((roundJob?.status==='running'||planHandoff?.status==='generating')&&stage!=='review')return <main className="shell"><section className="canvas"><header><a className="icon" href={data.session?.homeHref||'/'} aria-label="返回首页"><ArrowLeft size={20}/></a><h1>{`词元云集 ${reviewMonths.to}拆解`}</h1><div className="tools"><div className="view-switch" role="group" aria-label="环节"><Button aria-pressed={false} onPress={()=>setStage('review')}>{reviewMonths.from}复盘</Button><Button aria-pressed>{reviewMonths.to}拆解</Button></div></div></header><GenerationCanvas profile={p} job={roundJob?.status==='running'?roundJob:{status:'running',stage:'准备读取复盘和本体',createdAt:planHandoff?.startedAt||planHandoff?.requestedAt}}/></section><aside className="communication agent"><div className="chat-top"><div className="agent-chat-heading"><BotAvatar/><strong>{p.name}的 Agent</strong></div></div><div className="chat-empty"><Sparkles size={28}/><p>卡片生成后即可讨论与修订</p></div></aside></main>;
 const onFieldComment=(node,field)=>{const target=fieldCommentTarget(display(node),field),same=target.id===(commentTarget?.id||detail.id)&&field===commentAnchor;if(same)return;if(comment.trim()&&!window.confirm('切换批注位置将丢弃尚未发送的输入，继续吗？'))return;setCommentAnchor(field);setComment('');setCommentTarget(target);};
 const annotationNode=commentTarget?{...detail,...drafts[commentTarget.id],...commentTarget}:detail;
 const inlineAnnotation=detail&&commentAnchor?<section className="inline-annotation" data-comment-section><div className="inline-annotation-heading"><strong>批注 · {documentFieldLabel(annotationNode.level,String(commentAnchor).split('#')[0])}{String(commentAnchor).includes('#')?` · 第 ${Number(String(commentAnchor).split('#')[1])+1} 条`:''}</strong><button className="icon" aria-label="关闭批注" onClick={()=>{if(!comment.trim()||window.confirm('丢弃尚未发送的批注？')){setCommentAnchor(null);setComment('');}}}><X size={16}/></button></div>{(comments[annotationNode.id]||[]).filter(c=>{const [b,i]=String(commentAnchor).split('#');return c.block===b&&(i===undefined?!Number.isInteger(c.item):c.item===Number(i))||commentAnchor==='title'&&(!c.block||c.block==='card');}).map((c,i)=><p className="annotation" key={i}>{c.author} · v{c.version}<br/>{c.text}</p>)}<textarea autoFocus title="回车添加批注，Shift＋回车换行" onKeyDown={e=>enterSubmit(e,addComment,!!comment.trim())} aria-label="批注" value={comment} onChange={e=>setComment(e.target.value)} placeholder="对这处内容提出意见…"/><Button className="primary" isDisabled={!comment.trim()} onPress={addComment}>添加批注</Button></section>:null;
 const editor=detail?{title:documentEdit?.id===detail.id&&documentEdit.editing?<input className="inline-title-input" onKeyDown={documentEdit.onKeyDown} aria-label="修订标题" value={documentEdit.values.title||''} onChange={e=>documentEdit.onChange('title',e.target.value)}/>:null,onDetail:onFieldComment,card:<><DocumentContent editing={documentEdit?.id===detail.id?documentEdit:null} node={{...display(detail),unitName:labels.get(detail.unit||detail.id)?.planLabel,parentTitle:allNodes(data.units).find(n=>n.children.some(c=>c.id===detail.id))?.title}} childNodes={detail.children.map(display)} onOpen={openDetail} allowChildren={{po:0,mission:1,task:2,activity:3}[detail.level]<documentDepth(p,detail)} full deferred={detail.level==='po'?(data.deferredUpstream?.[detail.key||detail.id]||(data.roundAudit?.upstreamCoverage?.[detail.key||detail.id]||[]).filter(x=>/暂缓/.test(String(x.disposition)))):undefined} comments={comments[detail.id]||[]} me={p.name} onDeleteComment={(id,node)=>action({type:'deleteComment',cardId:node?.id||detail.id,commentId:id}).catch(e=>setError(e.message))} onDetail={onFieldComment} annotation={{cardId:commentTarget?.id||detail?.id,anchor:commentAnchor,content:inlineAnnotation}}/><ReviewEditor key={detail.id} actionsTarget={reviewActionsTarget} onEditingChange={setDocumentEdit} onDirtyChange={setDocDirty} node={display(detail)} editable={canPreviewRevise(detail,role,p)} history={drafts[detail.id]?.history} onSave={saveRevision} onAssist={()=>{setTab('agent');setGroupView('chat');send('请审阅我当前选中的成果：核对成果、验收、时间与下层组合，指出最重要的问题并给出具体修订建议。不要替我确认。','agent');}}/></>,notice:(()=>{const live=allNodes(data.units).find(n=>n.id===detail.id),parent=allNodes(data.units).find(n=>n.children.some(c=>c.id===detail.id));return <UpstreamNotice node={live} parent={parent&&display(parent)} profile={p} onOpenParent={()=>parent&&openDetail(parent)} onAck={()=>action({type:'acknowledgeImpact',cardId:detail.id,baseVersion:display(detail).version}).catch(e=>setError(e.message))}/>;})(),workflow:<Handshake node={display(detail)} profile={p} openIssues={openIssuesFor(detail)} signerNames={{ceo:Object.values(memberProfiles).find(m=>m.ceo)?.name||'CEO',unitDri:data.units.find(u=>u.id===(detail.unit||detail.id))?.owner,missionDri:display(detail).owner}} onAction={value=>action({...value,cardId:detail.id,baseVersion:display(detail).version}).catch(e=>setError(e.message))}/>} :null;
 const units=visibleUnits(orderedUnits,p,false).filter(u=>!mine||hasHandshake(u,p)).filter(u=>!scope||u.id===scope).filter(u=>!search||JSON.stringify(u).includes(search));

 const minutesTopics=scope?(topics[scope]||[]):[];
 const minutesRecords=scope?messages:[];

 const findNodeById=id=>allNodes(data.units).find(n=>n.id===id);
 const groupUnread=scope?unreadCount(records['group:'+scope],p.name,seen['group:'+scope]):0;
 // Things in this group only I can move forward: a proposal to accept, an @ to me, a version the other side already
 // confirmed, an upper-level change to check. Shown apart from plain unread messages.
 const scopeOf=item=>item.scope||(findNodeById(item.cardId)?.unit||item.cardId);
 const groupActionItems=scope?todoItems({units:data.units,drafts,records,comments,profile:p,name:p.name,seen}).filter(i=>(i.kind==='proposal'||i.kind==='mention')&&scopeOf(i)===scope):[],groupActions=groupActionItems.length;
 // The group's red count is only what waits in the group: revision cards to answer and lines that @ you. Confirming a
 // card or checking an upper change is done on the card and listed in 待我处理 (陈溪南 2026-10-19).
 // Double-click the red count to land on what needs you; each double-click goes to the next one (陈溪南 2026-10-19).
 function jumpToAction(items=groupActionItems){
  if(!items.length)return;const item=items[actionCursor.current++%items.length];
  // The card may still be rendering after the switch: look for the target for up to 1.5 s.
  const land=(find,tries=15)=>{const el=find();if(el)return flash(el);if(tries>0)setTimeout(()=>land(find,tries-1),100);};
  const flash=el=>{if(!el)return;el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.remove('jump-flash');void el.offsetWidth;el.classList.add('jump-flash');setTimeout(()=>el.classList.remove('jump-flash'),1800);};
  if(item.kind==='proposal'||item.kind==='mention'){setTab('group');setGroupView('chat');land(()=>item.kind==='proposal'?document.getElementById('proposal-'+item.id):document.querySelector(`[data-message-id="${item.id}"]`));}
  else{const n=findNode(item.cardId);if(n)openDetail(n);land(()=>document.querySelector('.handshake'));}
 }
 const todo=!detail&&canvasView==='document'?todoItems({units:data.units,drafts,records,comments,profile:p,name:p.name,seen}):[];
 const findNode=id=>allNodes(data.units).find(n=>n.id===id);
 // From a to-do line straight to where the action is: the proposal in the group, the confirm block, or the card.
 function goTodo(item){const n=findNode(item.cardId)||findNode(item.scope);if(!n)return;openDetail(n);if(['proposal','mention','objection'].includes(item.kind)){setTab('group');setGroupView('chat');}setTimeout(()=>{const target=item.kind==='proposal'?document.getElementById('proposal-'+item.id):item.kind==='objection'?document.querySelector(`[data-message-id="${item.id}"]`):['sign','upstream','downstream'].includes(item.kind)?document.querySelector('.handshake'):null;target?.scrollIntoView({block:'center',behavior:'smooth'});},120);}
 // A notice that @-mentions me carries the one action it asks for: confirm the new version, or check the lower cards.
 function noticeAction(m){if(m.kind!=='notice'||!m.cardId||!String(m.text).includes('@'+p.name))return null;const n=findNode(m.cardId);if(!n||display(n).status==='已确认'&&!/核对/.test(m.text))return null;const sentence=String(m.text).split(/(?<=。)/).find(x=>x.includes('@'+p.name))||'';const check=/核对/.test(sentence);return <Button className="plain notice-go" onPress={()=>{openDetail(n);setTimeout(()=>document.querySelector(check?'.work-plan':'.handshake')?.scrollIntoView({block:'center',behavior:'smooth'}),150);}}>{check?'去核对':'去确认'}</Button>;}
 // Open items on a card: topics anchored to it that have not reached agreement, and proposals still waiting.
 function openIssuesFor(n){const room=records['group:'+(n.unit||n.id)]||[],settled=new Set(room.filter(r=>r.kind==='revision-proposal'&&r.status==='accepted'&&r.cardId===n.id).flatMap(r=>r.sourceIds||[])),list=(topics[n.unit||n.id]||[]).filter(t=>t.anchor?.cardId===n.id&&t.status!=='agreement'&&t.stage!=='已定'&&!(t.sourceIds||[]).some(id=>settled.has(id))).map(t=>String(t.title).slice(0,40));const waiting=room.filter(r=>r.kind==='revision-proposal'&&r.cardId===n.id&&r.status==='pending'&&!r.stale).length;return waiting?[...list,`${waiting} 条 Nexus 修订建议待处理`]:list;}
 const canvasProposal=(records['group:'+scope]||[]).filter(m=>m.kind==='revision-proposal'&&(m.status==='accepted'||m.status==='pending'&&!m.stale)&&(!selected||m.cardId===selected.id)).at(-1);
 const groupMembers=Object.values(memberProfiles).filter(m=>m.ceo||m.unitDri?.includes(scope)||m.units?.includes(scope)||allNodes(data.units).some(n=>(n.unit||n.id)===scope&&(drafts[n.id]?.owner||n.owner)===m.name)).map(m=>m.name);
 const transferFor=(node,kind)=>node?.placeholder?null:<MarkdownTransfer key={kind+':'+node.id} stage={kind} rootId={node.id} title={node.title} memberId={role} onApplied={syncShared}/>;
 return <main className="shell"><section className="canvas"><header><Button className="icon" aria-label="返回" onPress={back}><ArrowLeft size={20}/></Button><h1>{stage==='review'?(reviewDetail?<span className="doc-path" role="navigation" aria-label="层级路径">{reviewDetail.level==='person'?<span className="doc-path-current">{reviewDetail.person==='未指派'?`未指派负责人的 Mission 复盘`:reviewDetail.person===p.name?`我的${reviewMonths.from}个人复盘`:`${reviewDetail.person}的${reviewMonths.from}个人复盘`}</span>:reviewDetail.level==='mission'&&ownerNames(reviewDetail).includes(p.name)?<><button className="doc-path-step" onClick={()=>{const who=reviewDetail.ownerAssigned===false?'未指派':ownerNames(reviewDetail)[0];openReview({id:'rv:person:'+who,level:'person',person:who});}}>{reviewDetail.ownerAssigned===false?'未指派负责人的 Mission 复盘':`我的${reviewMonths.from}个人复盘`}</button><ChevronRight size={14} aria-hidden="true"/><span className="doc-path-current">{reviewLabel(reviewDetail)}</span></>:reviewDetail.level==='mission'&&reviews.byId.get('rv:'+reviewDetail.unit)?<><button className="doc-path-step" onClick={()=>openReview(reviews.byId.get('rv:'+reviewDetail.unit))}>{unitLabel(reviewDetail)} · {reviewMonths.from}复盘</button><ChevronRight size={14} aria-hidden="true"/><span className="doc-path-current">{reviewLabel(reviewDetail)}</span></>:<span className="doc-path-current">{reviewDetail.level==='company'?`词元云集 · ${reviewMonths.from}公司复盘`:`${unitLabel(reviewDetail)} · ${reviewMonths.from}复盘`}</span>}</span>:`词元云集 ${reviewMonths.from}复盘`):canvasView==='document'&&detail?<DocPath units={data.units} node={detail} display={display} onOpen={openDetail}/>:scope?labels.get(scope)?.planLabel+' · 10 月计划':`词元云集 ${reviewMonths.to}拆解`}</h1><div className="tools">{stage==='plan'&&canvasView==='document'&&detail&&<div className="document-review-actions" ref={setReviewActionsTarget}/>}{stage==='review'?<TodoMenu key="review" openKey={todoOpenKey} items={reviewTodoItems} onGo={goReviewTodo} labelOf={reviewTodoLabel} onAck={item=>{const n=reviews.byId.get(item.cardId);if(n)action({type:'acknowledgeImpact',cardId:n.id,baseVersion:n.version}).catch(e=>setError(e.message));}}/>:<TodoMenu key="plan" openKey={todoOpenKey} items={todo} resolve={findNode} display={display} onGo={goTodo}/>}{operator&&<Button className="plain toolbar-chip admin-button" onPress={()=>setAdminOpen(true)}>管理</Button>}<div className="view-switch" role="group" aria-label="环节"><Button aria-pressed={stage==='review'} onPress={()=>setStage('review')}>{reviewMonths.from}复盘</Button><Button aria-pressed={stage==='plan'} isDisabled={!planOpen} onPress={()=>setStage('plan')}><span title={planOpen?undefined:`${reviewMonths.from}复盘全部确认、CEO 确认公司复盘后生成`}>{reviewMonths.to}拆解</span></Button></div>{stage==='plan'&&<div className="view-switch" role="group" aria-label="画布视角"><Button aria-pressed={canvasView==='document'} onPress={()=>switchView('document')}>文档</Button><Button aria-pressed={canvasView==='gantt'} onPress={()=>switchView('gantt')}>甘特图</Button></div>}{/* Gantt only, as two segmented switches like 文档 / 甘特图 (陈溪南 2026-10-19); the document view always shows everything. */}{stage==='plan'&&canvasView==='gantt'&&<div className="view-switch" role="group" aria-label="显示范围"><Button aria-pressed={!mine} onPress={()=>setMine(false)}>全部</Button><Button aria-pressed={mine} onPress={()=>setMine(true)}>只看我负责</Button></div>}{stage==='plan'&&canvasView==='gantt'&&<div className="view-switch" role="group" aria-label="展开层级"><Button aria-pressed={!ganttAllOpen} onPress={()=>{setExpanded(new Set());setGanttAllOpen(false);}}>收起</Button><Button aria-pressed={ganttAllOpen} onPress={()=>{setExpanded(new Set(allNodes(data.units).map(n=>n.id)));setGanttAllOpen(true);}}>全部展开</Button></div>}{scope&&<Button className="plain toolbar-chip minutes-toggle" aria-pressed={tab==='group'&&groupView==='minutes'} onPress={()=>{const closing=tab==='group'&&groupView==='minutes';setTab(closing&&!scope?'agent':'group');setGroupView(closing?'chat':'minutes');}}>{tab==='group'&&groupView==='minutes'?'返回沟通':'查看纪要'}</Button>}</div></header>
 <div className={`canvas-scroll view-${stage==='review'?'document':canvasView}`} ref={scroll}>{stage==='review'?<ReviewCanvas transferFor={node=>transferFor(node,'review')} insights={insights} onInsight={value=>action(value)} ceoName={Object.values(memberProfiles).find(m=>m.ceo)?.name} onRevise={(n,patch)=>action({type:'revise',cardId:n.id,baseVersion:n.version,patch}).then(res=>{
 // A verdict change is not applied on save: it goes to the other signer as a revision card (M2 2026-10-22).
 if('verdict'in patch){const names=reviewSigners(n),others=reviewSlots(n).filter(s=>!maySign(n,s,p)).map(s=>names[s]).filter(Boolean);if(others.length)setNotice(`判定改动已提交给 ${[...new Set(others)].join('、')} 决定，接受后才生效`);}return res;}).catch(e=>{setError(e.message);throw e;})} tree={reviews} active={reviewDetail} profile={p} comments={comments} toneOf={reviewTone} months={reviewMonths} review={reviewMeta} me={p.name} onOpen={openReview} onAction={value=>action(value).then(r=>{if(value.cardId==='rv:company'&&r?.planHandoff?.preparedAt){setStage('plan');setNotice(`已确认公司复盘，Nexus 开始生成 ${reviewMonths.to}拆解${r.planHandoff.dryRun?'（演示：这次不实际生成）':''}。`);}}).catch(e=>setError(e.message))} onDetail={reviewDetail?onFieldComment:null} onAnswer={(n,i,ask,text,block)=>answerAsk(n,i,ask,text,block).catch(e=>setError(e.message))} annotation={{cardId:commentTarget?.id||detail?.id,anchor:commentAnchor,content:inlineAnnotation}} onDeleteComment={(id,node)=>action({type:'deleteComment',cardId:node?.id||detail.id,commentId:id}).catch(e=>setError(e.message))} unitLabel={unitLabel} signerNames={reviewSigners}/>:canvasView==='document'?<DocumentCanvas transferFor={node=>transferFor(node,'plan')} ceoName={Object.values(memberProfiles).find(m=>m.ceo)?.name} units={units} allUnits={data.units} audit={data.roundAudit} me={p.name} onCommentCard={(n,text)=>action({type:'comment',cardId:n.id,baseVersion:display(n).version,block:'card',text})} onDeleteCommentCard={(n,id)=>action({type:'deleteComment',cardId:n.id,commentId:id}).catch(e=>setError(e.message))} onShowInGantt={showInGantt} todo={<><RoundStatusBar job={roundJob} round={data.round} canAct={!!p.ceo||!!data.canRunRounds} onResume={resumeRound} onLoad={loadRound} onDetails={()=>setEvidence(true)}/></>} profile={p} display={display} comments={comments} activeNode={detail&&(allNodes(data.units).find(n=>n.id===detail.id)||detail)} onOpen={openDetail} mine={false} editor={editor} activityPlan={task=><ActivityGenerator task={task} memberId={role} allowed={Boolean(p.ceo||p.unitDri?.includes(task.unit)||p.missions?.includes(task.id.split('-t')[0])||ownerName(task.owner)===p.name)} onDone={()=>fetch('/api/data').then(r=>r.json()).then(next=>{setData(next);setDetail(old=>old&&allNodes(next.units).find(n=>n.id===old.id)||old);}).catch(()=>setError('数据读取失败'))}/>}/>:<GanttCanvas units={units} allUnits={data.units} profile={p} mine={mine} search={search} expanded={expanded} onToggle={toggleRow} onOpen={openDetail} display={display} updated={updated}/>}</div>{error&&<div className="app-toast" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={()=>setError('')}>×</button></div>}{notice&&<div className="app-toast is-notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice('')}>×</button></div>}</section>
 <aside className={`communication ${tab}`}><div className="chat-top">{scope&&tab==='group'&&groupView==='minutes'?<strong className="minutes-panel-title">纪要</strong>:scope?<div className="tabs" onPointerDownCapture={()=>{const last=badgePress.current;if(last?.at&&Date.now()-last.at<400){badgePress.current={consumed:Date.now()};jumpToAction(last.items);}}}><Button className={tab==='agent'?'active':''} onPress={()=>setTab('agent')}><span className="tab-label">{p.name}的 Agent</span></Button>{scope&&<Button className={tab==='group'?'active':''} onPress={()=>setTab('group')}><span className="tab-label" title={(String(scope).startsWith('person:')?'个人复盘对话':labels.get(scope)?.groupName||(scope==='company'?'公司复盘':'规划群'))}>{(String(scope).startsWith('person:')?'个人复盘对话':labels.get(scope)?.groupName||(scope==='company'?'公司复盘':'规划群'))}</span><GroupMembers members={unitMembers} active={tab==='group'&&groupView!=='minutes'}/>{groupActions>0?<span className="tab-action" aria-label={`${groupActions} 项待你处理，双击定位`} title={`${groupActions} 项待你处理 · 双击定位，再双击跳下一项`} onPointerDown={()=>{if(!(Date.now()-(badgePress.current?.consumed||0)<50))badgePress.current={at:Date.now(),items:groupActionItems};}}>{groupActions}</span>:tab!=='group'&&groupUnread>0&&<span className="tab-unread" aria-label={`${groupUnread} 条未读`}>{groupUnread}</span>}</Button>}</div>:<div className="agent-chat-heading"><BotAvatar/><strong>{scope&&tab==='group'&&groupView==='minutes'?'沟通纪要':`${p.name}的 Agent`}</strong></div>}</div>{scope&&tab==="group"&&groupView==="minutes"?<DiscussionMinutes topics={minutesTopics} records={minutesRecords} drafts={drafts} busy={Boolean(nexusBusy&&nexusBusy===scope)} error={nexusErrors[scope]} listening={listening} onAnalyze={()=>analyzePublic(scope,true)} onSource={source=>{const n=allNodes(data.units).find(n=>n.id===source.context?.selection?.id);if(n)openDetail(n,source.context.block);}} onProposal={proposal=>{if(!scope){const n=allNodes(data.units).find(n=>n.id===proposal.cardId);if(n)openDetail(n);}setGroupView("chat");requestAnimationFrame(()=>document.getElementById("proposal-"+proposal.id)?.scrollIntoView({block:"center",behavior:"smooth"}));}}/>:<div className="messages">{!guideSeen&&tab==="group"&&<ChatMessage author="Nexus" name="Nexus" text={String(scope).startsWith('person:')?personGuide:nexusGuide(stage,reviewMonths)}><Button className="plain guide-close" onPress={closeGuide}>知道了</Button></ChatMessage>}{messages.length===0&&(guideSeen||tab!=="group")&&!pendingAgent&&nexusBusy!==scope&&<div className="chat-empty"><MessageCircle size={28}/><p>{tab==='agent'?'随时讨论你正在看的计划':'围绕这个领域的计划形成共识'}</p></div>}{messages.map((m,i)=>m.kind==='revision-proposal'?<ProposalCard onReply={proposal=>{setReplyTarget({...proposal,author:'Nexus',text:'拟修改确认 · '+drafts[proposal.cardId]?.title});setText('确认');requestAnimationFrame(()=>document.querySelector('.composer textarea')?.focus());}} key={m.id} proposal={m} node={{...drafts[m.cardId],...(isReviewId(m.cardId)?{referenceLabel:(drafts[m.cardId]?.level==='mission'?reviewLabel(drafts[m.cardId])+' 复盘':reviewLabel(drafts[m.cardId]||{}))}:labels.get(m.cardId))}} onOpen={id=>{const n=allNodes(data.units).find(n=>n.id===id);if(n)openDetail(n);}} onAction={value=>action(value).catch(e=>setError(e.message))} onSource={source=>{const n=allNodes(data.units).find(n=>n.id===source.context?.selection?.id);if(n)openDetail(n,source.block);}}/>:<ChatMessage key={m.id||i} id={m.id} notice={m.kind==='notice'} author={m.author} name={(m.author==='Agent'?`${p.name}的 Agent`:m.author)+(m.kind==='comment'?' · 文档批注':'')} text={m.text} quote={m.replyPreview||(tab==='agent'?privateQuote(messages,i,{name:p.name,cardLabel:id=>{const n=allNodes(data.units).find(x=>x.id===id);if(!n)return null;const d=display(n);return {ref:d.planLabel||d.referenceLabel||n.level,title:d.title};}}):null)}>{noticeAction(m)}{tab==='group'&&<Button className="plain message-reply" aria-label={`回复 ${m.author}的消息`} onPress={()=>{setReplyTarget(m);requestAnimationFrame(()=>document.querySelector('.composer textarea')?.focus());}}>回复</Button>}{m.kind==='comment'&&m.context?.selection&&<Button className="plain comment-location" onPress={()=>goComment(m)}>{commentLocation(m)}</Button>}{m.shareable&&scope&&m.context?.scope===scope&&<Button className="plain" onPress={()=>{const key='group:'+scope,old=roomDrafts.current[key];roomDrafts.current[key]=old?.trim()?old+'\n\n'+m.text:m.text;setTab('group');setGroupView('chat');setTimeout(()=>document.querySelector('.composer textarea')?.focus(),80);}}>带到规划群修改后发送</Button>}</ChatMessage>)}{tab==='agent'&&pendingAgent?.room===room&&messages.filter(m=>m.author==='Agent').at(-1)?.id===pendingAgent.lastAgentId&&<ChatMessage author="Agent" name={`${p.name}的 Agent`} text={pendingAgent.text} thinking/>}{tab==='group'&&nexusBusy===scope&&(nexusFlight.current||nexusAddressed(records['group:'+scope]))&&<ChatMessage author="Nexus" thinking/>}</div>}{offline&&<div className="connection-notice" role="status">连接中断，正在自动重连…</div>}{tab==="group"&&nexusErrors[scope]&&<div className="error" role="alert">{nexusErrors[scope]}</div>}{(tab!=="group"||groupView==="chat")&&<ChatComposer key={room} roomName={String(scope).startsWith('person:')?'个人复盘对话':scope==='company'?'公司复盘群':'规划群'} members={groupMembers} text={text} onChange={setText} onSend={send} onVoice={voice} recording={recording} busy={busy===tab} channel={tab} reply={replyTarget} onCancelReply={()=>setReplyTarget(null)}/>}</aside>

 {evidenceModal}{adminPanel}

 <RevisionOverlay revision={canvasRevision} canvas={scroll} view={canvasView}/>
 </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
