import {test} from 'node:test';import assert from 'node:assert/strict';
import {initialEvidenceContract,initialEvidenceSetup} from './review-initial-evidence.mjs';import {initialReviewCall} from './review-call-journal.mjs';
const fixture=()=>{const items=[{id:'a',level:'mission',title:'服务交付',evidence:[{id:'E1',asOf:'2026-10-20',source:'本人',text:'已给本层记录'}]},{id:'b',level:'mission',title:'另一个任务',objectId:'real-object',evidence:[{id:'E1',asOf:'2026-10-28',source:'单元进展，未指定Mission',text:'完整 Chat_Service 部署原文，尚未验收'},{id:'E2',source:'日期缺失',text:'Chat_Service 日期未知'}]}];const input={stages:[items],engineeringContracts:{initialEvidence:initialEvidenceContract()}},user={task:'JSON',unit:items[0]};return {input,card:items[0],user};};
const args={system:'完整规则JSON',wireOptions:{model:'wangsu/claude-sonnet-5-5',maxTokens:32000,json:false}};
const callArgs=(setup,gateway,run)=>({gateway,system:args.system,user:setup.user,evidenceFlow:setup.evidenceFlow,key:'a',skill:{hash:'fixture',version:'2.1.13'},run,validate:v=>{assert.ok(v.review||v.requestEvidence);return v;}});
test('directory is metadata; explicit address returns intact record/hash/namespace without attributing other unit evidence',()=>{
 const f=fixture(),snapshot=structuredClone(f.input),s=initialEvidenceSetup(f);assert.equal(JSON.stringify(s.user.evidenceDirectory).includes('尚未验收'),false);
 const v=s.evidenceFlow.resolve({requestEvidence:{addresses:[{sourceRef:'b',id:'E1'}]}},args);assert.deepEqual(v.response.records[0].evidence,f.input.stages[0][1].evidence[0]);assert.match(v.response.records[0].evidenceHash,/^[a-f0-9]{64}$/);assert.equal(v.response.records[0].sourceRef,'b');assert.equal(v.user.evidenceRetrieval.finalizeOnly,true);assert.deepEqual(f.input,snapshot);
 for(const requestEvidence of [{addresses:[{sourceRef:'missing',id:'E1'}]},{addresses:[{sourceRef:'b',id:'E999'}]},{query:'a',sourceRefs:['missing']},{query:'a',from:'2026-02-31'}])assert.throws(()=>s.evidenceFlow.resolve({requestEvidence},args));
});
test('literal query and inclusive dates preserve unknown-date boundary, no regex or semantic binding',()=>{
 const s=initialEvidenceSetup(fixture()),v=s.evidenceFlow.resolve({requestEvidence:{query:'chat_service',from:'2026-10-28',to:'2026-10-28'}},args);assert.equal(v.response.matchedCount,1);assert.equal(v.response.records.length,1);assert.equal(v.response.excludedMissingDate.length,1);
 const regex=s.evidenceFlow.resolve({requestEvidence:{query:'.*'}},args);assert.equal(regex.response.matchedCount,0);
});
test('record and byte limits leave explicit unprovided addresses and still finalize without cutting records',()=>{
 const f=fixture();f.input.stages[0][1].evidence=Array.from({length:70},(_,i)=>({id:'E'+i,text:'match '+(i===0?'x'.repeat(270000):'完整原文'),source:'来源',asOf:'2026-10-28'}));const s=initialEvidenceSetup(f),v=s.evidenceFlow.resolve({requestEvidence:{query:'match'}},args);assert.equal(v.response.matchedCount,70);assert.equal(v.response.records.length,64);assert.equal(v.response.notProvided.length,6);assert.ok(v.response.notProvided.some(a=>a.id==='E0'));assert.ok(v.response.records.every(r=>r.evidence.text==='match 完整原文'));assert.equal(v.user.evidenceRetrieval.finalizeOnly,true);
});
test('one source response is logged then final review; completed cache resume has zero calls',async()=>{
 const s=initialEvidenceSetup(fixture()),run={raw:{}};let calls=0;const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{calls++;const p=JSON.parse(messages[1].content);return {answer:JSON.stringify(calls===1?{requestEvidence:{addresses:[{sourceRef:'b',id:'E1'}]}}:{review:{verdict:'部分达成',verdictReason:p.evidenceResponse.records[0].evidence.text}})}}};
 const first=await initialReviewCall(callArgs(s,gateway,run));assert.equal(calls,2);assert.equal(first.review.verdictReason,'完整 Chat_Service 部署原文，尚未验收');assert.equal(run.initialAttempts[0].status,'context-provided');assert.ok(run.initialAttempts.every(a=>a.requestHash));await initialReviewCall(callArgs(s,gateway,run));assert.equal(calls,2);
 const bad=structuredClone(run);bad.initialAttempts[0].evidenceResponse.records[0].evidence.text='篡改';await assert.rejects(initialReviewCall(callArgs(s,gateway,bad)),/响应/);
});
test('cancel after source answer preserves source stage; resume never pays for the same source request again',async()=>{
 const s=initialEvidenceSetup(fixture()),run={raw:{}},ac=new AbortController();let calls=0;const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{calls++;if(calls===1){ac.abort();return {answer:JSON.stringify({requestEvidence:{query:'Chat_Service'}})};}assert.equal(JSON.parse(messages[1].content).evidenceRetrieval.finalizeOnly,true);return {answer:'{"review":{"verdict":"部分达成"}}'};}};
 await assert.rejects(initialReviewCall({...callArgs(s,gateway,run),signal:ac.signal}));assert.equal(calls,1);assert.equal(run.initialAttempts[0].status,'context-provided');await initialReviewCall(callArgs(s,gateway,run));assert.equal(calls,2);
});
test('fallback, retrieval and malformed replies share at most three physical calls; final call forbids further retrieval',async()=>{
 const s=initialEvidenceSetup(fixture()),run={raw:{}};let primary=0,backup=0;const other={status:{model:'wangsu/gpt-6.1-sol'},complete:async messages=>{backup++;const p=JSON.parse(messages[1].content);if(backup===1)return {answer:JSON.stringify({requestEvidence:{query:'Chat_Service'}})};assert.equal(p.evidenceRetrieval.finalizeOnly,true);return {answer:'{"review":{"verdict":"部分达成"}}'};}},gateway={status:{model:'wangsu/claude-sonnet-5-5'},reviewFallbacks:[other],complete:async()=>{primary++;return {answer:'invalid'};}};
 await initialReviewCall(callArgs(s,gateway,run));assert.equal(primary+backup,3);assert.equal(run.initialAttempts.length,3);await initialReviewCall(callArgs(s,gateway,run));assert.equal(primary+backup,3);
 const failRun={raw:{}},bad={status:gateway.status,complete:async()=>({answer:'invalid'})};await assert.rejects(initialReviewCall(callArgs(s,bad,failRun)));assert.equal(failRun.initialAttempts.length,3);await assert.rejects(initialReviewCall(callArgs(s,bad,failRun)),e=>e.code==='REVIEW_MODEL_ATTEMPT_LIMIT');assert.equal(failRun.initialAttempts.length,3);
});
test('old input and parent remain on original path; catalog contract cannot be changed on resume',()=>{
 const f=fixture();delete f.input.engineeringContracts.initialEvidence;assert.equal(initialEvidenceSetup(f).user,f.user);const newer=fixture();newer.input.engineeringContracts.initialEvidence.maxPhysicalAttempts=4;assert.throws(()=>initialEvidenceSetup(newer));const parent=fixture();parent.card.level='ru';assert.equal(initialEvidenceSetup(parent).user,parent.user);
});
test('knowing an evidence directory entry is not permission to cite unread cross-source facts',()=>{
 const s=initialEvidenceSetup(fixture());assert.throws(()=>s.evidenceFlow.validateReview({facts:[{evidence:'[b:E1]'}]},s.user),/尚未实际提供/);
 const next=s.evidenceFlow.resolve({requestEvidence:{addresses:[{sourceRef:'b',id:'E1'}]}},args);assert.doesNotThrow(()=>s.evidenceFlow.validateReview({facts:[{evidence:'[b:E1]'}]},next.user));
});
test('a received source answer before continuation checkpoint is recovered without repeating its paid call',async()=>{
 const s=initialEvidenceSetup(fixture()),run={raw:{}};let calls=0;const ac=new AbortController(),gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async()=>{calls++;if(calls===1){ac.abort();return {answer:JSON.stringify({requestEvidence:{query:'Chat_Service'}})};}return {answer:'{"review":{"verdict":"部分达成"}}'};}};
 await assert.rejects(initialReviewCall({...callArgs(s,gateway,run),signal:ac.signal}));const r=run.initialAttempts[0];r.status='received';for(const key of ['evidenceRequest','evidenceResponse','evidenceResponseHash','contextNextUserHash'])delete r[key];await initialReviewCall(callArgs(s,gateway,run));assert.equal(calls,2);assert.equal(r.status,'context-provided');
});
test('no retrieved record fits: model gets explicit gap and completes a review without a retrieval-budget job error',async()=>{
 const f=fixture();f.input.stages[0][1].evidence=[{id:'E1',source:'原出处',text:'x'.repeat(270000)}];const s=initialEvidenceSetup(f),run={raw:{}};let calls=0;const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{calls++;if(calls===1)return {answer:JSON.stringify({requestEvidence:{addresses:[{sourceRef:'b',id:'E1'}]}})};const p=JSON.parse(messages[1].content);assert.equal(p.evidenceResponse.records.length,0);assert.equal(p.evidenceResponse.notProvided.length,1);assert.equal(p.evidenceRetrieval.finalizeOnly,true);return {answer:'{"review":{"verdict":"部分达成","verdictReason":"缺跨源原文"}}'};}};assert.equal((await initialReviewCall(callArgs(s,gateway,run))).review.verdictReason,'缺跨源原文');assert.equal(calls,2);
});
