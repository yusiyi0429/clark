import {test} from 'node:test';
import {parentInitialContextContract} from './review-initial-context.mjs';
import {initialEvidenceContract} from './review-initial-evidence.mjs';
import {fullContextCheckContract} from './review-source-plan.mjs';
import assert from 'node:assert/strict';
import {evidenceAddresses,stripVerifiedEvidence,citationFacts,verifiedReferenceMap,validateIssueSources} from './review-evidence-addresses.mjs';
import {lengthFindings,jargonOf,evidenceFacts,reviewFile,runReviewSkill,reviewProblems,reviewQualityTasks} from './review-generation.mjs';
import {richParts,reviewSentence} from './review-display.mjs';
import {installReviewRound} from './review-round.mjs';
import {createCollaborationState} from './governance.mjs';
import {sharedProjection} from './shared-projection.mjs';
import {planTableItem} from './review-plan-table.mjs';
const sources={a:{evidence:[{id:'E1',text:'原文a'}]},b:{evidence:[{id:'E2',text:'完整原文b，不可裁掉'}]}};
const context={sourceRef:'a',sources};
test('namespaces are checked before IDs, and only verified machine markers are excluded from body metrics',()=>{
 const text='正文[E1][a:E1][b:E2][missing:E1][b:E1][b:E2-E3]',addresses=evidenceAddresses(text,context);
 assert.deepEqual(addresses.map(a=>a.valid),[true,true,true,false,false,false]);
 assert.equal(stripVerifiedEvidence(text,context),'正文[missing:E1][b:E1][b:E2-E3]');
 assert.deepEqual(citationFacts({verdictReason:text},context).missingIds,['missing:E1','b:E1','b:E2-E3']);
 const review={facts:[{item:'事实',status:'达成',evidence:'证'.repeat(100)+'[b:E2]',gap:'差'.repeat(60)+'[a:E1]'}]};
 assert.equal(lengthFindings(review,context).filter(x=>x.type==='超字数').length,0);assert.equal(lengthFindings(review).filter(x=>x.type==='超字数').length,2);
 assert.deepEqual(jargonOf('[b:E2]',context),[]);assert.ok(jargonOf('[unknown-source:E2]',context).length);assert.deepEqual(evidenceFacts({id:'a'}, {facts:[{evidence:'[b:E1]'}]},sources).missingIds,['b:E1']);
 const map=verifiedReferenceMap({verdictReason:text},context);assert.deepEqual(Object.keys(map),['[E1]','[a:E1]','[b:E2]']);
 assert.equal(richParts(text,map).map(p=>p.text||p.bold).join(''),'正文[missing:E1][b:E1][b:E2-E3]');assert.equal(richParts('[E99]',{}).map(p=>p.text).join(''),'[E99]');
 for(const text of ['完成。[b:E2]','完成[b:E2]','完成 [a:E1] [b:E2]'])assert.equal(richParts(reviewSentence(text,map),map).map(p=>p.text).join(''),'完成。');
 assert.ok(richParts(reviewSentence('完成[missing:E1]',map),map).map(p=>p.text).join('').includes('[missing:E1]'));
 const input={engineeringContracts:{evidenceAddresses:1},stages:[[{id:'a',...sources.a},{id:'b',...sources.b}],[],[]]};assert.ok(reviewProblems({reviews:{a:{verdict:'达成',facts:[{item:'事实',status:'达成',evidence:'错误[b:E1]'}],nextInputs:[]}},failed:[]},input).some(p=>p.problem.includes('冻结证据地址')));
});
test('verified reference metadata survives formal install and the existing read projection without exposing source bodies',()=>{
 const input={engineeringContracts:{evidenceAddresses:1},period:'2026-10',stages:[[{id:'a',...sources.a},{id:'b',...sources.b}],[],[]]},review={ref:'a',unit:'u',level:'mission',title:'事项',owner:'陈溪南',verdict:'达成',facts:[{item:'事实',status:'达成',evidence:'实际结果[b:E2]'}],nextInputs:[]},run={reviews:{a:review},failed:[],dropped:[],quality:{status:'passed',counts:{},remaining:[],maxRevisions:2}};
 const before=JSON.stringify(run.reviews),file=reviewFile(run,input,{skill:{version:'2.1.13',hash:'fixture'},model:'formal'}),state=installReviewRound(createCollaborationState([]),file),view=sharedProjection(state,{id:'member-04',name:'陈溪南',visibleUnits:['u']});
 assert.equal(JSON.stringify(run.reviews),before);const map=view.drafts['rv:a'].evidenceReferenceMap;assert.deepEqual(map,{'[b:E2]':{ref:'b',id:'E2'}});assert.equal(JSON.stringify(map).includes('完整原文'),false);assert.equal(richParts(review.facts[0].evidence,map).map(p=>p.text).join(''),'实际结果');
});
test('checker source metadata must be explicit, supplied, and tied to actual evidence addresses',()=>{
 const args={sources,providedRefs:['a','b']},good={ref:'a',sourceRefs:['a','b'],evidenceRefs:[{ref:'b',id:'E2'}]};assert.equal(validateIssueSources(good,args),good);
 for(const issue of [{ref:'a'},{...good,sourceRefs:['a']},{...good,sourceRefs:['a','missing']},{...good,evidenceRefs:[{ref:'b',id:'E1'}]}])assert.throws(()=>validateIssueSources(issue,args));
 assert.throws(()=>validateIssueSources({ref:'a',sourceRefs:['a'],problem:'机器地址[b:E2]'},args),/结构化来源/);
 assert.throws(()=>validateIssueSources({...good,evidenceRefs:[],problem:'机器地址[b:E2]'},args),/结构化来源/);
 const plain={ref:'a',sourceRefs:['a'],problem:'普通文字提到另一领域'};assert.equal(validateIssueSources(plain,args),plain);assert.deepEqual(plain.sourceRefs,['a']);
});
test('v3 validates optional evidenceRefs independently without requiring duplicate valid inline addresses',()=>{
 const args={sources,providedRefs:['a','b'],checkerSources:3},good={ref:'a',sourceRefs:['a','b'],problem:'核对[b:E2]',impact:'另一个真实地址[a:E1]',evidenceRefs:[{ref:'a',id:'E1'}]},before=structuredClone(good);
 assert.equal(validateIssueSources(good,args),good);assert.deepEqual(good,before);
 for(const checkerSources of [1,2])assert.throws(()=>validateIssueSources(good,{...args,checkerSources}),/结构化来源/);
 for(const evidenceRefs of [undefined,[]])assert.equal(validateIssueSources({...good,evidenceRefs},args).problem,good.problem);
 for(const issue of [{...good,sourceRefs:['a']},{...good,sourceRefs:['a','b','unknown']},{...good,evidenceRefs:[{ref:'b',id:'E1'}]},{...good,evidenceRefs:[{ref:'unknown',id:'E1'}]},{...good,evidenceRefs:'E1'},{...good,evidenceRefs:[{ref:'b',id:'E9999'}]}])assert.throws(()=>validateIssueSources(issue,args));
 assert.throws(()=>validateIssueSources(good,{...args,providedRefs:['a']}));
 // Existing boundary: checker prose may be reporting an invalid citation.
 // Structured supporting addresses and generated review citations stay strict.
 const reported={ref:'a',sourceRefs:['a'],problem:'错误引用[b:E9999]',evidenceRefs:[]};
 for(const checkerSources of [1,2,3])assert.equal(validateIssueSources(reported,{...args,checkerSources}),reported);
 assert.ok(citationFacts({facts:[{evidence:'[b:E9999]'}]},{sourceRef:'a',sources}).missingIds.length);
});
test('source-key contract v2 distinguishes top-level sources from real nested Task and component references',()=>{
 const uuid='00000000-0000-4000-8000-000000000001',component=uuid+'@2#execution_plan/t01',nested={...sources,a:{...sources.a,tasks:[{objectId:uuid,componentRef:component}]}};
 for(const inner of [uuid,component]){const issue={ref:'a',sourceRefs:['a',inner],evidenceRefs:[]},before=JSON.stringify(issue);assert.throws(()=>validateIssueSources(issue,{sources:nested,providedRefs:['a','b']}));assert.equal(JSON.stringify(issue),before);}
 assert.throws(()=>validateIssueSources({ref:'a',sourceRefs:['a'],evidenceRefs:[{ref:uuid,id:'E1'}]},{sources:nested,providedRefs:['a','b']}));
 const skill={groups:[{name:'组',types:['critical']}]},v1=reviewQualityTasks(skill,{checkerSources:true})[0],v2=reviewQualityTasks(skill,{checkerSources:true,sourceKeyContract:true})[0];
 assert.ok(v2.startsWith(v1));assert.ok(v2.includes('ONLY be literal top-level keys'));assert.ok(v2.includes('scope.sourceRefs'));assert.ok(v2.includes('componentRef'));assert.ok(v2.includes('evidenceRefs.ref MUST use the same'));assert.ok(!v1.includes('ONLY be literal top-level keys'));
});
test('a weekly plan keeps its original columns and row without fabricating output, acceptance or completion fields',()=>{
 const row='| **T01 交付** <br/>原任务说明 | 阶段一 | △ 上线 | 复验 | 交接 |',header='| Task | 10/23–10/25 | 10/26 | 10/27–10/28 | 10/29–10/31 |',document=header+'\n| --- | --- | --- | --- | --- |\n'+row;
 const out=planTableItem(row,[document,document]);assert.equal(out.title,'**T01 交付** <br/>原任务说明');assert.equal(out.planTable.status,'matched');assert.equal(out.planTable.rawRow,row);assert.equal(out.planTable.text,document);assert.equal(out.planTable.columns[2].header,'10/26');assert.equal(out.planTable.columns[2].value,'△ 上线');for(const key of ['expected','quality','finish'])assert.equal(out[key],undefined);
 assert.equal(planTableItem(row,[document.replace('| --- | --- | --- | --- | --- |','|-|-|-|-|-|')]).planTable.status,'matched');
 const escaped='| T01 含 \\| 字符与 `a|b` | 阶段 |';assert.equal(planTableItem(escaped,['| Task | 周一 |\n| --- | --- |\n'+escaped]).title,'T01 含 \\| 字符与 `a|b`');
 const ambiguous=planTableItem(row,[document,document.replace('10/26','其他列')]);assert.equal(ambiguous.title,row);assert.equal(ambiguous.planTable.status,'ambiguous');assert.equal(ambiguous.planTable.sourceTables.length,2);
});
for(const fullContext of [false,true])test('checker cross-source repair and raw file preservation; fullContext='+fullContext,async()=>{
 const basis={mode:'latest-source-candidate',snapshotHash:'frozen'},meta={basisMode:basis.mode,snapshotHash:basis.snapshotHash};
 const c=(id,level,parent,children=[])=>({id,unit:'u',title:id,owner:'陈溪南',level,parent,children,sourceBasis:meta,childCommitments:{...meta,complete:true,items:[]},evidence:sources[id]?.evidence||[]});
 const input={engineeringContracts:{evidenceAddresses:1,checkerSources:2},basis,stages:[[c('a','mission','u'),c('b','mission','u')],[c('u','ru','company',['a','b'])],[c('company','company',null,['u'])]]},items=input.stages.flat(),skill={version:'2.1.13',hash:'fixture',rules:'JSON',mustFix:['critical'],maxRevisionRounds:2,groups:[1,2,3].map(n=>({name:'组'+n,types:['critical']}))};
 if(fullContext){input.engineeringContracts.initialEvidence=initialEvidenceContract();input.engineeringContracts.initialContext=parentInitialContextContract();input.engineeringContracts.checkerSources=3;input.engineeringContracts.fullContextCheck=fullContextCheckContract(items.map(c=>c.id),{version:2});}
 const reviews=Object.fromEntries(items.map(c=>[c.id,{verdict:'达成',verdictReason:'initial',facts:(c.children.length?c.children:['t']).map(ref=>({ref,item:ref,owner:'陈溪南',status:'达成',evidence:'结果',gap:''})),nextInputs:[]}])),run={raw:{},reviews:{},failed:[],dropped:[]};let cross=0;
 const gateway={status:{model:'wangsu/claude-sonnet-5-5'},complete:async messages=>{const p=JSON.parse(messages[1].content);if(!p.unit){const changed=p.reviews.find(r=>r.ref==='a').verdictReason==='fixed';return {answer:JSON.stringify({checkedRefs:p.scope.targetRefs,checkedEdges:p.scope.edges,sourceRequests:[],issues:changed||!p.scope.targetRefs.includes('a')?[]:[{ref:'a',type:'critical',problem:fullContext?'需要依据其他来源[b:E2]核对':'需要依据其他来源核对',impact:'事实',mustFix:true,fixable:true,sourceRefs:['a','b'],evidenceRefs:fullContext?[]:[{ref:'b',id:'E2'}]}]})};}const id=p.unit.id;if(fullContext&&id==='a'&&!p.revision&&!p.evidenceResponse)return {answer:JSON.stringify({requestEvidence:{addresses:[{sourceRef:'b',id:'E2'}]}})};if(fullContext&&!p.revision&&['u','company'].includes(id)){assert.equal(p.initialContext.maxBodyBytes,512*1024);assert.ok(p.childCandidates.every(c=>c.candidate&&!c.confirmed));assert.ok(p.childEvidence);assert.equal(p.unit.id,id);}if(p.revision&&id==='a'){cross++;assert.equal(p.sources.b.evidence[0].text,sources.b.evidence[0].text);assert.ok(p.sourceScope.sourceRefs.includes('b'));}return {answer:JSON.stringify({review:{...reviews[id],...(p.revision?{verdictReason:'fixed'}:{}),...(p.revision&&id==='a'?{facts:[{ref:'t',item:'t',owner:'陈溪南',status:'达成',evidence:'结果[b:E2]',gap:''}]}:{})}})};}};
 await runReviewSkill({gateway,skill,input,run});assert.equal(run.quality.status,'passed');assert.equal(cross,1);assert.deepEqual(run.quality.counts,{a:1,u:1,company:1});const raw=JSON.stringify(run.reviews);const file=reviewFile(run,input,{skill,model:gateway.status.model});assert.equal(JSON.stringify(run.reviews),raw);assert.ok(file.evidenceReferences.a['[b:E2]']);if(fullContext){assert.equal(run.initialAttempts.filter(a=>a.key==='a').length,2);assert.equal(run.initialAttempts.find(a=>a.key==='a').status,'context-provided');for(const plan of Object.values(run.quality.sourcePlans)){assert.equal(plan.maxConcurrency,3);assert.equal(plan.requestCount,3);assert.deepEqual(plan.layout,input.engineeringContracts.fullContextCheck.layout);for(const packet of plan.packets){assert.equal(packet.scope.sourceRefs.length,4);assert.equal(Object.keys(packet.payloads[0].programFacts.perReview).length,4);}}for(const pass of Object.values(run.quality.sourcePasses))assert.equal(pass.maxAdditionalRequests,0);}
});

test('only the exact frozen fact title on a taskless mission skips item length measurement',()=>{
 const item='Co-Agent V1 原始目标名称'.repeat(5);
 const source={level:'mission',expectedFacts:[{ref:'ref-1',item}]};
 const facts=[
  {ref:'ref-1',item,evidence:'实际证据内容'.repeat(20)},
  {ref:'ref-2',item},
  {ref:'ref-1',item:item+'改写'},
 ];
 const over=(review,card)=>lengthFindings(review,undefined,card).filter(f=>f.type==='超字数').map(f=>f.field);
 assert.deepEqual(over({facts},source),['evidence','item','item']);
 assert.deepEqual(over({facts:[facts[0]]},{...source,tasks:[{ref:'task'}]}),['item','evidence']);
 assert.deepEqual(over({facts:[facts[0]]},{...source,level:'ru'}),['item','evidence']);
 assert.deepEqual(over({facts:[facts[0]]}),['item','evidence']);
});
