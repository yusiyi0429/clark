import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCollaborationState,applyAction,currentVersion,cardStatus} from './governance.mjs';
import {openCollaborationStore} from './collaboration-store.mjs';
const task={id:'bf01-m1-t1',unit:'bf01',level:'task',title:'Task',version:1,children:[]};
const mission={id:'bf01-m1',unit:'bf01',level:'mission',title:'Mission',version:1,children:[task]};
const seed=()=>createCollaborationState([{id:'bf01',level:'po',title:'PO',version:1,children:[mission]}]);
const ceo={id:'ceo',ceo:true},dri={id:'dri',visibleUnits:['bf01'],unitDri:['bf01']},owner={id:'owner',visibleUnits:['bf01'],missionDri:['bf01-m1']};
const confirm=(s,a,cardId,slot,baseVersion=1)=>applyAction(s,a,{type:'confirm',cardId,slot,baseVersion});
test('PO 同版本双方确认；Nexus 与无关人员不能确认',()=>{
 let s=confirm(seed(),dri,'bf01','unitDri');assert.equal(cardStatus(s.cards.bf01),'待另一方确认');
 s=confirm(s,ceo,'bf01','ceo');assert.equal(cardStatus(s.cards.bf01),'已确认');assert.equal(s.cards.bf01.confirmedVersion,1);
 assert.throws(()=>confirm(s,{id:'Nexus',kind:'coagent',units:['bf01']},'bf01','ceo'),/不能代替人/);
 assert.throws(()=>confirm(s,owner,'bf01','unitDri'),/没有这一确认职责/);
});
test('新版 PO 的交付衔接、LTO 引用与共同里程碑可修订且保留旧版',()=>{
 const before=seed();const next=applyAction(before,dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{handoffs:'Mission A 分批交付给 Mission B',parentLtoReference:'责任单元 LTO v2',milestones:['组合结果共同验收']}});
 assert.equal(currentVersion(next.cards.bf01).content.handoffs,'Mission A 分批交付给 Mission B');
 assert.equal(currentVersion(next.cards.bf01).content.parentLtoReference,'责任单元 LTO v2');
 assert.equal(next.cards.bf01.versions.length,2);assert.equal(before.cards.bf01.versions.length,1);
});
test('已确认 PO 修订保留旧版与签名，新版必须重新双方确认',()=>{
 let s=confirm(confirm(seed(),dri,'bf01','unitDri'),ceo,'bf01','ceo');
 s=applyAction(s,dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{title:'新 PO'}});
 assert.equal(s.cards.bf01.confirmedVersion,1);assert.equal(s.cards.bf01.versions[0].signatures.length,2);assert.equal(currentVersion(s.cards.bf01).signatures.length,0);
 assert.equal(cardStatus(s.cards.bf01),'待确认');assert.throws(()=>confirm(s,ceo,'bf01','ceo'),/当前版本/);
 s=confirm(s,ceo,'bf01','ceo',2);assert.equal(cardStatus(s.cards.bf01),'待另一方确认');
 s=confirm(s,dri,'bf01','unitDri',2);assert.equal(s.cards.bf01.confirmedVersion,2);
});
test('Mission 由领域 DRI 和 Mission DRI 同版本共同确认；Task 不握手',()=>{
 let s=confirm(seed(),dri,'bf01-m1','unitDri');assert.equal(cardStatus(s.cards['bf01-m1']),'待另一方确认');
 assert.equal(s.cards['bf01-m1'].confirmedVersion,null);
 assert.throws(()=>confirm(s,dri,'bf01-m1','missionDri'),/没有这一确认职责/);
 assert.throws(()=>confirm(s,owner,'bf01-m1','unitDri'),/没有这一确认职责/);
 assert.throws(()=>confirm(s,{id:'other',visibleUnits:['bf01'],missionDri:['bf01-m2']},'bf01-m1','missionDri'),/没有这一确认职责/);
 s=confirm(s,owner,'bf01-m1','missionDri');assert.equal(cardStatus(s.cards['bf01-m1']),'已确认');
 assert.throws(()=>confirm(s,ceo,'bf01-m1','ceo'),/没有这一确认职责/);
 assert.throws(()=>confirm(s,owner,task.id,'unitDri'),/不设握手/);
 s=applyAction(s,owner,{type:'revise',cardId:task.id,baseVersion:1,patch:{result:'负责人修订结果'}});assert.equal(currentVersion(s.cards[task.id]).number,2);
});
test('Mission 任一方先确认均可；修订后双方必须重新确认新版本',()=>{
 let s=confirm(seed(),owner,mission.id,'missionDri');assert.equal(cardStatus(s.cards[mission.id]),'待另一方确认');
 s=confirm(s,dri,mission.id,'unitDri');
 s=applyAction(s,owner,{type:'revise',cardId:mission.id,baseVersion:1,patch:{title:'修订 Mission'}});
 assert.equal(s.cards[mission.id].versions[0].signatures.length,2);assert.equal(currentVersion(s.cards[mission.id]).signatures.length,0);
 assert.throws(()=>confirm(s,dri,mission.id,'unitDri',1),/当前版本/);
 s=confirm(s,owner,mission.id,'missionDri',2);assert.equal(cardStatus(s.cards[mission.id]),'待另一方确认');
 s=confirm(s,dri,mission.id,'unitDri',2);assert.equal(s.cards[mission.id].confirmedVersion,2);
});
test('可读不等于可修订：CEO 和相邻 Mission 成员可看但不能修改',()=>{
 assert.throws(()=>applyAction(seed(),ceo,{type:'revise',cardId:mission.id,baseVersion:1,patch:{title:'越权'}}),/负责人/);
 assert.throws(()=>applyAction(seed(),{id:'other',visibleUnits:['bf01'],missionDri:['bf01-m2']},{type:'revise',cardId:task.id,baseVersion:1,patch:{title:'越权'}}),/负责人/);
 assert.throws(()=>applyAction(seed(),{id:'outside',visibleUnits:['eo']},{type:'comment',cardId:'bf01',text:'越域'}),/可见范围/);
});
test('Nexus 只能使用领域公开反馈修订候选，禁止注入私聊证据与改责任人',()=>{
 let s=applyAction(seed(),owner,{type:'comment',cardId:mission.id,text:'将成果写得具体一些'});
 const nexus={id:'Nexus',kind:'coagent',units:['bf01']};
 s=applyAction(s,nexus,{type:'revise',cardId:mission.id,baseVersion:1,patch:{result:'修订候选'},evidenceIds:['event-1']});
 assert.equal(currentVersion(s.cards[mission.id]).number,2);assert.equal(cardStatus(s.cards[mission.id]),'待确认');
 assert.throws(()=>applyAction(s,nexus,{type:'revise',cardId:mission.id,baseVersion:2,patch:{title:'私聊修订'},evidenceIds:['private-1']}),/私聊或其他领域/);
 assert.throws(()=>applyAction(s,nexus,{type:'revise',cardId:mission.id,baseVersion:2,patch:{owner:'另一人'},evidenceIds:['event-1']}),/字段不允许/);
});
test('持久化、单进程锁和并发版本冲突：不会覆盖别人修订',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'decoding-store-')),path=join(dir,'state.json');let store;
 try{
  store=await openCollaborationStore(path,seed());await assert.rejects(openCollaborationStore(path,seed()),{code:'EEXIST'});
  const results=await Promise.allSettled(['A','B'].map(title=>store.apply(dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{title}})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
  const snapshot=store.snapshot();snapshot.cards.bf01.title='篡改';assert.equal(store.snapshot().cards.bf01.title,'PO');
  await store.close();store=null;store=await openCollaborationStore(path,seed());assert.equal(currentVersion(store.snapshot().cards.bf01).number,2);
  assert.equal(JSON.parse(await readFile(path)).audit.length,1);assert.equal((await stat(path)).mode&0o777,0o600);
 }finally{if(store)await store.close();await unlink(path).catch(()=>{});await rmdir(dir);}
});
