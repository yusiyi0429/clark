import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packSourceText,restoreSourceText,buildReviewCheckPlan,refreshReviewCheckPlan,verifyReviewCheckPlan,validateScopedCheckResult,planSourceFollowups,executeReviewCheckPlan,reviewModelRequestBody} from './review-source-plan.mjs';
const data=()=>{
 const input={stages:[['a','b','c'].map(id=>({id,unit:id,level:'mission',parent:'p'})),[{id:'p',unit:'p',level:'ru',children:['a','b','c']}],[]]};
 const text='月初起点不算本月结果，完整保留日期、否定及旧E1命名空间。'.repeat(80);
 const sources=Object.fromEntries(input.stages.flat().map(c=>[c.id,{id:c.id,version:2,evidence:[{id:'E1',namespace:c.id,kind:'月初起点',text},{id:'E2',namespace:c.id,text}]}]));
 return {input,sources,reviews:Object.fromEntries(Object.keys(sources).map(ref=>[ref,{ref,verdict:'部分达成'}])),programFacts:{perReview:{},verdictFacts:[],askLoad:[]},tasks:['JSON组1','JSON组2','JSON组3'],system:'完整规则JSON',maxTargetRefs:1};
};
const ok=p=>({issues:[],checkedRefs:p.scope.targetRefs,checkedEdges:p.scope.edges,sourceRequests:[]});
test('text sharing is lossless and never merges distinct evidence identities or namespaces',()=>{
 const a=data(),packet=packSourceText(a.sources);assert.deepEqual(restoreSourceText(packet),a.sources);assert.ok(Object.keys(packet.texts).length);assert.equal(packet.sources.a.evidence[0].namespace,'a');assert.equal(packet.sources.b.evidence[0].namespace,'b');packet.texts[Object.keys(packet.texts)[0]]+='伪造';assert.throws(()=>restoreSourceText(packet));
});
test('three groups cover every target and edge with full original source and bounded actual model bodies',()=>{
 for(const model of ['wangsu/claude-sonnet-5-5','aliyun/deepseek-v4.1-flash','wangsu/gpt-6.1-sol']){
 const a={...data(),wireOptions:{model}},p=buildReviewCheckPlan(a);assert.equal(p.maxConcurrency,3);assert.equal(p.requestCount,p.packets.length*3);
 assert.deepEqual(new Set(p.packets.flatMap(x=>x.scope.targetRefs)),new Set(p.sourceRefs));
 assert.deepEqual(new Set(p.packets.flatMap(x=>x.scope.edges.map(e=>JSON.stringify(e)))),new Set(p.edges.map(e=>JSON.stringify(e))));
 for(const packet of p.packets){assert.deepEqual(restoreSourceText({sources:packet.payloads[0].sources,texts:packet.payloads[0].sourceTexts,bindings:packet.payloads[0].sourceBindings,originalHash:packet.originalHash}),Object.fromEntries(packet.scope.sourceRefs.map(ref=>[ref,a.sources[ref]])));for(const payload of packet.payloads)assert.ok(Buffer.byteLength(JSON.stringify(reviewModelRequestBody(a.system,payload,a.wireOptions)))<=p.maxBodyBytes);}
 }
});
test('oversize, altered source, payload and model fail before calling a model',()=>{
 const a=data(),p=buildReviewCheckPlan(a);assert.throws(()=>buildReviewCheckPlan({...a,maxBodyBytes:100}),e=>e.code==='REVIEW_PACKET_OVERSIZE');
 assert.throws(()=>refreshReviewCheckPlan(p,{...a,wireOptions:{model:'aliyun/deepseek-v4.1-flash'}}));const bad=structuredClone(p);bad.packets[0].payloads[0].sources.a.version=999;assert.throws(()=>verifyReviewCheckPlan(bad,a));
 const r=structuredClone(a.reviews);r.a.verdict='达成';const refreshed=refreshReviewCheckPlan(p,{...a,reviews:r});assert.deepEqual(refreshed.layout,p.layout);assert.notEqual(refreshed.stamp,p.stamp);
});
test('missing context is explicit, coalesced per group, bounded, and cannot pass or repeat provided sources',async()=>{
 const a=data(),p=buildReviewCheckPlan(a),packet=p.packets.find(x=>x.scope.targetRefs.includes('a')),index=p.packets.indexOf(packet),value={...ok(packet),sourceRequests:[{refs:['a','b'],relation:'跨单元交付',reason:'需要核对同一交付'}]};
 assert.equal(validateScopedCheckResult(value,packet,p.sourceRefs).status,'needs-source-context');
 const responses=[{packetIndex:index,group:0,value},{packetIndex:index,group:0,value}],extra=planSourceFollowups({plan:p,args:a,responses,maxAdditionalRequests:1});assert.equal(extra.length,1);assert.equal(extra[0].payload.sourceRequestContext.requests[0].relation,'跨单元交付');assert.throws(()=>validateScopedCheckResult(ok(extra[0].packet),extra[0].packet,p.sourceRefs,extra[0].payload.sourceRequestContext),e=>e.code==='REVIEW_SOURCE_REQUEST_UNANSWERED');assert.ok(extra[0].packet.scope.sourceRefs.includes('b'));assert.ok(extra[0].packet.scope.edges.some(e=>e.childRef==='a'));
 assert.throws(()=>planSourceFollowups({plan:p,args:a,responses,maxAdditionalRequests:0}),e=>e.code==='REVIEW_SOURCE_REQUEST_BUDGET');assert.throws(()=>planSourceFollowups({plan:p,args:a,responses,maxAdditionalRequests:1,providedKeys:[extra[0].key]}),e=>e.code==='REVIEW_SOURCE_REQUEST_REPEAT');
 assert.throws(()=>validateScopedCheckResult({...value,sourceRequests:[{refs:['a','unknown'],relation:'x',reason:'x'}]},packet,p.sourceRefs));assert.throws(()=>validateScopedCheckResult({...ok(packet),checkedRefs:[]},packet,p.sourceRefs));
 let active=0,max=0;
 const pending=await executeReviewCheckPlan({plan:p,args:a,runPacket:async r=>r.index===index&&r.group===0?value:ok(r.packet)});assert.equal(pending.status,'needs-source-context');
 const complete=await executeReviewCheckPlan({plan:p,args:a,maxAdditionalRequests:1,runPacket:async r=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return r.index===index&&r.group===0?value:{...ok(r.packet),sourceRequestAnswers:r.payload.sourceRequestContext?.requests.map(x=>({requestId:x.requestId,conclusion:'两端原文已核对，关系结论以冻结原文为准'}))};}});assert.equal(complete.status,'checked');assert.equal(complete.requestCount,p.requestCount+1);assert.ok(max<=3);
});

test('extra checked parents are accepted only with complete supplied source and issue scope; every target is still required',()=>{
 const a=data(),plan=buildReviewCheckPlan(a),packet=plan.packets.find(p=>p.scope.targetRefs.includes('a')),value={...ok(packet),checkedRefs:[...packet.scope.targetRefs,'p']};
 const accepted=validateScopedCheckResult(value,packet,plan.sourceRefs);assert.deepEqual(accepted.checkedRefs,value.checkedRefs);assert.equal(accepted.status,'checked');
 assert.throws(()=>validateScopedCheckResult({...value,checkedRefs:['p']},packet,plan.sourceRefs),/覆盖未完成/);
 assert.throws(()=>validateScopedCheckResult({...value,checkedRefs:[...value.checkedRefs,'b']},packet,plan.sourceRefs),/覆盖对象不正确/);
 assert.throws(()=>validateScopedCheckResult(value,{...packet,scope:{...packet.scope,allowedIssueRefs:packet.scope.allowedIssueRefs.filter(ref=>ref!=='p')}},plan.sourceRefs),/覆盖对象不正确/);
 assert.throws(()=>validateScopedCheckResult(value,{...packet,scope:{...packet.scope,sourceRefs:packet.scope.sourceRefs.filter(ref=>ref!=='p')}},plan.sourceRefs),/覆盖对象不正确/);
 assert.throws(()=>validateScopedCheckResult({...value,checkedRefs:[...value.checkedRefs,'p']},packet,plan.sourceRefs),/覆盖对象不正确/);
});

test('edge strings decode only to unique declared scope edges without changing the original reply',()=>{
 const a=data(),plan=buildReviewCheckPlan(a),packet=plan.packets.find(p=>p.scope.targetRefs.includes('a')),value={...ok(packet),checkedEdges:packet.scope.edges.map(e=>e.parentRef+'->'+e.childRef)},before=JSON.stringify(value);
 const accepted=validateScopedCheckResult(value,packet,plan.sourceRefs);assert.deepEqual(accepted.checkedEdges,packet.scope.edges);assert.equal(JSON.stringify(value),before);
 const unicode={...value,checkedEdges:value.checkedEdges.map(edge=>edge.replace('->','→'))},unicodeBefore=JSON.stringify(unicode);assert.deepEqual(validateScopedCheckResult(unicode,packet,plan.sourceRefs).checkedEdges,packet.scope.edges);assert.equal(JSON.stringify(unicode),unicodeBefore);
 for(const checkedEdges of [['unknown->a'],['a->p'],['unknown→a'],['a→p'],[...value.checkedEdges,...unicode.checkedEdges],[]])assert.throws(()=>validateScopedCheckResult({...value,checkedEdges},packet,plan.sourceRefs));
 assert.throws(()=>validateScopedCheckResult(value,{...packet,scope:{...packet.scope,edges:[...packet.scope.edges,...packet.scope.edges]}},plan.sourceRefs),/唯一/);
 assert.throws(()=>validateScopedCheckResult({...value,issues:[{ref:'b',type:'事实',problem:'越界',impact:'不能以未给来源判断',mustFix:true,fixable:true}]},packet,plan.sourceRefs),/来源范围/);
});

test('GPT budget body matches the actual gateway byte for byte, without an extra stream field',async()=>{
 const {createModelGateway}=await import('./model.mjs');const system='仅返回JSON',payload={scope:'完整冻结数据'},options={model:'wangsu/gpt-6.1-sol',json:true,thinking:true,reasoningEffort:'high',maxTokens:32000};let wire;
 const gateway=await createModelGateway({env:{DECODING_MODEL:options.model,DECODING_API_KEY:'fixture'},transport:async(_url,init)=>{wire=init.body;return new Response(JSON.stringify({id:'mock-gpt',model:'gpt-provider-canonical',choices:[{message:{content:'{}'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});}});
 const result=await gateway.complete([{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}],options);
 assert.equal(result.requestedAlias,options.model);assert.equal(result.returnedModel,'gpt-provider-canonical');
 assert.equal(JSON.stringify(reviewModelRequestBody(system,payload,options)),wire);const body=JSON.parse(wire);assert.equal(body.stream,undefined);assert.equal(body.max_tokens,undefined);assert.equal(body.max_completion_tokens,32000);assert.equal(body.reasoning_effort,'high');
 const gpt=buildReviewCheckPlan({...data(),wireOptions:{model:options.model}}),claude=buildReviewCheckPlan({...data(),wireOptions:{model:'wangsu/claude-sonnet-5-5'}});assert.notEqual(gpt.stamp,claude.stamp);assert.throws(()=>refreshReviewCheckPlan(claude,{...data(),wireOptions:{model:options.model}}));
});

test('a fully supplied allowed endpoint may request missing context only for its direct target edge',()=>{
 const a=data(),plan=buildReviewCheckPlan(a),packet=plan.packets.find(p=>p.scope.targetRefs.includes('a')),value={...ok(packet),sourceRequests:[{refs:['p','b'],relation:'核对本包a依赖的父级输入范围',reason:'b原文未给，不能拿其候选作证据'}]};
 assert.equal(validateScopedCheckResult(value,packet,plan.sourceRefs).status,'needs-source-context');
 const noEdge={...packet,scope:{...packet.scope,edges:[]}};assert.throws(()=>validateScopedCheckResult({...value,checkedEdges:[]},noEdge,plan.sourceRefs),e=>e.code==='REVIEW_SOURCE_REQUEST_CONTRACT');
 for(const refs of [['c','b'],['p','unknown'],['p','a']])assert.throws(()=>validateScopedCheckResult({...value,sourceRequests:[{...value.sourceRequests[0],refs}]},packet,plan.sourceRefs),e=>e.code==='REVIEW_SOURCE_REQUEST_CONTRACT');
 for(const field of ['sourceRefs','allowedIssueRefs'])assert.throws(()=>validateScopedCheckResult(value,{...packet,scope:{...packet.scope,[field]:packet.scope[field].filter(ref=>ref!=='p')}},plan.sourceRefs),e=>e.code==='REVIEW_SOURCE_REQUEST_CONTRACT');
});
