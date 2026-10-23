// 新增 Mission (陈溪南 2026-10-22): Nexus decides that a Mission is asked for and says what in a line; the decoding
// skill writes it in full — result, criteria, tier, dates, risks and 1–6 Task drafts — with the same context a round
// gives a unit, so an added Mission reads like the ones the round generated.
import {createDecodingGateway} from './decoding-gateway.mjs';
import {currentVersion} from './governance.mjs';
import {memberProfiles} from './member-profiles.mjs';
import {missionDraftProblem} from './mission-structure.mjs';
import {capacityFacts} from './round-runner-v3.mjs';
const shape='{gaps:[],mission:{title,owner,tier,time,gate,result,why,checks,boundary,route,risks,tasks:[{title,owner,tier,time,result,checks,effort,stop,dependsOn}]}}';
export function missionDraftRequest(state,{poId,brief,sources=[]}){
 const content=id=>state.cards[id]&&currentVersion(state.cards[id]).content;
 const po=content(poId),input=state.round?.input||{};
 const missions=Object.keys(state.cards).filter(id=>new RegExp(`^${poId}-m\\d+$`).test(id)).map(id=>{const m=content(id);return {title:m.title,owner:m.owner,tier:m.tier,time:m.time,result:m.result,tasks:Object.keys(state.cards).filter(t=>t.startsWith(id+'-t')).map(t=>({title:content(t).title,owner:content(t).owner,time:content(t).time,effort:content(t).effort}))};});
 const review=content('rv:'+poId);
 // What the skill needs to judge load and overlap (Decoding Skill 2026-10-22): each person's planned days against
 // capacity, and every other unit's Missions in one line each.
 const live=(state.round?.units||[]).map(u=>({po:{key:u.id},missions:(u.children||[]).map(m=>({tasks:(m.children||[]).map(t=>({owner:content(t.id)?.owner||t.owner,effort:content(t.id)?.effort||t.effort}))}))}));
 const ownerLoad=capacityFacts(live,{from:input.scheduleFrom||input.businessDate,period:input.period,capacity:input.capacity||{}});
 const otherUnitsMissions=(state.round?.units||[]).filter(u=>u.id!==poId).flatMap(u=>(u.children||[]).map(m=>{const c=content(m.id)||m;return {unit:u.id,title:c.title,owner:c.owner,tier:c.tier};}));
 return [{role:'system',content:'你在给一个已经拆好的单元补一条 Mission。'},{role:'user',content:JSON.stringify({stage:'mission-add',
  task:`为「${po.name||po.title}」（key=${poId}）新增一条 Mission：${brief}。按技能“产品生成整轮候选”里 Mission 和 Task 的写法执行：一条结果线、可核对的验收、档位、起止日期、风险，下面 2–4 个 Task 写清谁在何时交出什么、投入几人日、何时停。不改已有 Mission，也不与它们重复；负责人只能从 people 里选。要的事已在某条 Mission 里、或只是某条的一个阶段时不新增：mission 写 null，在 gaps 写明该并进哪条。返回 ${shape}。`,
  period:input.period,scheduleFrom:input.scheduleFrom||input.businessDate,capacity:input.capacity,
  po:{title:po.title,owner:po.owner,result:po.result,checks:po.checks},existingMissions:missions,
  lastMonthReview:review?{verdict:review.verdict,nextInputs:review.nextInputs}:null,
  discussion:sources.map(s=>({author:s.author,text:s.text})),people:Object.values(memberProfiles).map(p=>p.name),ownerLoad,otherUnitsMissions})}];
}
// One bounded retry when the draft misses a required part; the reason goes back in so it is fixed, not repeated.
export async function draftMission({state,gateway,skill,poId,brief,sources}){
 const decoder=createDecodingGateway(gateway,skill),messages=missionDraftRequest(state,{poId,brief,sources});
 let problem='';
 for(let attempt=0;attempt<2;attempt++){
  const asked=problem?[messages[0],{...messages[1],content:JSON.stringify({...JSON.parse(messages[1].content),previousProblem:problem})}]:messages;
  const result=await decoder.complete(asked,{});
  const answer=JSON.parse(result.answer),mission=answer?.mission,gaps=(Array.isArray(answer?.gaps)?answer.gaps:[answer?.gaps]).map(g=>typeof g==='string'?g:g?.text||g?.note||'').filter(Boolean);
  // The skill decided not to add one (already covered, or only a stage of another): say why in the room, no empty card.
  if(!mission&&gaps.length)return {gaps};
  problem=missionDraftProblem(mission);
  if(!problem)return {mission,providerRequestId:result.providerRequestId,usage:result.usage};
 }
 throw Object.assign(Error(`新增 Mission 起草两次都不完整：${problem}`),{status:502});
}
