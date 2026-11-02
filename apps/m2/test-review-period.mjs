import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {reviewTarget,monthEnd,defaultReviewPeriod} from './review-period.mjs';
import {createReviewJobs} from './review-generation.mjs';
import {openCollaborationStore,archivesPath} from './collaboration-store.mjs';
const now=new Date('2026-11-02T03:00:00Z'),target={period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00'};
test('explicit October target survives November run; boundaries handle leap years and year rollover',()=>{
 assert.deepEqual(reviewTarget(target,now),target);assert.equal(defaultReviewPeriod(now),'2026-10');assert.equal(defaultReviewPeriod(new Date('2027-01-01T01:00:00Z')),'2026-12');assert.equal(monthEnd('2024-02'),'2024-02-29');assert.equal(monthEnd('2026-02'),'2026-02-28');assert.equal(monthEnd('2026-04'),'2026-04-30');
});
test('missing or invalid period/cutoff and future dates fail before data is read',()=>{
 for(const bad of [{},{period:'2026-13',cutoff:target.cutoff},{period:'2026-10',cutoff:'2026-11-01T00:00:00+08:00'},{period:'2026-02',cutoff:'2026-02-30T23:59:59+08:00'},{period:'2026-10',cutoff:'2026-10-31T23:59:59Z'},{period:'2026-11',cutoff:'2026-11-02T23:59:59+08:00'},{period:'2026-12',cutoff:'2026-12-31T23:59:59+08:00'}])assert.throws(()=>reviewTarget(bad,now),e=>e.status===400,JSON.stringify(bad));
});
test('job and resume use frozen target rather than current month or replacement request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m2-review-period-')),statePath=join(dir,'state.json');const store=await openCollaborationStore(statePath,{schemaVersion:1,cards:{},comments:[],messages:[],audit:[],sequence:0});
 const requested=[];const jobs=createReviewJobs({store,gateway:{status:{ready:false}},skillRoot:new URL('./review-skill/',import.meta.url),statePath,isOperator:a=>a.id==='operator',archivesPath,reader:async()=>({listMany:async kinds=>{requested.push(kinds);throw Error('synthetic reader stops before model');}})});
 try{
  await assert.rejects(jobs.start({id:'operator'},{period:'2026-13',cutoff:target.cutoff},{now}),e=>e.status===400);assert.equal(store.snapshot().reviewJob,undefined);
  const job=await jobs.start({id:'operator'},target,{now});assert.equal(job.period,target.period);assert.equal(job.cutoff,target.cutoff);
  const wait=async()=>{for(let i=0;i<100&&store.snapshot().reviewJob?.status==='running';i++)await new Promise(r=>setTimeout(r,10));};await wait();assert.equal(store.snapshot().reviewJob.status,'failed');assert.ok(requested[0].filter(k=>k.period).every(k=>k.period==='2026-10'));
  const resumed=await jobs.start({id:'operator'},{resume:true,period:'2026-11',cutoff:'2026-11-01T23:59:59+08:00'},{now:new Date('2026-12-02T03:00:00Z')});assert.equal(resumed.id,job.id);assert.equal(resumed.period,'2026-10');assert.equal(resumed.cutoff,target.cutoff);await wait();assert.ok(requested[1].filter(k=>k.period).every(k=>k.period==='2026-10'));
 }finally{await store.close();}
});
test('month and cutoff use Beijing occurrence time even when events use UTC',async()=>{
 const {inReviewWindow,reviewDay}=await import('./review-period.mjs');
 assert.equal(inReviewWindow('2026-09-30T16:00:00Z',target.period,target.cutoff),true);
 assert.equal(inReviewWindow('2026-10-31T15:59:59Z',target.period,target.cutoff),true);
 assert.equal(inReviewWindow('2026-10-31T16:00:00Z',target.period,target.cutoff),false);
 assert.equal(reviewDay('2026-09-30T16:00:00Z'),'2026-10-01');
 assert.equal(inReviewWindow('2026-10-30',target.period,target.cutoff),true);
});
