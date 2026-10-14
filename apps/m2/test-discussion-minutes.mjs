import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discussionMinutes,minuteSentence} from './discussion-minutes.mjs';
test('纪要一条一句说明谁提出或讨论什么，不把问候编成观点',()=>{
 assert.equal(minuteSentence({status:'pending',title:'hi',evidence:[{author:'刘明华'}]}),'刘明华发言“hi”，尚未提出具体观点。');
 assert.equal(minuteSentence({status:'pending',title:'核对使用记录',evidence:[{author:'刘明华'}]}),'刘明华提出：核对使用记录。');
 assert.equal(minuteSentence({status:'discussing',title:'使用记录',evidence:[{author:'刘明华'},{author:'白田田'}]}),'刘明华、白田田正在讨论：使用记录。');
 assert.equal(minuteSentence({status:'agreement',title:'记录',conclusion:'保留使用日期',evidence:[{author:'刘明华'},{author:'白田田'}]}),'刘明华、白田田已达成一致：保留使用日期。');
});
test('纪要保留三个分区，依据只取当前公开记录，修订不当成共识',()=>{
 const records=[{id:'c',channel:'group',kind:'comment',author:'甲',text:'公开批注',context:{selection:{id:'m',version:1}}},{id:'private',channel:'private',author:'乙',text:'私聊'},{id:'n',channel:'group',author:'Nexus',text:'机器分析'},{id:'p',kind:'revision-proposal',status:'accepted',resultVersion:2}];
 const topics=[{title:'成果一致',status:'agreement',sourceIds:['c','private','n'],anchor:{cardId:'m',block:'result'}},{title:'讨论',status:'discussing',sourceIds:[]},{title:'问题',status:'pending',sourceIds:[]}];
 let m=discussionMinutes(topics,records,{m:{version:1}});assert.equal(m.agreement.length,1);assert.deepEqual(m.agreement[0].evidence.map(r=>r.id),['c']);assert.equal(m.pending.length,1);assert.equal(m.discussing.length,1);assert.equal(m.proposals.length,1);
 m=discussionMinutes(topics,records,{m:{version:2}});assert.equal(m.agreement.length,0);assert.equal(m.discussing[0].stale,true);
 assert.deepEqual(discussionMinutes(),{agreement:[],discussing:[],pending:[],proposals:[]});
});
