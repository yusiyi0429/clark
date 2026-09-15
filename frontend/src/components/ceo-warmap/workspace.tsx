'use client';

import { ArrowUpRight, Check, ChevronDown, History, Keyboard, Mic, ArrowUp, Volume2, VolumeX, X, CornerDownLeft } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { NotificationRail } from './notifications';
import { CardReferenceContext, ReferenceTray, ReferenceButton } from './card-references';
import { validReferences, MAX_REFERENCES, type CardReference, type SelectedReference } from '@/lib/warmap/card-reference';
import { issueReference } from './reference-model';
import { ConversationTurn, ConversationThinking, type ConversationMessage, type ConversationActivity } from './conversation-transcript';
import { readChatReply } from './read-chat-reply';
import { TianshuMark } from '@/components/brand/tianshu-mark';
import { usePrototypeVoice } from './use-prototype-voice';
import { issues, resolveCommand, strategyIds, zones, type Campaign, type IssueId, type ViewId } from './model';
import s from './workspace.module.css';
import d from './conversation-dock.module.css';
import { RadarFeed, RadarIssueRows } from './radar-feed';
import { missionSnapshots, type MissionAssessment } from '@/lib/warmap/mission-progress';
import { useRadar } from './use-radar';
import { CapabilityIssues, CapabilityIssueButton, capabilityIssueGroups } from './capability-issues';
import { HomeBoard } from './home-board';
import { battlefieldProgress, resolveProgressCommand, type BattlefieldDisplay, type BattlefieldMode } from './battlefield-progress';
import { IssueWorkspace } from './issue-workspace';
import { HeavyWorkspace, heavyTitles, heavyMaterials } from './heavy-workspace';
import { MeetingWorkspace } from './meeting-workspace';
import { todayMeetings } from './meeting-model';
import { readDecisions, type DecisionReceipt, type DecisionRecords, type HeavyNoticeId } from './decision-model';
import { FoldMaterialDesk } from './fold-material-desk';

type Message = ConversationMessage;
type Sheet = {kind:'issue'|'research';id:IssueId} | {kind:'campaign';campaign:Campaign};
type ConversationScope = {key:string;label:string;kind:'global'|'issue'|'signal'|'material'|'campaign'|'view'};
type Rect = {left:number;top:number;width:number;height:number};
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const preserveGlobalFocus = () => document.activeElement?.closest('[data-testid="global-controls"]') != null;


export function CeoWorkspace({ arrivingFromLock = false }: { arrivingFromLock?: boolean }) {
 const radar=useRadar();
 const [entryVisible,setEntryVisible]=useState(arrivingFromLock);
 useEffect(()=>{
  if(!arrivingFromLock)return;
  const url=new URL(window.location.href);
  url.searchParams.delete('_entry');
  window.history.replaceState(null,'',`${url.pathname}${url.search}${url.hash}`);
  // The URL flag describes a one-off handoff, not the lifetime of this page.
  // Clear the visual state even when reduced motion prevents animationend.
  const timer=window.setTimeout(()=>setEntryVisible(false),reduced()?0:1300);
  return()=>window.clearTimeout(timer);
 },[arrivingFromLock]);
 const [missionAssessments,setMissionAssessments]=useState<Record<string,MissionAssessment>>({});
 const receiveMissionAssessment=useCallback((zone:string,assessment:MissionAssessment)=>setMissionAssessments(previous=>previous[zone]?.assessedAt===assessment.assessedAt?previous:{...previous,[zone]:assessment}),[]);
 const [radarSelected,setRadarSelected]=useState<string|null>(null);
 const radarSignal=radar.data?.signals.find(s=>s.id===radarSelected);

 const [view,setView]=useState<ViewId|null>(null);
 const [battlefieldDisplay,setBattlefieldDisplay]=useState<BattlefieldDisplay>({mode:'decisions',overrides:{}});
 const displayBattlefields=(mode:BattlefieldMode)=>setBattlefieldDisplay({mode,overrides:{}});
 const flipBattlefield=(id:ViewId)=>setBattlefieldDisplay(previous=>({...previous,overrides:{...previous.overrides,[id]:(previous.overrides[id]??previous.mode)==='progress'?'decisions':'progress'}}));
 const [heavyNotice,setHeavyNotice]=useState<HeavyNoticeId|null>(null);
 const [heavyClosing,setHeavyClosing]=useState(false);
 const [heavyCompletions,setHeavyCompletions]=useState<Partial<Record<HeavyNoticeId,string>>>({});
 const [decisions,setDecisions]=useState<DecisionRecords>({});
 const [decisionsReady,setDecisionsReady]=useState(false);
 const decisionRef=useRef<DecisionRecords>({});
 const heavyMaterialRef=useRef<Partial<Record<HeavyNoticeId,string>>>({});
 const updateHeavyMaterials=useCallback((text:string)=>{if(heavyNotice)heavyMaterialRef.current[heavyNotice]=text;},[heavyNotice]);
 const invalidateHeavy=useCallback((id:HeavyNoticeId)=>setHeavyCompletions(previous=>{const next={...previous};delete next[id];try{localStorage.setItem('tianshu-heavy-completions-v1',JSON.stringify(next));}catch{}return next;}),[]);
 useEffect(()=>{
  const frame=requestAnimationFrame(()=>{
  try {
   const raw=localStorage.getItem('tianshu-decisions-v2');
   const restored=readDecisions(raw);
   if(raw===null){const legacy=JSON.parse(localStorage.getItem('tianshu-warmap-notices-v1')||'{}');if(legacy?.confirmation?.label?.startsWith('已确认'))restored.capacity={issueId:'capacity',status:'decided',summary:legacy.confirmation.detail||'优先支持灯塔项目'};}
   decisionRef.current=restored;setDecisions(restored);
   const complete=JSON.parse(localStorage.getItem('tianshu-heavy-completions-v1')||'{}');
   setHeavyCompletions(Object.fromEntries(Object.entries(complete||{}).filter(([k,v])=>['preflight-product','preflight-workshop','monthly'].includes(k)&&typeof v==='string')));
  } catch {} finally {setDecisionsReady(true);}
  });
  return()=>cancelAnimationFrame(frame);
 },[]);
 const commitDecision=useCallback((receipt:DecisionReceipt)=>{
  const next={...decisionRef.current,[receipt.issueId]:receipt};decisionRef.current=next;setDecisions(next);
  try{localStorage.setItem('tianshu-decisions-v2',JSON.stringify(next));}catch{}
 },[]);
 const undoDecision=useCallback((id:IssueId)=>{
  const next={...decisionRef.current};delete next[id];decisionRef.current=next;setDecisions(next);
  try{localStorage.setItem('tianshu-decisions-v2',JSON.stringify(next));}catch{}
 },[]);
 const completeHeavy=(id:HeavyNoticeId,summary:string)=>setHeavyCompletions(previous=>{const next={...previous,[id]:summary};try{localStorage.setItem('tianshu-heavy-completions-v1',JSON.stringify(next));}catch{}return next;});
 const [sheet,setSheet]=useState<Sheet|null>(null);
 const [historyScope,setHistoryScope]=useState<ConversationScope|null>(null);
 const [keyboard,setKeyboard]=useState(false);
 const [input,setInput]=useState('');
 const [composerHeight,setComposerHeight]=useState(36);
 const [composerExpanded,setComposerExpanded]=useState(false);
 const [caption,setCaption]=useState('');
 const [noticeToast,setNoticeToast]=useState('');
 const [references,setReferences]=useState<SelectedReference[]>([]);
 const referenceList=useRef<SelectedReference[]>([]);
 const refreshReference=useCallback((item:CardReference)=>{setReferences(previous=>{const existing=previous.find(ref=>ref.id===item.id);if(!existing||existing.content===item.content&&existing.title===item.title&&existing.source===item.source)return previous;const next=previous.map(ref=>ref.id===item.id?{...item,capturedAt:new Date().toISOString()}:ref);if(!validReferences(next))return previous;referenceList.current=next;return next;});},[]);
 const toggleReference=useCallback((item:CardReference)=>{const previous=referenceList.current;const next=previous.some(ref=>ref.id===item.id)?previous.filter(ref=>ref.id!==item.id):[...previous,{...item,capturedAt:new Date().toISOString()}];if(!validReferences(next)){setNoticeToast(previous.length>=MAX_REFERENCES?`最多同时引用 ${MAX_REFERENCES} 张卡片。`:'这张卡片内容较长，请引用其中的具体事项。');return;}referenceList.current=next;setReferences(next);setCaption('');},[]);
 useEffect(()=>{for(const ref of referenceList.current){const id=ref.id.startsWith('issue:')?ref.id.slice(6):'';if(id in issues)refreshReference(issueReference(id as IssueId,decisions[id as IssueId]));}},[decisions,refreshReference]);
 const removeReference=(id?:string)=>{const next=id?referenceList.current.filter(ref=>ref.id!==id):[];referenceList.current=next;setReferences(next);};
 const [messages,setMessages]=useState<Message[]>([]);
 const [busy,setBusy]=useState(false);
 const [activity,setActivity]=useState<ConversationActivity>({started:0,stage:'thinking'});
 const [promoted,setPromoted]=useState(false);
 const main=useRef<HTMLDivElement>(null);
 const expanded=useRef<HTMLDivElement>(null);
 const sheetElement=useRef<HTMLElement>(null);
 const inputElement=useRef<HTMLTextAreaElement>(null);
 const dockLayer=useRef<HTMLDivElement>(null);
 const dockOrigin=useRef<DOMRect|null>(null);
 const dockAnimation=useRef<Animation|null>(null);
 const captureDock=()=>{const el=dockLayer.current;if(!el)return;dockOrigin.current=el.getBoundingClientRect();dockAnimation.current?.cancel();el.dataset.moving='true';};
 const beginMaterialClose=()=>{captureDock();request.current?.abort();request.current=null;setBusy(false);voice.interrupt();setHeavyClosing(true);};
 const transcriptEnd=useRef<HTMLDivElement>(null);
 const origin=useRef<Rect|null>(null);
 const focusOrigin=useRef<HTMLElement|null>(null);
 const sheetTrigger=useRef<HTMLElement|null>(null);
 const issueOrigin=useRef<Rect|null>(null);
 const transition=useRef<Animation|null>(null);
 const sheetAnimation=useRef<Animation|null>(null);
 const sendRef=useRef<(text:string)=>void>(()=>{});
 const request=useRef<AbortController|null>(null);
 const serial=useRef(0);
 const mounted=useRef(true);
 const anchor=useRef<string|null>(null);
 const [closing,setClosing]=useState(false);
 const [sheetClosing,setSheetClosing]=useState(false);
 const voice=usePrototypeVoice({onCommit:text=>sendRef.current(text),onCaption:setCaption});
 const currentIssue=sheet&&(sheet.kind==='issue'||sheet.kind==='research')?sheet.id:null;
 const sheetOpen=!!sheet;
 const activeCampaign=sheet?.kind==='campaign'?sheet.campaign:null;
 const viewLabel=view?zones.find(z=>z.id===view)?.name||({radar:'雷达信号',capabilities:'公司能力',strategy:'公司战略议题'} as Record<string,string>)[view]:null;
 const pageConversation:ConversationScope=currentIssue
  ?{key:`issue:${currentIssue}`,label:issues[currentIssue].title,kind:'issue'}
  :activeCampaign?{key:`campaign:${activeCampaign.id}`,label:activeCampaign.name,kind:'campaign'}
  :heavyNotice?{key:`material:${heavyNotice}`,label:heavyTitles[heavyNotice],kind:'material'}
  :view==='radar'&&radarSignal?{key:`signal:${radarSignal.id}`,label:radarSignal.issue?.title||radarSignal.title,kind:'signal'}
  :view&&viewLabel?{key:`view:${view}`,label:viewLabel,kind:'view'}
  :{key:'global',label:'公司全局',kind:'global'};
 const conversation=historyScope??pageConversation;
 const context=conversation.key;
 const contextLabel=conversation.label;
 // Quoting prepares the global draft; it never changes the conversation being held.
 const globalContext=conversation.kind==='global';
 const activeReferences=globalContext?references:[];
 const hasActiveReferences=activeReferences.length>0;
 const pendingGlobalReferences=!globalContext&&references.length>0;
 const [draftContext,setDraftContext]=useState(context);
 const [contextDrafts,setContextDrafts]=useState<Record<string,string>>({});
 if(draftContext!==context){setContextDrafts({...contextDrafts,[draftContext]:input});setInput(contextDrafts[context]||'');setDraftContext(context);}
 const last=messages.filter(message=>message.context===context).at(-1);
 // Set the destination layout once; animate its composited surface instead of layout every frame.
 useLayoutEffect(()=>{
  const el=dockLayer.current,from=dockOrigin.current;if(!el||!from)return;
  dockOrigin.current=null;dockAnimation.current?.cancel();
  const to=el.getBoundingClientRect();
  const finish=()=>{delete el.dataset.moving;el.style.willChange='';};
  if(reduced()||!from.width||!to.width){finish();return;}
  const dx=from.x+from.width/2-to.x-to.width/2,dy=from.y-to.y;
  el.style.willChange='transform';
  const animation=el.animate([
   {transform:`translate(calc(-50% + ${dx}px), ${dy}px) scaleX(${from.width/to.width})`},
   {transform:'translateX(-50%) scaleX(1)'}
  ],{duration:sheetClosing||heavyClosing?250:360,easing:sheetClosing||heavyClosing?'cubic-bezier(.4,0,.2,1)':'cubic-bezier(.2,.8,.2,1)'});
  dockAnimation.current=animation;
  animation.finished.then(()=>{if(dockAnimation.current===animation)finish();}).catch(()=>{});
 },[currentIssue,sheetClosing,heavyNotice,heavyClosing,sheet]);


 const addMessage=useCallback((role:Message['role'],content:string,where:string,metadata:Pick<Message,'ms'|'research'|'references'>={})=>{
  setMessages(old=>[...old,{id:++serial.current,role,content,context:where,...metadata}]);
 },[]);
 const respond=(text:string,metadata:Pick<Message,'ms'|'research'|'references'>={})=>{setCaption(text);addMessage('assistant',text,context,metadata);voice.speak(text);};
 const closeHeavy=()=>main.current?.querySelector<HTMLButtonElement>('[data-heavy-workspace] button[aria-label="关闭工作区，保留草稿"], [data-meeting-workspace] button[aria-label="关闭会议空间"]')?.click();

 function openRadarSignal(id:string){setHistoryScope(null);setRadarSelected(id);setCaption('');request.current?.abort();setBusy(false);openView('radar',undefined,'signal');void radar.act('read',{id});}

 function openView(next:ViewId,from?:HTMLElement,section?:string) {
  setHistoryScope(null);
  if(view!==next){request.current?.abort();request.current=null;setBusy(false);setCaption('');voice.interrupt();}
  if(next!=='radar'||section!=='signal')setRadarSelected(null);
  setHeavyNotice(null);
  transition.current?.cancel();setClosing(false);
  if(from){const box=from.closest('[data-origin]')?.getBoundingClientRect()||from.getBoundingClientRect();origin.current={left:box.left,top:box.top,width:box.width,height:box.height};focusOrigin.current=from;}
  else {const target=main.current?.querySelector(`[data-origin="${next}"]`);const box=target?.getBoundingClientRect();origin.current=box?{left:box.left,top:box.top,width:box.width,height:box.height}:null;}
  if(sheet)closeSheet();anchor.current=section||null;
  if(view===next){scrollToSection(section);return;}setView(next);
 }
 function scrollToSection(section?:string){if(!section)return;requestAnimationFrame(()=>{const target=expanded.current?.querySelector(`[data-section="${section}"]`);target?.scrollIntoView({behavior:reduced()?'instant':'smooth',block:'start'});});}
 function transformForOrigin(){const a=origin.current,b=main.current?.getBoundingClientRect();return a&&b?`translate(${a.left-b.left}px,${a.top-b.top}px) scale(${a.width/b.width},${a.height/b.height})`:'translateY(18px) scale(.97)';}
 useLayoutEffect(()=>{
  const el=expanded.current;if(!view||!el)return;
  transition.current?.cancel();
  transition.current=el.animate([{transform:transformForOrigin(),opacity:.6,borderRadius:'25px'},{transform:'translate(0,0) scale(1)',opacity:1,borderRadius:'25px'}],{duration:reduced()?0:380,easing:'cubic-bezier(.2,.8,.2,1)'});
  transition.current.finished.then(()=>{scrollToSection(anchor.current||undefined);}).catch(()=>{});
  if(!preserveGlobalFocus())el.querySelector<HTMLButtonElement>('[data-close-view]')?.focus({preventScroll:true});
 },[view]);
 function closeView(){if(!view||closing)return;request.current?.abort();request.current=null;setBusy(false);voice.interrupt();if(sheet)closeSheet();const el=expanded.current;if(!el){setView(null);return;}setClosing(true);transition.current?.cancel();transition.current=el.animate([{transform:'translate(0,0) scale(1)',opacity:1},{transform:transformForOrigin(),opacity:.1}],{duration:reduced()?0:260,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'});transition.current.finished.then(()=>{setView(null);setRadarSelected(null);setClosing(false);if(!preserveGlobalFocus())focusOrigin.current?.focus({preventScroll:true});}).catch(()=>{});}
 function issueClipPath(){
  const a=issueOrigin.current,b=sheetElement.current?.getBoundingClientRect();
  if(!a||!b||!b.width||!b.height)return'inset(3% 2% 3% 2% round 22px)';
  const top=Math.max(0,Math.min(b.height,a.top-b.top));
  const left=Math.max(0,Math.min(b.width,a.left-b.left));
  const right=Math.max(0,Math.min(b.width,b.right-a.left-a.width));
  const bottom=Math.max(0,Math.min(b.height,b.bottom-a.top-a.height));
  return `inset(${top}px ${right}px ${bottom}px ${left}px round 12px)`;
 }
 function openSheet(next:Sheet){
  captureDock();
  setHistoryScope(null);
  setHeavyNotice(null);
  const nextIssue=next.kind==='issue'||next.kind==='research'?next.id:null;
  if(nextIssue!==currentIssue){request.current?.abort();request.current=null;setBusy(false);setCaption('');}
  sheetAnimation.current?.cancel();setSheetClosing(false);
  if(!currentIssue||nextIssue!==currentIssue){
   const active=document.activeElement instanceof HTMLElement?document.activeElement:null;
   const target=nextIssue?(active&&main.current?.contains(active)?active:main.current?.querySelector(`[data-home-issue="${nextIssue}"]`)):active;
   const box=target?.getBoundingClientRect();issueOrigin.current=box?{left:box.left,top:box.top,width:box.width,height:box.height}:null;
   sheetTrigger.current=active;
  }
  setSheet(next);
 }
 useLayoutEffect(()=>{
  const el=sheetElement.current;if(!sheetOpen||!el)return;
  sheetAnimation.current?.cancel();
  const frames:Keyframe[]=currentIssue
   ?[{clipPath:issueClipPath(),opacity:.28},{clipPath:'inset(0 round 22px)',opacity:1}]
   :[{transform:'translateY(16px)',opacity:.2},{transform:'translateY(0)',opacity:1}];
  el.style.willChange=currentIssue?'clip-path, opacity':'transform, opacity';
  const animation=el.animate(frames,{duration:reduced()?0:currentIssue?300:260,easing:'cubic-bezier(.2,.8,.2,1)'});
  sheetAnimation.current=animation;
  animation.finished.then(()=>{if(sheetAnimation.current===animation)el.style.willChange='';}).catch(()=>{});
  if(!preserveGlobalFocus())el.querySelector<HTMLButtonElement>('[data-close-sheet]')?.focus({preventScroll:true});
 },[sheetOpen,currentIssue]);
 function closeSheet(){
  if(!sheet||sheetClosing)return;
  captureDock();
  request.current?.abort();request.current=null;setBusy(false);voice.interrupt();
  setSheetClosing(true);
  const finish=()=>{
   setSheet(null);setSheetClosing(false);setCaption('');
   requestAnimationFrame(()=>{if(!preserveGlobalFocus())sheetTrigger.current?.focus({preventScroll:true});});
  };
  const el=sheetElement.current;if(!el){finish();return;}
  sheetAnimation.current?.cancel();
  const frames:Keyframe[]=currentIssue
   ?[{clipPath:'inset(0 round 22px)',opacity:1},{clipPath:issueClipPath(),opacity:0}]
   :[{transform:'translateY(0)',opacity:1},{transform:'translateY(16px)',opacity:0}];
  el.style.willChange=currentIssue?'clip-path, opacity':'transform, opacity';
  sheetAnimation.current=el.animate(frames,{duration:reduced()?0:220,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'});
  sheetAnimation.current.finished.then(finish).catch(()=>{});
 }
 function openHistory(scope:ConversationScope=conversation){
  setHistoryScope(scope);
  requestAnimationFrame(()=>transcriptEnd.current?.scrollIntoView({block:'end'}));
 }
 function closeHistory(){
  if(historyScope&&historyScope.key!==pageConversation.key){request.current?.abort();request.current=null;setBusy(false);voice.interrupt();setCaption('');}
  setHistoryScope(null);
 }
 function discussGlobalReferences(){
  if(sheetClosing)return;
  request.current?.abort();request.current=null;setBusy(false);voice.interrupt();setCaption('');
  openHistory({key:'global',label:'公司全局',kind:'global'});
 }
 function openHeavyNotice(id:HeavyNoticeId){
  if(id!==heavyNotice||sheet)captureDock();
  setHistoryScope(null);sheetAnimation.current?.cancel();
  request.current?.abort();request.current=null;setBusy(false);voice.interrupt();setCaption('');
  setSheetClosing(false);setSheet(null);setHeavyClosing(false);setHeavyNotice(id);
 }
 function toggleKeyboard(){setKeyboard(previous=>!previous);}
 useLayoutEffect(()=>{if(keyboard)inputElement.current?.focus({preventScroll:true});},[keyboard]);
 useLayoutEffect(()=>{const element=inputElement.current;if(!element)return;const layer=element.closest<HTMLElement>('[data-testid="global-controls"]');const layerWidth=layer?.clientWidth||560;const dockWidth=hasActiveReferences?layerWidth:window.innerWidth>=1800?Math.min(600,layerWidth):window.innerWidth<=1000?layerWidth:Math.min(560,layerWidth);const canvas=document.createElement('canvas');const context2d=canvas.getContext('2d');const style=getComputedStyle(element);if(context2d)context2d.font=style.font;const shouldExpand=input.includes('\n')||!!input&&(context2d?.measureText(input).width||0)>Math.max(140,dockWidth-132);setComposerExpanded(previous=>previous===shouldExpand?previous:shouldExpand);if(!shouldExpand){setComposerHeight(36);return;}element.style.height='0px';const next=Math.min(196,Math.max(76,element.scrollHeight));element.style.height='';setComposerHeight(previous=>previous===next?previous:next);},[input,keyboard,composerExpanded,hasActiveReferences]);
 useEffect(()=>{if(historyScope)transcriptEnd.current?.scrollIntoView({behavior:'smooth',block:'end'});},[messages,historyScope]);
 useEffect(()=>{if(!noticeToast)return;const t=setTimeout(()=>setNoticeToast(''),4000);return()=>clearTimeout(t);},[noticeToast]);

 async function send(text:string){
  const content=text.trim();if(!content)return;voice.interrupt();request.current?.abort();request.current=null;setBusy(false);
  const sentReferences=activeReferences.map(ref=>({...ref}));
  addMessage('user',content,context,{references:sentReferences});setCaption(content);setInput('');setComposerHeight(36);setComposerExpanded(false);
  if(/^(打开|看看|查看|进入)(会前预审|月初任务制定|月度目标|月初目标)/.test(content)){const id=/会前/.test(content)?(/workshop|M1B/i.test(content)?'preflight-workshop':'preflight-product'):'monthly';const card=document.querySelector<HTMLElement>(`[data-heavy-notice="${id}"]`);card?.scrollIntoView({block:'nearest',behavior:reduced()?'instant':'smooth'});card?.click();setCaption('已打开对应材料，可以继续讨论。');return;}
  const progressCommand=resolveProgressCommand(content,view);
  if(progressCommand){
   if(heavyNotice)closeHeavy();if(view)closeView();else if(sheet)closeSheet();
   if(progressCommand.zone){const id=progressCommand.zone;setBattlefieldDisplay(previous=>({...previous,overrides:{...previous.overrides,[id]:progressCommand.mode}}));}
   else displayBattlefields(progressCommand.mode);
   const target=progressCommand.zone;
   requestAnimationFrame(()=>main.current?.querySelector(`[data-testid="${target?`zone-${target}`:'battlefield-toolbar'}"]`)?.scrollIntoView({block:'nearest',behavior:reduced()?'instant':'smooth'}));
   respond(progressCommand.mode==='decisions'?'已回到待决策。':target?`已翻到${zones.find(z=>z.id===target)?.name}的进展。这里展示的是演练数据与评估。`:'已展示各战场进展。这里展示的是演练数据与评估。');return;
  }
  const command=sentReferences.length?{kind:'unknown' as const}:resolveCommand(content,view,currentIssue);
  if(command.kind==='home'){if(historyScope)closeHistory();if(heavyNotice)closeHeavy();if(view)closeView();else if(sheet)closeSheet();respond('已回到公司全局。');return;}
  if(command.kind==='close'){if(historyScope)closeHistory();else if(sheet)closeSheet();else if(heavyNotice){closeHeavy();return;}else closeView();respond('已收起。');return;}
  if(command.kind==='history'){openHistory();respond(`这是“${contextLabel}”的对话记录。`);return;}
  if(command.kind==='mute'){if(voice.muted!==command.muted)voice.toggleMuted();setCaption(command.muted?'已静音，接下来用文字回答。':'已恢复声音。');addMessage('assistant',command.muted?'已静音，接下来用文字回答。':'已恢复声音。',context);return;}
  if(command.kind==='view'){openView(command.view,undefined,command.section);const zone=zones.find(z=>z.id===command.view);respond(command.section==='issues'&&zone?zone.issues.length?`${zone.name}目前在讨论：${zone.issues.map(k=>issues[k].title).join('；')}。我已定位到对应位置。`:`${zone.name}还没有列入案例的研究议题。`:command.section==='goals'&&zone?`已打开目标。六个月目标：${zone.ltco}本月目标：${zone.monthly}`:`已打开${zone?.name||({radar:'雷达信号',capabilities:'公司能力',strategy:'公司战略议题'} as Record<string,string>)[command.view]}。`);return;}
  if(command.kind==='issue'){openSheet({kind:command.research?'research':'issue',id:command.issue});setCaption(issues[command.issue].judgment);addMessage('assistant',issues[command.issue].judgment,`issue:${command.issue}`);voice.speak(issues[command.issue].judgment);return;}
  if(/^(?:请|帮我|现在|就)?(?:确认(?:此|这个|该)?决定|拍板|下发|停掉|暂停|取消战役|增加预算)/.test(content)){respond('我先保留这条意见。涉及正式变化，请核对具体对象、内容与版本后，在对应确认卡上确认；这句话不会直接下发。');return;}
  if(sentReferences.length)openHistory({key:'global',label:'公司全局',kind:'global'});
  const controller=new AbortController();request.current=controller;setBusy(true);setActivity({started:Date.now(),stage:'thinking'});
  const timeout=setTimeout(()=>controller.abort(),95000);
  try{
   const localIssue=conversation.kind==='issue'?currentIssue:null;
   const localSignal=conversation.kind==='signal'?radarSignal:undefined;
   const localNotice=conversation.kind==='material'?heavyNotice:null;
   const localCampaign=conversation.kind==='campaign'?activeCampaign:null;
   const localView=conversation.kind==='view'?view:null;
   const focusedZone=localView?zones.find(item=>item.id===localView):undefined;
   const focusedIssueIds=localView==='strategy'?strategyIds:localView==='capabilities'?capabilityIssueGroups.flatMap(group=>group.issues):focusedZone?.issues??[];
   const discussionMeeting=localNotice?todayMeetings.find(meeting=>meeting.reviewId===localNotice):undefined;
   const meetingMaterials=discussionMeeting?`${discussionMeeting.title} · ${discussionMeeting.time}\n${discussionMeeting.summary}\n${discussionMeeting.issueIds.map(id=>{const issue=issues[id];return `${issue.title}\n当前判断：${issue.judgment}\n依据：${issue.evidence.join('；')}\n尚未弄清：${issue.unknown}`;}).join('\n\n')}`:null;
    const chatContext={
     prototype:true,
     focus:{key:conversation.key,title:conversation.label,kind:conversation.kind,attention:'primary'},
     missionProgress:globalContext?{snapshots:missionSnapshots,assessments:missionAssessments}:null,
    radarContext:view==='radar'&&localSignal?{...localSignal,excerpt:localSignal.excerpt.slice(0,2500)}:null,
     radarIssues:globalContext||localView==='radar'?radar.data?.signals.filter(s=>s.issue?.status==='pending').slice(0,12).map(s=>({id:s.id,title:s.issue?.title,fields:s.issue?.fields})):[],
     battlefieldDisplay,progressSnapshots:globalContext||focusedZone?battlefieldProgress:null,currentView:contextLabel,
     activeMaterials:localNotice?meetingMaterials||heavyMaterialRef.current[localNotice]||heavyMaterials[localNotice]:null,
     activeCampaign:localCampaign,
     decisions,currentIssue:localIssue?issues[localIssue]:null,
     zones:globalContext?zones.map(z=>({name:z.name,ltco:z.ltco,monthly:z.monthly,campaigns:z.campaigns})):focusedZone?[{name:focusedZone.name,ltco:focusedZone.ltco,monthly:focusedZone.monthly,campaigns:focusedZone.campaigns}]:[],
     issues:globalContext?Object.values(issues).map(({title,scope,judgment})=>({title,scope,judgment})):focusedIssueIds.map(id=>{const item=issues[id];return {title:item.title,scope:item.scope,judgment:item.judgment};}),
   };
   const res=await fetch('/api/warmap-chat',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/x-ndjson'},signal:controller.signal,body:JSON.stringify({message:content,references:sentReferences,context:JSON.stringify(chatContext),history:messages.filter(m=>m.context===context).slice(-8).map(m=>({role:m.role,content:(m.content+(m.references?.length?`\n此条消息引用：${m.references.map(ref=>ref.title).join('；')}`:'')).slice(0,2000)}))})});
   const result=await readChatReply(res,stage=>{if(mounted.current&&request.current===controller)setActivity(previous=>({...previous,stage}));});if(!mounted.current||request.current!==controller)return;
   respond(result.text,{ms:result.ms,research:result.research});
  }catch(error){if(!mounted.current||request.current!==controller)return;const message=error instanceof Error&&error.name==='AbortError'?'这次回答等待较久，已停止。你仍可以打开战场、查看目标或研究已有议题。':'对话服务暂时没有接通。页面操作仍可用；可以试试“看看灯塔项目正在研究什么议题”。';setCaption(message);addMessage('assistant',message,context);}
  finally{clearTimeout(timeout);if(mounted.current&&request.current===controller)setBusy(false);}
 }
 const stopThinking=()=>{request.current?.abort();request.current=null;setBusy(false);addMessage('assistant','已停止本次回答。',context);};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();transition.current?.cancel();sheetAnimation.current?.cancel();};},[]);
 useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.defaultPrevented||event.key!=='Escape')return;if(keyboard){toggleKeyboard();}else if(historyScope){closeHistory();}else if(sheet){closeSheet();}else if(heavyNotice){closeHeavy();}else if(view){closeView();}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);});
 useEffect(()=>{sendRef.current=text=>void send(text);});
 const launchIssue=(id:IssueId)=>openSheet({kind:'issue',id});
 const handleLeadingControl=()=>{
  if(voice.active){voice.toggleMuted();return;}
  if(historyScope){closeHistory();return;}
  openHistory();
 };
 const renderIssue=(id:IssueId)=> <div key={id} className={s.referenceRow}><button className={s.issueRow} key={id} onClick={()=>launchIssue(id)}><span aria-hidden className={s.orangeDot}/><span>{issues[id].title}</span><ArrowUpRight size={15}/></button><ReferenceButton item={issueReference(id,decisions[id])}/></div>;
 const renderCampaign=(campaign:Campaign,detail=false)=> <div key={campaign.id} className={s.referenceRow}><button key={campaign.id} className={cn(s.campaign,detail&&s.campaignDetail)} onClick={()=>openSheet({kind:'campaign',campaign})}><span className={s.campaignName}><span className={s.sphere}/>{campaign.name}<span className={s.achievement}>{campaign.achieved}</span><ArrowUpRight size={15}/></span><span className={s.focus}>{campaign.focus}</span></button></div>;
 const zone=zones.find(z=>z.id===view);
 const activeMeeting=heavyNotice&&heavyNotice!=='monthly'?todayMeetings.find(meeting=>meeting.reviewId===heavyNotice):undefined;
 const historyMessages=messages.filter(message=>message.context===context);

 return <CardReferenceContext.Provider value={{items:references,toggle:toggleReference,refresh:refreshReference}}><div className={s.shell} data-arriving={entryVisible} data-detail-open={!!view||!!currentIssue||!!heavyNotice} data-issue-open={!!currentIssue} data-testid="ceo-workspace">
  <div className={cn(s.mainArea,sheet&&!currentIssue&&s.mainBehindSheet)} ref={main}>
   <div className={s.foldMaterialSurface}><FoldMaterialDesk completions={heavyCompletions} onOpen={openHeavyNotice}/></div>
   <div className={s.homeSurface} aria-hidden={!!view||!!heavyNotice||!!currentIssue} inert={!!view||!!heavyNotice||!!currentIssue}>
    {decisionsReady&&<HomeBoard onMissionAssessment={receiveMissionAssessment} radar={radar.data} onRadarSignal={openRadarSignal} display={battlefieldDisplay} onDisplayMode={displayBattlefields} onFlipZone={flipBattlefield} decisions={decisions} activeIssue={currentIssue} onOpenView={openView} onOpenIssue={launchIssue}/>}
   </div>
    {view&&!heavyNotice&&<div className={s.expanded} aria-hidden={!!currentIssue} inert={!!currentIssue} ref={expanded} data-testid="expanded-panel" aria-label={zone?.name||contextLabel}>
     <header className={s.expandedHeader}><h1>{view==='radar'?'雷达信号':zone?.name.replace('战场','')||contextLabel}</h1><button data-close-view onClick={closeView} className={s.closeRound} aria-label="返回全局" disabled={closing}><X size={23}/></button></header>
    <div className={s.expandedScroll} data-radar-reader-layout={view==='radar'&&!!radarSignal}>
      {zone?<><div className={s.zoneDetailLead}><span>{zone.owner}</span><p>{zone.position||'目标与判断'}</p></div><section className={s.goals} data-section="goals"><div><span>LTCO · 6个月公司目标</span><p>{zone.ltco}</p></div><div><span>当前月度目标</span><p>{zone.monthly}</p></div><small>{zone.placeholder?'等待提供真实目标。':'案例目标草案 · 用于交互评审，未作为公司生效目标'}</small></section><section><h2 className={s.sectionTitle}>当前战役</h2><div className={s.detailCampaigns}>{zone.campaigns.length?zone.campaigns.map(c=>renderCampaign(c,true)):<p className={s.empty}>当前尚未提供战役。可以通过对话梳理，但不会自动创建。</p>}</div></section><section data-section="issues" className={s.researchSection}><h2 className={s.sectionTitle}>正在研究的议题</h2>{zone.issues.length?zone.issues.map(renderIssue):<p className={s.empty}>这个战场尚未提供研究议题。</p>}{zone.id==='lighthouse'&&promoted&&renderIssue('voice')}<RadarIssueRows signals={radar.data?.signals??[]} location={zone.id} onSelect={openRadarSignal}/></section>{zone.id==='lighthouse'&&<section><h2 className={s.sectionTitle}>负责人正在判断</h2><button className={s.ownerQuestion} onClick={()=>{openSheet({kind:'campaign',campaign:zone.campaigns[1]});setCaption('这是负责人在当前目标边界内的产品切入选择。');}}>CEO Agent 与 DRI Agent 应该捆绑销售还是分别切入？<ArrowUpRight size={16}/></button></section>}</>:view==='strategy'?<><p className={s.sectionIntro}>决定公司下一步的方向与投入。</p><section data-section="issues">{strategyIds.map(renderIssue)}<RadarIssueRows signals={radar.data?.signals??[]} location="strategy" onSelect={openRadarSignal}/></section><p className={s.contextNote}>议题分类规则仍在讨论；这些案例不代表已经确认的新战略。</p></>:view==='capabilities'?<section data-section="issues"><CapabilityIssues visible={id=>!decisions[id]} renderIssue={id=><CapabilityIssueButton id={id} onOpen={launchIssue}/>}/></section>:<RadarFeed data={radar.data} error={radar.error} act={radar.act} selected={radarSelected} onSelect={id=>{setHistoryScope(null);setRadarSelected(id);setCaption('');request.current?.abort();setBusy(false);}}/>}
    </div>
   </div>}
     {activeMeeting?<MeetingWorkspace key={activeMeeting.id} meeting={activeMeeting} onCloseStart={beginMaterialClose} onClose={()=>{setHeavyNotice(null);setHeavyClosing(false);}} onComplete={completeHeavy} onDecision={commitDecision} decisions={decisions}/>:heavyNotice==='monthly'?<HeavyWorkspace key={heavyNotice} notice={heavyNotice} onCloseStart={beginMaterialClose} onClose={()=>{setHeavyNotice(null);setHeavyClosing(false);}} onComplete={completeHeavy} onMaterialsChange={updateHeavyMaterials} onDirty={invalidateHeavy}/>:null}
  </div>
  <div className={s.notificationArea} data-testid="notification-only"><NotificationRail onHome={()=>{voice.interrupt();setCaption('');if(sheet)closeSheet();if(heavyNotice)closeHeavy();if(view)closeView();}} homeActive={!sheet&&!heavyNotice&&!view} radarSignals={radar.data?.signals} onRadarSignal={openRadarSignal} decisions={decisions} onDecision={commitDecision} onUndoDecision={undoDecision} heavyNotice={heavyNotice} heavyCompletions={heavyCompletions} onOpenHeavy={openHeavyNotice} onPromote={()=>setPromoted(true)} onUndoPromote={()=>setPromoted(false)} onNoticeCaption={text=>setNoticeToast(text)}/></div>
  {noticeToast&&<div className={s.noticeToast} role="status"><Check size={15}/>{noticeToast}</div>}
  {historyScope&&<button type="button" className={s.historyBackdrop} data-testid="conversation-backdrop" aria-label="关闭对话记录" onClick={closeHistory}/>}
  {currentIssue&&<IssueWorkspace key={currentIssue} id={currentIssue} initialResearch={sheet?.kind==='research'} panelRef={sheetElement} closing={sheetClosing} onClose={closeSheet} receipt={decisions[currentIssue]} onAsk={text=>void send(text)} onQuote={text=>{setKeyboard(true);setInput(`关于“${text}”，`);requestAnimationFrame(()=>inputElement.current?.focus({preventScroll:true}));}}/>}
  {sheet?.kind==='campaign'&&<section className={s.sheet} ref={sheetElement} role="dialog" aria-modal="false" aria-label={sheet.campaign.name} data-testid="conversation-sheet">
   <div className={s.sheetHandle} aria-hidden/><header className={s.sheetHeader}><div><small>当前战役</small><h2>{sheet.campaign.name}</h2></div><button data-close-sheet onClick={closeSheet} aria-label="收起战役详情" disabled={sheetClosing}><ChevronDown size={24}/></button></header>
   <div className={s.sheetScroll}><p className={s.resultLine}><Check size={16}/>{sheet.campaign.achieved}</p><h3>{sheet.campaign.focus}</h3><p>{sheet.campaign.judgment}</p><blockquote>{sheet.campaign.evidence}</blockquote><h3>还没弄清的</h3><p>{sheet.campaign.unknown}</p><button className={s.sheetAction} onClick={()=>{setKeyboard(true);setInput(`关于${sheet.campaign.name}，`);setTimeout(()=>inputElement.current?.focus(),80);}}>继续追问<CornerDownLeft size={15}/></button></div>
  </section>}
  {historyScope&&<section className={cn(s.sheet,s.historySheet)} role="dialog" aria-modal="false" aria-label={`${contextLabel}的对话记录`} data-testid="conversation-sheet">
   <div className={s.sheetHandle} aria-hidden/><header className={s.sheetHeader}><div className={s.chatBrand}><TianshuMark className={s.chatBrandMark}/><div><small>独立对话 · {contextLabel}</small><h2>天枢</h2></div></div><button onClick={closeHistory} aria-label="收起对话记录"><ChevronDown size={24}/></button></header>
   <div className={s.sheetScroll}><div className={s.historyContent}>{historyMessages.length?historyMessages.map(message=><ConversationTurn key={message.id} message={message}/>):<div className={s.chatWelcome}><p>{globalContext?'从你正在想的事情开始。':`从“${contextLabel}”里你最想弄清的地方开始。`}</p>{globalContext&&<><button onClick={()=>void send('看看灯塔项目目前正在研究什么议题')}>看看灯塔项目正在研究什么议题<ArrowUpRight size={16}/></button><button onClick={()=>void send('研究一下灯塔是否必须验证客户付费')}>研究一下灯塔是否必须验证客户付费<ArrowUpRight size={16}/></button></>}</div>}{busy&&<ConversationThinking activity={activity} onStop={stopThinking}/>}<div ref={transcriptEnd}/></div></div>
  </section>}
  <div ref={dockLayer} className={d.layer} data-testid="global-controls" data-conversation-context={context} data-has-references={hasActiveReferences} data-history-open={!!historyScope} data-scoped-context={!globalContext||pendingGlobalReferences}>
   {(!globalContext||pendingGlobalReferences)&&<div className={cn(d.contextLabel,pendingGlobalReferences&&d.referenceContext)}>
    {!globalContext&&<span title={contextLabel}>当前{conversation.kind==='issue'?'议题':conversation.kind==='signal'?'信号':conversation.kind==='material'?'材料':conversation.kind==='campaign'?'战役':'范围'} · {contextLabel}</span>}
    {pendingGlobalReferences&&<button type="button" onClick={discussGlobalReferences} disabled={sheetClosing} data-testid="discuss-global-references" aria-label={`在全局讨论已引用的 ${references.length} 张卡片`} title={references.map(ref=>ref.title).join('\n')}>在全局讨论 · {references.length}<ArrowUpRight size={12}/></button>}
   </div>}
   {(caption||voice.error||busy)&&<button className={d.caption} onClick={()=>openHistory()} aria-label={`查看“${contextLabel}”的完整对话记录`}><span aria-live="polite">{caption||voice.error||last?.content||(activity.stage==='researching'?'正在快速查证…':activity.stage==='answering'?'正在整理回答…':'正在思考…')}</span></button>}
   <div className={cn(d.dock,keyboard&&d.typing,keyboard&&composerExpanded&&d.composerExpanded,voice.active&&d.live,busy&&d.thinking)} data-testid="conversation-dock" data-mode={keyboard?'keyboard':'voice'} data-composer-expanded={composerExpanded} style={keyboard?{height:composerExpanded?composerHeight+(hasActiveReferences?48:12):hasActiveReferences?84:48}:undefined}>
   <ReferenceTray items={activeReferences} onRemove={removeReference} onClear={()=>removeReference()}/>
    <button className={cn(d.iconButton,d.leadingButton)} onClick={handleLeadingControl} aria-label={voice.active?(voice.muted?'取消静音':'静音模型声音'):historyScope?'收起当前对话记录':`查看“${contextLabel}”的对话记录`} aria-pressed={voice.active?voice.muted:undefined} data-voice-active={voice.active} title={voice.active?(voice.muted?'恢复语音播报':'静音语音播报'):historyScope?'收起当前对话记录':`查看“${contextLabel}”的对话记录`}>
     <span className={cn(d.leadingIcon,d.historyIcon)} aria-hidden><History size={20} strokeWidth={1.7}/></span>
     <span className={cn(d.leadingIcon,d.volumeIcon)} aria-hidden>{voice.muted?<VolumeX size={20} strokeWidth={1.7}/>:<Volume2 size={20} strokeWidth={1.7}/>}</span>
    </button>
    <div className={d.content} style={{height:keyboard&&composerExpanded?composerHeight:36}}>
     <div className={d.voiceLayer} aria-hidden={keyboard} inert={keyboard}>
      <button className={d.voiceButton} onClick={()=>{void voice.toggle();}} aria-label={voice.active?'结束语音对话':'开始语音对话'} aria-pressed={voice.active} disabled={voice.status==='正在连接'}><span className={d.wave} aria-hidden><i/><i/><i/><i/><i/></span><span>{voice.status==='正在连接'?'正在连接':busy?'正在思考':voice.active?'实时对话':'开始对话'}</span></button>
     </div>
     <div className={d.textLayer} aria-hidden={!keyboard} inert={!keyboard}>
      <form className={d.inputForm} onSubmit={e=>{e.preventDefault();void send(input);}}><textarea ref={inputElement} rows={1} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key!=='Enter'||e.shiftKey)return;if(e.nativeEvent.isComposing)return;e.preventDefault();e.currentTarget.form?.requestSubmit();}} placeholder={hasActiveReferences?'围绕引用的卡片，聊聊你的判断…':conversation.kind==='issue'?'继续追问这个议题…':conversation.kind==='signal'?'围绕这条信号继续讨论…':conversation.kind==='material'?'围绕这份材料继续讨论…':conversation.kind==='campaign'?'围绕这个战役继续讨论…':'输入你的想法…'} aria-label={globalContext?'全局对话输入':`${contextLabel}对话输入`}/><button className={d.sendButton} type="submit" aria-label={input.trim()?'发送':'输入内容后发送'} data-ready={Boolean(input.trim())} disabled={!input.trim()}><ArrowUp size={19} strokeWidth={2}/></button></form>
     </div>
    </div>
    <button className={cn(d.iconButton,d.modeButton)} onClick={toggleKeyboard} aria-label={keyboard?'切换语音模式':'切换键盘输入'} aria-expanded={keyboard} data-listening={voice.active} title={keyboard?'切换到实时对话':voice.error?'语音暂不可用，使用键盘继续':'切换到键盘输入'}><span className={cn(d.modeIcon,d.keyboardIcon)} aria-hidden><Keyboard size={20} strokeWidth={1.7}/></span><span className={cn(d.modeIcon,d.microphoneIcon)} aria-hidden><Mic size={20} strokeWidth={1.7}/></span></button>
   </div>
  </div>
  {entryVisible?<div className={s.entryCarry} aria-hidden="true" onAnimationEnd={()=>setEntryVisible(false)}/>:null}
 </div></CardReferenceContext.Provider>;
}
