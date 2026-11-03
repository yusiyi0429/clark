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
