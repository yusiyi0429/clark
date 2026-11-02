// Deterministic audit of an existing frozen job. No gateway or state writer.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {buildReviewCheckPlan,restoreSourceText,planSourceFollowups,reviewModelRequestBody} from '../apps/m2/review-source-plan.mjs';
const path=process.argv[2];if(!path)throw Error('Usage: node tools/m2-review-source-plan-audit.mjs <private-frozen-job>');
const work=JSON.parse(await readFile(path,'utf8')),requests=Object.values(work.run.quality.requests).filter(r=>r.stage==='check'),original=requests[0].payload;
const system=requests[0].attempts?.[0]?.system;
// The source job stores the skill identity; load only the same checked-in rules.
import {loadReviewSkill,reviewQualityTasks,runReviewSkill} from '../apps/m2/review-generation.mjs';
const skill=await loadReviewSkill(new URL('../apps/m2/review-skill/',import.meta.url));assert.equal(skill.hash,work.skillSnapshot.hash);
const rules=`你是 TKOS 的月度复盘助手。按下面的技能工作。仅返回有效 JSON 对象，不加代码围栏。\n${skill.rules}`;
const tasks=reviewQualityTasks(skill),summaries=[];
for(const model of ['wangsu/claude-sonnet-5-5','aliyun/deepseek-v4.1-flash']){
 const args={maxTargetRefs:3,input:work.input,sources:original.sources,reviews:work.run.reviews,programFacts:original.programFacts,tasks,system:system||rules,wireOptions:{model,thinking:true,reasoningEffort:'high',maxTokens:32000,json:true}},plan=buildReviewCheckPlan(args);
 const refs=new Set(plan.packets.flatMap(p=>p.scope.targetRefs)),edges=new Set(plan.packets.flatMap(p=>p.scope.edges.map(e=>e.parentRef+'>'+e.childRef)));
 assert.equal(refs.size,28);assert.equal(edges.size,27);
 for(const packet of plan.packets){const payload=packet.payloads[0];assert.deepEqual(restoreSourceText({sources:payload.sources,texts:payload.sourceTexts,bindings:payload.sourceBindings,originalHash:packet.originalHash}),Object.fromEntries(packet.scope.sourceRefs.map(ref=>[ref,args.sources[ref]])));assert.equal(payload.reviews.length,28);assert.ok(packet.maxBodyBytes<=512*1024);}
 const responses=[];for(const pair of [['agents','tokenhub'],['method','bf01']]){
  const packetIndex=plan.packets.findIndex(p=>p.scope.targetRefs.includes(pair[0])&&!p.scope.sourceRefs.includes(pair[1]));assert.ok(packetIndex>=0);const p=plan.packets[packetIndex];
  for(let group=0;group<3;group++)responses.push({packetIndex,group,value:{issues:[],checkedRefs:p.scope.targetRefs,checkedEdges:p.scope.edges,sourceRequests:[{refs:pair,relation:'指定原文跨单元归属核对',reason:'只按冻结原文核对，不预判结论'}]}});
 }
 const extra=planSourceFollowups({plan,args,responses,maxAdditionalRequests:6});assert.equal(extra.length,6);
 for(const call of extra){const p=call.packet,payload=call.payload;assert.deepEqual(restoreSourceText({sources:payload.sources,texts:payload.sourceTexts,bindings:payload.sourceBindings,originalHash:p.originalHash}),Object.fromEntries(p.scope.sourceRefs.map(ref=>[ref,args.sources[ref]])));assert.ok(call.refs.every(ref=>p.scope.sourceRefs.includes(ref)));assert.ok(call.bodyBytes<=512*1024);}
 assert.throws(()=>planSourceFollowups({plan,args,responses,maxAdditionalRequests:5}),e=>e.code==='REVIEW_SOURCE_REQUEST_BUDGET');
 assert.throws(()=>planSourceFollowups({plan,args,responses,maxAdditionalRequests:6,providedKeys:extra.map(x=>x.key)}),e=>e.code==='REVIEW_SOURCE_REQUEST_REPEAT');
 let calls=0,initial=0,active=0,maxConcurrency=0,maxRuntimeBody=0;
 const run=structuredClone(work.run),gateway={status:{model},complete:async messages=>{
  const payload=JSON.parse(messages[1].content);calls++;if(payload.unit){initial++;throw Error('Unexpected initial generation or semantic repair in deterministic no-issue audit');}
  active++;maxConcurrency=Math.max(maxConcurrency,active);await new Promise(resolve=>setTimeout(resolve,1));active--;
  maxRuntimeBody=Math.max(maxRuntimeBody,Buffer.byteLength(JSON.stringify(reviewModelRequestBody(messages[0].content,payload,args.wireOptions))));
  const sourceRequests=[];for(const pair of [['agents','tokenhub'],['method','bf01']])if(payload.scope.kind==='object'&&payload.scope.targetRefs.includes(pair[0])&&!payload.scope.sourceRefs.includes(pair[1]))sourceRequests.push({refs:pair,relation:'指定原文跨单元归属核对',reason:'只按冻结原文核对，不预判结论'});
  return {answer:JSON.stringify({issues:[],checkedRefs:payload.scope.targetRefs,checkedEdges:payload.scope.edges,sourceRequests,sourceRequestAnswers:payload.sourceRequestContext?.requests.map(r=>({requestId:r.requestId,conclusion:'确定性接线fixture，不构成真实内容判断'}))})};
 }};
 await runReviewSkill({gateway,skill,input:work.input,run,save:async()=>{}});assert.equal(run.quality.status,'passed');assert.equal(calls,36);assert.equal(initial,0);assert.equal(maxConcurrency,3);assert.ok(maxRuntimeBody<=512*1024);
 for(const [key,raw]of Object.entries(work.run.raw))assert.equal(run.raw[key],raw);
 const old=Buffer.byteLength(JSON.stringify(reviewModelRequestBody(args.system,original,args.wireOptions)));
 summaries.push({model,skillHash:skill.hash,objects:refs.size,edges:edges.size,groups:3,basePackets:plan.packets.length,baseCalls:plan.requestCount,maxBaseBodyBytes:Math.max(...plan.packets.map(p=>p.maxBodyBytes)),oldWholeBodyBytes:old,additionalCalls:extra.length,maxAdditionalBodyBytes:Math.max(...extra.map(x=>x.bodyBytes)),perPassHardMaximum:plan.requestCount+6,maxThreePassCheckerCalls:(plan.requestCount+6)*3,maxThreePassCheckerHttpAttempts:(plan.requestCount+6)*3*3,maxRepairCalls:28*2,maxTotalLogicalCalls:(plan.requestCount+6)*3+28*2,maxTotalHttpAttempts:((plan.requestCount+6)*3+28*2)*3,initialDraftCalls:0,mockRuntime:{calls,initial,maxConcurrency,maxRuntimeBody,status:run.quality.status}});
}
console.log(JSON.stringify({paidCalls:0,businessWrites:0,wholeSourceEqual:true,results:summaries},null,2));
