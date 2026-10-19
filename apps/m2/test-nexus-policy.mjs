import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicEvidence,validateNexusResult,candidateCards} from './nexus-policy.mjs';
import {applyNexusProposals} from './review-workflow.mjs';
const messages=[{id:'a',channel:'group',scope:'bf01',kind:'comment',author:'甲',text:'请修改成果为持续使用',context:{selection:{id:'bf01',version:1},block:'result'}},{id:'b',channel:'group',scope:'bf01',kind:'comment',author:'乙',text:'同意持续使用',context:{selection:{id:'bf01',version:1},block:'result'}},{id:'x',channel:'private',scope:'bf01',author:'私人',text:'secret'},{id:'y',channel:'group',scope:'eo',author:'其他',text:'other'},{id:'z',channel:'group',scope:'bf01',author:'Nexus',text:'自说自话'}];
const cards=[{id:'bf01',level:'po',version:1,title:'原成果'}],evidence=publicEvidence(messages,'bf01');
test('Nexus 排除私聊、其他领域和自身意见；客户端卡片只取允许字段',()=>{assert.deepEqual(evidence.map(x=>x.id),['a','b']);const projected=candidateCards(cards,[{id:'bf01',version:2,title:'候选',private:'secret',owner:'冒充',history:['secret']}],'bf01');assert.equal(projected[0].title,'候选');assert.equal(projected[0].owner,undefined);assert.ok(!JSON.stringify(projected).includes('secret'));});
test('单人意见不升级为共识；至少两人可追溯原文，仍不是确认',()=>{const topic={title:'持续使用',status:'agreement',conclusion:'采用持续使用',sourceIds:['a'],quotes:[{id:'a',text:'持续使用'}]};let r=validateNexusResult({topics:[topic],proposals:[],reply:'',interventionNeeded:false},{cards,evidence});assert.equal(r.topics[0].status,'discussing');r=validateNexusResult({topics:[{...topic,sourceIds:['a','b'],quotes:[...topic.quotes,{id:'b',text:'同意持续使用'}]}],proposals:[]},{cards,evidence});assert.equal(r.topics[0].status,'agreement');assert.equal(r.topics[0].confirmed,undefined);});
test('普通讨论保持静默；风险需定位成果、版本、影响和回答者；被点名可回答',()=>{
 const value={topics:[],proposals:[],reply:'建议核对客户窗口',interventionNeeded:false};
 assert.equal(validateNexusResult(value,{cards,evidence}).reply,'');
 const risk={...value,interventionNeeded:true,interventionType:'risk',interventionReason:'客户窗口影响部署',interventionSourceIds:['a']};
 assert.equal(validateNexusResult(risk,{cards,evidence}).reply,'');
 assert.ok(validateNexusResult({...risk,interventionCardId:'bf01',interventionVersion:1,interventionRecipient:'甲',interventionKey:'使用范围',interventionImpact:'成果修改会改变使用范围',interventionQuestion:'是否保留原来的使用范围？'},{cards,evidence}).reply);
 assert.ok(validateNexusResult(value,{cards,evidence:[{id:'a',author:'甲',text:'@Nexus 请核对'}]}).reply);
});
test('仅允许当前领域、当前版本、有依据的候选修订；禁止改负责人',()=>{const proposal={cardId:'bf01',baseVersion:1,basis:'request',sourceIds:['a'],patch:{title:'持续使用'}};const validate=p=>validateNexusResult({topics:[],proposals:[p]},{cards,evidence}).proposals;assert.equal(validate(proposal).length,1);assert.equal(validate({...proposal,cardId:'eo'}).length,0);assert.equal(validate({...proposal,baseVersion:2}).length,0);assert.equal(validate({...proposal,sourceIds:['x']}).length,0);assert.equal(validate({...proposal,patch:{owner:'乙'}}).length,0);assert.equal(validate({...proposal,basis:'agreement'}).length,1,'依据标签只是提示，真实修改请求照样出卡');assert.equal(validate({...proposal,sourceIds:['b']}).length,0,'只有一句同意、没有达成一致，不出卡');});
test('模型处理中人已修订，则跳过过期修订；保留历史证据',()=>{const p={cardId:'bf01',baseVersion:1,sourceIds:['a'],reason:'公开修订请求',patch:{title:'持续使用'}};assert.equal(applyNexusProposals(cards,{bf01:{version:2,title:'人类新稿'}},[p]).skipped.length,1);const r=applyNexusProposals(cards,{},[p]);assert.equal(r.drafts.bf01.version,2);assert.equal(r.drafts.bf01.status,'修订候选');assert.deepEqual(r.drafts.bf01.history[0].sourceIds,['a']);});
