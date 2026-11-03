import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createReviewJobs} from './review-generation.mjs';
import {withReviewFallbacks} from './review-model-fallback.mjs';
import {createCollaborationState} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';

const actor={id:'member-04'};
const skillRoot=new URL('./review-skill-history/2.1.15/',import.meta.url);
const review={verdict:'未达成',verdictReason:'缺少结果',facts:[{ref:'x',item:'成果',status:'未达成',evidence:'尚缺记录',gap:'尚缺记录'}],nextInputs:[{ref:'x',type:'继续',text:'核对结果'}]};
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('job did not finish');}
async function setup(gateway,{formalFallbacks=true,root=skillRoot}={}){
 if(formalFallbacks)gateway=withReviewFallbacks(gateway,[{...gateway,status:{model:'wangsu/gpt-6.1-sol'}}]);
 const dir=await mkdtemp(join(tmpdir(),'m2-quality-job-'));let state=createCollaborationState([]);const original=structuredClone(state.cards);
 const store={snapshot:()=>state,transact:async fn=>{state=fn(structuredClone(state));return state;}};
 const reader=async()=>({list:async f=>f.type==='Company'?[{object_id:'company-source'}]:[],get:async()=>({business:{title:'公司',version:1,blocks:[]}}),findEvents:async()=>[]});
 const jobs=createReviewJobs({store,gateway,skillRoot:root,statePath:join(dir,'state.json'),reader,isOperator:a=>a.id==='member-04',installReviewRound,archivesPath:path=>path+'.archives.json',ceoName:'刘明华'});
 return {jobs,store,dir,original};
}
test('a job at the two-edit limit writes an independent draft and never installs it in current business state',async()=>{
 let revisions=0,checks=0;
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{const p=JSON.parse(messages[1].content);if(!p.unit){checks++;return {answer:JSON.stringify({...checkCoverage(p),issues:[{ref:'company',...candidateBasis(p,'company'),type:'结构与表达',problem:'未验证被写成未发生',impact:'事实过强',mustFix:true,fixable:true}]})};}if(p.revision)revisions++;return {answer:JSON.stringify({review})};}};
 const {jobs,store,dir,original}=await setup(gateway);
 try{
  const job=await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});
  await until(()=>jobs.view().status!=='running');const final=jobs.view();
  assert.equal(final.status,'draft',final.error);assert.equal(final.candidateAvailable,true);assert.equal(revisions,2);assert.equal(checks,5,'three initial checks and one per repair');assert.ok(final.checks.length);
  assert.deepEqual(store.snapshot().cards,original);assert.equal(store.snapshot().reviewRound,undefined);
  const work=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.json'),'utf8')),draft=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.candidate.json'),'utf8'));
  assert.equal(work.run.quality.counts.company,2);assert.equal(draft.quality.status,'blocked');assert.equal(work.run.quality.passes.length,3);
  assert.equal((await jobs.start(actor,{resume:true})).status,'draft');assert.equal(revisions,2);assert.equal(checks,5,'terminal draft resume cannot restart exhausted calls');
  await assert.rejects(jobs.candidate({id:'member-09'}),{status:403});
  assert.deepEqual((await jobs.candidate(actor)).cards,[],'operator status alone grants no card visibility');
  const preview=await jobs.candidate({...actor,ceo:true});assert.equal(preview.readOnly,true);assert.equal(preview.cards.length,1);assert.match(preview.cards[0].id,/^candidate:/);assert.equal(preview.cards[0].content.verdictReason,review.verdictReason);assert.equal(preview.raw,undefined);assert.equal(preview.analysis,undefined);assert.deepEqual(store.snapshot().cards,original);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('only an operator can cancel a running job; cancellation saves a resumable failure without installing',async()=>{
 let entered=false;
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async(_messages,{signal})=>{entered=true;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
 const {jobs,store,dir,original}=await setup(gateway);
 try{
  await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});await until(()=>entered);
  await assert.rejects(jobs.cancel({id:'member-09'}),{status:403});await jobs.cancel(actor);await until(()=>jobs.view().status==='failed');
  assert.match(jobs.view().error,/停止/);assert.deepEqual(store.snapshot().cards,original);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('exhausted single-model checker resume preserves the edited draft and cannot reset its attempts or install',async()=>{
 let fail=true,initial=0,revised=0,failedChecks=0;
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{const p=JSON.parse(messages[1].content);
  if(!p.unit){const current=p.reviews[0];if(current.verdictReason==='fixed'&&p.phase==='impact'&&fail){failedChecks++;throw Error('checker offline');}return {answer:JSON.stringify({...checkCoverage(p),issues:current.verdictReason==='fixed'?[]:[{ref:'company',...candidateBasis(p,'company'),type:'结构与表达',problem:'需要澄清',impact:'影响理解',mustFix:true,fixable:true}]})};}
  if(p.revision)revised++;else initial++;return {answer:JSON.stringify({review:{...review,verdictReason:p.revision?'fixed':'initial'}})};
 }};
 // A primary-only checker still has one cumulative three-attempt budget.
 const {jobs,store,dir}=await setup(gateway,{formalFallbacks:false});
 try{
  const job=await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});await until(()=>jobs.view().status==='failed');
  assert.equal(store.snapshot().reviewRound,undefined);fail=false;await jobs.start(actor,{resume:true});await until(()=>jobs.view().status!=='running');
  assert.equal(jobs.view().status,'draft');assert.equal(initial,1);assert.equal(revised,1);assert.equal(failedChecks,3);assert.equal(store.snapshot().reviewRound,undefined);
  const work=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.json'),'utf8'));assert.equal(work.run.reviews.company.verdictReason,'fixed');assert.equal(work.run.quality.counts.company,1);assert.equal(work.run.quality.status,'needs-review');
 }finally{await rm(dir,{recursive:true,force:true});}
});

function checkCoverage(p){return {phase:p.phase,candidateHash:p.candidateHash,checkedRefs:p.scope.targetRefs,checkedEdges:p.scope.edges,sourceRequests:[],issueResults:p.priorIssues?.map(issue=>({id:issue.id,status:'resolved',reason:'已按当前候选核对',basis:{kind:'candidate',refs:[{ref:issue.ref,field:'verdictReason'}]}}))};}

test('final findings route repairs by revision batch rather than check index',async()=>{
 const phases=[],repairs=[];
 const claude='wangsu/claude-sonnet-5-5',gpt='wangsu/gpt-6.1-sol';
 const makeGateway=model=>({status:{model},complete:async messages=>{
  const p=JSON.parse(messages[1].content);
  if(p.unit){
   if(p.revision)repairs.push({batch:p.revision,model});
   return {answer:JSON.stringify({review:{...review,verdictReason:['初稿','第一处已修','第二处已修'][p.revision||0]}})};
  }
  phases.push({phase:p.phase,model});
  const issues=p.phase==='final'&&p.reviews[0].verdictReason!=='第二处已修'?[{
   ref:'company',...candidateBasis(p,'company'),type:'漏行',problem:p.reviews[0].verdictReason==='初稿'?'需要澄清':'另一处不一致',impact:'影响理解',mustFix:true,fixable:true,
  }]:[];
  return {answer:JSON.stringify({...checkCoverage(p),issues})};
 }});
 const gateway=withReviewFallbacks(makeGateway(claude),[makeGateway(gpt)]);
 const {jobs,dir}=await setup(gateway,{formalFallbacks:false});
 try{
  const job=await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});
  await until(()=>jobs.view().status!=='running');
  assert.equal(jobs.view().status,'done',jobs.view().error);
  assert.deepEqual(phases.map(x=>x.phase),['initial','initial','initial','final','impact','final','impact','final']);
  assert.ok(phases.every(x=>x.model===claude));
  assert.deepEqual(repairs,[{batch:1,model:claude},{batch:2,model:gpt}]);
  const {run}=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.json'),'utf8'));
  assert.deepEqual(run.quality.passes.filter(pass=>pass.actions?.length).map(pass=>pass.index),[1,3]);
  assert.equal(run.quality.passes.at(-1).coverage.candidateHash,run.quality.candidateHash);
  assert.equal(run.quality.counts.company,2);
  assert.equal(run.quality.status,'passed');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('final check supplies originals once and preserves specific unresolved evidence as a draft',async()=>{
 const rounds=[];
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{
  const p=JSON.parse(messages[1].content);
  if(p.unit)return {answer:JSON.stringify({review})};
  const answer={...checkCoverage(p),issues:[]};
  if(p.phase==='final'){
   rounds.push(p.sourceRound);
   if(p.sourceRound==='first'){
    assert.match(p.task,/一次在 sourceRequests 列齐/);
    answer.sourceRequests=['company'];
   }else{
    assert.match(p.task,/sourceRequests 必须为空/);
    assert.deepEqual(p.scope.completeSourceRefs,['company']);
    answer.missingEvidence=[{ref:'company',reason:'缺少原始交接记录，不能确认交接是否发生'}];
   }
  }
  return {answer:JSON.stringify(answer)};
 }};
 const {jobs,store,dir,original}=await setup(gateway);
 try{
  const job=await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});
  await until(()=>jobs.view().status!=='running');
  assert.deepEqual(rounds,['first','last']);
  assert.equal(jobs.view().status,'draft');
  assert.deepEqual(store.snapshot().cards,original);
  const {run}=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.json'),'utf8'));
  assert.equal(run.quality.status,'needs-review');
  assert.deepEqual(run.quality.verificationPending[0].checks,[{unit:'company',problem:'缺少原始交接记录，不能确认交接是否发生'}]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a third-attempt source request retains the raw answer and the specific pending refs without a fourth call',async()=>{
 const rounds=[];
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{
  const p=JSON.parse(messages[1].content);
  if(p.unit)return {answer:JSON.stringify({review})};
  const answer={...checkCoverage(p),issues:[]};
  if(p.phase==='final'){
   rounds.push(p.sourceRound);
   assert.equal(p.sourceRound,'first');
   if(rounds.length<3)throw Object.assign(Error('temporary provider failure'),{providerStatus:503});
   answer.sourceRequests=['company'];
  }
  return {answer:JSON.stringify(answer)};
 }};
 const {jobs,store,dir,original}=await setup(gateway,{formalFallbacks:false});
 try{
  const job=await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});
  await until(()=>jobs.view().status!=='running');
  assert.equal(jobs.view().status,'draft');
  assert.equal((await jobs.start(actor,{resume:true})).status,'draft');
  assert.deepEqual(rounds,['first','first','first']);
  assert.deepEqual(store.snapshot().cards,original);
  const {run}=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.json'),'utf8'));
  const requests=Object.entries(run.quality.requests).filter(([,request])=>request.payload.phase==='final');
  assert.deepEqual(requests.flatMap(([,request])=>request.attempts.map(attempt=>attempt.attempt)),[1,2,3]);
  assert.deepEqual(JSON.parse(run.raw[requests[0][0]]).sourceRequests,['company']);
  assert.equal(run.quality.verificationPending[0].code,'REVIEW_MODEL_ATTEMPT_LIMIT');
  assert.deepEqual(run.quality.verificationPending[0].checks.map(check=>check.unit),['company']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

function candidateBasis(p,ref){return p.checkBasis?{sourceRefs:[],basis:{kind:'candidate',refs:[{ref,field:'verdictReason'}]}}:{sourceRefs:[ref]};}

const latestSkill=new URL('./review-skill/',import.meta.url);

test('one repair batch and scoped recheck install a complete round with remaining issues and fresh signatures',async()=>{
 const phases=[],repairs=[];
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{
  const p=JSON.parse(messages[1].content);
  if(p.unit){
   if(p.revision)repairs.push(p.revision);
   return {answer:JSON.stringify({review:{...review,verdictReason:p.revision?'新修订':'初稿'}})};
  }
  phases.push(p.phase);
  const issues=[{ref:'company',...candidateBasis(p,'company'),type:'结构与表达',problem:p.phase==='impact'?'仍待核对':'需要澄清',impact:'影响理解',mustFix:true,fixable:true}];
  const coverage=checkCoverage(p);
  return {answer:JSON.stringify({...coverage,issues})};
 }};
 const {jobs,store,dir}=await setup(gateway,{root:latestSkill});
 const old=installReviewRound(store.snapshot(),{reviews:[{...review,ref:'company',unit:'company',level:'company',title:'上一轮',owner:'刘明华'}]});
 old.cards['rv:company'].versions[0].signatures=[{by:'刘明华'}];old.cards['rv:company'].confirmedVersion=1;
 await store.transact(()=>old);
 try{
  await jobs.start(actor,{regenerate:true,period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});
  await until(()=>jobs.view().status!=='running');
  assert.equal(jobs.view().status,'done',jobs.view().error);
  assert.equal(jobs.view().qualityStatus,'needs-review');
  assert.deepEqual(phases,['initial','initial','initial','impact']);
  assert.deepEqual(repairs,[1]);
  const state=store.snapshot();
  assert.equal(state.cards['rv:company'].verdictReason,'新修订');
  assert.deepEqual(state.cards['rv:company'].versions[0].signatures,[]);
  assert.equal(state.cards['rv:company'].confirmedVersion,null);
  assert.deepEqual(state.reviewArchives[0].cards[0].versions[0].signatures,[{by:'刘明华'}]);
  assert.ok(state.reviewRound.problems.some(x=>x.ref==='company'&&x.reason==='仍待核对'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('failed first check delivers a complete draft as check-incomplete, but damaged initial output cannot install',async()=>{
 for(const broken of [null,{verdict:'未达成'},{verdict:' ',verdictReason:' ',facts:[],nextInputs:[]}]){
  const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{
   const p=JSON.parse(messages[1].content);
   if(p.unit)return {answer:JSON.stringify({review:broken||{...review,facts:review.facts.map(row=>({...row,evidence:''}))}})};
   throw Object.assign(Error('checker unavailable'),{providerStatus:503});
  }};
  const {jobs,store,dir,original}=await setup(gateway,{root:latestSkill});
  try{
   await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});
   await until(()=>jobs.view().status!=='running');
   assert.equal(jobs.view().status,broken?'failed':'done',jobs.view().error);
   if(broken){assert.deepEqual(store.snapshot().cards,original);assert.equal(jobs.view().errorCode,'REVIEW_INITIAL_INCOMPLETE');}
   else{assert.equal(jobs.view().qualityStatus,'check-incomplete');assert.equal(store.snapshot().cards['rv:company'].verdictReason,review.verdictReason);assert.ok(jobs.view().checks.length);}
  }finally{await rm(dir,{recursive:true,force:true});}
 }
});

test('a damaged repair keeps the complete previous card and never runs a second repair batch',async()=>{
 let attempted=0;
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{
  const p=JSON.parse(messages[1].content);
  if(p.unit){
   if(p.revision){attempted++;return {answer:'{"review":{"verdict":"达成"}}'};}
   return {answer:JSON.stringify({review})};
  }
  return {answer:JSON.stringify({...checkCoverage(p),issues:[{ref:'company',sourceRefs:['company'],type:'结构与表达',problem:'需要澄清',impact:'影响理解',mustFix:true,fixable:true}]})};
 }};
 const {jobs,store,dir}=await setup(gateway,{root:latestSkill});
 try{
  const job=await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});
  await until(()=>jobs.view().status!=='running');
  assert.equal(jobs.view().status,'done',jobs.view().error);
  assert.equal(jobs.view().qualityStatus,'needs-review');
  assert.equal(store.snapshot().cards['rv:company'].verdict,review.verdict);
  const {run}=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.json'),'utf8'));
  assert.equal(run.quality.counts.company,1);
  assert.equal(run.quality.passes.length,1);
  assert.equal(attempted,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});
