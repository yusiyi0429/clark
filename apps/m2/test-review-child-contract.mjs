import {test} from 'node:test';import assert from 'node:assert/strict';
import {childVerdictProblem} from './review-child-contract.mjs';
import {buildReviewInput,reviewProblems,reviewFile,runReviewSkill} from './review-generation.mjs';
import {reviewCards} from './review-round.mjs';
const contract=(statuses,kind='Task')=>({complete:true,items:statuses.map((s,i)=>({ref:'c'+i,kind,parentRef:'p',period:'2026-10',effective:true,version:1})),excluded:[]});
for(const [statuses,allowed] of [[[],['达成','未达成']],[['未达成'],['未达成']],[['部分达成','未达成'],['未达成']],[['达成','未达成'],['部分达成']],[['达成','部分达成'],['部分达成']],[['达成','达成'],['达成','部分达成']]])test('子项校验不改输出：'+JSON.stringify(statuses),()=>{for(const verdict of ['达成','部分达成','未达成']){const r={verdict,facts:statuses.map((status,i)=>({ref:'c'+i,status}))},before=JSON.stringify(r);assert.equal(childVerdictProblem(r,contract(statuses))===null,allowed.includes(verdict),verdict);assert.equal(JSON.stringify(r),before);}});
test('元信息不全不能按空列表；占位成功标准不参与子项数量；PO对齐本轮Mission判定',()=>{assert.match(childVerdictProblem({verdict:'达成',facts:[]},{complete:false,items:[]}),/不完整/);assert.equal(childVerdictProblem({verdict:'未达成',facts:[{ref:'criterion',status:'部分达成'}]},contract([])),null);assert.match(childVerdictProblem({verdict:'部分达成',facts:[{ref:'c0',status:'达成'}]},contract(['达成'],'Mission'),{childReviews:[{ref:'c0',verdict:'未达成'}]}),/不一致/);});
function src({cancelTask=false,plan=false,missing=false,cancelMission=false}={}){const relation=(field,id)=>({field,value:{object_id:id}}),o=(title,version,relations=[],status='进行中')=>({business:{title,version,relations,blocks:[]},records:{lifecycle:{status,display_name:status}}});const m=o('任务成果',3,[relation('goal_ref','g')],cancelMission?'已取消':'进行中');m.business.revision_id='revision-m3';m.business.formal={effective_revision_id:'revision-m3'};m.business.blocks=[{id:'definition',components:[{type:'acceptance_criterion',text:'成果可用'}]},...(plan?[{id:'execution_plan',components:[{ref:'m@3#execution_plan/task1',type:'plan_item',text:'正式任务'}]}]:[])];const objects={r:o('E&O',1),g:o('E&O PO',2),m,...(!missing?{t:o('正式任务',4,[relation('mission_ref','m')],cancelTask?'已取消':'进行中')}:{})};if(objects.t)objects.t.business.blocks=[{id:'definition',components:[{type:'outcome',text:'正式任务'}]}];return {period:'2026-10',cutoff:'2026-10-30T23:59:59+08:00',heads:{rus:[{object_id:'r',domain_id:'d',title:'E&O'}],companies:[],goals:[{object_id:'g',domain_id:'d'}],missions:[{object_id:'m',domain_id:'d'}],tasks:plan?[]:[{object_id:'t',domain_id:'d'}],snapshots:[]},objects,monthEvents:[]};}
test('读取元信息明确真实Task、正式计划Task、已取消和成功标准fallback，不靠事实行数',()=>{let input=buildReviewInput(src()),m=input.stages.flat().find(c=>c.id==='eo-m1');assert.equal(m.childCommitments.complete,true);assert.equal(m.childCommitments.items[0].ref,'t');assert.equal(m.childCommitments.items[0].version,4);assert.equal(m.childCommitments.items[0].kind,'Task');input=buildReviewInput(src({cancelTask:true}));m=input.stages.flat().find(c=>c.id==='eo-m1');assert.equal(m.childCommitments.items.length,0);assert.equal(m.childCommitments.excluded[0].ref,'t');assert.ok(m.expectedFacts.length);input=buildReviewInput(src({plan:true}));m=input.stages.flat().find(c=>c.id==='eo-m1');assert.equal(m.childCommitments.complete,true);assert.equal(m.childCommitments.items[0].source,'planItem');input=buildReviewInput(src({missing:true}));m=input.stages.flat().find(c=>c.id==='eo-m1');assert.equal(m.childCommitments.complete,false);input=buildReviewInput(src({cancelMission:true}));assert.ok(!input.stages.flat().some(c=>c.level==='mission'));const po=input.stages.flat().find(c=>c.id==='eo');assert.equal(po.childCommitments.items.length,0);assert.equal(po.childCommitments.excluded[0].ref,'m');});
test('新规则只在明确开关检查新生成，不回写已有轮次；来源元信息存入冻结卡而非信模型',()=>{const input=buildReviewInput(src()),m=input.stages.flat().find(c=>c.id==='eo-m1'),r={ref:m.id,unit:m.unit,level:'mission',title:m.title,owner:'孙铭泽',verdict:'部分达成',verdictReason:'理由',facts:[{ref:'t',item:'任务',status:'部分达成',evidence:'事实',gap:'未完成'}],nextInputs:[{ref:'t',type:'继续',text:'继续'}]},run={reviews:{[m.id]:r},failed:[],dropped:[]};assert.ok(!reviewProblems(run,input).some(p=>/0项达成/.test(p.problem)));assert.ok(reviewProblems(run,input,{childRule:true}).some(p=>/0项达成/.test(p.problem)));const file=reviewFile(run,input,{skill:{version:'2.1.10',hash:'frozen'},model:'fixture'}),card=reviewCards(file)['rv:eo-m1'];assert.deepEqual(card.versions[0].content.childCommitments,m.childCommitments);assert.equal(card.versions[0].content.verdict,'部分达成','不自动改写错误模型输出，只校验拒绝');});

test('正式移出不回退到旧domain；Task缺版本和计划缺组件引用不当作无子项；元信息缺失不调用模型',async()=>{
 let source=src();source.objects.m.business.relations[0].value.object_id='other-period-goal';let input=buildReviewInput(source);assert.ok(!input.stages.flat().some(c=>c.level==='mission'));assert.match(input.stages.flat().find(c=>c.id==='eo').childCommitments.excluded[0].reason,/移出/);
 source=src();delete source.objects.t.business.version;input=buildReviewInput(source);assert.equal(input.stages.flat().find(c=>c.id==='eo-m1').childCommitments.complete,false);
 source=src({plan:true});delete source.objects.m.business.blocks[1].components[0].ref;input=buildReviewInput(source);assert.equal(input.stages.flat().find(c=>c.id==='eo-m1').childCommitments.complete,false);let calls=0;await assert.rejects(()=>runReviewSkill({gateway:{complete:async()=>{calls++;}},skill:{version:'2.1.10',rules:''},input}),/有效直接子项元信息不完整/);assert.equal(calls,0);
});

test('最新来源基线保留草稿计划全部条目、原组件引用和真实formal，不改源对象',()=>{
 const source=src({plan:true});source.objects.m.business.version=7;source.objects.m.business.revision_id='latest-r7';source.objects.m.business.formal={lifecycle_status:'draft',effective_revision_id:'older-r3'};
 source.objects.m.business.blocks[1].components=[{ref:'m@7#execution_plan/a',type:'plan_item',text:'最新任务A'},{ref:'m@7#execution_plan/b',type:'plan_item',text:'新增任务B'}];
 const before=JSON.stringify(source),input=buildReviewInput(source),m=input.stages.flat().find(c=>c.id==='eo-m1');
 assert.equal(input.basis.mode,'latest-source-candidate');assert.equal(m.childCommitments.complete,true);assert.equal(m.tasks.length,2);assert.equal(m.expectedFacts,undefined);
 assert.equal(m.sourceBasis.sourceVersion,7);assert.equal(m.sourceBasis.sourceRevision,'latest-r7');assert.equal(m.sourceBasis.effective,false);assert.deepEqual(m.sourceBasis.formal,source.objects.m.business.formal);
 assert.ok(m.childCommitments.items.every(t=>t.inBaseline&&t.effective===false&&t.version===7));assert.deepEqual(m.childCommitments.items.map(t=>t.componentRef),['m@7#execution_plan/a','m@7#execution_plan/b']);assert.equal(JSON.stringify(source),before);
 const po=input.stages.flat().find(c=>c.id==='eo');assert.equal(po.childCommitments.items[0].effective,false);
});
test('独立Task也用最新对象版本；formal未知保留null，不依生命周期文字冒充确认',()=>{
 const source=src();source.objects.t.business.version=8;source.objects.t.business.revision_id='task-latest';
 const m=buildReviewInput(source).stages.flat().find(c=>c.id==='eo-m1'),t=m.childCommitments.items[0];
 assert.equal(t.version,8);assert.equal(t.sourceRevision,'task-latest');assert.equal(t.inBaseline,true);assert.equal(t.effective,null);assert.equal(t.formal,null);assert.equal(m.childCommitments.complete,true);
});
test('空正文、缺组件引用、父级冲突或Task匹配歧义仍拦，已知条目不丢成无子项',()=>{
 for(const change of [s=>s.objects.m.business.blocks[1].components[0].text='',s=>delete s.objects.m.business.blocks[1].components[0].ref,s=>s.objects.m.business.relations.push({field:'goal_ref',value:{object_id:'other'}})]){
  const source=src({plan:true});change(source);const m=buildReviewInput(source).stages.flat().find(c=>c.id==='eo-m1');assert.equal(m.childCommitments.complete,false);assert.equal(m.tasks.length,1);assert.equal(m.expectedFacts,undefined);
 }
 const source=src();source.objects.t.business.relations.push({field:'parent_ref',value:{object_id:'other'}});assert.equal(buildReviewInput(source).stages.flat().find(c=>c.id==='eo-m1').childCommitments.complete,false);
 const ambiguous=src({plan:true});ambiguous.heads.tasks=[{object_id:'t',domain_id:'d'},{object_id:'t2',domain_id:'d'}];ambiguous.objects.t2=structuredClone(ambiguous.objects.t);const m=buildReviewInput(ambiguous).stages.flat().find(c=>c.id==='eo-m1');assert.equal(m.childCommitments.complete,false);assert.match(m.childCommitments.missing.join('；'),/歧义/);assert.equal(m.tasks.length,3);
});
test('2.1.11续跑不能换来源基线或套用无指纹旧输出，拒绝前不调用模型',async()=>{
 const source=src({plan:true});source.objects.g.business.blocks=[{id:'definition',text:'PO成果'}];const input=buildReviewInput(source);let calls=0;const gateway={complete:async()=>{calls++;throw Error('不应调用');}},skill={version:'2.1.11',rules:''};
 for(const run of [{inputFingerprint:'different',raw:{},reviews:{}},{raw:{mission:'old output'},reviews:{}}])await assert.rejects(runReviewSkill({gateway,skill,input,run}),/续跑输入基线不一致/);
 const noBasis=structuredClone(input);delete noBasis.basis;await assert.rejects(runReviewSkill({gateway,skill,input:noBasis}),/候选基线缺失/);assert.equal(calls,0);
});
test('首次准备与同版续跑保持同一指纹，跨单元来源混配被拒，不触发模型',async()=>{
 const source=src({plan:true});source.objects.g.business.blocks=[{id:'definition',text:'PO成果'}];const input=buildReviewInput(source),run={raw:{},reviews:{},failed:[],dropped:[]};let saved,calls=0;
 const gateway={complete:async()=>{calls++;throw Error('不应调用');}},skill={version:'2.1.11',rules:''},stop=Error('仅校验输入，不生成');
 const check=()=>runReviewSkill({gateway,skill,input,run,save:async value=>{saved=structuredClone(value);},onProgress:async()=>{throw stop;}});
 await assert.rejects(check(),error=>error===stop);const fingerprint=saved.inputFingerprint;assert.equal(typeof fingerprint,'string');assert.equal(fingerprint.length,64);
 await assert.rejects(check(),error=>error===stop);assert.equal(saved.inputFingerprint,fingerprint);
 const mixed=structuredClone(input);mixed.stages[0][0].sourceBasis.snapshotHash='other';await assert.rejects(runReviewSkill({gateway,skill,input:mixed}),/对象来源与整轮候选基线不一致/);assert.equal(calls,0);
});

test('匹配Task后最新对象的交付、验收和日期优先，旧计划条目明确保留在planSource',()=>{
 const source=src({plan:true});source.heads.tasks=[{object_id:'t',domain_id:'d'}];source.objects.t.business.version=8;source.objects.t.business.revision_id='task-r8';
 source.objects.m.business.blocks[1].components[0].attributes={expected_output:'旧交付',quality_standard:'旧验收',finish_date:'2026-10-15'};
 source.objects.t.business.blocks=[{id:'definition',components:[{type:'outcome',text:'最新交付'},{type:'acceptance_criterion',text:'最新验收'},{type:'time_boundary',text:'2026-10-31'}]}];
 const input=buildReviewInput(source),m=input.stages.flat().find(c=>c.id==='eo-m1'),task=m.tasks[0];
 assert.equal(m.childCommitments.complete,true);assert.equal(task.source,'object');assert.equal(task.version,8);assert.equal(task.expected,'最新交付');assert.equal(task.quality,'最新验收');assert.equal(task.finish,'2026-10-31');assert.equal(task.planSource.expected,'旧交付');assert.equal(task.planSource.quality,'旧验收');assert.equal(task.planSource.finish,'2026-10-15');
 source.objects.t.business.blocks=[];const missingBody=buildReviewInput(source).stages.flat().find(c=>c.id==='eo-m1');assert.equal(missingBody.childCommitments.complete,false);assert.match(missingBody.childCommitments.missing.join('；'),/正文缺失/);const absent=missingBody.tasks[0];assert.equal(absent.expected,undefined);assert.equal(absent.quality,undefined);assert.equal(absent.finish,undefined);assert.equal(absent.planSource.expected,'旧交付','Task没有定义的字段不静默从计划补成最新要求');
});
