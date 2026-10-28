import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unitKeyOfTitle,buildReviewInput,runReviewSkill,reviewProblems,reviewFile,createReviewJobs,collectReviewSources,httpReviewReader} from './review-generation.mjs';
import {openCollaborationStore,archivesPath} from './collaboration-store.mjs';
import {createCollaborationState} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
// 生成复盘 (陈溪南 2026-10-23): month targets are the RU POs and Missions in the ontology; a unit with no PO is not reviewed.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const blocks=text=>[{id:'b1',display_name:'成果',components:[{type:'outcome',text}]}];
const who=name=>({responsible:{principals:[{display_name:name}]}});
function sources({withMissionOwner=true}={}){
 const heads={
  rus:[{object_id:id(1),domain_id:'d-eo',title:'E&O'},{object_id:id(2),domain_id:'d-ops',title:'Token Ops'}],
  companies:[{object_id:id(3),domain_id:'d-co',title:'词元云集'}],
  goals:[{object_id:id(10),domain_id:'d-eo'}],missions:[{object_id:id(20),domain_id:'d-eo'}],tasks:[],
  snapshots:[{object_id:id(30),domain_id:'d-eo'},{object_id:id(31),domain_id:'d-eo'},{object_id:id(32),domain_id:'d-eo'},{object_id:id(33),domain_id:'d-eo'}]};
 const objects={
  [id(3)]:{identity:who('刘明华')},
  [id(10)]:{business:{title:'E&O 10 月：读写打通',blocks:blocks('真实读写打通')},identity:who('刘人豪'),records:{lifecycle:{display_name:'已承诺'}}},
  [id(20)]:{business:{title:'Context 建模',blocks:blocks('建模完成'),relations:[{field:'goal_ref',value:{object_id:id(10)}}]},identity:withMissionOwner?who('于斯一'):{}},
  [id(30)]:{title:'Context 建模 · 于斯一 10/15 日进展',as_of:'2026-10-15T10:00:00+08:00',subject_ref:{object_id:id(20)},blocks:[{id:'p',display_name:'进展',text:'对象模型定稿；候选人期望薪资 40 万还没谈拢。'}]},
  [id(31)]:{title:'E&O · 10/12 周进展',as_of:'2026-10-12T10:00:00+08:00',subject_ref:{object_id:id(10)},blocks:[{id:'p',display_name:'进展',text:'读取链路通了'}]},
  [id(32)]:{title:'M2 基础资料 · E&O 截至 10/08',as_of:'2026-10-08T10:00:00+08:00',subject_ref:{object_id:id(1)},blocks:[{id:'p',display_name:'背景',text:'9 月底状态'}]},
  [id(33)]:{title:'E&O · 10/30 进展',as_of:'2026-10-30T10:00:00+08:00',subject_ref:{object_id:id(10)},blocks:[{id:'p',display_name:'进展',text:'截止后的记录'}]},
 };
 const ev=(n,o)=>({event_id:id(100+n),corrected_by:[],withdrawn_by:[],principal:{display_name:'于斯一'},...o});
 const monthEvents=[
  ev(1,{kind:'event.recorded',category:'meeting',occurred_at:'2026-10-18T09:00:00+08:00',subject_refs:[{object_id:id(20)}],content:{text:'评审会定了建模口径'}}),
  ev(2,{kind:'event.recorded',category:'other',occurred_at:'2026-09-28T09:00:00+08:00',subject_refs:[{object_id:id(20)}],content:{text:'上月的事'}}),
  ev(3,{kind:'event.recorded',category:'other',occurred_at:'2026-10-16T09:00:00+08:00',subject_refs:[{object_id:id(20)}],content:{text:'写错的进展'},corrected_by:[{event_id:id(104)}]}),
  ev(4,{kind:'event.recorded',category:'correction',occurred_at:'2026-10-16T10:00:00+08:00',subject_refs:[{object_id:id(20)}],content:{text:'更正：模型只定了一半'}}),
  ev(5,{kind:'event.recorded',category:'other',occurred_at:'2026-10-14T09:00:00+08:00',subject_refs:[{object_id:id(1)},{object_id:id(2)}],content:{text:'E&O 给 Token Ops 交了读接口'}}),
  ev(6,{kind:'commit',occurred_at:'2026-10-10T09:00:00+08:00',subject_refs:[{object_id:id(10)}],principal:{display_name:'刘明华'}}),
  ev(7,{kind:'event.recorded',category:'review',occurred_at:'2026-10-08T15:59:59Z',subject_refs:[{object_id:id(1)}],content:{text:'【9月复盘】E&O 9 月未达成'}}),
  ev(8,{kind:'state.refreshed',occurred_at:'2026-10-15T10:00:00+08:00',subject_refs:[{object_id:id(20)}]}),
  ev(9,{kind:'event.recorded',category:'review',occurred_at:'2026-10-09T09:00:00+08:00',subject_refs:[{object_id:id(3)}],content:{text:'公司 9 月复盘'}}),
  ev(10,{kind:'event.recorded',category:'other',occurred_at:'2026-10-15T09:00:00+08:00',subject_refs:[{object_id:id(20)}],content:{text:'【日进展】快照已经引用的原始记录'}}),
  ev(11,{kind:'event.recorded',category:'other',occurred_at:'2026-10-09T09:00:00+08:00',subject_refs:[{object_id:id(20)}],content:{text:'以下于斯一名下的记录由于斯一代为录入，待本人复核：1. 修订'}}),
  ev(12,{kind:'event.recorded',category:'meeting',occurred_at:'2026-10-19T11:00:00+08:00',subject_refs:[{object_id:id(10)}],content:{text:JSON.stringify({payload:{title:'对话质量',participants:[{name:'刘明华'}],summary:'- 会议场景优先',sections:[{heading:'分工',body:'产品写验收标准'}]}})}}),
  ev(13,{kind:'event.recorded',category:'meeting',occurred_at:'2026-10-18T09:00:00+08:00',subject_refs:[{object_id:id(20)}],content:{text:'评审会定了建模口径'}}),
 ];
 objects[id(30)].source_event_refs=[{event_id:id(110)}];
 objects[id(3)].identity={responsible:{principals:[{display_name:'于斯一（代录）'},{display_name:'刘明华'}]}};
 // 10/23: a test account was added next to the real owner on two October PeriodGoals; it must not become an owner.
 if(withMissionOwner)objects[id(20)].identity.responsible.principals.push({display_name:'于斯一（测试治理）'});
 return {period:'2026-10',cutoff:'2026-10-22T23:59:59+08:00',readAt:'2026-10-23T09:00:00+08:00',heads,objects,monthEvents};
}

test('复盘生成：单元按名称认，缺 RU PO 的单元不复盘，公司 PO 复盘照常写',()=>{
 assert.equal(unitKeyOfTitle('维信诺（002客户）'),'bf03');assert.equal(unitKeyOfTitle('E&O'),'eo');assert.equal(unitKeyOfTitle('别的'),null);
 const input=buildReviewInput(sources(),{companyDirection:'10 月公司方向：三个战场做成',ceoName:'刘明华'});
 const [s1,s2,s3]=input.stages;
 assert.deepEqual(s1.map(c=>c.id),['eo-m1']);assert.deepEqual(s2.map(c=>c.id),['eo']);assert.deepEqual(s2[0].children,['eo-m1']);
 assert.ok(input.skipped.some(x=>/Token Ops：本体里没有 10 月 RU PO，不复盘/.test(x)));assert.ok(!input.stages.flat().some(c=>c.unit==='bf02'));
 const m=s1[0];assert.equal(m.owner,'于斯一');assert.match(m.commitment,/建模完成/);assert.match(m.commitmentSource,/本体 10 月 Mission/);
 // Mission evidence: its own snapshot and in-month event, plus the PO-level record; nothing after the cutoff or before the month.
 const own=m.evidence.filter(e=>e.kind!=='单元层面进展'&&!/单元层面/.test(e.source));
 assert.deepEqual(own.map(e=>e.asOf),['2026-10-10','2026-10-12','2026-10-15','2026-10-16','2026-10-18','2026-10-19']);
 // Unit-level records reach the Mission too, marked as not evidence for any one Task (读取盘点 2026-10-26).
 assert.ok(m.evidence.filter(e=>/单元层面进展/.test(e.source)).length>=1);assert.deepEqual(m.evidence.map(e=>e.id),m.evidence.map((_,i)=>'E'+(i+1)));
 const all=JSON.stringify(input);
 assert.ok(!all.includes('截止后的记录'));assert.ok(!all.includes('上月的事'));assert.ok(!all.includes('写错的进展'));assert.ok(all.includes('更正：模型只定了一半'));
 assert.ok(m.evidence.some(e=>e.source==='会议'&&/建模口径/.test(e.text)));
 assert.ok(m.evidence.some(e=>/承诺：E&O 10 月：读写打通（刘明华）/.test(e.text)),'承诺这类没有正文的事件写成一行');
 const po=input.stages[1][0];
 assert.ok(po.evidence.some(e=>/给 Token Ops 交了读接口/.test(e.text)),'挂在 RU 上的记录归到 RU PO 复盘');
 assert.ok(po.evidence.some(e=>e.kind==='上月复盘'&&/9 月复盘，不算本月结果/.test(e.source)));
 assert.ok(!all.includes('快照已经引用的原始记录'),'被快照引用过的事件不再单列');
 assert.ok(!all.includes('代为录入'),'代录说明不当进展');
 assert.equal(m.evidence.filter(e=>/建模口径/.test(e.text)).length,1,'同一天同样内容只留一条');
 assert.ok(po.evidence.some(e=>/【会议】对话质量/.test(e.text)&&/参会：刘明华/.test(e.text)&&/\*\*分工：\*\*产品写验收标准/.test(e.text)),'会议卡整理成纪要');
 // Sensitive details are hidden before the model sees them.
 assert.ok(!JSON.stringify(input).includes('40 万'));assert.equal(m.redactions['薪酬细节'],1);
 // The PO review gets the unit-level background marked as the month's starting point.
 assert.ok(s2[0].evidence.some(e=>e.kind==='月初起点'&&/不算本月结果/.test(e.source)));
 const c=s3[0];assert.ok(c.evidence.some(e=>/公司 9 月复盘/.test(e.text)),'公司 PO 复盘有自己的证据');assert.equal(c.owner,'刘明华');assert.match(c.commitment,/三个战场/);assert.match(c.commitmentSource,/本体里没有公司 10 月 PO/);assert.deepEqual(c.children,['eo']);
 const noOwner=buildReviewInput(sources({withMissionOwner:false}));assert.equal(noOwner.stages[0][0].owner,'刘人豪');assert.match(noOwner.stages[0][0].missing[0],/没写负责人/);
});

const answer=(level,verdict='未达成')=>JSON.stringify({analysis:'a',review:{verdict,verdictReason:'理由',targets:['**t：**x'],causes:[{text:'**c：**y',ask:''}],nextInputs:[{id:'x-1',type:'欠账',text:'**n：**z'}],...(level==='company'?{ltoReview:{choice:'建议维持',reason:'r'}}:{})}});
function fakeGateway({refuse=new Set(),refuseAlways=new Set(),refuseOnce=new Set(),verdict}={}){
 const calls=[],refusedOnce=new Set();
 return {calls,status:{model:'fake'},async complete(messages){const u=JSON.parse(messages[1].content);calls.push(u.unit?.id||u.task.slice(0,12));
  if(u.unit&&refuse.has(u.unit.id)&&u.unit.evidence?.some(e=>e.kind==='月初起点'))throw Object.assign(Error('refused'),{code:'MODEL_REFUSAL',diagnostics:{finishReason:'refusal'}});
  const no=()=>Object.assign(Error('refused'),{code:'MODEL_REFUSAL',diagnostics:{finishReason:'refusal'}});
  if(u.unit&&refuseAlways.has(u.unit.id))throw no();
  if(u.unit&&refuseOnce.has(u.unit.id)&&!refusedOnce.has(u.unit.id)){refusedOnce.add(u.unit.id);throw no();}
  if(/检查/.test(u.task)&&!u.unit)return {answer:JSON.stringify({issues:/第1组/.test(u.task)?[{ref:'eo-m1',type:'判定偏严',problem:'p',impact:'i',fixable:true}]:[]})};
  return {answer:answer(u.unit?.level,verdict)};}};
}
const skill={rules:'技能',version:'2.0.4',hash:'h'.repeat(64),groups:[{name:'判定与证据',types:['判定偏严']},{name:'表达',types:['其他']}],mustFix:['判定偏严']};

test('复盘生成：按技能顺序生成，检查后只改必须改的，拒答时去掉月初背景重试',async()=>{
 const input=buildReviewInput(sources(),{companyDirection:'方向',ceoName:'刘明华'}),g=fakeGateway({refuse:new Set(['eo'])}),saved=[];
 const run=await runReviewSkill({gateway:g,skill,input,save:async r=>saved.push(Object.keys(r.raw).length)});
 assert.deepEqual(Object.keys(run.reviews).sort(),['company','eo','eo-m1']);
 assert.equal(run.reviews.eo.parent,'company');assert.equal(run.reviews['eo-m1'].parent,'eo');
 assert.ok(run.raw['revise-eo-m1']);assert.ok(!run.raw['revise-eo']);
 assert.deepEqual(run.dropped.map(d=>d.id),['eo']);assert.ok(run.raw['eo#nobg']);
 assert.ok(saved.length>0);
 // A second call with the same run reuses every saved answer: resuming asks again only what never got an answer (the refused unit).
 const again=fakeGateway();await runReviewSkill({gateway:again,skill,input,run});assert.deepEqual(again.calls,['eo']);
 assert.deepEqual(reviewProblems(run,input,{roster:['刘人豪','于斯一','刘明华']}),[]);
});

test('复盘生成：判定不在三档、缺字段、公司 PO 复盘没生成都挡住',()=>{
 const input=buildReviewInput(sources(),{ceoName:'刘明华'});
 const run={reviews:{'eo-m1':{verdict:'基本达成',verdictReason:'r',targets:['t'],causes:['c'],nextInputs:[{type:'欠账',text:'n'}]},eo:{verdict:'未达成',verdictReason:'r',targets:[],causes:['c'],nextInputs:[{type:'别的',text:'n'}],owner:'外人'}},failed:[{id:'company',error:'x'}]};
 const p=reviewProblems(run,input,{roster:['刘人豪']}).map(x=>`${x.unit} ${x.problem}`).join('\n');
 assert.match(p,/company 公司 PO 复盘没有生成出来/);assert.match(p,/eo-m1 判定写成“基本达成”/);assert.match(p,/eo 缺 targets/);assert.match(p,/下月输入类型“别的”/);assert.match(p,/负责人“外人”/);
});

async function harness({gateway=fakeGateway(),reviews=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'review-gen-')),statePath=join(dir,'state.json');
 let initial=createCollaborationState([{id:'eo',level:'po',title:'E&O',owner:'刘人豪',version:1,children:[]}]);
 if(reviews)initial=installReviewRound(initial,{period:'2026-10',reviews:[{unit:'eo',level:'ru',ref:'eo',title:'旧',owner:'刘人豪',verdict:'未达成',verdictReason:'r',targets:[],causes:[],nextInputs:[]}]});
 const store=await openCollaborationStore(statePath,initial);
 const src=sources();
 const reader={list:async()=>[],get:async x=>src.objects[x],findEvents:async()=>src.monthEvents};
 const jobs=createReviewJobs({store,gateway,skillRoot:new URL('./.runtime/eval/review/skills/tkos-review-2.0.4/',import.meta.url),statePath,reader:async()=>({...reader,listMany:async kinds=>kinds.flatMap(k=>({ResponsibilityUnit:src.heads.rus,Company:src.heads.companies,PeriodGoal:src.heads.goals,Mission:src.heads.missions,Task:[],StateSnapshot:src.heads.snapshots}[k.type]).map(o=>({...o,object_type:k.type})))}),
  isOperator:a=>a.id==='member-04'||a.ceo,roster:['刘人豪','于斯一','刘明华'],ceoName:'刘明华',companyDirection:async()=>'方向',installReviewRound,archivesPath});
 const until=async test=>{for(let i=0;i<200&&!test(store.snapshot());i++)await new Promise(r=>setTimeout(r,20));};
 return {store,jobs,until,statePath};
}
const now=new Date('2026-10-23T02:00:00Z');

test('复盘生成任务：只有 CEO 和轮次操作人能开始，跑完装入新一轮复盘',async t=>{
 const skillThere=await import('node:fs').then(fs=>fs.existsSync(new URL('./.runtime/eval/review/skills/tkos-review-2.0.4/SKILL.md',import.meta.url)));
 if(!skillThere)return t.skip('本机没有复盘技能目录');
 const {store,jobs,until}=await harness();
 await assert.rejects(jobs.start({id:'member-03'},{},{now}),/只有 CEO 和轮次操作人/);
 const job=await jobs.start({id:'member-04'},{},{now});assert.equal(job.status,'running');assert.equal(job.period,'2026-10');
 await assert.rejects(jobs.start({id:'member-04'},{},{now}),/正在生成/);
 await until(s=>s.reviewJob?.status!=='running');
 const s=store.snapshot();assert.equal(s.reviewJob.status,'done',JSON.stringify(s.reviewJob));
 assert.deepEqual(Object.values(s.cards).filter(c=>c.kind==='review').map(c=>c.id).sort(),['rv:company','rv:eo','rv:eo-m1']);
 assert.match(s.reviewRound.label,/10 月复盘/);assert.ok(s.reviewRound.readAt&&s.reviewRound.generatedAt,'记下本体读取时间和生成完成时间');assert.ok(s.reviewRound.durationMs>=0&&s.reviewRound.startedAt,'记下生成用时');assert.equal(s.reviewRound.cutoff,'2026-10-23T23:59:59+08:00');
 assert.ok(jobs.view().skipped.some(x=>/Token Ops/.test(x)));
});

test('复盘生成任务：检查没过不装入、已有复盘要明确重新生成、失败后可以续跑',async t=>{
 const skillThere=await import('node:fs').then(fs=>fs.existsSync(new URL('./.runtime/eval/review/skills/tkos-review-2.0.4/SKILL.md',import.meta.url)));
 if(!skillThere)return t.skip('本机没有复盘技能目录');
 const {store,jobs,until}=await harness({gateway:fakeGateway({verdict:'基本达成'}),reviews:true});
 await assert.rejects(jobs.start({id:'member-04',ceo:false},{},{now}),e=>e.code==='review-exists'&&e.total===1);
 await jobs.start({id:'member-04'},{regenerate:true},{now});
 await until(s=>s.reviewJob?.status!=='running');
 const s=store.snapshot();assert.equal(s.reviewJob.status,'failed');assert.ok(s.reviewJob.checks.some(c=>/基本达成/.test(c.problem)));
 assert.equal(s.cards['rv:eo'].title,'旧','检查没过时现有复盘不动');
 const resumed=await jobs.start({id:'member-04'},{resume:true},{now});assert.equal(resumed.status,'running');
 await until(s=>s.reviewJob?.status!=='running');assert.equal(store.snapshot().reviewJob.status,'failed');
});

test('复盘生成：产品凭证读本体会翻页，只走列对象和读对象两种路径',async()=>{
 const seen=[];
 const transport=async url=>{seen.push(url.pathname+url.search);const page=url.searchParams.get('cursor')?{items:[{object_id:id(2)}],next_cursor:null}:{items:[{object_id:id(1)}],next_cursor:'n'};return {ok:true,json:async()=>({data:url.pathname.endsWith('/objects')?page:{events:[{content:{text:'e'}}]}})};};
 const r=httpReviewReader({token:'t',transport});
 assert.deepEqual((await r.list({type:'Mission',period:'2026-10'})).map(o=>o.object_id),[id(1),id(2)]);
 assert.equal((await r.events(id(1))).length,1);
 await assert.rejects(r.get('../x'),/编号不对/);
 assert.throws(()=>httpReviewReader({}),/没有本体只读凭证/);
 const asked=[];
 const src=await collectReviewSources({reader:{list:async k=>k.type==='Mission'?[{object_id:id(5)}]:[],get:async x=>({id:x}),findEvents:async f=>{asked.push(f);return [{event_id:'e'}];}},period:'2026-10',cutoff:'2026-10-22T23:59:59+08:00'});
 assert.deepEqual(Object.keys(src.objects),[id(5)]);assert.deepEqual(asked,[{occurred_from:'2026-10-01T00:00:00+08:00',occurred_to:'2026-10-22T23:59:59+08:00'}]);assert.equal(src.monthEvents.length,1);
 const pages=[];const t2=async url=>{pages.push(url.search);return {ok:true,json:async()=>({data:{items:[{event_id:pages.length}],next_cursor:pages.length<2?'n':null}})};};
 assert.equal((await httpReviewReader({token:'t',transport:t2}).findEvents({occurred_from:'a'})).length,2);
});


test('拒答：同样的请求先再试一次；仍失败的单元续跑时重写，它的上级 RU 和公司复盘也跟着重写',async()=>{
 const input=buildReviewInput(sources(),{companyDirection:'方向',ceoName:'刘明华'});
 const once=fakeGateway({refuseOnce:new Set(['eo-m1'])});const ok=await runReviewSkill({gateway:once,skill,input});
 assert.ok(ok.reviews['eo-m1']);assert.deepEqual(ok.failed,[]);assert.ok(ok.raw['eo-m1']&&!ok.raw['eo-m1#nobg']);assert.deepEqual(ok.dropped,[]);
 const g=fakeGateway({refuseAlways:new Set(['eo-m1'])});const run=await runReviewSkill({gateway:g,skill,input});
 assert.deepEqual(run.failed.map(f=>f.id),['eo-m1']);assert.ok(run.reviews.eo&&run.reviews.company);
 // 陈溪南 2026-10-23: a refused unit does not hold back the round; it is named in 管理 and left out this time.
 assert.deepEqual(reviewProblems(run,input,{roster:['刘人豪','于斯一','刘明华']}),[]);assert.equal(run.failed[0].title,'Context 建模');
 const {reviewSummary}=await import('./review-handoff.mjs');
 const installed=installReviewRound({cards:{},comments:[],messages:[],sequence:1},reviewFile(run,input,{skill,model:'fake',label:'10 月复盘'}),{label:'10 月复盘'});
 assert.deepEqual(reviewSummary(installed).failedList.map(f=>[f.ref,f.title]),[['eo-m1','Context 建模']]);assert.equal(reviewSummary(installed).failed,1);
 // Other gaps still block: a unit missing for any other reason, and the company review even when refused.
 assert.match(JSON.stringify(reviewProblems({...run,failed:[{id:'eo-m1',finishReason:null}]},input)),/eo-m1.*没有生成出来/);
 assert.match(JSON.stringify(reviewProblems({...run,reviews:Object.fromEntries(Object.entries(run.reviews).filter(([k])=>k!=='company')),failed:[...run.failed,{id:'company',finishReason:'refusal'}]},input)),/公司 PO 复盘没有生成出来/);
 const again=fakeGateway();await runReviewSkill({gateway:again,skill,input,run});
 assert.ok(again.calls.includes('eo-m1')&&again.calls.includes('eo')&&again.calls.includes('company'));
 assert.deepEqual(run.failed,[]);assert.deepEqual(reviewProblems(run,input,{roster:['刘人豪','于斯一','刘明华']}),[]);
});
test('读取盘点 10/26：Task 行合并计划条目和 Task 对象；单元记录按正文归到 Mission；本月的 review 事件不当上月复盘；按条目时间认月份；留读取回执',()=>{
 const s=sources();
 // A plan with two items (principal ids), one matching a Task object by title.
 s.objects[id(20)].business.blocks.push({id:'execution_plan',display_name:'Task 全景',kind:'plan',value:{components:[
  {id:'task:t-a',type:'plan_item',text:'T01｜对象模型定稿：模型和口径定下来',attributes:{responsible:'p-yu',finish_date:'2026-10-30',expected_output:'模型定稿',quality_standard:'评审通过'},ref:`${id(20)}@3#execution_plan/task:t-a`},
  {id:'task:t-b',type:'plan_item',text:'T02｜读写联调',attributes:{responsible:null}}]}});
 s.heads.tasks=[{object_id:id(40)},{object_id:id(41)}];
 s.objects[id(40)]={business:{title:'对象模型定稿',blocks:blocks('模型定稿'),relations:[{field:'parent_ref',value:{object_id:id(20)}}]},identity:{}};
 s.objects[id(41)]={business:{title:'额外的 Task',blocks:blocks('别的'),relations:[{field:'parent_ref',value:{object_id:id(20)}}]},identity:who('刘人豪')};
 s.monthEvents.push({event_id:'pn',principal:{principal_id:'p-yu',display_name:'于斯一'},kind:'event.recorded',category:'other',occurred_at:'2026-10-20T09:00:00+08:00',subject_refs:[{object_id:id(1)}],content:{text:'Context 建模这周把对象模型定稿推进到评审'},corrected_by:[],withdrawn_by:[]});
 s.monthEvents.push({event_id:'rv',principal:{display_name:'刘人豪'},kind:'event.recorded',category:'review',occurred_at:'2026-10-21T09:00:00+08:00',subject_refs:[{object_id:id(10)}],content:{text:'E&O 目标重写范围决定'},corrected_by:[],withdrawn_by:[]});
 s.monthEvents.push({event_id:'lto',principal:{display_name:'刘明华'},kind:'event.recorded',category:'other',occurred_at:'2026-10-21T09:00:00+08:00',subject_refs:[{object_id:'lto-x'}],content:{text:'明华确认了长期目标'},corrected_by:[],withdrawn_by:[]});
 s.heads.snapshots.push({object_id:id(34),domain_id:'d-eo'});
 s.objects[id(34)]={title:'E&O · 11/02 补记 10 月进展',as_of:'2026-11-02T10:00:00+08:00',subject_ref:{object_id:id(20)},blocks:[{id:'p',display_name:'进展',components:[{type:'progress',text:'10/21 联调过一次',attributes:{entries:[{at:'2026-10-21T10:00:00+08:00',text:'联调过一次'}]}}]}]};
 const input=buildReviewInput(s,{ceoName:'刘明华'}),m=input.stages[0][0];
 assert.deepEqual(m.tasks.map(t=>[t.title.slice(0,8),t.owner,t.ref.startsWith(id(40))||t.ref===id(41)?'task':'plan']),[['T01｜对象模型','于斯一','task'],['T02｜读写联调','未指派','plan'],['额外的 Task','刘人豪','task']]);
 assert.equal(m.tasks[0].expected,'模型定稿');assert.ok(!('expectedFacts' in m));
 assert.ok(m.evidence.some(e=>/正文提到这个 Mission/.test(e.source)&&/定稿推进到评审/.test(e.text)),'单元上的记录提到 Task 标题，归到 Mission');
 const po=input.stages[1][0];assert.ok(po.evidence.some(e=>/重写范围决定/.test(e.text)&&e.kind!=='上月复盘'),'本月的 review 事件按本月记录');
 assert.ok(m.evidence.some(e=>/联调过一次/.test(e.text)),'11 月补记、条目时间在 10 月的快照照读');
 assert.ok(input.stages[2][0].evidence.some(e=>/长期目标/.test(e.text)),'挂在长期目标上的记录归到公司，不丢');
 assert.ok(input.readReceipt.objects.length&&input.readReceipt.events.includes('pn')&&input.readReceipt.snapshots.includes(id(34)));
 // No owner: shown as unassigned, the unit DRI still signs.
 const o=buildReviewInput(sources({withMissionOwner:false}),{ceoName:'刘明华'}).stages[0][0];assert.equal(o.ownerAssigned,false);assert.match(o.missing[0],/未指派/);
});
