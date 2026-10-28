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
  const snapshot=store.snapshot();assert.throws(()=>{snapshot.cards.bf01.title='篡改';},TypeError);assert.equal(store.snapshot().cards.bf01.title,'PO');
  await store.close();store=null;store=await openCollaborationStore(path,seed());assert.equal(currentVersion(store.snapshot().cards.bf01).number,2);
  assert.equal(JSON.parse(await readFile(path)).audit.length,1);assert.equal((await stat(path)).mode&0o777,0o600);
 }finally{if(store)await store.close();await unlink(path).catch(()=>{});await rmdir(dir);}
});
test('协作通知：接受修订后群里只 @ 需重签的人（不再说谁接受了什么）并提示对照下级；双方确认后公告达成共识；同卡不同字段的建议保留',async()=>{
 const {queueProposals}=await import('./nexus-memory.mjs');
 const dri={id:'member-05',visibleUnits:['eo'],unitDri:['eo'],missionDri:[]},owner={id:'member-06',visibleUnits:['eo'],unitDri:[],missionDri:['eo-m2']};
 let s=createCollaborationState([{id:'eo',level:'po',title:'E&O',owner:'刘人豪',children:[{id:'eo-m2',unit:'eo',level:'mission',title:'受控上下文复用',owner:'于斯一',result:'旧成果',checks:['旧验收'],children:[{id:'eo-m2-t1',unit:'eo',level:'task',title:'T',owner:'孙铭泽',children:[]}]}]}]);
 s=applyAction(s,owner,{type:'comment',cardId:'eo-m2',block:'checks',text:'建议改验收'});
 queueProposals(s,'eo',[{cardId:'eo-m2',baseVersion:1,sourceIds:[s.comments[0].id],patch:{checks:['新验收']},reason:'r1'},{cardId:'eo-m2',baseVersion:1,sourceIds:[s.comments[0].id],patch:{result:'新成果'},reason:'r2'}]);
 const [p1,p2]=s.proposals;
 s=applyAction(s,owner,{type:'acceptProposal',cardId:'eo-m2',proposalId:p1.id,patch:{checks:['负责人改过的验收']}});
 assert.deepEqual(currentVersion(s.cards['eo-m2']).content.checks,['负责人改过的验收']);
 assert.equal(s.proposals.find(p=>p.id===p1.id).edited,true);
 // Different field: still pending, carried to v2.
 assert.equal(s.proposals.find(p=>p.id===p2.id).status,'pending');assert.equal(s.proposals.find(p=>p.id===p2.id).baseVersion,2);
 const notice=s.messages.filter(m=>m.kind==='notice').at(-1).text;
 assert.match(notice,/^「受控上下文复用」已更新到 v2，请 @刘人豪 重新确认/);assert.doesNotMatch(notice,/接受了/,'不再说一遍谁接受了什么');assert.match(notice,/@刘人豪/);assert.match(notice,/正在按拆解规则对照下级 1 张卡/);assert.doesNotMatch(notice,/@于斯一/);
 s=applyAction(s,owner,{type:'confirm',cardId:'eo-m2',slot:'missionDri',baseVersion:2});
 s=applyAction(s,dri,{type:'confirm',cardId:'eo-m2',slot:'unitDri',baseVersion:2});
 assert.match(s.messages.at(-1).text,/达成共识/);
 // Only the author can delete a comment.
 assert.throws(()=>applyAction(s,dri,{type:'deleteComment',cardId:'eo-m2',commentId:s.comments[0].id}),/只能删除自己的批注/);
 s=applyAction(s,owner,{type:'deleteComment',cardId:'eo-m2',commentId:s.comments[0].id});assert.equal(s.comments.length,0);
});
test('上级修订后，下级负责人自己修订这张卡就算核对过；只看不改要点“核对完”',()=>{
 let s=applyAction(seed(),dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{title:'PO 新版'}});
 assert.equal(cardStatus(s.cards['bf01-m1']),'上级有调整 · 待核对');
 s=applyAction(s,owner,{type:'revise',cardId:'bf01-m1',baseVersion:1,patch:{title:'Mission 跟着改'}});
 assert.equal(s.cards['bf01-m1'].upstreamChange,undefined);
 let t=applyAction(seed(),dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{title:'PO 新版'}});
 t=applyAction(t,owner,{type:'acknowledgeImpact',cardId:'bf01-m1',baseVersion:1});
 assert.equal(t.cards['bf01-m1'].upstreamChange,undefined);
});
import {answersNexus} from './governance.mjs';
import {directQuestion} from './nexus-participation.mjs';
test('Nexus 刚问过某人，那人接着说的第一句就算在回答 Nexus，要马上处理',()=>{
 const t=n=>`2026-10-19T02:0${n}:00Z`;
 const s={messages:[{id:'n1',channel:'group',scope:'bf01',author:'Nexus',text:'刘明华，您希望在哪个节点前预留多长返工缓冲？',createdAt:t(1)}]};
 assert.equal(answersNexus(s,'bf01','member-01',t(2)),true);
 assert.equal(answersNexus(s,'bf01','member-03',t(2)),false,'问的是刘明华，孙铭泽说话不算回答');
 s.messages.push({id:'m1',channel:'group',scope:'bf01',author:'member-01',text:'至少 3 天吧？',createdAt:t(2)});
 assert.equal(answersNexus(s,'bf01','member-01',t(3)),false,'已经回答过了');
 assert.equal(directQuestion({text:'至少 3 天吧？',answersNexus:true}),true);
 const later=applyAction({...seed(),messages:[{id:'n2',channel:'group',scope:'bf01',author:'Nexus',text:'请确认是否按 10/26 改？',createdAt:new Date().toISOString()}]},dri,{type:'message',cardId:'bf01',general:true,text:'可以，按 10/26'});
 assert.equal(later.messages.at(-1).answersNexus,true);
});
test('接受修订卡后，它依据的话题在纪要里标为已定',()=>{
 let s=seed();s.nexus={bf01:{topics:[{id:'t1',title:'试点范围',status:'discussing',stage:'有方案',sourceIds:['c1','m2']},{id:'t2',title:'别的事',status:'discussing',sourceIds:['m9']}]}};
 s.proposals=[{id:'p1',scope:'bf01',cardId:'bf01',baseVersion:1,status:'pending',patch:{title:'新标题'},sourceIds:['c1'],reason:'按批注',createdAt:new Date().toISOString()}];
 s=applyAction(s,dri,{type:'acceptProposal',cardId:'bf01',proposalId:'p1'});
 assert.deepEqual(s.nexus.bf01.topics.map(t=>[t.id,t.status,t.stage]),[['t1','agreement','已定'],['t2','discussing',undefined]]);
});
