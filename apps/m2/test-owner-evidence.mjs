import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicEvidence,validateNexusResult,ownerReviewCorrection} from './nexus-policy.mjs';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
import {queueProposals} from './nexus-memory.mjs';
import {loadReviewRules,reviewPatchProblem} from './nexus-review.mjs';
import {loadReviewSkill} from './review-generation.mjs';

test('负责人补证保留原消息身份、陈述时间和来源，不能混入其他房间或私人 Agent 消息',()=>{
 const scope='person:member-03',message={id:'owner-source',author:'孙铭泽',channel:'group',scope,createdAt:'2026-11-02T10:00:00+08:00',text:'10/27 正式上线并访问成功',context:{selection:{id:'rv:eo-m1',version:1},block:'verdict'}};
 const result=publicEvidence([message,{...message,id:'other',scope:'person:member-04'},{...message,id:'agent',channel:'private',author:'Agent'}],scope);
 assert.equal(result.length,1);assert.equal(result[0].id,message.id);assert.equal(result[0].author,message.author);assert.equal(result[0].createdAt,message.createdAt);assert.equal(result[0].text,message.text);assert.deepEqual(result[0].context.selection,message.context.selection);
 assert.equal(publicEvidence([{...message,createdAt:undefined}],scope)[0].createdAt,undefined,'没有时间就保持缺失，不编造');
});

test('采信负责人证据的候选仍等本人接受；接受后保留来源、旧版和既有确认权',()=>{
 let s=installReviewRound(createCollaborationState([{id:'eo',unit:'eo',level:'po',title:'E&O',owner:'刘人豪',version:1,children:[]}]),{period:'2026-10',reviews:[{ref:'eo-m1',unit:'eo',level:'mission',owner:'孙铭泽',title:'接口上线',verdict:'未达成',verdictReason:'缺正式上线记录',facts:[{ref:'t1',item:'正式上线',owner:'孙铭泽',status:'未达成',evidence:'未见完成证据',gap:'缺上线记录'}],nextInputs:[{ref:'t1',type:'继续',text:'完成上线'}]}]});
 const actor=memberActor('member-03',s),id='rv:eo-m1';
 s=applyAction(s,actor,{type:'message',cardId:id,text:'10/27 我已正式上线且业务方访问成功，请修正。'});
 const source=s.messages.at(-1),sourceId=source.id,old=structuredClone(currentVersion(s.cards[id]));
 const patch={verdict:'达成',verdictReason:'负责人报告已正式上线且业务方访问成功',facts:[{ref:'t1',item:'正式上线',owner:'孙铭泽',status:'达成',evidence:'负责人报告：10/27 已正式上线，业务方访问成功',gap:''}],nextInputs:[]};
 queueProposals(s,'person:member-03',[{cardId:id,baseVersion:1,sourceIds:[sourceId],reason:'负责人补充了本期具体上线事实',patch}]);
 assert.equal(s.proposals.at(-1).status,'pending');assert.deepEqual(currentVersion(s.cards[id]),old);
 s=applyAction(s,actor,{type:'acceptProposal',cardId:id,proposalId:s.proposals.at(-1).id});
 assert.deepEqual(s.cards[id].versions[0],old);assert.equal(currentVersion(s.cards[id]).content.verdict,'达成');assert.deepEqual(currentVersion(s.cards[id]).evidenceIds,[sourceId]);assert.deepEqual(currentVersion(s.cards[id]).signatures,[]);
 const projection=sharedProjection(s,actor),record=projection.records['group:person:member-03'].find(m=>m.id===sourceId);
 assert.equal(record.author,'孙铭泽');assert.equal(record.createdAt,source.createdAt);
 for(const verdict of ['待核实','尚不能确认'])assert.match(reviewPatchProblem(currentVersion(s.cards[id]).content,{verdict}),/判定只能/);
});

test('生成和协作读取同一产品复盘版本，原字段检查分组保持兼容',async()=>{
 const root=new URL('./review-skill/',import.meta.url),generation=await loadReviewSkill(root),chat=await loadReviewRules(root);
 assert.equal(generation.version,'2.1.15');assert.equal(chat.version,generation.version);assert.match(chat.rules,/--- references\/contracts.md ---/);
 assert.equal(generation.groups.length,3);assert.ok(generation.mustFix.includes('判定偏严'));assert.ok(generation.mustFix.includes('证据不符'));
});

test('负责人反对原判定并要求按事实修正，可以出候选；反对修订卡或他人反对仍拦截',()=>{
 const card={id:'rv:eo-m1',kind:'review',level:'mission',owner:'孙铭泽',version:1,status:'待确认',verdict:'未达成',facts:[],nextInputs:[]};
 const source={id:'owner-source',author:'孙铭泽',scope:'person:member-03',kind:'chat',text:'我不同意这个判定，10/27 已上线且业务方访问成功，请按事实修正。',context:{selection:{id:card.id,version:1},block:'verdict'}};
 const proposal={cardId:card.id,baseVersion:1,sourceIds:[source.id],basis:'request',patch:{verdict:'达成',verdictReason:'负责人报告上线并访问成功'}};
 const check=ev=>validateNexusResult({topics:[],proposals:[proposal]},{cards:[card],evidence:ev,fresh:ev});
 assert.equal(ownerReviewCorrection(source,card),true);assert.equal(check([source]).proposals.length,1);
 for(const text of ['我不同意这张修订卡，请不要这样改。','我不同意这个判定，但不需要改。','我不同意这个判定，别出修订卡。']){
  const against={...source,text};assert.equal(ownerReviewCorrection(against,card),false);assert.equal(check([against]).proposals.length,0);
 }
 assert.equal(ownerReviewCorrection({...source,author:'白田田'},card),false);
 assert.equal(ownerReviewCorrection({...source,context:{selection:{id:'rv:eo-m2',version:1}}},card),false);
 assert.equal(check([source,{...source,id:'other-objector',author:'白田田',text:'我不同意按这个改。'}]).proposals.length,0);
});
