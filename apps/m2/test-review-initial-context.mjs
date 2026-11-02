import {test} from 'node:test';import assert from 'node:assert/strict';
import {parentInitialContextContract,parentInitialPayload,validateInitialContext,restoreParentInitialContext} from './review-initial-context.mjs';
import {initialReviewCall} from './review-call-journal.mjs';
const fixture=()=>{const cards=[{id:'a',level:'mission',evidence:[{id:'E1',text:'子项完整原文'}]},{id:'p',level:'ru',children:['a'],evidence:[{id:'E1',text:'父项不同原文'}]}];return {input:{engineeringContracts:{initialContext:parentInitialContextContract()},stages:[cards]},card:cards[1],user:{task:'原规则',unit:cards[1],missionReviews:[{ref:'a',verdict:'部分达成',verdictReason:'子原文[E1]'}]},reviews:{a:{ref:'a',verdict:'部分达成',verdictReason:'子原文[E1]'}},sourceFor:c=>structuredClone(c)};};
test('parent receives only child-cited complete records with child namespace binding and unchanged candidates',()=>{
 const args=fixture(),before=structuredClone(args.input),reviews=structuredClone(args.reviews),p=parentInitialPayload(args).user;
 assert.equal(p.initialContext.maxBodyBytes,512*1024);assert.equal(p.childEvidence.records.length,1);assert.equal(p.childEvidence.records[0].evidence.text,'子项完整原文');assert.deepEqual(p.childEvidence.bindings,[{childRef:'a',raw:'[E1]',sourceRef:'a',id:'E1'}]);assert.equal(p.unit.evidence[0].text,'父项不同原文');assert.deepEqual(p.missionReviews,args.user.missionReviews);assert.equal(p.childCandidates[0].candidate,true);assert.equal(p.childCandidates[0].confirmed,false);assert.match(p.childCandidates[0].reviewHash,/^[a-f0-9]{64}$/);assert.deepEqual(args.input,before);assert.deepEqual(args.reviews,reviews);
 const unknown=parentInitialPayload({...args,reviews:{a:{ref:'a',verdictReason:'错误[E999]，跨源[p:E1]'}}}).user;assert.deepEqual(unknown.childEvidence.missingAddresses,[{childRef:'a',raw:'[E999]'}]);assert.equal(unknown.childEvidence.records[0].sourceRef,'p');
});
test('old inputs/Missions keep original payload; invalid contracts or missing children refuse',()=>{
 const args=fixture();delete args.input.engineeringContracts.initialContext;assert.equal(parentInitialPayload(args).user,args.user);
 const fresh=fixture();assert.equal(parentInitialPayload({...fresh,card:fresh.input.stages[0][0]}).user,fresh.user);assert.throws(()=>parentInitialPayload({...fresh,reviews:{}}));
 for(const change of [c=>c.maxBodyBytes*=2,c=>c.version=3,c=>c.sourceMode='all']){const x=fixture();change(x.input.engineeringContracts.initialContext);assert.throws(()=>validateInitialContext(x.input));}
});
test('new parent remains bounded at 512KiB even without backup; oversize does not truncate or call',async()=>{
 let calls=0;const args=fixture();args.user.unit.extra='x'.repeat(530000);const user=parentInitialPayload(args).user,before=structuredClone(user);
 await assert.rejects(initialReviewCall({gateway:{status:{model:'wangsu/claude-sonnet-5-5'},complete:async()=>{calls++;}},system:'JSON',user,key:'p',skill:{hash:'fixture'},run:{raw:{}}}),e=>e.code==='REVIEW_PACKET_OVERSIZE');assert.equal(calls,0);assert.deepEqual(user,before);
});
test('v2 parent transport losslessly shares repeated whole text and refuses invalid paths or hashes before any model call',async()=>{
 const args=fixture(),text='完整来源、日期、否定与命名空间都不能丢失。'.repeat(200);args.input.stages[0][0].evidence[0].text=text;args.user.unit.evidence[0].text=text;const original=structuredClone(args.input),p=parentInitialPayload(args).user,restored=restoreParentInitialContext(p);assert.deepEqual(restored.unit,args.user.unit);assert.deepEqual(restored.childEvidence.records[0].evidence,args.input.stages[0][0].evidence[0]);assert.ok(Object.keys(p.parentSourceTexts).length);assert.ok(p.parentSourceBindings.length>=2);assert.equal(p.childEvidence.records.length,1);assert.deepEqual(args.input,original);
 let calls=0;for(const change of [p=>p.parentSourceHash='bad',p=>p.parentSourceBindings[0].path=['missing','text'],p=>p.parentSourceTexts[Object.keys(p.parentSourceTexts)[0]]+='坏',p=>p.unit.evidence[0].text='坏标记']){const bad=structuredClone(p);change(bad);await assert.rejects(initialReviewCall({gateway:{status:{model:'wangsu/gpt-6.1-sol'},complete:async()=>{calls++;}},system:'JSON',user:bad,key:'p',skill:{hash:'fixture'},run:{raw:{}}}));}assert.equal(calls,0);
 args.input.engineeringContracts.initialContext=parentInitialContextContract({version:1});const legacy=parentInitialPayload(args).user;assert.equal(legacy.parentSourceTexts,undefined);assert.equal(legacy.unit.evidence[0].text,text);assert.equal(legacy.childEvidence.records[0].evidence.text,text);
});
