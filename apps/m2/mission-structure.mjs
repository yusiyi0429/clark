// 新增 / 撤掉 Mission (陈溪南 2026-10-22). A Mission joins or leaves a PO only through its own revision card, one
// request per card, accepted by the PO's owner like any other card. The PO is not re-confirmed: CEO and the unit DRI
// confirm the result, not the Mission plan beneath it. A withdrawn Mission leaves the plan and the pages but its data
// stays in state.withdrawnMissions, so 「@Nexus 恢复…」 can bring it back with its Tasks.
const list=v=>Array.isArray(v)?v.map(x=>String(x||'').trim()).filter(Boolean):v?[String(v).trim()]:[];
const text=v=>String(v??'').trim();
const tiers=['P0','P1','P2'];
const span=/^\d{4}-\d{2}-\d{2}—\d{4}-\d{2}-\d{2}$/;
const normalTime=t=>text(t).replace(/\s*(?:至|到|~|－|-{1,2}|–)\s*(?=\d{4}-)/,'—');
const bold=(label,v)=>v?[/^\*\*/.test(v)?v:`**${label}：**${v}`]:[];
export const effortDays=effort=>{const r=String(effort||'').match(/(\d+(?:\.\d+)?)(?:\s*[–—~-]\s*(\d+(?:\.\d+)?))?\s*人日/);return r?Number(r[2]||r[1]):0;};
export function findInTree(units,id){
 const walk=(nodes,parent)=>{for(let i=0;i<nodes.length;i++){const n=nodes[i];if(n.id===id)return {node:n,parent,index:i};const found=walk(n.children||[],n);if(found)return found;}return null;};
 return walk(units||[],null);
}
// What the skill wrote, checked the way a round checks a Mission: a title, a result, criteria, an owner, a date span,
// and Tasks that each say who does what by when. Returns the problem in words, or null.
export function missionDraftProblem(draft){
 if(!draft||typeof draft!=='object')return '没有 Mission 内容';
 for(const [f,label] of [['title','标题'],['result','成果'],['owner','负责人']])if(!text(draft[f]))return `Mission 缺少${label}`;
 if(!list(draft.checks).length)return 'Mission 缺少验收';
 if(!span.test(normalTime(draft.time)))return `Mission 时间格式不对：${text(draft.time)||'空'}`;
 const tasks=Array.isArray(draft.tasks)?draft.tasks:[];
 if(tasks.length<1||tasks.length>6)return 'Task 草稿要 1 到 6 个';
 for(const t of tasks){if(!text(t?.title)||!text(t?.result)||!text(t?.owner))return 'Task 缺少标题、成果或负责人';if(!list(t.checks).length)return `Task「${text(t.title)}」缺少验收`;if(!span.test(normalTime(t.time)))return `Task「${text(t.title)}」时间格式不对`;}
 return null;
}
// The skill's Mission becomes the same node shape a generated round has, so every page treats it alike.
export function missionNode(po,number,draft){
 const id=`${po.id}-m${number}`,unit=po.id;
 const tasks=draft.tasks.map(t=>({owner:text(t.owner),title:text(t.title),tier:tiers.includes(t.tier)?t.tier:'P1',time:normalTime(t.time),result:text(t.result),checks:list(t.checks),
  ...(t.effort?{effort:text(t.effort)}:{}),...(t.stop?{stop:text(t.stop)}:{}),dependsOn:list(t.dependsOn)}));
 const risks=list(draft.risks),gate=text(draft.gate);
 return {owner:text(draft.owner),title:text(draft.title),tier:tiers.includes(draft.tier)?draft.tier:'P1',time:normalTime(draft.time),...(gate?{gate}:{}),result:text(draft.result),
  why:bold('贡献',text(draft.why)),checks:list(draft.checks),boundary:list(draft.boundary),upstreamIds:[],...(draft.route?{route:text(draft.route)}:{}),risks,tasks,
  path:bold('路径',text(draft.route)),tradeoff:[],dependencies:risks,milestones:gate&&/^\s*\d{1,2}[/.-]\d{1,2}\s+\S/.test(gate)?[gate]:[],
  id,unit,level:'mission',version:1,status:'候选',
  children:tasks.map((t,i)=>({...t,why:[],boundary:[...(t.effort?[`**投入：**${t.effort}`]:[]),...(t.stop?[`**停止：**${t.stop}`]:[])],activities:[],id:`${id}-t${i+1}`,unit,level:'task',version:1,status:'候选',children:[]}))};
}
// Cards for a node and everything under it, as createCollaborationState makes them.
function cardsOf(node,parentId,now){
 const out={};const visit=(n,p)=>{const {children,missions,tasks,activities,...content}=n;out[n.id]={...content,parentId:p,versions:[{number:1,content:structuredClone(content),author:'Nexus',signatures:[],createdAt:now}],confirmedVersion:null};(children||[]).forEach(c=>visit(c,n.id));};
 visit(node,parentId);return out;
}
const idsUnder=node=>{const ids=[];const walk=n=>{ids.push(n.id);(n.children||[]).forEach(walk);};walk(node);return ids;};
export const missionDays=node=>(node.children||[]).reduce((sum,t)=>sum+effortDays(t.effort),0);
// Numbers never reuse a withdrawn Mission's id, so a restored one comes back under its own name.
export function nextMissionNumber(state,poId){
 const used=[...Object.keys(state.cards||{}),...(state.withdrawnMissions||[]).map(w=>w.id)].map(id=>id.match(new RegExp(`^${poId}-m(\\d+)$`))?.[1]).filter(Boolean).map(Number);
 return Math.max(0,...used)+1;
}
export function addMission(state,poId,draft,{now=new Date().toISOString()}={}){
 const at=findInTree(state.round?.units,poId);if(!at||at.node.level!=='po')throw Object.assign(Error('找不到要挂的 PO'),{status:409});
 const problem=missionDraftProblem(draft);if(problem)throw Object.assign(Error(problem),{status:400});
 const node=missionNode(at.node,nextMissionNumber(state,poId),draft);
 at.node.children.push(node);at.node.missions=[...(at.node.missions||[]),{...node,children:undefined}];
 Object.assign(state.cards,cardsOf(node,poId,now));
 state.round.structureVersion=(state.round.structureVersion||0)+1;
 return node;
}
export function withdrawMission(state,missionId,{by,reason='',now=new Date().toISOString()}={}){
 const at=findInTree(state.round?.units,missionId);if(!at||at.node.level!=='mission')throw Object.assign(Error('找不到这条 Mission，可能已经撤掉'),{status:409});
 const ids=idsUnder(at.node),cards=Object.fromEntries(ids.filter(id=>state.cards[id]).map(id=>[id,state.cards[id]]));
 at.parent.children.splice(at.index,1);at.parent.missions=(at.parent.missions||[]).filter(m=>m.id!==missionId&&m.title!==at.node.title);
 for(const id of ids)delete state.cards[id];
 for(const p of state.proposals||[])if(p.status==='pending'&&(ids.includes(p.cardId)||p.missionId&&ids.includes(p.missionId)))p.status='superseded';
 (state.withdrawnMissions??=[]).push({id:missionId,parentId:at.parent.id,index:at.index,node:at.node,cards,by,reason,at:now});
 state.round.structureVersion=(state.round.structureVersion||0)+1;
 return at.node;
}
export function restoreMission(state,missionId){
 const i=(state.withdrawnMissions||[]).findIndex(w=>w.id===missionId);if(i<0)throw Object.assign(Error('没有这条撤掉的 Mission'),{status:409});
 const w=state.withdrawnMissions[i],at=findInTree(state.round?.units,w.parentId);if(!at)throw Object.assign(Error('它原来的 PO 已不在本轮'),{status:409});
 at.node.children.splice(Math.min(w.index,at.node.children.length),0,w.node);at.node.missions=[...(at.node.missions||[]),{...w.node,children:undefined}];
 Object.assign(state.cards,w.cards);state.withdrawnMissions.splice(i,1);
 state.round.structureVersion=(state.round.structureVersion||0)+1;
 return w.node;
}
// For Nexus: what this unit withdrew, so it can be named and brought back.
export const withdrawnFor=(state,unit)=>(state.withdrawnMissions||[]).filter(w=>w.node.unit===unit).map(w=>({id:w.id,title:w.node.title,owner:w.node.owner,tier:w.node.tier,tasks:(w.node.children||[]).length,withdrawnAt:w.at,reason:w.reason}));
