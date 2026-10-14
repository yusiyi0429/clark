import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,createCollaborationState} from './governance.mjs';
import {sharedProjection} from './shared-projection.mjs';
import {publicEvidence,validateNexusResult} from './nexus-policy.mjs';
import {mergeTopics} from './nexus-memory.mjs';
import {materializeTopics} from './topic-lifecycle.mjs';
const actor={id:'member-01',ceo:true};
const initial=()=>createCollaborationState([{id:'bf01',level:'po',title:'客户试用',children:[]}]);
test('群聊观点立即待讨论，引用回应立即正在讨论，只有模型校验可升级已共识',()=>{
 let s=applyAction(initial(),actor,{type:'message',cardId:'bf01',text:'客户试用先做一轮'});
 assert.equal(s.nexus.bf01.topics[0].status,'pending');
 s=applyAction(s,{id:'member-02',ceo:true},{type:'message',cardId:'bf01',replyTo:s.messages[0].id,text:'同意先做一轮'});
 assert.equal(s.nexus.bf01.topics.length,1);assert.equal(s.nexus.bf01.topics[0].status,'discussing');
 const evidence=publicEvidence(s.messages,'bf01');
 const value={topics:[{title:'先做一轮客户试用',status:'agreement',conclusion:'先做一轮',sourceIds:evidence.map(e=>e.id),quotes:evidence.map(e=>({id:e.id,text:e.text}))}],proposals:[]};
 const checked=validateNexusResult(value,{cards:[{id:'bf01',version:1}],evidence});
 s.nexus.bf01.topics=mergeTopics(s.nexus.bf01.topics,checked.topics);
 assert.equal(s.nexus.bf01.topics.length,1);assert.equal(s.nexus.bf01.topics[0].status,'agreement');
 assert.equal(sharedProjection(s,actor).nexus.bf01.topics[0].status,'agreement');
 s=applyAction(s,actor,{type:'message',cardId:'bf01',replyTo:s.messages[0].id,text:'不同意，还缺客户反馈'});
 assert.equal(s.nexus.bf01.topics[0].status,'discussing');assert.equal(s.nexus.bf01.topics[0].conclusion,'');
});
test('批注和群回复共用话题，批注回复也支持，其他字段独立',()=>{
 let s=applyAction(initial(),actor,{type:'comment',cardId:'bf01',block:'result',text:'成果应该写清楚客户使用记录'});
 const id=s.comments[0].id;assert.equal(s.nexus.bf01.topics[0].status,'pending');
 s=applyAction(s,{id:'member-02',ceo:true},{type:'message',cardId:'bf01',replyTo:id,text:'记录应该包括使用日期'});
 assert.equal(s.nexus.bf01.topics.length,1);assert.equal(s.nexus.bf01.topics[0].status,'discussing');
 s=applyAction(s,actor,{type:'comment',cardId:'bf01',replyTo:id,block:'result',text:'同意增加日期'});
 assert.equal(s.nexus.bf01.topics.length,1);
 s=applyAction(s,actor,{type:'comment',cardId:'bf01',block:'time',text:'请核对时间窗口'});
 assert.equal(s.nexus.bf01.topics.length,2);assert.equal(s.nexus.bf01.topics[1].status,'pending');
});
test('旧公开意见无需改写状态即可显示，私聊和机器发言不会生成议题',()=>{
 const s=initial();s.comments.push({id:'old',channel:'group',author:'member-01',scope:'bf01',cardId:'bf01',version:1,block:'result',text:'请补验收记录',createdAt:'2026-10-12'});
 s.messages.push({id:'private',channel:'private',memberId:'member-01',author:'member-01',text:'秘密',createdAt:'2026-10-12'},{id:'bot',channel:'group',scope:'bf01',author:'Nexus',text:'分析',createdAt:'2026-10-12'});
 const before=JSON.stringify(s),p=sharedProjection(s,actor);assert.equal(p.nexus.bf01.topics.length,1);assert.equal(p.nexus.bf01.topics[0].status,'pending');assert.equal(JSON.stringify(s),before);
});
test('模型总结替换种子不重复，未总结的话题不丢，旧已处理来源不会重开共识',()=>{
 const records=[{id:'a',channel:'group',author:'甲',text:'意见一'},{id:'b',channel:'group',author:'乙',text:'意见二'}];
 const seeded=materializeTopics([],records);
 const merged=mergeTopics(seeded,[{title:'合并总结',status:'agreement',sourceIds:['b'],quotes:[{id:'b',text:'意见二'}],anchor:seeded[0].anchor}]);
 assert.equal(merged.length,1);assert.equal(materializeTopics(merged,records).length,1);assert.equal(materializeTopics(merged,records)[0].status,'agreement');
 assert.equal(mergeTopics(seeded,[{title:'仅总结一个',status:'pending',sourceIds:['a'],quotes:[],anchor:seeded[0].anchor}]).length,2);
});
