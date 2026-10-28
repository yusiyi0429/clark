import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion,nextInputProblem} from './governance.mjs';
import {installReviewRound,reviewDueAt} from './review-round.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
import {reviewTree,reviewTodos} from './review-display.mjs';
import {handoffPackage} from './review-handoff.mjs';
import {withReviewSources} from './review-sources.mjs';
import {reviewProblems,repairReviews,jargonOf,lengthFindings,skillAtLeast} from './review-generation.mjs';
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
 assert.ok(s.reviewCascadeQueue?.some(j=>j.childId==='rv:bf01-m1'&&j.fields.includes('nextInputs')),'交给 Nexus 判断对单元复盘的影响');
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
 const card=notificationsFor(s,'member-03').find(i=>i.id==='todo:review');assert.equal(card?.dueAt,'2026-10-28T02:33:00.000Z','待办里有个人复盘，取最早的 24 小时');
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
 assert.match(s.messages.at(-1).text,/孙铭泽在「首用」下的分析洞察：演示和真用要分开验收/);assert.equal(s.messages.at(-1).scope,'bf01','公开后的洞察进单元群');
 assert.equal(s.insightNexus['rv:bf01-m1'],undefined);assert.equal(s.insightNexus['rv:company'],undefined);assert.equal(s.insightNexus['rv:bf01'],undefined,'单元复盘的综合也读 Mission 洞察，一起重写');
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
 const late={...s,reviewRound:{...s.reviewRound,dueAt:'2026-10-01T00:00:00.000Z'}};assert.match(notificationsFor(late,'member-03').find(i=>i.id==='stage:review').text,/已过截止时间（10\/01 08:00）/);
 const company=s.cards['rv:company'],v=currentVersion(company);v.signatures.push({slot:'ceo',actorId:'member-01',version:v.number,createdAt:'2026-10-29T01:00:00.000Z'});company.confirmedVersion=v.number;
 card=notificationsFor(s,'member-03').find(i=>i.id==='stage:review');
 assert.deepEqual([card.status,card.title,card.dueAt,card.updatedAt],['done','10 月复盘已完成',undefined,'2026-10-29T01:00:00.000Z']);
 assert.ok(!notificationsFor(s,'member-03').some(i=>i.id==='comments'),'新批注不再单独成卡');
});

test('被点名的人不在这个单元，也能打开这张复盘卡回答；别的卡照样看不到',()=>{
 const asked=structuredClone(run);asked.reviews[2].nextInputs=[{ref:'t2',type:'待决策',text:'材料要补进本体',ask:{to:'唐巨杰',question:'灯塔的成本口径何时定下来？'}}];
 let s=installReviewRound(createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,children:[]}]),asked,{label:'10 月复盘',now:'2026-10-27T02:33:00.000Z'});
 const yu=memberActor('member-09',s);
 const v=sharedProjection(s,yu);assert.ok(v.drafts['rv:bf01-m1'],'被问的那张看得到');assert.equal(v.drafts['rv:bf01'],undefined,'单元复盘看不到');
 s=applyAction(s,yu,{type:'comment',cardId:'rv:bf01-m1',baseVersion:1,block:'nextInputs',text:'11/5 前补齐',answers:{index:0}});
 assert.equal(s.comments.at(-1).answers.to,'唐巨杰');
 assert.throws(()=>applyAction(s,yu,{type:'comment',cardId:'rv:bf01',baseVersion:1,text:'x'}),/不在当前领域可见范围内/);
});

test('在判定上说出不同的判定（“实际是达成了”）就算改判要求，Nexus 的修订卡不被丢掉；只是附和原判定的不算',async()=>{
 const {validateNexusResult}=await import('./nexus-policy.mjs');
 const card={id:'rv:agents-m4',kind:'review',level:'mission',version:1,title:'M04 复盘',owner:'陈溪南',verdict:'部分达成',facts:[{ref:'t1',item:'x',status:'部分达成',evidence:'y'}],aliases:[]};
 const ev=[{id:'c1',author:'刘明华',kind:'document-comment',text:'基本上达成的……实际是达成了',context:{selection:{id:'rv:agents-m4',version:1},block:'verdict'}}];
 const ask=sourceIds=>validateNexusResult({topics:[],proposals:[{cardId:'rv:agents-m4',baseVersion:1,basis:'request',sourceIds,patch:{verdict:'达成'}}]},{cards:[card],evidence:ev,fresh:ev});
 const r=ask(['c1']);assert.equal(r.proposals.length,1,JSON.stringify(r.rejected));
 ev[0].text='部分达成没问题';assert.equal(ask(['c1']).proposals.length,0);
});

test('疑似内部用词：版本号、编号、父 PO、不认识的英文词量出来交给检查；产品名、证据编号和日期不算',()=>{
 assert.deepEqual(jargonOf('按01-1文稿rev14的边界准备 Readiness 候选'),['01-1','rev14','Readiness']);
 assert.deepEqual(jargonOf('父 PO 不收窄，M04 复盘'),['父 PO','M04']);
 assert.deepEqual(jargonOf('TokenHub 首版 10/15 发布，Agent 已接入 [E3]，2026-10-26 CEO 确认'),[]);
 const f=lengthFindings({verdict:'部分达成',verdictReason:'Readiness 没到',facts:[{item:'x',status:'达成',evidence:'y'}],nextInputs:[{type:'待决策',text:'z',ask:{to:'刘明华',question:'01-1 还做吗？'}}]});
 assert.deepEqual(f.filter(x=>x.type==='疑似内部用词').map(x=>x.word),['Readiness','01-1']);
});

test('生成时点名提问每份最多 2 个、公司复盘 3 个；人改卡不受这个限制',()=>{
 const q=n=>Array.from({length:n},(_,i)=>({ref:'',type:'待决策',text:'x'+i,ask:{to:'刘明华',question:'定吗？'}}));
 assert.match(nextInputProblem(q(3),{maxAsks:2}),/点名提问最多 2 个，现在有 3 个/);
 assert.equal(nextInputProblem(q(3),{maxAsks:3}),null);
 assert.equal(nextInputProblem(q(3)),null,'不传上限（人改卡）就不拦');
});

test('2.1.6 起：下期输入要对上一行事实、一行最多一条、不对应行的最多一条；已达成的行带了只量不拦；2.1.5 不开',()=>{
 const input={stages:[run.reviews.map(r=>({id:r.ref,level:r.level==='ru'?'ru':r.level,unit:r.unit,tasks:r.level==='mission'?[{ref:'t1',title:'部署'},{ref:'t2',title:'客户试用'}]:[],children:r.level==='ru'?['bf01-m1']:r.level==='company'?['bf01']:[]}))]};
 const reviews=Object.fromEntries(run.reviews.map(r=>[r.ref,structuredClone(r)]));
 reviews['bf01-m1'].nextInputs=[{ref:'t2',type:'继续',text:'a'},{ref:'t2',type:'调整',text:'b'},{ref:'t9',type:'继续',text:'c'},{ref:'',type:'待决策',text:'d'},{ref:'',type:'继续',text:'e'}];
 const roster=['刘明华','孙铭泽'],found=o=>reviewProblems({reviews,failed:[]},input,{roster,...o}).filter(p=>p.unit==='bf01-m1').map(p=>p.problem);
 assert.deepEqual(found({}),[],'2.1.5 不查');
 const strict=found({rowMatch:true});
 assert.ok(strict.some(p=>/对应的事实行不存在：t9/.test(p)));assert.ok(strict.some(p=>/同一行事实写了多条下期输入.*t2/.test(p)));assert.ok(strict.some(p=>/最多 1 条，现在有 2 条/.test(p)));
 const f=lengthFindings({...reviews['bf01-m1'],nextInputs:[{ref:'t1',type:'停止',text:'不再保留演示环境'}]});
 assert.deepEqual(f.filter(x=>x.type==='已达成行带下期输入').map(x=>x.ref),['t1']);
 assert.ok(skillAtLeast('2.1.6','2.1.6')&&skillAtLeast('2.2.0','2.1.6')&&!skillAtLeast('2.1.5','2.1.6')&&!skillAtLeast(null,'2.1.6'));
 assert.deepEqual(jargonOf('Method 和 Talent 的资料'),[],'单元名不算');
});

test('下级有调整（单元复盘改了，公司复盘标出来）：签字人能核对、在他的待办里；不是签字人的不行',()=>{
 let s=fresh();const ceo=memberActor('member-01',s),tang=memberActor('member-09',s);
 const c=currentVersion(s.cards['rv:bf01']).content;
 s=applyAction(s,ceo,{type:'revise',cardId:'rv:bf01',baseVersion:1,patch:{facts:[{...c.facts[0],evidence:'10/29 已部署'}]}});
 assert.equal(s.cards['rv:company'].downstreamChange?.cardId,'rv:bf01');
 const v=sharedProjection(s,ceo);assert.ok(reviewTodos(reviewTree(v.drafts).nodes,{name:'刘明华',ceo:true,unitDri:ceo.unitDri||[]},v.comments,[]).some(i=>i.kind==='downstream'&&i.cardId==='rv:company'));
 assert.throws(()=>applyAction(s,tang,{type:'acknowledgeImpact',cardId:'rv:company',baseVersion:1}),/下级调整|不在当前领域/);
 s=applyAction(s,ceo,{type:'acknowledgeImpact',cardId:'rv:company',baseVersion:1});assert.equal(s.cards['rv:company'].downstreamChange,undefined);
});

test('群里少说：两份个人复盘改了不在单元群里发提醒，只排给 Nexus 判断；没出成的卡不进群',async()=>{
 const two={...run,reviews:[...run.reviews,{unit:'bf01',level:'mission',ref:'bf01-m2',title:'复用',owner:'孙铭泽',verdict:'未达成',verdictReason:'没做',facts:[{ref:'t1',item:'复用',owner:'孙铭泽',status:'未达成',evidence:'无'}],nextInputs:[{ref:'t1',type:'继续',text:'接着做'}],parent:'bf01'}]};
 let s=installReviewRound(createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,children:[]}]),two,{label:'10 月复盘',now:'2026-10-27T02:33:00.000Z'});
 const sun=memberActor('member-03',s),before=s.messages.length;
 for(const id of ['rv:bf01-m1','rv:bf01-m2']){const c=currentVersion(s.cards[id]).content;s=applyAction(s,sun,{type:'revise',cardId:id,baseVersion:1,patch:{nextInputs:[{...c.nextInputs[0],text:c.nextInputs[0].text+'（改）'}]}});}
 assert.equal(s.messages.slice(before).filter(m=>m.scope==='bf01').length,0,'单元群里不发');
 assert.deepEqual(s.reviewCascadeQueue.map(j=>j.childId),['rv:bf01-m1','rv:bf01-m2']);
 const {quietReply}=await import('./nexus-policy.mjs');
 assert.equal(quietReply('已出修订卡，请确认。',[],[{cardId:'talent-m03',why:'这张卡上还有人反对'}]),'');
 assert.equal(quietReply('M02 改好了，请看。另外周五前给数。',[{cardId:'talent-m02'}],[{cardId:'talent-m03',why:'x'}]),'M02 改好了，请看。另外周五前给数。');
 assert.equal(quietReply('好的，周五前给数。',[],[]),'好的，周五前给数。');
});

test('个人复盘的房间：只有本人能说，话进 person:<id>，别人看得到卡、看不到房间里的话；被点名的人仍能回答',()=>{
 let s=fresh();const sun=memberActor('member-03',s),ceo=memberActor('member-01',s);
 s=applyAction(s,sun,{type:'message',cardId:'rv:person:孙铭泽',text:'帮我看看 T2 的证据'});
 assert.equal(s.messages.at(-1).scope,'person:member-03');assert.equal(s.messages.at(-1).general,true);
 s=applyAction(s,sun,{type:'comment',cardId:'rv:bf01-m1',baseVersion:1,block:'facts',item:1,text:'客户窗口其实 10/25 定了'});
 assert.equal(s.comments.at(-1).scope,'person:member-03');
 assert.throws(()=>applyAction(s,ceo,{type:'comment',cardId:'rv:bf01-m1',baseVersion:1,block:'facts',text:'我觉得判严了'}),/只在本人的个人复盘里/);
 assert.throws(()=>applyAction(s,ceo,{type:'message',cardId:'rv:person:孙铭泽',text:'x'}),/只有本人能发/);
 const v=sharedProjection(s,ceo);assert.ok(v.drafts['rv:bf01-m1'],'CEO 能只读看卡');assert.equal((v.comments['rv:bf01-m1']||[]).length,0);assert.equal(v.records['group:person:member-03'],undefined);
 s=applyAction(s,ceo,{type:'comment',cardId:'rv:bf01-m1',baseVersion:1,block:'nextInputs',text:'11/4 可以',answers:{index:0}});
 assert.equal(sharedProjection(s,ceo).comments['rv:bf01-m1'].length,1,'回答者看得到自己的回答');
 assert.equal(sharedProjection(s,sun).records['group:person:member-03'].length,3);
});

test('洞察公开后，个人复盘的洞察汇进单元复盘，带“来自 Mission N”；公开前不汇；个人复盘截止 24 小时、其余 48 小时',()=>{
 let s=fresh();const sun=memberActor('member-03',s),ceo=memberActor('member-01',s);
 s=applyAction(s,sun,{type:'insight',cardId:'rv:bf01-m1',text:'客户窗口只靠一个人'});
 assert.equal(sharedProjection(s,ceo).drafts['rv:bf01'].insights.items,undefined);
 s.insightsRevealed={at:'2026-10-29T02:33:00.000Z',by:'auto'};
 const items=sharedProjection(s,ceo).drafts['rv:bf01'].insights.items;
 assert.deepEqual(items.map(i=>[i.text,i.source?.label,i.source?.cardId]),[['客户窗口只靠一个人','Mission 1','rv:bf01-m1']]);
 const d=sharedProjection(s,ceo).drafts;assert.equal(d['rv:bf01-m1'].dueAt,'2026-10-28T02:33:00.000Z');assert.equal(d['rv:bf01'].dueAt,'2026-10-29T02:33:00.000Z');
});

test('私人 Agent 在个人复盘里读本人房间的话，读不到别人房间的；Mission 改动对单元复盘的判断：有影响才出单元群的卡',async()=>{
 const {privateAgentContext}=await import('./private-agent-context.mjs');
 const {reviewCascadeRequest,reviewCascadeProposal}=await import('./review-cascade.mjs');
 let s=fresh();const sun=memberActor('member-03',s),ceo=memberActor('member-01',s);
 s=applyAction(s,sun,{type:'comment',cardId:'rv:bf01-m1',baseVersion:1,block:'facts',text:'客户窗口其实 10/25 定了'});
 const mine=privateAgentContext(s,sun,{scope:'person:member-03'});assert.ok(mine.page.cards.some(c=>c.title==='首用'));assert.ok(mine.annotations.some(a=>/10\/25/.test(a.text)));
 assert.throws(()=>privateAgentContext(s,ceo,{scope:'person:member-03'}),/不在成员可见范围/);
 assert.ok(!privateAgentContext(s,ceo,{selection:{id:'rv:bf01-m1'}}).annotations.some(a=>/10\/25/.test(a.text)),'CEO 只读卡，不读房间里的话');
 const c=currentVersion(s.cards['rv:bf01-m1']).content;
 s=applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:1,patch:{facts:[c.facts[0],{...c.facts[1],status:'部分达成',evidence:'10/25 客户试用一次'}]}});
 const job=s.reviewCascadeQueue.at(-1),req=JSON.parse(reviewCascadeRequest(s,job,'规则')[1].content);
 assert.equal(req.mission.before.facts[1].status,'未达成');assert.equal(req.mission.after.facts[1].status,'部分达成');assert.equal(req.unitReview.id,'rv:bf01');
 assert.equal(reviewCascadeProposal(s,job,{impact:false,reason:'措辞'}).proposal,null);
 const pf=currentVersion(s.cards['rv:bf01']).content.facts;
 const out=reviewCascadeProposal(s,job,{impact:true,reason:'首用那一行要改成部分达成',patch:{facts:[{...pf[0],status:'部分达成',evidence:'10/20 演示，10/25 客户试用一次'}]}});
 assert.equal(out.scope,'bf01');assert.equal(out.proposal.cardId,'rv:bf01');assert.match(out.proposal.reason,/「首用」的个人复盘改了/);
 assert.match(reviewCascadeProposal(s,job,{impact:true,patch:{facts:[{item:'x',status:'差不多'}]}}).reason,/事实证据格式不对/);
});

test('个人复盘的负责人进这个单元：能只读看本单元别人的个人复盘和单元复盘，看不到别人房间里的话',()=>{
 const three={...run,reviews:[...run.reviews,{unit:'bf01',level:'mission',ref:'bf01-m2',title:'复用',owner:'唐巨杰',verdict:'未达成',verdictReason:'没做',facts:[{ref:'t1',item:'复用',owner:'唐巨杰',status:'未达成',evidence:'无'}],nextInputs:[{ref:'t1',type:'继续',text:'接着做'}],parent:'bf01'}]};
 let s=installReviewRound(createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,children:[]}]),three,{label:'10 月复盘',now:'2026-10-27T02:33:00.000Z'});
 const sun=memberActor('member-03',s);s=applyAction(s,sun,{type:'comment',cardId:'rv:bf01-m1',baseVersion:1,block:'facts',text:'只给我看'});
 const tang=memberActor('member-09',s);assert.ok(tang.visibleUnits.includes('bf01'));
 const v=sharedProjection(s,tang);assert.ok(v.drafts['rv:bf01-m1']&&v.drafts['rv:bf01']);assert.equal((v.comments['rv:bf01-m1']||[]).length,0);
});

test('复盘卡标题去掉本体标题开头的“M03｜”这类编号，名字里的编号保留',async()=>{
 const {displayTitle}=await import('./review-generation.mjs');
 assert.equal(displayTitle('M03｜灯塔 E&O 数据与对话服务完成真实接入'),'灯塔 E&O 数据与对话服务完成真实接入');
 assert.equal(displayTitle('01-1 对本期可控制结果负责'),'01-1 对本期可控制结果负责');
 assert.equal(displayTitle('CEO Agent 双 P0 真实应用'),'CEO Agent 双 P0 真实应用');
 assert.equal(displayTitle('M03｜'),'M03｜');
});

test('个人复盘房间里的 Nexus：没点名哪张卡时看本人的复盘卡；本人有依据地主张改，就算改的要求',async()=>{
 const {actContext}=await import('./nexus-context.mjs');const {validateNexusResult,publicEvidence}=await import('./nexus-policy.mjs');const {reviewCardsFor}=await import('./nexus-review.mjs');
 let s=fresh();const sun=memberActor('member-03',s);
 s=applyAction(s,sun,{type:'message',cardId:'rv:person:孙铭泽',text:'Mission 1 第二条客户试用我觉得是部分达成：10/25 客户用过一次，有会议纪要'});
 const cards=reviewCardsFor(s,'person:member-03');
 const ev=publicEvidence(sharedProjection(s,sun).records['group:person:member-03'],'person:member-03',{retainAll:true});
 assert.ok(actContext({cards,evidence:ev,fresh:ev,topics:[]}).focusCardIds.includes('rv:bf01-m1'),'没点名也看得到本人的卡');
 const c=currentVersion(s.cards['rv:bf01-m1']).content;
 const r=validateNexusResult({topics:[],proposals:[{cardId:'rv:bf01-m1',baseVersion:1,basis:'request',sourceIds:[ev[0].id],patch:{facts:[c.facts[0],{...c.facts[1],status:'部分达成',evidence:'10/25 客户试用一次（会议纪要）'}]}}]},{cards,evidence:ev,fresh:ev});
 assert.equal(r.proposals.length,1,JSON.stringify(r.rejected));
});

test('个人复盘房间里本人说话就算在跟 Nexus 说：不带 @ 也一定回一句；已确认的卡本人要改也能出卡',async()=>{
 const {validateNexusResult,publicEvidence}=await import('./nexus-policy.mjs');const {reviewCardsFor}=await import('./nexus-review.mjs');
 let s=fresh();const sun=memberActor('member-03',s);
 s=applyAction(s,sun,{type:'insight',cardId:'rv:bf01-m1',text:'窗口靠一个人'});s=applyAction(s,sun,{type:'confirm',cardId:'rv:bf01-m1',slot:'missionDri',baseVersion:1});
 s=applyAction(s,sun,{type:'message',cardId:'rv:person:孙铭泽',text:'第二条其实 10/25 客户用过一次，有会议纪要，能不能改成部分达成'});
 const cards=reviewCardsFor(s,'person:member-03'),ev=publicEvidence(sharedProjection(s,sun).records['group:person:member-03'],'person:member-03',{retainAll:true});
 assert.equal(cards[0].status,'已确认');
 const quiet=validateNexusResult({topics:[],proposals:[],reply:'会议纪要还缺日期，补上后我再出卡。'},{cards,evidence:ev,fresh:ev,ownRoom:true});
 assert.equal(quiet.reply,'会议纪要还缺日期，补上后我再出卡。','不带 @ 也回');
 const c=currentVersion(s.cards['rv:bf01-m1']).content;
 const r=validateNexusResult({topics:[],proposals:[{cardId:'rv:bf01-m1',baseVersion:1,basis:'request',sourceIds:[ev[0].id],patch:{facts:[c.facts[0],{...c.facts[1],status:'部分达成',evidence:'10/25 客户试用一次（会议纪要）'}]}}]},{cards,evidence:ev,fresh:ev,ownRoom:true});
 assert.equal(r.proposals.length,1,JSON.stringify(r.rejected));
});

test('个人复盘房间里 Nexus 回本人，本人的通知里有一张“个人复盘”的提及卡',()=>{
 let s=fresh();const sun=memberActor('member-03',s);
 s=applyAction(s,sun,{type:'message',cardId:'rv:person:孙铭泽',text:'第二条能改成部分达成吗'});
 s.messages.push({id:'nx1',author:'Nexus',channel:'group',scope:'person:member-03',text:'还缺会议纪要的日期，补上后我再出卡。',createdAt:new Date(Date.now()+1000).toISOString()});
 const card=notificationsFor(s,'member-03').find(i=>i.id==='mention:person:member-03');
 assert.ok(card,'有提及卡');assert.match(card.title,/^个人复盘：1 条消息与你有关/);assert.match(card.link,/scope=person%3Amember-03/);
 assert.ok(!notificationsFor(s,'member-01').some(i=>i.id==='mention:person:member-03'),'别人没有');
});

test('给人看的话里不露内部写法：ref-3 写成第 3 项，复盘卡编号写成标题，nextInputs 这类字段写中文',async()=>{
 const {readableAnswer}=await import('./agent-prompts.mjs');
 const cards=[{id:'rv:eo-m3',title:'Ontology & Data Grounding'}];
 assert.equal(readableAnswer('核实后，ref-3 可改成部分达成',cards),'核实后，第 3 项 可改成部分达成');
 assert.equal(readableAnswer('单元复盘 eo-m3 行里的 status 要改，nextInputs 里加一条',cards),'单元复盘 《Ontology & Data Grounding》 行里的 状态 要改，下期输入 里加一条');
 assert.equal(readableAnswer('bf01-m10 不认识就不动',cards),'bf01-m10 不认识就不动');
});

test('锁定：单元复盘确认后个人复盘不能再改、不再联动；公司复盘确认后整轮只能看和批注；投影带 locked 和原因',async()=>{
 const {cascadeSkip}=await import('./review-cascade.mjs');const {validateNexusResult}=await import('./nexus-policy.mjs');const {reviewCardsFor}=await import('./nexus-review.mjs');
 let s=fresh();const sun=memberActor('member-03',s),ceo=memberActor('member-01',s);
 const c=currentVersion(s.cards['rv:bf01-m1']).content;
 s=applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:1,patch:{verdictReason:'演示了，客户没真用'}});const job=s.reviewCascadeQueue.at(-1);
 for(const [id,slot,who] of [['rv:bf01-m1','missionDri',sun],['rv:bf01','ceo',ceo],['rv:bf01','unitDri',ceo]]){s=applyAction(s,who,{type:'insight',cardId:id,text:'x'});s=applyAction(s,who,{type:'confirm',cardId:id,slot,baseVersion:currentVersion(s.cards[id]).number});}
 assert.throws(()=>applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:2,patch:{verdictReason:'再改'}}),/单元复盘已确认，个人复盘不能再改/);
 assert.equal(cascadeSkip(s,job),'单元复盘已确认，不再联动');
 const d=sharedProjection(s,sun).drafts;assert.deepEqual([d['rv:bf01-m1'].locked,d['rv:bf01-m1'].lockedReason],[true,'单元复盘已确认，个人复盘不能再改']);assert.equal(d['rv:bf01'].locked,undefined);
 const cards=reviewCardsFor(s,'person:member-03');assert.equal(cards[0].locked,true);
 assert.equal(validateNexusResult({topics:[],proposals:[{cardId:'rv:bf01-m1',baseVersion:2,basis:'request',sourceIds:['x'],patch:{verdictReason:'y'}}]},{cards,evidence:[{id:'x',author:'孙铭泽',text:'改一下',kind:'chat',scope:'person:member-03',context:null}],fresh:[],ownRoom:true}).rejected[0].why,'这份复盘已定稿，不再修订');
 s=applyAction(s,ceo,{type:'insight',cardId:'rv:company',text:'y'});s=applyAction(s,ceo,{type:'confirm',cardId:'rv:company',slot:'ceo',baseVersion:1});
 assert.throws(()=>applyAction(s,ceo,{type:'revise',cardId:'rv:bf01',baseVersion:1,patch:{verdictReason:'z'}}),/公司复盘已确认/);
 s=applyAction(s,ceo,{type:'comment',cardId:'rv:bf01',baseVersion:1,block:'facts',text:'仍可批注'});assert.equal(s.comments.at(-1).text,'仍可批注');
});

test('复盘技能 2.1.7 起个人复盘最多 1 个点名问题，单元 2 个、公司 3 个；之前的版本不变',()=>{
 const input={stages:[run.reviews.map(r=>({id:r.ref,level:r.level==='ru'?'ru':r.level,unit:r.unit,tasks:r.level==='mission'?[{ref:'t1',title:'部署'},{ref:'t2',title:'客户试用'}]:[],children:r.level==='ru'?['bf01-m1']:r.level==='company'?['bf01']:[]}))]};
 const reviews=Object.fromEntries(run.reviews.map(r=>[r.ref,structuredClone(r)]));
 reviews['bf01-m1'].nextInputs=[{ref:'t1',type:'待决策',text:'a',ask:{to:'刘明华',question:'甲？'}},{ref:'t2',type:'待决策',text:'b',ask:{to:'孙铭泽',question:'乙？'}}];
 const roster=['刘明华','孙铭泽'],asks=o=>reviewProblems({reviews,failed:[]},input,{roster,...o}).filter(p=>/点名提问/.test(p.problem)).map(p=>p.unit+':'+p.problem);
 assert.deepEqual(asks({}),[]);assert.deepEqual(asks({askCaps:true}),['bf01-m1:点名提问最多 1 个，现在有 2 个']);
});
