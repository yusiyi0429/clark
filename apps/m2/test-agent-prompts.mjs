import {test} from 'node:test';
import assert from 'node:assert/strict';
import {privateAgentPrompt} from './agent-prompts.mjs';
test('个人 Agent 默认问答及审阅简短，明确请求可展开，并保留事实和授权边界',()=>{
 const prompt=privateAgentPrompt('陈溪南','测试规则');
 for(const text of ['100—180','请 Agent 审阅','220','只有用户明确要求详细','权限边界','不能说“已修改”','不把私人草稿自动发到群里','测试规则'])assert.ok(prompt.includes(text));
});
