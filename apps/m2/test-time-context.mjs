import test from 'node:test';
import assert from 'node:assert/strict';
import {nowContext,NOW_RULE} from './time-context.mjs';
import {listenInput,listenSystemPrompt} from './nexus-listen.mjs';
import {actContext} from './nexus-context.mjs';
import {nexusSystemPrompt} from './nexus-policy.mjs';
import {privateAgentPrompt} from './agent-prompts.mjs';
// 现在是什么时候 (孙铭泽 10/27, adopted by 陈溪南): every Nexus and private-Agent turn carries the Beijing date, week and month.
test('按北京时间给出今天、本周、上周、本月和月底；周日晚上和周一零点分在两周',()=>{
 assert.deepEqual(nowContext(Date.parse('2026-10-27T08:30:00Z')),{at:'2026-10-27 周二 16:30（北京时间）',week:'2026-10-26 周一 至 2026-11-01 周日',lastWeek:'2026-10-19 周一 至 2026-10-25 周日',month:'2026-10',monthEnd:'2026-10-31 周六'});
 assert.equal(nowContext(Date.parse('2026-11-01T15:59:00Z')).week,'2026-10-26 周一 至 2026-11-01 周日');
 assert.equal(nowContext(Date.parse('2026-11-01T16:01:00Z')).week,'2026-11-02 周一 至 2026-11-08 周日');
});
test('倾听、出手和私人 Agent 的输入都带 now，系统提示词说按 now 换算',()=>{
 const at=Date.parse('2026-10-27T08:30:00Z');
 assert.equal(listenInput({scope:'bf01',fresh:[],evidence:[],topics:[],cards:[],now:at}).now.at,'2026-10-27 周二 16:30（北京时间）');
 assert.equal(actContext({cards:[{id:'bf01',level:'po',title:'灯塔'}],evidence:[],fresh:[],topics:[],now:at}).now.month,'2026-10');
 for(const p of [listenSystemPrompt,nexusSystemPrompt,privateAgentPrompt('孙铭泽','')])assert.ok(p.includes(NOW_RULE));
});
