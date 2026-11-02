import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewDependencyPool} from './review-dependencies.mjs';
import {runReviewQuality,qualityModelCall,deferReviewAction,qualityHash} from './review-quality.mjs';
import {withReviewFallbacks,reviewInitialConcurrency,withReviewRateLimit} from './review-model-fallback.mjs';
import {MODEL_PROFILES} from './model.mjs';
import {runReviewSkill} from './review-generation.mjs';
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

test('exhausted real transport failures defer only the affected branch and preserve final error diagnostics',async()=>{
 for(const code of ['ECONNRESET','ETIMEDOUT','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','MODEL_STREAM_INCOMPLETE','MODEL_STREAM_FAILURE']){
  const run={raw:{},reviews:{a:{text:'old a'},b:{text:'old b'},p:{text:'old parent'}}},input={stages:[[{id:'a',parent:'p'},{id:'b',parent:'p'}],[{id:'p',children:['a','b']}],[]]},skill={hash:'h',maxRevisionRounds:2,mustFix:['critical']};let calls=0;
  const channel=model=>({status:{model},complete:async()=>{calls++;throw Object.assign(Error('transport outage'),{code});}}),gateway=withReviewFallbacks(channel('wangsu/claude-sonnet-5-5'),[channel('wangsu/gpt-6.1-sol')]);
  const args={run,input,skill,sources:{},check:async()=>['a','b'].map(ref=>({ref,type:'critical',mustFix:true,fixable:true})),revise:async(c,action,pass,q)=>c.id==='b'?{text:'new b'}:qualityModelCall({gateway,quality:q,run,pass,stage:'revise',ref:c.id,payload:{unit:{id:c.id},revision:action.revision,candidateHash:action.beforeHash},system:'JSON',save:async()=>{}})};
  await runReviewQuality(args);assert.equal(calls,3,code);assert.equal(run.quality.status,'needs-review');assert.equal(run.reviews.a.text,'old a');assert.equal(run.reviews.b.text,'new b');assert.equal(run.reviews.p.text,'old parent');assert.equal(run.quality.verificationPending.find(x=>x.unit==='a').code,'REVIEW_MODEL_ATTEMPT_LIMIT');assert.equal(run.quality.verificationPending.find(x=>x.unit==='a').lastFailure.code,code);
  const request=Object.values(run.quality.requests)[0];assert.equal(request.attempts.length,3);assert.equal(request.attempts.at(-1).errorCode,code);await runReviewQuality(args);assert.equal(calls,3);
 }
});

test('cancellation and journal persistence errors remain explicit failures instead of unverified drafts',async()=>{
 const run={raw:{},reviews:{a:{text:'original'}}},input={stages:[[{id:'a'}],[],[]]},skill={hash:'h',maxRevisionRounds:2,mustFix:['critical']};
 for(const code of ['REVIEW_JOURNAL_UNAVAILABLE','LOCAL_STORAGE_UNAVAILABLE']){
  const copy=structuredClone(run);await assert.rejects(runReviewQuality({run:copy,input,skill,sources:{},check:async()=>[{ref:'a',type:'critical',mustFix:true,fixable:true}],revise:async()=>{throw Object.assign(Error('persist failed'),{code});}}),e=>e.code===code);assert.equal(copy.quality.status,'waiting');assert.equal(copy.reviews.a.text,'original');
 }
 const controller=new AbortController();let calls=0;const copy=structuredClone(run);
 await assert.rejects(runReviewQuality({run:copy,input,skill,sources:{},signal:controller.signal,check:async()=>[{ref:'a',type:'critical',mustFix:true,fixable:true}],revise:async()=>{calls++;controller.abort(new DOMException('user stopped','AbortError'));controller.signal.throwIfAborted();}}),e=>e.name==='AbortError');assert.equal(calls,1);assert.equal(copy.quality.status,'waiting');
});

test('review initial calls use the existing Sonnet capacity with a hard review cap of twenty',async()=>{
 assert.equal(reviewInitialConcurrency({roundConcurrency:MODEL_PROFILES['wangsu/claude-sonnet-5-5'].roundConcurrency}),20);
 assert.equal(reviewInitialConcurrency({roundConcurrency:MODEL_PROFILES['wangsu/gpt-6.1-sol'].roundConcurrency}),20);assert.equal(reviewInitialConcurrency({}),8);
 const entered=latch(),release=latch();let active=0,peak=0,calls=0;
 const gateway={roundConcurrency:20,complete:async()=>{peak=Math.max(peak,++active);if(++calls===20)entered.resolve();await release.promise;active--;return {answer:'{"review":{"verdict":"达成"}}'};}};
 const flight=runReviewSkill({gateway,skill:{version:'2.1.0',hash:'fixture',rules:'JSON',groups:[]},input:{stages:[Array.from({length:20},(_,i)=>({id:'m'+i,level:'mission'})),[],[]]}});
 await entered.promise;assert.equal(peak,20);release.resolve();await flight;assert.equal(calls,20);
});

test('review provider 429 cooldown honors retry-after and is abortable without another model attempt',async()=>{
 let time=0,calls=0;const waits=[],channel={complete:async()=>{if(++calls===1)throw Object.assign(Error('429'),{providerStatus:429,retryAfterMs:1250});return {answer:'ok'};}};
 const gateway=withReviewRateLimit(channel,{now:()=>time,wait:async ms=>{waits.push(ms);time+=ms;}});
 await assert.rejects(gateway.complete([],{}),{providerStatus:429});assert.equal((await gateway.complete([],{})).answer,'ok');assert.deepEqual(waits,[1250]);assert.equal(calls,2);
 let interrupted=0;const controller=new AbortController(),limited=withReviewRateLimit({complete:async()=>{interrupted++;throw Object.assign(Error('429'),{providerStatus:429});}},{now:()=>0,wait:async(_ms,signal)=>{controller.abort(new DOMException('stop','AbortError'));signal.throwIfAborted();}});
 await assert.rejects(limited.complete([],{}),{providerStatus:429});await assert.rejects(limited.complete([],{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(interrupted,1);
});

test('64k complete checks have distinct frozen cache and wire budgets without relabelling 32k records',async()=>{
 const run={raw:{}},quality={requests:{},sourceHash:'s',skillHash:'h'},limits=[];
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async(_messages,options)=>{limits.push(options.maxTokens);return {answer:'{"issues":[]}'};}},args={gateway,system:'JSON',quality,run,pass:0,stage:'check',ref:'all',payload:{unchanged:'all sources'},save:async()=>{}};
 await qualityModelCall(args);const oldKey=Object.keys(quality.requests)[0],old=structuredClone(quality.requests[oldKey]);
 await qualityModelCall({...args,maxTokens:64000});assert.deepEqual(limits,[32000,64000]);assert.equal(Object.keys(quality.requests).length,2);assert.deepEqual(quality.requests[oldKey],old);
 const newKey=Object.keys(quality.requests).find(k=>k!==oldKey),request=quality.requests[newKey];assert.equal(request.callOptions.maxTokens,64000);assert.equal(request.attempts[0].options.maxTokens,64000);
 await qualityModelCall({...args,maxTokens:64000});await qualityModelCall(args);assert.equal(limits.length,2);
 request.callOptions.maxTokens=32000;await assert.rejects(qualityModelCall({...args,maxTokens:64000}),/缓存输入/);assert.equal(limits.length,2);
 request.callOptions.maxTokens=64000;request.attempts[0].options.maxTokens=32000;await assert.rejects(qualityModelCall({...args,maxTokens:64000}),/缓存输入/);assert.equal(limits.length,2);
 await assert.rejects(qualityModelCall({...args,stage:'revise',maxTokens:64000}),/仅完整检查/);
});
