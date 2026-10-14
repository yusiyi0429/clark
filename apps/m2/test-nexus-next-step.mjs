import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateNexusResult} from './nexus-policy.mjs';
import {mergeTopics} from './nexus-memory.mjs';
import {discussionMinutes,waitingSentence} from './discussion-minutes.mjs';
const cards=[{id:'c',version:2,title:'联调验证',owner:'孙铭泽'}];
const evidence=[{id:'e',author:'孙铭泽',text:'联调验证还缺客户窗口，孙铭泽等客户回复后再核对。',context:{selection:{id:'c',version:2},block:'dependencies'}}];
const waiting={cardId:'c',baseVersion:2,recipient:'孙铭泽',missing:'客户窗口',recheckWhen:'客户回复后再核对'};
const value={topics:[{title:'客户窗口',status:'pending',sourceIds:['e'],quotes:[{id:'e',text:evidence[0].text}],waiting}],proposals:[],reply:'很长的分析'.repeat(100),interventionNeeded:true,interventionType:'risk',interventionReason:'窗口影响联调',interventionKey:'客户窗口',interventionSourceIds:['e'],interventionCardId:'c',interventionVersion:2,interventionRecipient:'孙铭泽',interventionImpact:'客户窗口未明确，联调时间不能核实',interventionQuestion:'客户窗口什么时候能确认？'};
test('等待条件有来源，持久保存；不编造日期、负责人或旧版本',()=>{
 const result=validateNexusResult(value,{cards,evidence});
 assert.deepEqual(result.topics[0].waiting,waiting);
 assert.deepEqual(mergeTopics(result.topics,[])[0].waiting,waiting);
 for(const patch of [{recheckWhen:'10月15日'},{recipient:'陌生人'},{baseVersion:1}]){
  const changed={...value,topics:[{...value.topics[0],waiting:{...waiting,...patch}}]};
  assert.equal(validateNexusResult(changed,{cards,evidence}).topics[0].waiting,null);
 }
 const topic=mergeTopics([],result.topics)[0];
 const buckets=discussionMinutes([topic],evidence.map(e=>({...e,channel:'group'})),{c:{...cards[0],version:3}});
 assert.equal(buckets.discussing[0].stale,true);
 assert.match(waitingSentence(buckets.discussing[0]),/重新核对/);
 assert.equal(mergeTopics([topic],[{...result.topics[0],status:'agreement',waiting:null}])[0].waiting,null);
});
test('主动提醒绑定当前成果版本、影响和一个回答者；不发送长分析',()=>{
 const result=validateNexusResult(value,{cards,evidence});
 assert.match(result.reply,/孙铭泽/);assert.ok(result.reply.length<=180);assert.ok(!result.reply.includes('很长'));
 for(const patch of [{interventionVersion:1},{interventionCardId:'wrong'},{interventionRecipient:'陌生人'},{interventionImpact:''},{interventionSourceIds:['private']}])assert.equal(validateNexusResult({...value,...patch},{cards,evidence}).reply,'');
});
test('同一问题同一证据不重复；新事实或新版本允许核对；明确呼叫可回答',()=>{
 const first=validateNexusResult(value,{cards,evidence});
 const interventionHistory=[{signature:first.participation.signature}];
 const repeated=evidence.map(e=>({...e,id:'new'}));
 assert.equal(validateNexusResult({...value,interventionSourceIds:['new']},{cards,evidence:repeated,interventionHistory}).reply,'');
 assert.equal(validateNexusResult({...value,interventionKey:'改名绕过'},{cards,evidence,interventionHistory}).reply,'');
 const old={...evidence[0],id:'old',context:{selection:{id:'c',version:1},block:'dependencies'}};
 const child={id:'child',author:'孙铭泽',text:'有风险',replyTo:'old'};
 assert.equal(validateNexusResult({...value,interventionSourceIds:['child']},{cards,evidence:[old,child],fresh:[child]}).reply,'');
 assert.ok(validateNexusResult(value,{cards,evidence:evidence.map(e=>({...e,text:e.text+'客户说窗口推迟。'})),interventionHistory}).reply);
 assert.ok(validateNexusResult({...value,interventionVersion:3},{cards:cards.map(c=>({...c,version:3})),evidence:evidence.map(e=>({...e,context:{...e.context,selection:{id:'c',version:3}}})),interventionHistory}).reply);
 assert.ok(validateNexusResult({...value,reply:'请孙铭泽回答客户窗口。'},{cards,evidence,interventionHistory,manual:true}).reply);
});
