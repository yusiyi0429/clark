import {test} from 'node:test';import assert from 'node:assert/strict';
import {captureConfirmedFacts,addConfirmedFacts,evidenceHash,verifyEvidenceBundle} from './confirmed-review-evidence.mjs';
const job='94651523-eab0-476a-a9fd-b36d33e840aa',objectId='ontology-mission',ref='ontology-mission#execution_plan/t01';
function fixture(){
 const fact={ref,item:'上线访问',owner:'孙铭泽',status:'达成',evidence:'负责人报告：10/27 上线且业务方访问成功 [E5][event-855]',gap:'仅本人报告，未独立核验'},content={objectId,owner:'孙铭泽',ownerAssigned:true,facts:[fact],verdict:'达成',verdictReason:'旧判定不得继承'},signature={slot:'missionDri',actorId:'member-03',version:2,createdAt:'2026-11-01T01:00:00Z'};
 const card={id:'rv:eo-m1',kind:'review',level:'mission',unit:'eo',confirmedVersion:2,versions:[{number:1,content:{...structuredClone(content),facts:[{...fact,evidence:'原缺证据'}]},author:'Review',createdAt:'2026-10-29T01:00:00Z',signatures:[]},{number:2,content,author:'member-03',createdAt:'2026-10-30T01:00:00Z',evidenceIds:['event-855'],signatures:[signature]}]};
 const state={cards:{[card.id]:card},reviewRound:{period:'2026-10',source:'生成任务 '+job,loadedAt:'2026-10-29T01:00:00Z'},messages:[{id:'event-855',author:'member-03',channel:'group',scope:'person:member-03',cardId:'rv:eo-m1',createdAt:'2026-10-30T01:00:00Z',text:'PRIVATE-RAW-TEXT-IS-NOT-INPUT'},{id:'private',author:'member-03',channel:'private',scope:'person:member-03',text:'SECRET-AGENT'}],comments:[],insights:{secret:'HIDDEN-INSIGHT'}};
 const stage={id:'eo-m1',objectId,period:'2026-10',owner:'孙铭泽',commitment:'既定上线及访问承诺',tasks:[{ref,title:'上线访问',expected:'正式环境可访问',quality:'业务方可访问',owner:'孙铭泽'}],evidence:[{id:'E1',kind:'本月进展',text:'本体旧记录仍说缺证据'}]};
 const input={period:'2026-10',stages:[[stage],[],[]]},sourceInputs={[job]:{period:'2026-10',stages:[[ {...structuredClone(stage),evidence:[{id:'E5',source:'旧本体10/12记录',text:'旧E5原文'}]}],[],[]]}};
 return {state,input,sourceInputs,card,fact};
}
test('same-object confirmed source carries exact facts and namespace, never verdict/status/signatures/private text',()=>{
 const {state,input,sourceInputs,fact}=fixture(),before=JSON.stringify({state,input,sourceInputs}),bundle=captureConfirmedFacts(state,{period:'2026-10'}),result=addConfirmedFacts(input,bundle,sourceInputs),added=result.stages[0][0].evidence[1];
 assert.equal(added.text,fact.evidence);assert.equal(added.reportedGap,fact.gap);assert.equal(added.id,'E2');assert.ok(added.source.includes(bundle.entries[0].namespace));assert.equal(added.m2Source.legacyEvidence[0].id,'E5');assert.equal(added.m2Source.legacyEvidence[0].source.text,'旧E5原文');assert.equal(added.m2Source.independentVerification,false);assert.deepEqual(result.stages[0][0].evidence[0],input.stages[0][0].evidence[0]);
 const raw=JSON.stringify(bundle);for(const text of ['PRIVATE-RAW-TEXT','SECRET-AGENT','HIDDEN-INSIGHT','旧判定不得继承','"status"','"signatures"'])assert.ok(!raw.includes(text),text);assert.equal(JSON.stringify({state,input,sourceInputs}),before);
});
test('manual edit without event ids retains author/version/confirmation provenance; unassigned is never formalized',()=>{
 const x=fixture();x.card.versions[1].content.ownerAssigned=false;x.card.versions[1].evidenceIds=[];x.card.versions[1].content.facts[0].evidence='v0.9经本人确认符合现阶段要求，包含模拟场景，不等于实际发放激励';
 const bundle=captureConfirmedFacts(x.state,{period:'2026-10'}),result=addConfirmedFacts(x.input,bundle,x.sourceInputs),proof=result.stages[0][0].evidence[1].m2Source;
 assert.deepEqual(proof.sourceIds,[]);assert.equal(proof.revisionAuthorId,'member-03');assert.equal(proof.reviewVersion,2);assert.equal(proof.confirmedBy,'member-03');assert.equal(proof.worldAssignmentVerified,false);assert.equal(proof.sourceOwnerAssigned,false);assert.match(result.stages[0][0].evidence[1].text,/不等于实际发放激励/);
});
test('inherited fact uses the earlier revision source ids even after an unrelated later edit',()=>{
 const x=fixture(),v=structuredClone(x.card.versions[1]);v.number=3;v.createdAt='2026-10-31T01:00:00Z';v.evidenceIds=['event-921'];v.signatures[0].version=3;x.card.versions.push(v);x.card.confirmedVersion=3;const e=captureConfirmedFacts(x.state,{period:'2026-10'}).entries[0];assert.equal(e.revisionVersion,2);assert.deepEqual(e.sourceIds,['event-855']);
});
test('missing or noncurrent confirmation, wrong signer, wrong period, empty result-only text are excluded',()=>{
 for(const change of [x=>{x.card.confirmedVersion=null;},x=>{x.card.confirmedVersion=1;},x=>{x.card.versions[1].signatures=[];},x=>{x.card.versions[1].signatures[0].actorId='member-01';},x=>{x.state.reviewRound.period='2026-09';},x=>{x.card.versions[1].content.facts[0].evidence='达成';}]){const x=fixture();change(x);assert.equal(captureConfirmedFacts(x.state,{period:'2026-10'}).entries.length,0);}
});
test('different owner, period, commitment, Task identity/terms, duplicate refs or missing old job cannot be silently attached',()=>{
 for(const change of [x=>{x.input.stages[0][0].owner='刘明华';},x=>{x.input.stages[0][0].period='2026-11';},x=>{x.input.stages[0][0].commitment='全新目标';},x=>{x.input.stages[0][0].tasks[0].ref='replacement';},x=>{x.input.stages[0][0].tasks[0].quality='新的验收口径';},x=>{x.input.stages[0][0].tasks.push(structuredClone(x.input.stages[0][0].tasks[0]));},x=>{delete x.sourceInputs[job];}]){const x=fixture();change(x);const result=addConfirmedFacts(x.input,captureConfirmedFacts(x.state,{period:'2026-10'}),x.sourceInputs);assert.equal(result.m2ConfirmedEvidence.accepted.length,0);assert.ok(result.m2ConfirmedEvidence.excluded.length>0);assert.equal(result.stages[0][0].evidence.length,1);}
});
test('an archived same-period confirmed report survives a new unsigned generated draft; a new human pending revision blocks it',()=>{
 const x=fixture(),old=structuredClone(x.card);x.state.reviewArchives=[{round:structuredClone(x.state.reviewRound),cards:[old],messages:[]}];x.card.confirmedVersion=null;x.card.versions=[{...x.card.versions[0],createdAt:'2026-11-02T01:00:00Z'}];x.state.reviewRound={period:'2026-10',loadedAt:'2026-11-02T01:00:00Z',source:'生成任务 11111111-1111-4111-8111-111111111111'};
 assert.equal(captureConfirmedFacts(x.state,{period:'2026-10'}).entries.length,1);
 x.card.versions.push({...structuredClone(old.versions[1]),number:2,createdAt:'2026-11-02T02:00:00Z',signatures:[]});assert.equal(captureConfirmedFacts(x.state,{period:'2026-10'}).entries.length,0);
});
test('unknown legacy E id remains explicitly unresolved rather than binding to new E id, and frozen tampering is detected',()=>{
 const x=fixture();x.sourceInputs[job].stages[0][0].evidence=[];const bundle=captureConfirmedFacts(x.state,{period:'2026-10'}),result=addConfirmedFacts(x.input,bundle,x.sourceInputs);assert.equal(result.stages[0][0].evidence[1].m2Source.legacyEvidence[0].unresolved,true);bundle.entries[0].fact.evidence='篡改';assert.throws(()=>verifyEvidenceBundle(bundle),/冻结校验失败/);assert.notEqual(bundle.hash,evidenceHash(bundle));
});
test('frozen report is unchanged by later messages or edits, and cancelled cards never supply facts',()=>{
 const x=fixture(),bundle=captureConfirmedFacts(x.state,{period:'2026-10'}),original=JSON.stringify(bundle);x.card.versions[1].content.facts[0].evidence='后来修改';x.state.messages.push({id:'new',text:'之后的讨论'});assert.equal(JSON.stringify(bundle),original);verifyEvidenceBundle(bundle);
 x.card.cancelled=true;x.card.versions[1].content.cancelled=true;assert.equal(captureConfirmedFacts(x.state,{period:'2026-10'}).entries.length,0);
});
test('ambiguous old refs and missing ontology identity are reported instead of guessed',()=>{
 const x=fixture();x.card.versions[1].content.facts.push(structuredClone(x.fact));const duplicate=captureConfirmedFacts(x.state,{period:'2026-10'});assert.equal(duplicate.entries.length,0);assert.ok(duplicate.excluded.some(e=>e.reason.includes('ref重复')));
 delete x.card.versions[1].content.objectId;const missing=captureConfirmedFacts(x.state,{period:'2026-10'});assert.equal(missing.entries.length,0);assert.ok(missing.excluded.some(e=>e.reason.includes('objectId')));
});
test('original signed quotation stays frozen privately; recursive model view redacts new fact, gap and old reference text',()=>{
 const x=fixture(),secret='候选人期望年薪40万';x.card.versions[1].content.facts[0].evidence=secret+'，正式上线已有进展 [E5]';x.card.versions[1].content.facts[0].gap=secret+'，后续待核';x.sourceInputs[job].stages[0][0].evidence[0].text=secret+'。';const bundle=captureConfirmedFacts(x.state,{period:'2026-10'}),original=JSON.stringify(bundle),result=addConfirmedFacts(x.input,bundle,x.sourceInputs),evidence=result.stages[0][0].evidence[1];
 assert.ok(bundle.entries[0].fact.evidence.includes(secret));assert.equal(JSON.stringify(bundle),original);assert.ok(!JSON.stringify(evidence).includes(secret));assert.match(evidence.text,/正式上线已有进展/);assert.ok(Object.keys(evidence.redactions).length);assert.ok(Object.keys(result.redactions['eo-m1']).length);assert.ok(!JSON.stringify(evidence.m2Source).includes(secret));
});
test('later unsigned change to another row preserves only the unchanged historically confirmed row',()=>{
 const x=fixture(),original=structuredClone(x.card.versions[1]);original.content.facts.push({...structuredClone(x.fact),ref:'other',item:'另一事实',evidence:'另一条已确认报告'});x.card.versions[1]=original;
 const later=structuredClone(original);later.number=3;later.createdAt='2026-11-02T01:00:00Z';later.signatures=[];later.content.facts[1].evidence='未签的新改动';x.card.versions.push(later);
 const before=JSON.stringify(x.state),bundle=captureConfirmedFacts(x.state,{period:'2026-10'});assert.equal(bundle.entries.length,1);assert.equal(bundle.entries[0].fact.ref,ref);assert.equal(bundle.entries[0].reviewVersion,2);assert.equal(bundle.entries[0].latestReviewVersion,3);assert.equal(bundle.entries[0].historicalConfirmed,true);assert.equal(bundle.entries[0].confirmedAt,original.signatures[0].createdAt);assert.equal(JSON.stringify(x.state),before);assert.ok(bundle.excluded.some(e=>e.ref==='other'));
});
test('changing then restoring an unsigned row does not revive its former confirmation',()=>{
 const x=fixture(),v3=structuredClone(x.card.versions[1]);v3.number=3;v3.createdAt='2026-11-02T01:00:00Z';v3.signatures=[];v3.content.facts[0].evidence='后来撤回旧报告';const v4=structuredClone(x.card.versions[1]);v4.number=4;v4.createdAt='2026-11-02T02:00:00Z';v4.signatures=[];x.card.versions.push(v3,v4);const bundle=captureConfirmedFacts(x.state,{period:'2026-10'});assert.equal(bundle.entries.length,0);assert.ok(bundle.excluded.some(e=>e.reason.includes('撤回')));
});
test('reader projection bridge requires matching UUID/version, parent and exact frozen definition/plan',async()=>{
 const {taskSourceCompatibility}=await import('./confirmed-review-evidence.mjs'),task='e48814fd-1c4a-4481-a121-1772e20350fc',parent='9333f51a-ef2c-4a31-a624-e12246d47a5d',definition='【任务定义】\n- 成果：全部方式入会\n- time_boundary：计划完成日期：2026-10-25\n【Task 计划】\nTask 计划：暂无',title='T01 入会体验：全部方式入会';
 const old={ref:task,title,owner:'陈溪南',definition},current={ref:task,objectId:task,version:2,parentRef:parent,title:'T01 入会体验',planTitle:title,owner:'陈溪南',definition,expected:'全部方式入会',finish:'计划完成日期：2026-10-25',componentRef:parent+'@2#execution_plan/t01',commitmentRef:parent+'#execution_plan/t01',planSource:{title,sourceVersion:2,sourceRevision:'revision',componentRef:parent+'@2#execution_plan/t01',ref:parent+'#execution_plan/t01'}},card={objectId:parent,sourceBasis:{sourceVersion:2,sourceRevision:'revision'}},input={readReceipt:{objects:[task+'@2',parent+'@2']}};
 assert.equal(taskSourceCompatibility(old,current,{},card,input,input).mode,'same-object-reader-projection');
 for(const field of ['expected','finish','definition','planTitle'])assert.equal(taskSourceCompatibility(old,{...current,[field]:current[field]+'新增条件'}, {},card,input,input),null,field);
 assert.equal(taskSourceCompatibility(old,{...current,version:3},{},card,input,input),null);assert.equal(taskSourceCompatibility(old,current,{},card,{},input),null);
});
test('exact visible Task fields never override added definition conditions or an explicit version conflict',async()=>{
 const {taskSourceCompatibility}=await import('./confirmed-review-evidence.mjs'),id='e48814fd-1c4a-4481-a121-1772e20350fc',before={ref:id,title:'入会体验',owner:'陈溪南',expected:'全部方式入会',definition:'【任务定义】\n- 成果：全部方式入会'},input={readReceipt:{objects:[id+'@2']}},after={...before,objectId:id,version:2};
 assert.equal(taskSourceCompatibility(before,after,{},{},input,input).mode,'exact-fields');assert.equal(taskSourceCompatibility(before,{...after,definition:before.definition+'\n新增必要条件：腾讯会议'},{},{},input,input),null);assert.equal(taskSourceCompatibility(before,{...after,version:999},{},{},input,input),null);
});
