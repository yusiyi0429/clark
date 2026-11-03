import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fullContextCheckContract,buildReviewCheckPlan,refreshReviewCheckPlan,verifyReviewCheckPlan,executeReviewCheckPlan,restoreSourceText,validateScopedCheckResult} from './review-source-plan.mjs';
const fixture=(count=28)=>{
 const items=Array.from({length:count},(_,i)=>({id:'ref'+String(i).padStart(2,'0'),children:i===0?Array.from({length:count-1},(_,j)=>'ref'+String(j+1).padStart(2,'0')):[]}));
 const input={stages:[items],engineeringContracts:{checkerSources:2,fullContextCheck:fullContextCheckContract(items.map(c=>c.id))}};
 const sources=Object.fromEntries(items.map(c=>[c.id,{id:c.id,evidence:[{id:'E1',namespace:c.id,text:'完整原始正文与日期，不能丢失。'.repeat(100)}]}]));
 return {input,sources,reviews:Object.fromEntries(items.map(c=>[c.id,{ref:c.id,verdict:'部分达成'}])),programFacts:{perReview:Object.fromEntries(items.map(c=>[c.id,{length:123}])),verdictFacts:['all'],askLoad:['all']},tasks:['一JSON','二JSON','三JSON'],system:'规则JSON',maxBodyBytes:2*1024*1024,maxTargetRefs:count};
};
const ok=packet=>({issues:[],checkedRefs:[...packet.scope.targetRefs],checkedEdges:structuredClone(packet.scope.edges),sourceRequests:[]});
test('frozen two packets retain all raw sources, candidates and facts; every group covers each target/edge exactly once',()=>{
 const args=fixture(),plan=buildReviewCheckPlan(args);assert.equal(plan.requestCount,6);assert.equal(plan.maxConcurrency,6);assert.equal(plan.packets.length,2);
 assert.deepEqual(plan.layout,args.input.engineeringContracts.fullContextCheck.layout);
 for(let group=0;group<3;group++){
  const refs=plan.packets.flatMap(p=>p.payloads[group].scope.targetRefs),edges=plan.packets.flatMap(p=>p.payloads[group].scope.edges.map(e=>JSON.stringify(e)));
  assert.equal(refs.length,28);assert.equal(new Set(refs).size,28);assert.equal(edges.length,27);assert.equal(new Set(edges).size,27);
  for(const p of plan.packets){const value=p.payloads[group];assert.deepEqual(value.reviews,Object.values(args.reviews));assert.deepEqual(value.programFacts,args.programFacts);assert.deepEqual(value.allowedSourceRefs,Object.keys(args.sources));assert.deepEqual(restoreSourceText({sources:value.sources,texts:value.sourceTexts,bindings:value.sourceBindings,originalHash:p.originalHash}),args.sources);assert.equal(value.sourceHash,plan.sourceHash);assert.equal(value.candidateHash,plan.candidateHash);assert.ok(p.maxBodyBytes<=plan.maxBodyBytes);}
 }
 const refreshed=refreshReviewCheckPlan(plan,{...args,reviews:{...args.reviews,ref01:{ref:'ref01',verdict:'达成'}}});assert.deepEqual(refreshed.layout,plan.layout);assert.equal(refreshed.maxConcurrency,6);assert.notEqual(refreshed.stamp,plan.stamp);
});
test('single object uses one packet; invalid contracts, alternate layouts, oversize and tampering fail closed',()=>{
 assert.equal(buildReviewCheckPlan(fixture(1)).requestCount,3);assert.equal(buildReviewCheckPlan(fixture(1)).maxConcurrency,3);
 const args=fixture(),plan=buildReviewCheckPlan(args);
 for(const alter of [c=>c.maxConcurrency=7,c=>c.version=2,c=>c.sourceMode='targets',c=>c.layout.reverse(),c=>c.layout[0].units.pop(),c=>c.layout.push({kind:'object',units:['ref00']})]){const changed=structuredClone(args);alter(changed.input.engineeringContracts.fullContextCheck);assert.throws(()=>buildReviewCheckPlan(changed));}
 assert.throws(()=>buildReviewCheckPlan({...args,fixedLayout:[{kind:'object',units:Object.keys(args.sources)}]}));assert.throws(()=>buildReviewCheckPlan({...args,extraRelations:[['ref00','ref01']]}));assert.throws(()=>buildReviewCheckPlan({...args,maxBodyBytes:50}),e=>e.code==='REVIEW_PACKET_OVERSIZE');
 const changed=structuredClone(plan);changed.maxConcurrency=3;assert.throws(()=>verifyReviewCheckPlan(changed,args));
});
test('scope validator still refuses missing target/edge, extra issue refs and already supplied source requests',()=>{
 const args=fixture(),plan=buildReviewCheckPlan(args),packet=plan.packets[0];
 for(const value of [{...ok(packet),checkedRefs:packet.scope.targetRefs.slice(1)},{...ok(packet),checkedEdges:packet.scope.edges.slice(1)},{...ok(packet),issues:[{ref:'ref01',type:'事实',problem:'范围外',impact:'影响',mustFix:true,fixable:true}]},{...ok(packet),sourceRequests:[{refs:['ref00','ref01'],relation:'补查',reason:'原文'}]}])assert.throws(()=>validateScopedCheckResult(value,packet,plan.sourceRefs));
});
test('out of order six-way completion stays associated with packet/group and never drops checks',async()=>{
 const args=fixture(),plan=buildReviewCheckPlan(args);let active=0,peak=0;const completed=[];
 const result=await executeReviewCheckPlan({plan,args,runPacket:async({packet,index,group})=>{peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,10-(index*3+group)));active--;completed.push(index+':'+group);return ok(packet);}});
 assert.equal(peak,6);assert.equal(result.status,'checked');assert.equal(result.requestCount,6);assert.equal(completed.length,6);for(let i=0;i<result.results.length;i++)assert.deepEqual(result.results[i].checkedRefs,plan.packets[Math.floor(i/3)].scope.targetRefs);
});
test('cancel, 429 and uncovered responses reject while other completed responses remain delivered to journal callback',async()=>{
 for(const fail of [()=>Object.assign(Error('cancel'),{name:'AbortError'}),()=>Object.assign(Error('rate limit'),{status:429}),()=>null]){
  const args=fixture(),plan=buildReviewCheckPlan(args),saved=[];let calls=0;
  await assert.rejects(executeReviewCheckPlan({plan,args,runPacket:async({packet,index,group})=>{calls++;await new Promise(resolve=>setTimeout(resolve,index===0&&group===0?1:3));if(index===0&&group===0){const error=fail();if(error)throw error;return {...ok(packet),checkedRefs:[]};}saved.push(index+':'+group);return ok(packet);}}));
  assert.equal(calls,6);assert.equal(saved.length,5);
 }
});
test('unmarked old inputs retain original layout, concurrency, payload and cache stamp',()=>{
 for(const checkerSources of [undefined,1,2]){const args=fixture();delete args.input.engineeringContracts.fullContextCheck;if(checkerSources===undefined)delete args.input.engineeringContracts.checkerSources;else args.input.engineeringContracts.checkerSources=checkerSources;
 const old=buildReviewCheckPlan({...args,fixedLayout:[{kind:'object',units:Object.keys(args.sources).sort()}]});assert.equal(old.maxConcurrency,3);assert.equal(old.requestCount,3);assert.equal(old.fullContextCheck,undefined);assert.deepEqual(refreshReviewCheckPlan(old,args),old);assert.ok(!old.packets[0].payloads[0].task.includes('sourceMode=all-frozen'));
 }
});
test('v2 freezes one full-source packet and three groups without changing the v1 two-packet layout',()=>{
 const args=fixture(),v1=buildReviewCheckPlan(args);args.input.engineeringContracts.fullContextCheck=fullContextCheckContract(Object.keys(args.sources),{version:2});
 const v2=buildReviewCheckPlan(args);assert.equal(v2.maxConcurrency,3);assert.equal(v2.requestCount,3);assert.equal(v2.packets.length,1);assert.equal(v2.packets[0].scope.targetRefs.length,28);assert.equal(v2.packets[0].scope.edges.length,27);for(const p of v2.packets[0].payloads){assert.deepEqual(p.programFacts,args.programFacts);assert.equal(p.reviews.length,28);assert.equal(p.scope.sourceRefs.length,28);}assert.equal(refreshReviewCheckPlan(v2,args).stamp,v2.stamp);
 args.input.engineeringContracts.fullContextCheck=fullContextCheckContract(Object.keys(args.sources),{version:1});assert.deepEqual(buildReviewCheckPlan(args),v1);
});
