import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readableField,parseReadableField,readableValue} from './readable-markdown.mjs';
const roundtrip=(key,value)=>{const encoded=readableField(key,value);assert.deepEqual(parseReadableField(encoded.meta,encoded.body),value);return encoded;};
test('自然段完整往返多行、列表、标题、代码、中文符号、空格和保留标记字面量',()=>{
 for(const value of ['第一行\n\n## 正文标题\n1. 用户自己的编号\n- 子项\n**重要** | 字段：甲 `code`','  前后空格  ','','\n开头换行\n','字面量 <!-- /m2-field --> &amp; <b>文本</b>'])roundtrip('verdictReason',value);
});
test('有序列表条目包含多行、子列表与符号时不串项，可用普通项目符号编辑',()=>{
 const value=['第一条\n- 里面的子项\n  1. 子编号','第二条\n\n下一段 | 符号'];const encoded=roundtrip('checks',value);
 const edited=encoded.body.replace('1. 第一条','- 用户改了第一条');assert.equal(parseReadableField(encoded.meta,edited)[0],'用户改了第一条\n- 里面的子项\n  1. 子编号');
});
test('事实表多行、管道、反斜线、HTML字面符号往返，正文直接编辑不依赖模型',()=>{
 const value=[{ref:'uuid-a',item:'任务甲',owner:'甲',status:'未达成',evidence:'第一行 | 列\n第二行\\路径 <br> &amp;',gap:''},{ref:'uuid-b',item:'任务乙',status:'部分达成',evidence:'  保留空格  '}];const e=roundtrip('facts',value);
 const body=e.body.replace('第一行 \\| 列','修改后的证据 \\| 列');const result=parseReadableField(e.meta,body);assert.equal(result[0].evidence,'修改后的证据 | 列\n第二行\\路径 <br> &amp;');assert.equal(result[0].ref,'uuid-a');
 const lines=e.body.split('\n');[lines[2],lines[3]]=[lines[3],lines[2]];assert.deepEqual(parseReadableField(e.meta,lines.join('\n')),value);
});
test('下期输入的对象与提问用中文表格；空白模板不暗藏原有正文',()=>{
 const value=[{ref:'r1',type:'继续',text:'不能被空白模板带出的旧正文',ask:{to:'甲',question:'旧提问'}}];roundtrip('nextInputs',value);
 const blank=readableField('nextInputs',value,{blank:true});assert.ok(!JSON.stringify(blank).includes('不能被空白模板带出的旧正文'));assert.ok(!JSON.stringify(blank).includes('旧提问'));const parsed=parseReadableField(blank.meta,blank.body);assert.equal(parsed[0].text,'');assert.equal(parsed[0].ref,'r1');assert.equal(parsed[0].ask.question,'');
 roundtrip('ltoReview',{choice:'建议维持',reason:'证据一\n证据二'});
 assert.ok(!readableValue('nextInputs',value).includes('"text":'));assert.match(readableValue('facts',[{item:'甲',status:'未达成',evidence:'缺证据'}]),/事项.*负责人.*状态/);
});
test('缺失或重复表格身份标记明确失败，不能按位置误映射',()=>{
 const e=readableField('facts',[{ref:'a',item:'甲',status:'未达成'},{ref:'b',item:'乙',status:'达成'}]);assert.throws(()=>parseReadableField(e.meta,e.body.replace('<!-- m2-row:0 -->','')),/缺失/);assert.throws(()=>parseReadableField(e.meta,e.body.replace('m2-row:1','m2-row:0')),/重复/);
});

test('非标准自然段按原文分句归集，不要求整个长字符串在文件中连续出现',async()=>{
 const {assertImportGrounded}=await import('./markdown-transfer.mjs');
 const state={cards:{a:{versions:[{content:{verdictReason:'旧'}}]}}};
 assert.doesNotThrow(()=>assertImportGrounded(state,[{id:'a',fields:{verdictReason:'第一点缺材料；第二点缺场次日期'}}],'# 判定理由\n第一点缺材料\n\n## 补充\n第二点缺场次日期'));
 assert.throws(()=>assertImportGrounded(state,[{id:'a',fields:{verdictReason:'第一点缺材料；新增验收通过'}}],'第一点缺材料\n第二点缺场次日期'),/未提供/);
});
