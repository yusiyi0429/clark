import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion,nextInputProblem} from './governance.mjs';
import {installReviewRound,reviewDueAt} from './review-round.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
import {reviewTree,reviewTodos} from './review-display.mjs';
import {handoffPackage} from './review-handoff.mjs';
import {withReviewSources} from './review-sources.mjs';
import {reviewProblems,repairReviews} from './review-generation.mjs';
import {insightSynthesisRequest,reviewPatchProblem} from './nexus-review.mjs';
import {notificationsFor} from './notifications.mjs';
// 下期输入、截止时间、公司综合读全部洞察 (陈溪南 2026-10-27).
const next=[{ref:'t2',type:'待决策',text:'客户试用窗口要重新约',ask:{to:'刘明华',question:'11 月第一周能约到王总吗？'}},{ref:'t1',type:'继续',text:'部署环境保留到 11 月'}];
const run={period:'2026-10',reviews:[
 {unit:'company',level:'company',ref:'company',title:'词元云集 10 月',owner:'刘明华',verdict:'未达成',verdictReason:'灯塔没交付',facts:[{ref:'bf01',item:'灯塔',owner:'刘明华',status:'未达成',evidence:'10/28 未部署'}],nextInputs:[{ref:'bf01',type:'调整',text:'11 月先保灯塔首用'}]},
 {unit:'bf01',level:'ru',ref:'bf01',title:'灯塔',owner:'刘明华',verdict:'未达成',verdictReason:'首用没发生',facts:[{ref:'bf01-m1',item:'首用',owner:'孙铭泽',status:'部分达成',evidence:'10/20 演示'}],nextInputs:[{ref:'bf01-m1',type:'继续',text:'首用改到 11 月上旬'}],parent:'company'},
 {unit:'bf01',level:'mission',ref:'bf01-m1',title:'首用',owner:'孙铭泽',verdict:'部分达成',verdictReason:'演示了，没真用',facts:[{ref:'t1',item:'部署',owner:'孙铭泽',status:'达成',evidence:'10/18 部署'},{ref:'t2',item:'客户试用',owner:'孙铭泽',status:'未达成',evidence:'没有记录',gap:'客户窗口推迟'}],nextInputs:next,parent:'bf01'}]};
const fresh=()=>installReviewRound(createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,children:[]}]),run,{label:'10 月复盘',now:'2026-10-27T02:33:00.000Z'});

test('下期输入的格式：类型只能是继续、调整、停止、待决策；问人要写问谁、问什么，问的人在名单里',()=>{
 assert.equal(nextInputProblem(next,{roster:['刘明华','孙铭泽']}),null);
 assert.equal(nextInputProblem([]),'缺下期输入');assert.equal(nextInputProblem([],{allowEmpty:true}),null,'判定达成、没有未了事项的可以没有');
 assert.match(nextInputProblem([{type:'欠账',text:'x'}]),/类型只能是/);
 assert.match(nextInputProblem([{type:'待决策',text:'x',ask:{to:'',question:'?'}}]),/问谁、问什么/);
 assert.match(nextInputProblem([{type:'待决策',text:'x',ask:{to:'王总',question:'能约吗？'}}],{roster:['刘明华']}),/“王总”不在公司名单里/);
 assert.match(nextInputProblem(Array(6).fill({type:'继续',text:'x'})),/最多 5 条/);
});

test('生成结果：新格式复盘必须带下期输入，缺了或格式不对都挡住；洞察和原因仍不该生成',()=>{
 const input={stages:[run.reviews.map(r=>({id:r.ref,level:r.level==='ru'?'ru':r.level,unit:r.unit,tasks:r.level==='mission'?[{ref:'t1',title:'部署'},{ref:'t2',title:'客户试用'}]:[],children:r.level==='ru'?['bf01-m1']:r.level==='company'?['bf01']:[]}))]};
 const reviews=Object.fromEntries(run.reviews.map(r=>[r.ref,structuredClone(r)]));
 const roster=['刘明华','孙铭泽'];
 assert.deepEqual(reviewProblems({reviews,failed:[]},input,{roster}).filter(p=>/下期输入|洞察/.test(p.problem)),[]);
 const done=structuredClone(reviews['bf01-m1']);done.verdict='达成';done.nextInputs=[];
 assert.deepEqual(reviewProblems({reviews:{...reviews,'bf01-m1':done},failed:[]},input,{roster}).filter(p=>/下期输入/.test(p.problem)),[],'判定达成的可以没有下期输入');
 delete reviews['bf01-m1'].nextInputs;reviews.bf01.nextInputs=[{type:'约束',text:'x'}];reviews.company.insights=[];
 const found=reviewProblems({reviews,failed:[]},input,{roster}).map(p=>p.unit+':'+p.problem);
 assert.ok(found.includes('bf01-m1:缺下期输入'));assert.ok(found.some(p=>p.startsWith('bf01:下期输入类型')));assert.ok(found.some(p=>p.startsWith('company:生成结果里不该有洞察')));
});

test('装入后卡上有下期输入并参与握手；改成不合法的类型被拒；Nexus 修订卡按同一格式校验',()=>{
 let s=fresh();const card=s.cards['rv:bf01-m1'],c=currentVersion(card).content;
 assert.deepEqual(c.nextInputs,next);
 const sun=memberActor('member-03',s);
 s=applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:1,patch:{nextInputs:[...c.nextInputs,{ref:'',type:'停止',text:'不再做演示版'}]}});
 assert.equal(currentVersion(s.cards['rv:bf01-m1']).content.nextInputs.length,3);
 assert.ok(s.cards['rv:bf01'].downstreamChange?.fields.includes('nextInputs'),'上级复盘也被提醒');
 assert.throws(()=>applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:2,patch:{nextInputs:[{type:'欠账',text:'x'}]}}),/类型只能是/);
 assert.match(reviewPatchProblem(s.cards['rv:bf01-m1'],{nextInputs:[{type:'欠账',text:'x'}]}),/下期输入格式不对/);
});

test('下期输入里点了名的问题：只在被点名的人的待办里，回答（批注带 answers）后消失；交给拆解时带着回答、标为必读',()=>{
 let s=fresh();const ceo=memberActor('member-01',s),sun=memberActor('member-03',s);
 const todos=a=>{const v=sharedProjection(s,a),p={name:a.name,ceo:a.ceo===true,unitDri:a.unitDri||[]};return reviewTodos(reviewTree(v.drafts).nodes,p,v.comments,[]).filter(i=>i.kind==='ask');};
 assert.deepEqual(todos(ceo).map(i=>[i.cardId,i.index,i.block]),[['rv:bf01-m1',0,'nextInputs']]);
 assert.deepEqual(todos(sun),[],'负责人自己不用答，问的是刘明华');
 s=applyAction(s,ceo,{type:'comment',cardId:'rv:bf01-m1',baseVersion:1,block:'nextInputs',text:'11/4 可以',answers:{index:0}});
 assert.deepEqual(s.comments.at(-1).answers,{index:0,ask:'11 月第一周能约到王总吗？',block:'nextInputs',to:'刘明华'});
 assert.deepEqual(todos(ceo),[]);
 const pkg=handoffPackage(s),m=pkg.units[0].missions[0];
 assert.deepEqual(m.nextInputs[0].answer,{by:'刘明华',text:'11/4 可以'});
 const input={sources:[{key:'bf01',title:'bf01',content:'',facts:[]},{key:'company',title:'company',content:'',facts:[]}]};
 const text=withReviewSources(input,pkg).sources.find(x=>x.key==='bf01').content;
 assert.match(text,/下期输入（必读，下月拆解要逐条承接）/);assert.match(text,/问 刘明华：11 月第一周能约到王总吗？ 答复（刘明华）：11\/4 可以/);
});

test('截止时间：复盘装入后 48 小时，投影和通知卡片都带着',async()=>{
 const s=fresh();
 assert.equal(reviewDueAt(s.reviewRound),'2026-10-29T02:33:00.000Z');
 const {withDueAt}=await import('./review-round.mjs'),old={loadedAt:'2026-10-27T02:33:00.000Z'};
 assert.equal(withDueAt(old,Date.parse('2026-10-28T00:00:00Z')).dueAt,'2026-10-29T02:33:00.000Z','这版之前装入、还在 48 小时内的，补上截止时间');
 assert.equal(withDueAt(old,Date.parse('2026-10-30T00:00:00Z')).dueAt,undefined,'早就过了 48 小时的旧轮次不补，免得一上线就自动公开');
 assert.equal(sharedProjection(s,memberActor('member-03',s)).review.dueAt,'2026-10-29T02:33:00.000Z');
 const card=notificationsFor(s,'member-03').find(i=>i.id==='todo:review');assert.equal(card?.dueAt,'2026-10-29T02:33:00.000Z');
});

test('公司复盘的 Nexus 综合读所有复盘下的洞察，按复盘分组；其他复盘只读自己的',()=>{
 const s=fresh();s.insights={'rv:bf01-m1':[{id:'i1',author:'member-03',text:'客户窗口靠单点联系'}],'rv:company':[{id:'i2',author:'member-01',text:'目标定得太满'}]};
 const name=id=>({'member-01':'刘明华','member-03':'孙铭泽'})[id]||id;
 const company=JSON.parse(insightSynthesisRequest(s,s.cards['rv:company'],'',name)[1].content);
 assert.deepEqual(company.insights,[{author:'刘明华',text:'目标定得太满'}]);
 assert.deepEqual(company.allReviews.map(r=>[r.title,r.insights[0].text]),[['首用','客户窗口靠单点联系']]);
 const mission=JSON.parse(insightSynthesisRequest(s,s.cards['rv:bf01-m1'],'',name)[1].content);
 assert.equal(mission.allReviews,undefined);
});

test('确认前至少贴一条洞察：应交洞察的人没交，从任何入口确认都被拒；交了一条就能确认',()=>{
 let s=fresh();const sun=memberActor('member-03',s);
 assert.throws(()=>applyAction(s,sun,{type:'confirm',cardId:'rv:bf01-m1',baseVersion:1,slot:'missionDri'}),/确认前至少贴一条洞察/);
 s=applyAction(s,sun,{type:'insight',cardId:'rv:bf01-m1',text:'客户窗口只靠一个人联系'});
 s=applyAction(s,sun,{type:'confirm',cardId:'rv:bf01-m1',baseVersion:1,slot:'missionDri'});
 assert.ok(currentVersion(s.cards['rv:bf01-m1']).signatures.some(x=>x.slot==='missionDri'));
});

test('公开后还能补交洞察：补交的进群里，这份复盘和公司复盘的 Nexus 综合作废重写',()=>{
 let s=fresh();const sun=memberActor('member-03',s);
 s.insightsRevealed={at:'2026-10-29T02:33:00.000Z',by:'auto'};s.insightNexus={'rv:bf01-m1':{text:'旧综合'},'rv:company':{text:'公司旧综合'},'rv:bf01':{text:'单元综合'}};
 s=applyAction(s,sun,{type:'insight',cardId:'rv:bf01-m1',text:'演示和真用要分开验收'});
 assert.match(s.messages.at(-1).text,/孙铭泽在「首用」下的分析洞察：演示和真用要分开验收/);assert.equal(s.messages.at(-1).scope,'bf01');
 assert.equal(s.insightNexus['rv:bf01-m1'],undefined);assert.equal(s.insightNexus['rv:company'],undefined);assert.equal(s.insightNexus['rv:bf01'].text,'单元综合','别的复盘不动');
});

test('程序检查没过的那份单独重写一次再查，不整轮作废；重写还不对的照样挡住',async()=>{
 const input={stages:[run.reviews.map(r=>({id:r.ref,level:r.level==='ru'?'ru':r.level,unit:r.unit,title:r.title,owner:r.owner,parent:r.parent,tasks:r.level==='mission'?[{ref:'t1',title:'部署'},{ref:'t2',title:'客户试用'}]:[],children:r.level==='ru'?['bf01-m1']:r.level==='company'?['bf01']:[]}))]};
 const reviews=Object.fromEntries(run.reviews.map(r=>[r.ref,structuredClone(r)]));reviews['bf01-m1'].nextInputs=Array(6).fill({ref:'t2',type:'继续',text:'接着做'});
 const work={raw:{},reviews,failed:[]},roster=['刘明华','孙铭泽'],asked=[];
 const problems=reviewProblems(work,input,{roster});assert.deepEqual(problems.map(p=>p.unit+':'+p.problem),['bf01-m1:下期输入最多 5 条']);
 const gateway={async complete(messages){const u=JSON.parse(messages[1].content);asked.push(u.unit.id);return {answer:JSON.stringify({analysis:'',review:{...u.review,nextInputs:u.review.nextInputs.slice(0,2)}})};}};
 await repairReviews({gateway,skill:{rules:''},input,run:work,problems});
 assert.deepEqual(asked,['bf01-m1'],'只重写有问题的那一份');assert.equal(work.reviews['bf01-m1'].nextInputs.length,2);
 assert.deepEqual(reviewProblems(work,input,{roster}),[]);
});

test('环节卡：复盘装入后是“已出”并带截止时间；CEO 确认公司复盘后同一张变成“已完成”',()=>{
 const s=fresh();let card=notificationsFor(s,'member-03').find(i=>i.id==='stage:review');
 assert.deepEqual([card.status,card.title,card.dueAt],['open','10 月复盘已出','2026-10-29T02:33:00.000Z']);assert.match(card.text,/10\/29 10:33 前确认/);
 const company=s.cards['rv:company'],v=currentVersion(company);v.signatures.push({slot:'ceo',actorId:'member-01',version:v.number,createdAt:'2026-10-29T01:00:00.000Z'});company.confirmedVersion=v.number;
 card=notificationsFor(s,'member-03').find(i=>i.id==='stage:review');
 assert.deepEqual([card.status,card.title,card.dueAt,card.updatedAt],['done','10 月复盘已完成',undefined,'2026-10-29T01:00:00.000Z']);
 assert.ok(!notificationsFor(s,'member-03').some(i=>i.id==='comments'),'新批注不再单独成卡');
});
