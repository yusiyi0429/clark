import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialReviewCall,createReviewCallJournal,outputContractError} from './review-call-journal.mjs';
import {runReviewSkill} from './review-generation.mjs';
const skill={version:'2.1.13',hash:'frozen'},run=()=>({raw:{},reviews:{},failed:[],dropped:[]});
const args=state=>({run:state,system:'仅返回复盘JSON',user:{unit:{id:'eo',evidence:[{kind:'月初起点',text:'原始来源'}]}},key:'eo',skill,save:async()=>{}});
test('the exact raw answer is independently saved before validation and only accepted output enters the cache',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m2-initial-journal-')),state=run(),raw='模型前言\n{"review":{"verdict":"未达成"}}\n结束';
 try{
  const write=createReviewCallJournal(dir);
  await initialReviewCall({...args(state),recordAttempt:write,gateway:{status:{model:'fixture'},complete:async()=>({answer:'{"review":{"verdict":"未达成"}}',rawAnswer:raw,providerRequestId:'request-one',finishReason:'end_turn',finishReasonSource:'provider.messages.stop_reason',usage:{input_tokens:9}})},validate:value=>{assert.equal(state.raw.eo,undefined);return value;}});
  const files=await readdir(dir);assert.equal(files.length,1);const saved=JSON.parse(await readFile(join(dir,files[0]),'utf8'));
  assert.equal(saved.raw,raw);assert.equal(saved.status,'accepted');assert.equal(saved.providerRequestId,'request-one');assert.equal(saved.finishReasonSource,'provider.messages.stop_reason');assert.equal((await stat(join(dir,files[0]))).mode&0o777,0o600);
  assert.equal(state.raw.eo,'{"review":{"verdict":"未达成"}}');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('off-task plain text is a bounded output-contract failure, not a guessed policy refusal',async()=>{
 const state=run(),snapshots=[];let calls=0;
 const gateway={complete:async()=>{calls++;return {answer:"I can't confirm the exact model ID; check API metadata.",traceFinishReason:'stop'};}};
 await assert.rejects(initialReviewCall({...args(state),gateway,recordAttempt:async r=>snapshots.push(r)}),e=>e.code==='MODEL_OUTPUT_CONTRACT'&&!e.refusal);
 assert.equal(calls,3);assert.equal(state.raw.eo,undefined);assert.equal(state.initialAttempts.length,3);
 assert.ok(state.initialAttempts.every(r=>r.raw.includes('model ID')&&r.status==='output-contract-failed'&&r.finishReason===null&&r.finishReasonSource===null));
 assert.ok(snapshots.some(r=>r.status==='received'&&r.rawAvailable));
});
test('reliable provider refusal keeps the returned text and metadata and does not get inferred from wording',async()=>{
 const state=run();let calls=0;
 const error=Object.assign(Error('provider refusal'),{code:'MODEL_REFUSAL',rawAnswer:'provider supplied refusal text',providerRequestId:'request-two',diagnostics:{finishReason:'refusal',finishReasonSource:'provider.chat.finish_reason',providerFinishReason:'content_filter'}});
 await assert.rejects(initialReviewCall({...args(state),gateway:{complete:async()=>{calls++;throw error;}}}),e=>e.code==='MODEL_REFUSAL');
 assert.equal(calls,1);assert.equal(state.initialAttempts[0].raw,error.rawAnswer);assert.equal(state.initialAttempts[0].providerRequestId,'request-two');assert.equal(state.initialAttempts[0].status,'provider-refusal');assert.equal(state.initialAttempts[0].finishReason,'content_filter');
});
test('a journal failure stops before parsing or further paid retries',async()=>{
 const state=run();let calls=0;
 await assert.rejects(initialReviewCall({...args(state),gateway:{complete:async()=>{calls++;return {answer:'{}'};}},recordAttempt:async r=>{if(r.status==='received')throw Error('disk unavailable');}}),e=>e.code==='REVIEW_JOURNAL_UNAVAILABLE');
 assert.equal(calls,1);assert.equal(state.raw.eo,undefined);
});
test('missing review objects are contract failures and failed raw never becomes a successful cached draft',async()=>{
 const state=run();let calls=0;
 await assert.rejects(initialReviewCall({...args(state),gateway:{complete:async()=>{calls++;return {answer:'{"model":"Claude"}'};}},validate:value=>{if(!value.review)throw outputContractError();return value;}}),e=>e.code==='MODEL_OUTPUT_CONTRACT');
 assert.equal(calls,3);assert.equal(state.raw.eo,undefined);
 const failed=structuredClone(state.initialAttempts);await assert.rejects(initialReviewCall({...args(state),gateway:{complete:async()=>{calls++;return {answer:'{"review":{}}'};}}}),e=>e.code==='REVIEW_MODEL_ATTEMPT_LIMIT');assert.equal(calls,3);assert.deepEqual(state.initialAttempts,failed);
 const fresh=run(),answer=await initialReviewCall({...args(fresh),gateway:{complete:async()=>({answer:'{"review":{}}'})}});assert.ok(answer.review);
 await initialReviewCall({...args(fresh),gateway:{complete:async()=>{throw Error('must reuse successful same-input cache');}}});
 await assert.rejects(initialReviewCall({...args(fresh),user:{different:true},gateway:{complete:async()=>{throw Error('must not call');}}}),e=>e.code==='REVIEW_CACHE_MISMATCH');
});
test('new product initial refusals keep the complete source and never use the legacy background-removal retry',async()=>{
 const basis={mode:'latest-source-candidate',snapshotHash:'frozen'},meta={basisMode:basis.mode,snapshotHash:basis.snapshotHash};
 const card={id:'eo',unit:'eo',level:'ru',title:'E&O',owner:'于斯一',children:[],sourceBasis:meta,childCommitments:{...meta,complete:true,items:[]},evidence:[{kind:'月初起点',text:'不允许删掉的来源'}]},input={basis,stages:[[card],[],[]]},state=run();let calls=0;
 await assert.rejects(runReviewSkill({input,skill:{...skill,rules:'规则',groups:[],mustFix:[],maxRevisionRounds:2},run:state,gateway:{complete:async()=>{calls++;throw Object.assign(Error('refused'),{code:'MODEL_REFUSAL',diagnostics:{finishReason:'refusal'}});}}}),e=>e.code==='REVIEW_INITIAL_FAILED');
 assert.equal(calls,1);assert.deepEqual(state.dropped,[]);assert.deepEqual(state.initialAttempts[0].request.user.unit.evidence,card.evidence);assert.equal(state.failed[0].code,'MODEL_REFUSAL');
});
