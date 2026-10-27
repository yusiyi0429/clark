import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCollaborationState,applyAction,currentVersion,cardStatus} from './governance.mjs';
import {installReviewRound,reviewCards,causeOf} from './review-round.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
// 复盘 (陈溪南 2026-10-20/21): same units, groups and handshake as the plan; 刘明华 signs both slots on units he leads.
const sample={skillFormat:'tkos-review 2.0.3',period:'2026-10',reviews:[
 {unit:'company',level:'company',ref:'company',title:'词元云集 10 月',owner:'刘明华',verdict:'未达成',verdictReason:'r',targets:[],causes:[{text:'**a：**b',ask:'为什么？'}],nextInputs:[],ltoReview:{choice:'维持',reason:'x'}},
 {unit:'bf01',level:'ru',ref:'bf01',title:'灯塔',owner:'刘明华',verdict:'未达成',verdictReason:'r',targets:['**部署（未达成）：**没有'],causes:['**晚：**排得晚'],nextInputs:[{id:'bf01-1',type:'欠账',text:'t'}],parent:'company'},
 {unit:'bf01',level:'mission',ref:'bf01-m1',title:'首用',owner:'孙铭泽',verdict:'部分达成',verdictReason:'r',targets:[],causes:[{text:'**慢：**链路没通',ask:'为什么？'}],nextInputs:[],parent:'bf01'}]};
const plan=()=>createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,children:[]}]);
test('复盘卡挂在同一单元：rv:前缀、上下级、原因统一成 {text, ask}',()=>{
 const c=reviewCards(sample);
 assert.deepEqual(Object.keys(c),['rv:company','rv:bf01','rv:bf01-m1']);
 assert.equal(c['rv:bf01'].parentId,'rv:company');assert.equal(c['rv:bf01-m1'].parentId,'rv:bf01');assert.equal(c['rv:bf01-m1'].unit,'bf01');
 assert.deepEqual(c['rv:bf01'].causes,[{text:'**晚：**排得晚',ask:''}]);assert.deepEqual(causeOf({text:'x',ask:'y'}),{text:'x',ask:'y'});
});
test('握手：PO 复盘 CEO 和单元 DRI 各签一次（刘明华两个都签）；个人复盘只由负责人确认；公司复盘 CEO 签',()=>{
 let s=installReviewRound(plan(),sample,{label:'10 月复盘'});
 const ceo=memberActor('member-01',s),sun=memberActor('member-03',s);
 assert.throws(()=>applyAction(s,ceo,{type:'confirm',cardId:'rv:bf01',slot:'ceo',baseVersion:1}),/还有 1 份个人复盘未确认/,'单元复盘等个人复盘先确认');
 s=applyAction(s,sun,{type:'confirm',cardId:'rv:bf01-m1',slot:'missionDri',baseVersion:1});
 s=applyAction(s,ceo,{type:'confirm',cardId:'rv:bf01',slot:'ceo',baseVersion:1});
 assert.notEqual(s.cards['rv:bf01'].confirmedVersion,1,'签一次不算完成');
 s=applyAction(s,ceo,{type:'confirm',cardId:'rv:bf01',slot:'unitDri',baseVersion:1});
 assert.equal(s.cards['rv:bf01'].confirmedVersion,1);
 s=applyAction(s,sun,{type:'confirm',cardId:'rv:bf01-m1',slot:'missionDri',baseVersion:1});
 assert.equal(s.cards['rv:bf01-m1'].confirmedVersion,1,'个人复盘负责人一人确认就完成（2026-10-27）');
 assert.throws(()=>applyAction(s,ceo,{type:'confirm',cardId:'rv:bf01-m1',slot:'unitDri',baseVersion:1}),/确认职责/,'单元 DRI 不再签个人复盘');
 s=applyAction(s,ceo,{type:'confirm',cardId:'rv:company',slot:'ceo',baseVersion:1});assert.equal(s.cards['rv:company'].confirmedVersion,1);
});
test('复盘可修订判定、原因等字段，不触发拆解的下级对齐；拆解卡不受影响',()=>{
 let s=installReviewRound(plan(),sample,{label:'10 月复盘'});
 const sun=memberActor('member-03',s);
 assert.ok(!sun.missionDri.includes('rv:bf01-m1'),'复盘卡不算进拆解的 Mission');
 s=applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:1,patch:{causes:[{text:'**人被借走：**一周',ask:''}]}});
 assert.equal(currentVersion(s.cards['rv:bf01-m1']).number,2);assert.ok(!(s.cascadeQueue||[]).length);
 assert.throws(()=>applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:2,patch:{tier:'P0'}}),/字段不允许/);
 assert.equal(currentVersion(s.cards.bf01).number,1);
});
test('重装复盘：旧复盘卡归档，拆解卡不动；页面拿到复盘轮次信息，公司复盘只有 CEO 看得到',()=>{
 let s=installReviewRound(plan(),sample,{label:'第 1 轮'});s=installReviewRound(s,sample,{label:'第 2 轮'});
 assert.equal(s.reviewArchives.length,1);assert.ok(s.cards.bf01);assert.equal(s.reviewRound.label,'第 2 轮');
 const p=sharedProjection(s,memberActor('member-03',s));assert.equal(p.review.label,'第 2 轮');assert.ok(!p.drafts['rv:company']);
 assert.ok(sharedProjection(s,memberActor('member-01',s)).drafts['rv:company']);
});
test('回答追问：作为原因行的批注进群，记下回答的是哪一问',()=>{
 let s=installReviewRound(plan(),sample,{label:'10 月复盘'});
 const ceo=memberActor('member-01',s);
 s=applyAction(s,ceo,{type:'comment',cardId:'rv:company',baseVersion:1,block:'causes',text:'回答「为什么？」：人不够',answers:{index:0}});
 const c=s.comments.at(-1);assert.deepEqual(c.answers,{index:0,ask:'为什么？'});assert.equal(c.scope,'company');
});
test('同一个 Nexus：复盘卡并进单元的卡片，按复盘字段校验；回答追问算修改要求、不自动生效',async()=>{
 const {reviewCardsFor,reviewPatchProblem,reviewPromptBlock}=await import('./nexus-review.mjs');
 const {validateNexusResult,publicEvidence}=await import('./nexus-policy.mjs');
 const {queueProposals,applyOwnerAnnotations}=await import('./nexus-memory.mjs');
 let s=installReviewRound(plan(),sample,{label:'10 月复盘'});
 const sun=memberActor('member-03',s);
 s=applyAction(s,sun,{type:'comment',cardId:'rv:bf01-m1',baseVersion:1,block:'causes',text:'回答：人被借走一周',answers:{index:0}});
 assert.deepEqual(reviewCardsFor(s,'bf01').map(c=>c.id),['rv:bf01'],'单元群只管单元复盘（个人复盘在本人的房间，2026-10-27）');
 const cards=reviewCardsFor(s,'person:member-03');assert.deepEqual(cards.map(c=>c.id),['rv:bf01-m1']);assert.deepEqual(cards[0].aliases,[]);
 assert.equal(reviewPatchProblem(cards[0],{tier:'P0'}),'有字段不能改');assert.match(reviewPatchProblem(cards[0],{verdict:'差不多'}),/判定只能是/);
 const evidence=publicEvidence(sharedProjection(s,sun).records['group:person:member-03'],'person:member-03',{retainAll:true});
 const e=evidence.find(x=>x.answers);assert.ok(e,'回答带着 answers 进 Nexus');
 const out=validateNexusResult({topics:[],proposals:[{cardId:'rv:bf01-m1',baseVersion:1,basis:'request',sourceIds:[e.id],reason:'对原因的解释',patch:{causes:[{text:'**人被借走：**一周（负责人报告）',ask:'x'}]}}]},{cards,evidence,fresh:evidence});
 assert.equal(out.proposals.length,1,JSON.stringify(out.rejected));assert.equal(out.proposals[0].patch.causes[0].ask,'x');
 s=applyOwnerAnnotations(queueProposals(s,'person:member-03',out.proposals),'person:member-03');
 assert.equal(s.proposals.at(-1).status,'pending','回答不是改稿指令，仍等负责人确认');
 assert.match(reviewPromptBlock('--- references/revision-loop.md ---\n补了新证据'),/补了新证据/);
});
test('群里说“PO 复盘”“Mission 01 的复盘”，Nexus 会把对应复盘卡带进来',async()=>{
 const {focusCardIds}=await import('./nexus-context.mjs');
 const cards=[{id:'eo',level:'po',title:'E&O',aliases:[]},{id:'rv:eo',kind:'review',level:'po',title:'E&O 10 月',aliases:[]},{id:'rv:eo-m1',kind:'review',level:'mission',title:'Ontology',aliases:[]}];
 assert.deepEqual(focusCardIds(cards,[{id:'a',text:'@Nexus PO 复盘里那条原因能改吗'}],[]),['rv:eo']);
 assert.deepEqual(focusCardIds(cards,[{id:'b',text:'Mission 01 的复盘判严了'}],[]),['rv:eo-m1']);
});
test('群里点名“PO 复盘”就算依据提到了这张复盘卡',async()=>{
 const {validateNexusResult}=await import('./nexus-policy.mjs');
 const card={id:'rv:eo',kind:'review',level:'po',version:1,title:'E&O 10 月',owner:'刘人豪',causes:[{text:'**a：**b',ask:''}],aliases:[]};
 const ev=[{id:'m1',author:'刘人豪',text:'@Nexus PO 复盘里三大场景没定名是因为明华没回，写进去',kind:'chat'}];
 const r=validateNexusResult({topics:[],proposals:[{cardId:'rv:eo',baseVersion:1,basis:'request',sourceIds:['m1'],patch:{causes:[{text:'**场景没人定：**负责人报告，明华未回复',ask:''}]}}]},{cards:[card],evidence:ev,fresh:ev});
 assert.equal(r.proposals.length,1,JSON.stringify(r.rejected));
});
test('换一轮复盘：旧复盘卡上的批注跟着归档，不挂到新一轮同名的卡上',()=>{
 let s=installReviewRound(plan(),sample,{label:'样例'});
 s=applyAction(s,memberActor('member-01',s),{type:'comment',cardId:'rv:bf01',baseVersion:1,block:'verdict',text:'判严了'});
 s=installReviewRound(s,sample,{label:'正式'});
 assert.equal(s.comments.filter(c=>c.cardId==='rv:bf01').length,0);assert.equal(s.reviewArchives.at(-1).comments.length,1);
});
test('复盘 → 拆解：别的复盘都确认完才能确认公司复盘；确认后把复盘打包成下月拆解的输入',async()=>{
 const {handoffPackage,nextPeriod,monthOf}=await import('./review-handoff.mjs');
 let s=installReviewRound(plan(),{...sample,period:'2026-10'},{label:'10 月复盘'});
 const ceo=memberActor('member-01',s),sun=memberActor('member-03',s);
 assert.throws(()=>applyAction(s,ceo,{type:'confirm',cardId:'rv:company',slot:'ceo',baseVersion:1}),/还有 2 份复盘未确认/);
 s=applyAction(s,sun,{type:'confirm',cardId:'rv:bf01-m1',slot:'missionDri',baseVersion:1});
 s=applyAction(s,ceo,{type:'confirm',cardId:'rv:bf01',slot:'ceo',baseVersion:1});s=applyAction(s,ceo,{type:'confirm',cardId:'rv:bf01',slot:'unitDri',baseVersion:1});
 s=applyAction(s,ceo,{type:'confirm',cardId:'rv:company',slot:'ceo',baseVersion:1});
 assert.equal(s.planHandoff.status,'requested');
 const pkg=handoffPackage(s);assert.equal(pkg.forPeriod,'2026-11');assert.equal(pkg.units[0].po.nextInputs[0].id,'bf01-1');assert.equal(pkg.company.ltoReview.choice,'维持');
 assert.equal(nextPeriod('2026-12'),'2027-01');assert.equal(monthOf('2026-11'),'11 月');
});
test('换一轮复盘：旧复盘的修订卡、群消息和上一轮其他讨论都归档，Nexus 不会把旧讨论当成这一轮',()=>{
 let s=installReviewRound(plan(),sample,{label:'样例',now:'2026-10-21T01:00:00Z'});
 (s.proposals??=[]).push({id:'p1',cardId:'rv:bf01',status:'accepted',scope:'bf01'});
 s.messages.push({id:'m1',author:'Nexus',channel:'group',scope:'bf01',text:'已出修订卡：PO 复盘里改判未达成',createdAt:'2026-10-21T02:00:00Z'},{id:'m2',author:'member-01',channel:'group',scope:'bf01',text:'计划的事',createdAt:'2026-10-21T02:01:00Z'});
 s=installReviewRound(s,sample,{label:'正式',now:'2026-10-21T03:00:00Z'});
 assert.ok(!s.proposals.some(p=>p.id==='p1'));assert.ok(!s.messages.some(m=>m.id==='m1'));assert.ok(!s.messages.some(m=>m.id==='m2'));
 assert.ok(s.reviewArchives.at(-1).messages.some(m=>m.id==='m1'));
 // 复盘和拆解是一整轮: the other talk of the last round is archived too, and the rooms only hold this round's notices.
 assert.ok(s.talkArchives.at(-1).messages.some(m=>m.id==='m2'));assert.ok(s.messages.every(m=>m.broadcast));
});
test('上级在卡上提意见、负责人回“我认了”，算达成一致，可以出卡',async()=>{
 const {validateNexusResult}=await import('./nexus-policy.mjs');
 const po={id:'rv:eo',kind:'review',level:'po',version:1,title:'E&O',owner:'刘人豪、于斯一',targets:['**资料包（部分达成）：**x'],aliases:[]};
 const m3={id:'rv:eo-m3',kind:'review',level:'mission',version:1,title:'M3',owner:'于斯一',targets:['**资料包（部分达成）：**x'],aliases:[]};
 const ev=[{id:'c1',author:'刘明华',text:'资料包那条不能算部分达成吧，没人在用',kind:'document-comment',context:{selection:{id:'rv:eo',version:1},block:'verdict'},createdAt:'2026-10-21T08:00:00Z'},{id:'m1',author:'刘人豪',text:'我认了',kind:'chat',createdAt:'2026-10-21T08:01:00Z'}];
 for(const card of [po,m3]){const r=validateNexusResult({topics:[],proposals:[{cardId:card.id,baseVersion:1,basis:'agreement',sourceIds:['c1'],patch:{targets:['**资料包（未达成）：**x']}}]},{cards:[po,m3],evidence:ev,fresh:ev});assert.equal(r.proposals.length,1,card.id+JSON.stringify(r.rejected));}
});
test('领域内的公共通知 @所有人：复盘生成、换新一轮、本领域复盘全部确认',()=>{
 let s=installReviewRound(plan(),{...sample,period:'2026-10'},{label:'第 1 轮'});
 const ready=s.messages.filter(m=>m.broadcast==='review-ready');assert.deepEqual(ready.map(m=>m.scope),['bf01']);assert.match(ready[0].text,/^@所有人 10 月复盘已生成/);
 const ceo=memberActor('member-01',s),sun=memberActor('member-03',s);
 s=applyAction(s,sun,{type:'confirm',cardId:'rv:bf01-m1',slot:'missionDri',baseVersion:1});
 assert.ok(!s.messages.some(m=>m.broadcast==='review-unit-done'),'单元复盘还没确认');
 s=applyAction(s,ceo,{type:'confirm',cardId:'rv:bf01',slot:'ceo',baseVersion:1});s=applyAction(s,ceo,{type:'confirm',cardId:'rv:bf01',slot:'unitDri',baseVersion:1});
 assert.equal(s.messages.filter(m=>m.broadcast==='review-unit-done').length,1);
 s=installReviewRound(s,{...sample,period:'2026-10'},{label:'第 2 轮'});
 assert.match(s.messages.filter(m=>m.broadcast==='review-regenerated').at(-1).text,/已换成新一轮（第 2 轮）/);
});
test('新一轮拆解载入后，复盘卡、复盘讨论和交接都还在，旧计划讨论进归档',async()=>{
 const {activateIndependentRound}=await import('./round-activation.mjs');
 const {handoffGenerated}=await import('./review-handoff.mjs');
 const old=installReviewRound(plan(),sample,{label:'r1'});
 old.messages.push({id:'m-plan',author:'刘明华',channel:'group',scope:'bf01',cardId:'bf01',text:'旧计划讨论',createdAt:new Date().toISOString()});
 old.messages.push({id:'m-rv',author:'刘明华',channel:'group',scope:'bf01',cardId:'rv:bf01',text:'复盘讨论',createdAt:new Date().toISOString()});
 old.planHandoff={status:'generating',package:{forPeriod:'2026-11',units:[{unit:'bf01',po:{owner:'刘明华'}}]}};
 const next=handoffGenerated(activateIndependentRound(old,{id:'r24',number:24,units:[{id:'bf01',level:'po',title:'灯塔 11 月',owner:'刘明华',version:1,children:[]}]}));
 assert.ok(next.cards['rv:company']&&next.cards['rv:bf01-m1']);assert.equal(next.reviewRound.label,'r1');
 assert.ok(next.messages.some(m=>m.id==='m-rv'));assert.ok(!next.messages.some(m=>m.id==='m-plan'));
 assert.equal(next.planHandoff.status,'generated');assert.ok(next.messages.some(m=>m.broadcast==='plan-ready'&&m.scope==='bf01'&&/11 月拆解草稿已出/.test(m.text)));
 assert.equal(next.archives.at(-1).messages.some(m=>m.id==='m-plan'),true);
});
