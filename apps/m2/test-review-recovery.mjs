import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewDependencyPool} from './review-dependencies.mjs';
import {runReviewQuality,qualityModelCall,deferReviewAction,qualityHash} from './review-quality.mjs';
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('a completed branch starts its parent while unrelated slow work is running',async()=>{
 const slow=latch(),parent=latch(),started=[];let active=0,peak=0;
 const flight=reviewDependencyPool({items:[{id:'p',children:['a']},{id:'a'},{id:'slow'}],concurrency:2,dependencies:c=>c.children||[],execute:async c=>{started.push(c.id);peak=Math.max(peak,++active);if(c.id==='slow')await slow.promise;if(c.id==='p')parent.resolve();active--;}});
 await parent.promise;assert.deepEqual(started,['a','slow','p']);assert.equal(peak,2);slow.resolve();await flight;
});
test('independent successful work is retained when a sibling fails; no new calls after failure',async()=>{
 const slow=latch(),started=[],done=[];
 const flight=reviewDependencyPool({items:[{id:'fail'},{id:'slow'},{id:'pending'}],concurrency:2,dependencies:()=>[],execute:async c=>{started.push(c.id);if(c.id==='fail')throw Error('outage');await slow.promise;done.push(c.id);}});
 await Promise.resolve();await Promise.resolve();slow.resolve();await assert.rejects(flight,/outage/);assert.deepEqual(started,['fail','slow']);assert.deepEqual(done,['slow']);
 await assert.rejects(reviewDependencyPool({items:[{id:'a',children:['b']},{id:'b',children:['a']}],concurrency:2,dependencies:c=>c.children,execute:async()=>assert.fail()}),/循环/);
});
test('source enrichment, provider fallback and resume share three attempts for one revision',async()=>{
 const q={requests:{},sourceHash:'s',skillHash:'h'},run={raw:{}},seen=[];
 const backup={status:{model:'wangsu/claude-sonnet-5-5'},complete:async()=>{seen.push('backup');return {answer:'{}'};}};
 const gateway={status:{model:'wangsu/gpt-6.1-sol'},reviewFallbacks:[backup],complete:async()=>{seen.push('primary');return {answer:'{"sourceRequests":[{"refs":["u","c"]}]}'};}};
 const args={gateway,quality:q,run,system:'JSON',pass:0,ref:'u',stage:'refresh',payload:{unit:{id:'u'},revision:1,candidateHash:'frozen'},save:async()=>{}};
 await qualityModelCall(args);
 await assert.rejects(qualityModelCall({...args,stage:'refresh-source',payload:{...args.payload,sources:{c:'complete original'}},validate:()=>{throw Error('contract');}}),/contract/);
 assert.equal(seen.length,3);
 await assert.rejects(qualityModelCall({...args,stage:'refresh-source',payload:{...args.payload,sources:{c:'complete original'}}}),e=>e.code==='REVIEW_MODEL_ATTEMPT_LIMIT');assert.equal(seen.length,3);
 // Cached first response remains readable after the action budget is used.
 assert.ok((await qualityModelCall(args)).sourceRequests);assert.equal(seen.length,3);
});
test('a local unresolved source keeps its raw candidate, defers dependent parents and finishes other branches',async()=>{
 const input={stages:[[{id:'a',parent:'p'},{id:'b',parent:'p'}],[{id:'p',children:['a','b']}],[]]},skill={hash:'h',maxRevisionRounds:2,mustFix:['x']};
 const run={raw:{original:'original'},reviews:{a:{text:'a'},b:{text:'b'},p:{text:'parent original'}}},calls=[];
 const args={run,input,skill,sources:{},check:async()=>['a','b'].map(ref=>({ref,type:'x',mustFix:true,fixable:true})),revise:async c=>{calls.push(c.id);return c.id==='a'?deferReviewAction({code:'SOURCE_ALREADY_PROVIDED',problem:'unverified'}):{text:'new b'};}};
 await runReviewQuality(args);assert.equal(run.quality.status,'needs-review');assert.deepEqual(calls.sort(),['a','b']);assert.equal(run.reviews.a.text,'a');assert.equal(run.reviews.p.text,'parent original');assert.equal(run.reviews.b.text,'new b');assert.equal(run.raw.original,'original');assert.equal(run.quality.counts.p,undefined);
 const frozen=qualityHash(run);await runReviewQuality(args);assert.equal(qualityHash(run),frozen);assert.equal(calls.length,2);
});
