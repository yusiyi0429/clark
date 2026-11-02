import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createReviewJobs} from './review-generation.mjs';
import {createCollaborationState} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';

const actor={id:'member-04'};
const skillRoot=new URL('./review-skill/',import.meta.url);
const review={verdict:'未达成',verdictReason:'缺少结果',facts:[{ref:'x',item:'成果',status:'未达成',evidence:'尚缺记录',gap:'尚缺记录'}],nextInputs:[{ref:'x',type:'继续',text:'核对结果'}]};
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('job did not finish');}
async function setup(gateway){
 const dir=await mkdtemp(join(tmpdir(),'m2-quality-job-'));let state=createCollaborationState([]);const original=structuredClone(state.cards);
 const store={snapshot:()=>state,transact:async fn=>{state=fn(structuredClone(state));return state;}};
 const reader=async()=>({list:async f=>f.type==='Company'?[{object_id:'company-source'}]:[],get:async()=>({business:{title:'公司',version:1,blocks:[]}}),findEvents:async()=>[]});
 const jobs=createReviewJobs({store,gateway,skillRoot,statePath:join(dir,'state.json'),reader,isOperator:a=>a.id==='member-04',installReviewRound,archivesPath:path=>path+'.archives.json',ceoName:'刘明华'});
 return {jobs,store,dir,original};
}
test('a job at the two-edit limit writes an independent draft and never installs it in current business state',async()=>{
 let revisions=0,checks=0;
 const gateway={status:{model:'fixture'},complete:async messages=>{const p=JSON.parse(messages[1].content);if(!p.unit){checks++;return {answer:JSON.stringify({issues:[{ref:'company',type:'结构与表达',problem:'未验证被写成未发生',impact:'事实过强',mustFix:true,fixable:true}]})};}if(p.revision)revisions++;return {answer:JSON.stringify({review})};}};
 const {jobs,store,dir,original}=await setup(gateway);
 try{
  const job=await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});
  await until(()=>jobs.view().status!=='running');const final=jobs.view();
  assert.equal(final.status,'draft');assert.equal(final.candidateAvailable,true);assert.equal(revisions,2);assert.equal(checks,9,'all three groups run after each of the two edits');assert.ok(final.checks.length);
  assert.deepEqual(store.snapshot().cards,original);assert.equal(store.snapshot().reviewRound,undefined);
  const work=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.json'),'utf8')),draft=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.candidate.json'),'utf8'));
  assert.equal(work.run.quality.counts.company,2);assert.equal(draft.quality.status,'blocked');assert.equal(work.run.quality.passes.length,3);
  await assert.rejects(jobs.start(actor,{resume:true}),/没有可续跑/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('only an operator can cancel a running job; cancellation saves a resumable failure without installing',async()=>{
 let entered=false;
 const gateway={status:{model:'fixture'},complete:async(_messages,{signal})=>{entered=true;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
 const {jobs,store,dir,original}=await setup(gateway);
 try{
  await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});await until(()=>entered);
  await assert.rejects(jobs.cancel({id:'member-09'}),{status:403});await jobs.cancel(actor);await until(()=>jobs.view().status==='failed');
  assert.match(jobs.view().error,/停止/);assert.deepEqual(store.snapshot().cards,original);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('resume after a checker outage keeps the edited draft and its budget, then installs only the rechecked candidate',async()=>{
 let fail=true,initial=0,revised=0;
 const gateway={status:{model:'fixture'},complete:async messages=>{const p=JSON.parse(messages[1].content);
  if(!p.unit){const current=p.reviews[0];if(current.verdictReason==='fixed'&&/第3组/.test(p.task)&&fail)throw Error('checker offline');return {answer:JSON.stringify({issues:current.verdictReason==='fixed'?[]:[{ref:'company',type:'结构与表达',problem:'需要澄清',impact:'影响理解',mustFix:true,fixable:true}]})};}
  if(p.revision)revised++;else initial++;return {answer:JSON.stringify({review:{...review,verdictReason:p.revision?'fixed':'initial'}})};
 }};
 const {jobs,store,dir}=await setup(gateway);
 try{
  const job=await jobs.start(actor,{period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'},{now:new Date('2026-11-02T00:00:00Z')});await until(()=>jobs.view().status==='failed');
  assert.equal(store.snapshot().reviewRound,undefined);fail=false;await jobs.start(actor,{resume:true});await until(()=>jobs.view().status!=='running');
  assert.equal(jobs.view().status,'done');assert.equal(initial,1);assert.equal(revised,1);assert.ok(store.snapshot().cards['rv:company']);
  const work=JSON.parse(await readFile(join(dir,'review-jobs',job.id+'.json'),'utf8'));assert.equal(work.run.reviews.company.verdictReason,'fixed');assert.equal(work.run.quality.counts.company,1);assert.equal(work.run.quality.status,'passed');
 }finally{await rm(dir,{recursive:true,force:true});}
});
