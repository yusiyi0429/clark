import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCollaborationState} from './governance.mjs';
import {openCollaborationStore} from './collaboration-store.mjs';
import {importReviewRound} from './deployment-review-import.mjs';
// 上线复盘 (陈溪南 2026-10-22): the earlier state is saved whole, then the review opens on clean rooms.
const run={skill:{version:'2.0.4'},reviews:[
 {unit:'company',level:'company',ref:'company',title:'词元云集 10 月',owner:'刘明华',verdict:'未达成',verdictReason:'r',targets:[],causes:[],nextInputs:[]},
 {unit:'bf01',level:'ru',ref:'bf01',title:'灯塔',owner:'刘明华',verdict:'未达成',verdictReason:'r',targets:[],causes:[],nextInputs:[],parent:'company'}]};
test('导入复盘：先整份存档，再装一轮干净的复盘；文件名、月份和生成中都会拦下',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m2-review-import-')),seedDir=join(dir,'seed'),statePath=join(dir,'state','collaboration.json');
 try{
  await (await import('node:fs/promises')).mkdir(seedDir);await writeFile(join(seedDir,'review-oct.json'),JSON.stringify(run));
  const initial={...createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,children:[]}]),messages:[{id:'m1',text:'旧测试消息'}],planHandoff:{status:'prepared'},unitsDone:{bf01:true},roundAttempts:[{id:'x'}]};
  const store=await openCollaborationStore(statePath,initial);
  for(const [args,status] of [[{file:'../x.json',period:'2026-10'},400],[{file:'review-oct.json'},400]])await assert.rejects(importReviewRound(store,args,{seedDir,statePath}),{status});
  await assert.rejects(importReviewRound(store,{file:'review-oct.json',period:'2026-10'},{seedDir,statePath,busy:true}),{status:409});
  const out=await importReviewRound(store,{file:'review-oct.json',period:'2026-10',cutoff:'2026-10-22T23:59:59+08:00',label:'10 月复盘 2.0.4'},{seedDir,statePath,now:'2026-10-22T12:00:00.000Z'});
  assert.equal(out.reviews,2);assert.equal(out.label,'10 月复盘 2.0.4');
  const saved=JSON.parse(await readFile(join(dir,'state','archive',out.saved),'utf8'));assert.equal(saved.messages[0].text,'旧测试消息');
  const s=store.snapshot();
  assert.deepEqual(s.messages.filter(m=>m.text==='旧测试消息'),[]);assert.equal(s.planHandoff,undefined);assert.equal(s.unitsDone,undefined);assert.deepEqual(s.roundAttempts,[]);
  assert.equal(s.reviewRound.period,'2026-10');assert.equal(s.reviewRound.cutoff,'2026-10-22T23:59:59+08:00');assert.ok(s.cards['rv:company']&&s.cards['rv:bf01']);
  assert.ok((await readdir(join(dir,'state','archive'))).length>=1);
  await store.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
