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
