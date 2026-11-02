import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {importReviewRound} from './deployment-review-import.mjs';
import {reviewFile} from './review-generation.mjs';
import {reviewCards} from './review-round.mjs';
import {createCollaborationState} from './governance.mjs';
import {openCollaborationStore} from './collaboration-store.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(JSON.stringify(v));
const oldId='3120849e-bc65-4793-8da3-9d76b5e6875a',jobId='b1eac8ab-05e5-4b76-8790-b22f2ac7e28b',attemptId='00000000-0000-4000-8000-000000000001';
const primary='wangsu/claude-sonnet-5-5',backup='wangsu/gpt-6.1-sol',generationHead='340260ee9fb93e073aa629927ee2d9694b6b4efd',installationHead='a'.repeat(40),now='2026-11-02T18:00:00.000Z';
async function fixture(referenceContract=false){
 const dir=await mkdtemp(join(tmpdir(),'m2-external-install-')),seedDir=join(dir,'seed'),statePath=join(dir,'state/collaboration.json'),jobsDir=join(dir,'state/review-jobs');await mkdir(seedDir,{recursive:true});await mkdir(join(jobsDir,jobId+'.attempts'),{recursive:true});
 const skill={version:'2.1.13',hash:hash('skill')},input={...(referenceContract?{engineeringContracts:{evidenceAddresses:1}}:{}),period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00',stages:[[],[],[{id:'company',level:'company'}]]};
 const review={ref:'company',unit:'company',level:'company',title:'真实新复盘',owner:'刘明华',verdict:'达成',verdictReason:'完成',facts:[{ref:'x',item:'结果',status:'达成',evidence:'事实',gap:''}],nextInputs:[]},reviews={company:review},attempt={id:attemptId,key:'company',status:'accepted',request:{model:primary,options:{maxTokens:32000}},returnedModel:'provider-sonnet'};
 const run={modelPolicy:{primary,fallbackModels:[backup]},outputPolicy:{initialMaxTokens:32000,checkMaxTokens:64000,revisionMaxTokens:32000},raw:{company:JSON.stringify({review})},initialAttempts:[attempt],initialCache:{company:{selectedAlias:primary,returnedModel:'provider-sonnet',attemptId}},reviews,failed:[],dropped:[],issues:[],quality:{status:'passed',maxRevisions:2,counts:{},remaining:[],verificationPending:[],inputHash:hash(input),sourceHash:hash('sources'),skillHash:skill.hash,candidateHash:hash(reviews),requests:{},passes:[{status:'done',reviews:structuredClone(reviews),reviewHash:hash(reviews)}]}};
 const work={input,inputHash:hash(input),skillSnapshot:skill,run},file=reviewFile(run,input,{skill,model:primary,label:'新正式复盘',startedAt:'2026-11-02T16:40:10.514Z'});
 const job={id:jobId,status:'done',period:input.period,cutoff:input.cutoff,createdAt:'2026-11-02T16:41:02.000Z',finishedAt:'2026-11-02T16:55:00.000Z'};
 const receipt={schemaVersion:1,job,startedAt:file.startedAt,generationHead,installationHead,skill,inputHash:work.inputHash,sourceHash:run.quality.sourceHash,journalHashes:{}};
 async function persist(){const bytes=Buffer.from(JSON.stringify(file)),workBytes=Buffer.from(JSON.stringify(work)),journal=Buffer.from(JSON.stringify({schemaVersion:1,...attempt}));receipt.fileSha256=sha(bytes);receipt.workSha256=sha(workBytes);receipt.journalHashes[attemptId+'.json']=sha(journal);await writeFile(join(seedDir,'formal.json'),bytes);await writeFile(join(jobsDir,jobId+'.json'),workBytes);await writeFile(join(jobsDir,jobId+'.attempts',attemptId+'.json'),journal);await writeFile(join(seedDir,'receipt.json'),JSON.stringify(receipt));}
 await persist();await writeFile(join(jobsDir,oldId+'.json'),'original 312 work');
 const oldJob={id:oldId,status:'failed',error:'original failure'},cards=reviewCards({reviews:{company:{...review,title:'旧复盘'}}});cards['rv:company'].versions[0].signatures=[{slot:'ceo',actorId:'member-01'}];cards['rv:company'].confirmedVersion=1;
 const state={...createCollaborationState([]),cards,reviewJob:oldJob,reviewRound:{period:'2026-10',loadedAt:'2026-10-28T00:00:00Z'},comments:[{id:'old-comment',cardId:'rv:company'}],messages:[]},store=await openCollaborationStore(statePath,state);
 return {dir,seedDir,statePath,jobsDir,store,work,file,receipt,persist,oldJob,args:{file:'formal.json',receipt:'receipt.json',period:input.period,cutoff:input.cutoff},options:{seedDir,statePath,installationHead,now}};
}
test('external install archives the current locked state and old job, installs truthful new job and never inherits signatures',async()=>{
 const f=await fixture();try{
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const edit=f.store.transact(async s=>{entered();await gate;s.comments.push({id:'concurrent-human',cardId:'rv:company'});return s;});await ready;
  const importing=importReviewRound({transact:fn=>f.store.transact(fn),snapshot:()=>assert.fail('must archive under lock')},f.args,f.options);release();await edit;const result=await importing;
  const state=f.store.snapshot(),archived=JSON.parse(await readFile(join(f.dir,'state/archive',result.saved),'utf8'));
  assert.ok(archived.comments.some(c=>c.id==='concurrent-human'));assert.deepEqual(archived.reviewJob,f.oldJob);assert.deepEqual(state.reviewJobArchives[0].job,f.oldJob);
  assert.equal(state.reviewJob.id,jobId);assert.equal(state.reviewJob.status,'done');assert.equal(state.reviewJob.createdAt,f.receipt.job.createdAt);assert.equal(state.reviewJob.startedAt,f.file.startedAt);assert.notEqual(state.reviewJob.createdAt,state.reviewJob.startedAt);
  assert.equal(state.reviewRound.externalGeneration.generationHead,generationHead);assert.equal(state.reviewRound.externalGeneration.installationHead,installationHead);assert.equal(state.reviewRound.externalGeneration.fileSha256,f.receipt.fileSha256);
  assert.deepEqual(state.cards['rv:company'].versions[0].signatures,[]);assert.equal(state.cards['rv:company'].confirmedVersion,null);assert.ok(state.reviewArchives.some(a=>a.cards?.[0]?.versions[0].signatures.length));
  assert.equal(await readFile(join(f.jobsDir,oldId+'.json'),'utf8'),'original 312 work');
  await f.store.transact(s=>{s.messages.push({id:'after-install',text:'human'});return s;});const before=hash(f.store.snapshot());const again=await importReviewRound(f.store,f.args,f.options);assert.equal(again.alreadyInstalled,true);assert.equal(hash(f.store.snapshot()),before);
 }finally{await f.store.close();await rm(f.dir,{recursive:true,force:true});}
});
test('missing/wrong quality, altered artifacts, mismatched heads and running jobs cannot replace current state',async()=>{
 for(const kind of ['no-receipt','no-quality','bad-quality','body','input','source','model','work-bytes','head','journal','running','proof','no-proof']){
  const f=await fixture(['proof','no-proof'].includes(kind));try{
   if(kind==='no-receipt')delete f.args.receipt;
   if(kind==='no-quality'){delete f.file.quality;await f.persist();}
   if(kind==='bad-quality'){f.file.quality.status='blocked';await f.persist();}
   if(kind==='body'){f.file.reviews.company.verdictReason='tampered';await f.persist();}
   if(kind==='input'){f.work.input.period='2026-09';await f.persist();}
   if(kind==='source'){f.receipt.sourceHash=hash('wrong source');await f.persist();}
   if(kind==='model'){f.file.modelProvenance.requestedPrimary=backup;await f.persist();}
   if(kind==='proof'){f.file.evidenceReferences.company={'[fake:E99]':{ref:'fake',id:'E99'}};await f.persist();}
   if(kind==='no-proof'){delete f.file.evidenceReferences;await f.persist();}
   if(kind==='work-bytes')await writeFile(join(f.jobsDir,jobId+'.json'),'{}');
   if(kind==='head'){f.receipt.installationHead='b'.repeat(40);await f.persist();}
   if(kind==='journal')await writeFile(join(f.jobsDir,jobId+'.attempts',attemptId+'.json'),'{}');
   if(kind==='running')await f.store.transact(s=>{s.reviewJob.status='running';return s;});
   const before=hash(f.store.snapshot());await assert.rejects(importReviewRound(f.store,f.args,f.options),e=>[400,409].includes(e.status),kind);assert.equal(hash(f.store.snapshot()),before,kind);assert.equal(await readFile(join(f.jobsDir,oldId+'.json'),'utf8'),'original 312 work');
  }finally{await f.store.close();await rm(f.dir,{recursive:true,force:true});}
 }
});
