// On-demand Activity Plan for one Task (template v0.3: a round stops at Task; the Task's people ask for Activities when they need them).
// How to split a Task comes from the skill; this module only builds the request, checks the shape and attaches the result.
import {currentVersion,unitOf} from './governance.mjs';
import {domainContext} from './round-context.mjs';
import {checkCard} from './round-runner.mjs';
import {ownerName} from './owner-name.mjs';
import {parseRoundJSON} from './round-retry.mjs';

const content=(state,id)=>currentVersion(state.cards[id]).content;
const missionOf=taskId=>taskId.split('-t')[0];
export function canGenerateActivities(actor,state,taskId){
 const card=state.cards[taskId];if(!actor||card?.level!=='task')return false;
 return Boolean(actor.ceo||(actor.unitDri||[]).includes(unitOf(card))||(actor.missionDri||[]).includes(missionOf(taskId))||ownerName(content(state,taskId).owner)===actor.name);
}
export function activityRequest(state,taskId){
 const task=content(state,taskId),missionId=missionOf(taskId),mission=content(state,missionId),unit=unitOf(state.cards[taskId]),po=content(state,unit);
 const brief=v=>({title:v.title,owner:v.owner,time:v.time,result:v.result});
 const siblings=Object.values(state.cards).filter(c=>c.level==='task'&&c.parentId===missionId&&c.id!==taskId).map(c=>brief(currentVersion(c).content));
 return {
  stage:'activity-generate',
  task:`为 Task「${task.title}」生成 Activity Plan：按技能“按需生成 Activity”执行（技能没有这一节时按 method.md 第 6 节和 contracts.md 的 Activity 定义）。这个 Task 交给执行人就能直接做时，返回 directlyExecutable:true 和空数组，并在 gaps 里写一句理由。返回 {directlyExecutable:boolean,activities:[{type:"Agent Activity|Human Activity|Human Checkpoint",title,owner,result,checks:[],time,inputs:[],rollback:[]}],gaps:[]}；owner 写执行主体（人写名单中的姓名，Agent 写 Agent 名称）；time 落在 Task 时间之内。`,
  key:unit,
  taskCard:{title:task.title,owner:task.owner,result:task.result,time:task.time,checks:task.checks,boundary:task.boundary,dependsOn:task.dependsOn},
  mission:{title:mission.title,owner:mission.owner,result:mission.result,time:mission.time,checks:mission.checks},
  po:{title:po.title,result:po.result},
  siblingTasks:siblings,
  context:domainContext(state.round?.input||{},unit).filter(s=>[unit,'company','organization'].includes(s.key)),
 };
}
const text=v=>v==null?undefined:Array.isArray(v)?v.map(x=>typeof x==='string'?x:JSON.stringify(x)):typeof v==='string'?v:JSON.stringify(v);
export function readActivities(answerText){
 const answer=parseRoundJSON(answerText);
 const list=Array.isArray(answer.activities)?answer.activities:[];
 if(!list.length&&answer.directlyExecutable!==true)throw Error('模型没有给出 Activity，也没有说明可以直接执行');
 const activities=list.map(a=>{const c={...a,inputs:text(a.inputs),rollback:text(a.rollback)};checkCard(c,3,{preserveOwners:true});return Object.fromEntries(['type','title','owner','result','checks','time','inputs','rollback','why','boundary'].filter(k=>c[k]!==undefined).map(k=>[k,c[k]]));});
 return {activities,directlyExecutable:answer.directlyExecutable===true&&!list.length,gaps:Array.isArray(answer.gaps)?answer.gaps.map(String):[]};
}
// New Activity cards go under the Task in both the card store and the round tree, as candidates.
export function attachActivities(previous,taskId,activities,author='Nexus'){
 const state=structuredClone(previous),task=state.cards[taskId],unit=unitOf(task);
 const visit=n=>n.id===taskId?n:(n.children||[]).map(visit).find(Boolean);
 const node=(state.round?.units||[]).map(visit).find(Boolean);
 if(!node)throw Error('当前轮次里找不到这个 Task');
 const start=(node.children||[]).length,createdAt=new Date().toISOString();
 activities.forEach((a,k)=>{
  const id=`${taskId}-a${start+k+1}`,card={...a,id,unit,level:'activity',version:1,status:'候选'};
  state.cards[id]={...card,parentId:taskId,versions:[{number:1,content:structuredClone(card),author,signatures:[],createdAt}],confirmedVersion:null};
  (node.children??=[]).push({...card,children:[]});
 });
 state.sequence=(state.sequence||0)+1;
 return state;
}
