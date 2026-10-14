import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mentionAt,insertMention} from './mention-input.mjs';
test('提及支持开头、句中空格、中文检索及光标插入，邮箱不触发',()=>{
 assert.deepEqual(mentionAt('@',1),{start:0,end:1,query:''});
 assert.equal(mentionAt('请问@',3).query,'');
 assert.equal(mentionAt('请问 @陈',5).query,'陈');assert.equal(mentionAt('a@b.com',7),null);
 const text='请问 @Ne 后续内容',m=mentionAt(text,6),r=insertMention(text,m,'Nexus');
 assert.equal(r.value,'请问 @Nexus  后续内容');assert.equal(r.caret,10);
 assert.equal(mentionAt('@Nexus ',7),null);
});
