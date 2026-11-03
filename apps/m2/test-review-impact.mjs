import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planReviewImpact,reviewImpactPayload,validateReviewImpact} from './review-impact.mjs';

const items=[{id:'company',children:['a','b']},{id:'a',children:['m']},{id:'b'},{id:'m'}];
const sources=Object.fromEntries(items.map(({id})=>[id,{evidence:[{id:'E1',text:'冻结原文 '+id}]}]));
const before={company:{facts:[{ref:'a',evidence:'原文'},{ref:'b',evidence:'其他'}]},a:{verdict:'未达成'},b:{facts:[{evidence:'[m:E1]'}]},m:{verdict:'未达成'}};
const impact=reviews=>planReviewImpact({items,sources,before,reviews,issues:[],phase:'impact'});

test('changing a candidate does not propagate through a stable original evidence citation',()=>{
 const scope=impact({...before,m:{verdict:'达成'}});
 assert.deepEqual(scope.targetRefs,['m']);
 assert.deepEqual(scope.sourceRefs,['m']);
 assert.deepEqual(scope.edges,[{parentRef:'a',childRef:'m',kind:'hierarchy'}]);
});
test('parent fact changes follow the affected child row; handoffs are directed dependencies',()=>{
 const scope=impact({...before,company:{facts:[{ref:'a',evidence:'改稿'},before.company.facts[1]]}});
 assert.deepEqual(scope.edges.filter(x=>x.kind==='hierarchy').map(x=>x.childRef),['a']);
 const prior={...before,b:{nextInputs:[{covers:[{ref:'m',index:0}]}]}};
 const after={...prior,m:{verdict:'达成'}};
 const handoff=planReviewImpact({items,sources,before:prior,reviews:after,issues:[],phase:'impact'});
 assert.ok(handoff.edges.some(x=>x.parentRef==='b'&&x.childRef==='m'&&x.kind==='handoff'));
 assert.ok(handoff.allowedIssueRefs.includes('b'));
 assert.ok(!handoff.sourceRefs.includes('b'));
});
test('unknown changes expand review; final covers every relation without sending unrelated originals',()=>{
 const unknown=impact({...before,m:{verdict:'达成',unrecognized:'新增'}});
 assert.equal(unknown.unknown,true);
 assert.equal(unknown.sourceRefs.length,items.length);
 const scope=planReviewImpact({items,sources,reviews:before,issues:[],phase:'final'});
 const payload=reviewImpactPayload({phase:'final',scope,reviews:before,sources,priorIssues:[],coverage:[]});
 assert.deepEqual(payload.sources,{});
 const receipt={phase:'final',candidateHash:payload.candidateHash,checkedRefs:scope.targetRefs,checkedEdges:scope.edges,issues:[],issueResults:[],sourceRequests:[]};
 assert.equal(validateReviewImpact(receipt,payload,scope.targetRefs),receipt);
 assert.throws(()=>validateReviewImpact({...receipt,candidateHash:'旧候选'},payload,scope.targetRefs),/候选/);
 assert.throws(()=>validateReviewImpact({...receipt,checkedEdges:[]},payload,scope.targetRefs),/覆盖/);
});

test('business facts and resolutions require supplied originals; candidate relationships do not',()=>{
 const items=[{id:'ru',children:['mission']},{id:'mission'},{id:'service'}];
 const sources={
  ru:{evidence:[]},
  mission:{evidence:[{id:'E1',text:'候选待核，尚未确认部署日'}]},
  service:{evidence:[{id:'E56',text:'10/30 核对正式环境已在运行，未确认部署发生日'}]},
 };
 const reviews={
  ru:{facts:[{ref:'mission',status:'未达成'}]},
  mission:{verdict:'达成'},
  service:{facts:[]},
 };
 const known=Object.keys(sources);
 const check=(phase,priorIssues=[],extraSourceRefs=[])=>{
  const scope=planReviewImpact({items,sources,before:reviews,reviews,issues:priorIssues,phase});
  const payload=reviewImpactPayload({phase,scope,reviews,sources,priorIssues,coverage:[],extraSourceRefs,boundedSource:true,checkBasis:true});
  const response={phase,candidateHash:payload.candidateHash,checkedRefs:scope.targetRefs,checkedEdges:scope.edges,issues:[],issueResults:[],sourceRequests:[]};
  return {payload,response,validate:()=>validateReviewImpact(response,payload,known)};
 };
 const fact={ref:'mission',type:'证据不符',problem:'实际部署发生在10/30',impact:'部署日期错误',mustFix:true,fixable:true,sourceRefs:[]};
 const candidate={kind:'candidate',refs:[{ref:'mission',field:'verdict'}]};
 const original={kind:'source',refs:[{ref:'mission',field:'evidence',id:'E1'},{ref:'service',field:'evidence',id:'E56'}]};
 const final=check('final');
 final.response.issues=[fact];
 assert.throws(final.validate,/缺少可核对的依据/);
 final.response.issues=[{...fact,basis:candidate}];
 assert.throws(final.validate,/必须依据/);
 final.response.issues=[{...fact,type:'上下不一致',basis:{kind:'candidate',refs:[{ref:'mission',field:'verdict'},{ref:'ru',field:'facts'}]}}];
 assert.doesNotThrow(final.validate);
 const field=final.response.issues[0].basis.refs[1];
 field.field='facts[0].status';
 assert.doesNotThrow(final.validate);
 for(const invalid of ['facts[1].status','facts[0].missing','facts.0.status','facts[00].status','facts[-1]','facts.length','facts[0].constructor','facts[0].__proto__','facts[0].prototype','facts[0].status.length']){
  field.field=invalid;
  assert.throws(final.validate,/候选依据/,invalid);
 }

 const impact=check('impact',[{...fact,id:'old',sourceRefs:['mission','service']}]);
 impact.response.issueResults=[{id:'old',status:'resolved',reason:'候选已改成10/30部署',basis:candidate}];
 assert.throws(impact.validate,/必须依据/);
 impact.response.issueResults[0].basis={kind:'source',refs:[original.refs[0]]};
 assert.throws(impact.validate,/声明的来源不一致/);
 impact.response.issueResults[0].basis=original;
 assert.doesNotThrow(impact.validate);
 const supplemented=check('final',[],['mission','service']);
 supplemented.response.issues=[{...fact,problem:'原文只支持10/30核对已运行，不能认定为部署日',sourceRefs:['mission','service'],basis:original}];
 assert.doesNotThrow(supplemented.validate);
 supplemented.response.issues[0].basis={...original,refs:[...original.refs.slice(0,1),{...original.refs[1],id:'E57'}]};
 assert.throws(supplemented.validate,/本次已提供/);
});

test('exact receipts distinguish missing coverage from extra relationship endpoints',()=>{
 const reviews={...before,m:{verdict:'达成'}};
 const scope=impact(reviews),priorIssues=[{id:'old'}];
 const payload=reviewImpactPayload({phase:'impact',scope,reviews,sources,priorIssues,coverage:[],exactReceipt:true});
 const receipt={phase:'impact',candidateHash:payload.candidateHash,checkedRefs:['m'],checkedEdges:scope.edges,issues:[],issueResults:[{id:'old',status:'open',reason:'待核'}],sourceRequests:[]};
 const validate=value=>validateReviewImpact(value,payload,Object.keys(sources));
 assert.deepEqual(payload.requiredReceipt,{checkedRefs:['m'],checkedEdges:scope.edges,issueResultIds:['old']});
 assert.match(payload.task,/不能增删或重复/);
 assert.doesNotThrow(()=>validate(receipt));
 assert.throws(()=>validate({...receipt,checkedRefs:['m','a']}),/缺少 \[\]，多报 \["a"\]/);
 assert.throws(()=>validate({...receipt,checkedRefs:[]}),/缺少 \["m"\]，多报 \[\]/);
 assert.throws(()=>validate({...receipt,checkedEdges:[]}),/checkedEdges 集合不符，缺少/);
 assert.throws(()=>validate({...receipt,issueResults:[]}),/issueResults.id 集合不符，缺少 \["old"\]/);
});

test('precise original paths are accepted and individual invalid bases remain pending',()=>{
 const scopedSources={...sources,m:{...sources.m,tasks:[{quality:'已冻结的验收标准'}]}};
 const reviews={...before,m:{verdict:'达成'}};
 const priorIssues=[{id:'old',ref:'m',type:'证据不符',sourceRefs:['m'],problem:'原问题'}];
 const scope=planReviewImpact({items,sources:scopedSources,before,reviews,issues:priorIssues,phase:'impact'});
 const payload=reviewImpactPayload({phase:'impact',scope,reviews,sources:scopedSources,priorIssues,coverage:[],checkBasis:2,exactReceipt:true,sourcePaths:true});
 const issue={ref:'m',type:'证据不符',sourceRefs:['m'],problem:'新问题'};
 const basis=(field,id)=>({kind:'source',refs:[{ref:'m',field,id}]});
 const receipt={phase:'impact',candidateHash:payload.candidateHash,checkedRefs:scope.targetRefs,checkedEdges:scope.edges,sourceRequests:[],issues:[{...issue,basis:basis('tasks[0].quality')}],
  issueResults:[{id:'old',status:'resolved',reason:'原文已核',basis:basis('evidence','E999')}]};
 assert.equal(payload.priorIssues[0].requiredBasis,'source');
 const valid=validateReviewImpact(receipt,payload,Object.keys(sources));
 assert.equal(valid.issues.length,1);
 assert.equal(valid.issueResults[0].status,'open');
 assert.equal(receipt.issueResults[0].status,'resolved');
 for(const invalid of [basis('tasks[1].quality'),basis('evidence','E999'),{kind:'source',refs:[{ref:'a',field:'commitment'}]}]){
  const result=validateReviewImpact({...receipt,issues:[{...issue,basis:invalid}]},payload,Object.keys(sources));
  assert.equal(result.issues.length,0);
  assert.equal(result.basisPending.length,2);
 }
 assert.throws(()=>validateReviewImpact({...receipt,checkedRefs:[]},payload,Object.keys(sources)),/checkedRefs/);
});
