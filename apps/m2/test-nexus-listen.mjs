import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseListen,applyListen,listenInput} from './nexus-listen.mjs';
import {focusCardIds,actContext} from './nexus-context.mjs';
const topics=[{id:'t1',title:'时间上没有容错',status:'discussing',stage:'讨论',sourceIds:['c1','m1'],quotes:[{id:'c1',text:'时间上没有容错啊？需要留出 buffer'},{id:'m1',text:'至少 3 天吧？'}]}];
test('先听：随口一句接着原话题；新问题开新话题；只表态不开话题；被点名一定出场',()=>{
 const fresh=[{id:'m2',author:'孙铭泽',text:'那入口提前到 10/26'},{id:'c2',author:'刘明华',text:'可决策是什么意思',context:{selection:{id:'bf01'},block:'result'}},{id:'m3',author:'陈溪南',text:'收到'}];
 const d=parseListen({events:[{id:'m2',topicId:'t1',intent:'proposal'},{id:'c2',topicId:'new',newTitle:'说清“可决策”',intent:'question'},{id:'m3',topicId:'new',intent:'ack'}],stages:{t1:'有方案','new:说清“可决策”':'提出'},act:'none'},{fresh,topics});
 assert.equal(d.act,'now','孙铭泽给了具体改法，话题到了有方案，Nexus 该出卡');
 const out=applyListen(topics,d,fresh);
 assert.deepEqual(out.map(t=>[t.title,t.stage,t.sourceIds.length]),[['时间上没有容错','有方案',3],['说清“可决策”','提出',1]]);
 assert.equal(parseListen({events:[],act:'none'},{fresh:[{id:'q',text:'@Nexus 进度怎样'}],topics}).act,'now');
 assert.equal(parseListen({events:[],act:'none'},{fresh:[{id:'a',text:'至少 3 天',answersNexus:true}],topics}).act,'now');
 assert.equal(parseListen({events:[{id:'zz',topicId:'t9'}]},{fresh,topics}).events.length,0,'不认识的消息不收');
});
test('先听的输入只带新消息指向的位置、进行中的话题和 Nexus 上一句',()=>{
 const cards=[{id:'bf01',level:'po',title:'灯塔',aliases:[],result:'王总可决策'}];
 const input=listenInput({scope:'bf01',fresh:[{id:'c2',author:'刘明华',text:'啥意思',context:{selection:{id:'bf01'},block:'result'}}],evidence:[],topics,cards,nexusLast:{text:'刘明华，留多少缓冲？',createdAt:'x'}});
 assert.deepEqual(input.fresh[0].anchor,{card:'po 灯塔',field:'result',content:'王总可决策'});
 assert.equal(input.openTopics[0].id,'t1');assert.equal(input.nexusLast.text,'刘明华，留多少缓冲？');
});
test('出场时的上下文：被批注的卡、被回复那条背后的卡、点名的卡；都没有就给 PO',()=>{
 const cards=[{id:'bf01',level:'po',title:'灯塔试点',aliases:[]},{id:'bf01-m1',level:'mission',title:'经营问题可决策',aliases:['M01','Mission 01']},{id:'bf01-m2',level:'mission',title:'正式入口',aliases:['M02','Mission 02']}];
 const evidence=[{id:'c1',text:'这里不清楚',context:{selection:{id:'bf01-m1'},block:'result'}},{id:'r1',text:'同意',replyTo:'c1'},{id:'g1',text:'Mission 02 要提前'}];
 assert.deepEqual(focusCardIds(cards,[evidence[1]],evidence),['bf01-m1']);
 assert.deepEqual(focusCardIds(cards,[evidence[2]],evidence),['bf01-m2']);
 const ctx=actContext({cards,evidence,fresh:[{id:'x',text:'大家辛苦'}],topics:[],capacity:{days:16}});
 assert.deepEqual(ctx.focusCardIds,['bf01']);assert.equal(ctx.capacity.days,16);assert.equal(ctx.facts,undefined);
 assert.equal(ctx.focus.cards[0].siblings.length,0);
});
import {settles} from './nexus-listen.mjs';
test('有方案就出场：“就按这三份写”“我来改”或话题到了有方案',()=>{
 assert.equal(settles('就按这三份现有案例写。每份交什么、怎么算过，放进method'),true);
 assert.equal(settles('我来改method：月底交三份现有案例'),true);
 assert.equal(settles('那月底我具体看什么？举个例子'),false);
 const fresh=[{id:'m4',text:'就按这三份现有案例写'}];
 assert.equal(parseListen({events:[],act:'none'},{fresh,topics:[]}).act,'now');
 assert.equal(parseListen({events:[],stages:{t1:'有方案'},act:'none'},{fresh:[{id:'x',text:'嗯'}],topics:[{id:'t1'}]}).act,'now');
 assert.equal(parseListen({events:[],stages:{t1:'讨论'},act:'none'},{fresh:[{id:'x',text:'嗯'}],topics:[{id:'t1'}]}).act,'none');
});
