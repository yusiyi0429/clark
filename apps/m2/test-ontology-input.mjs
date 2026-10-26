import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFacts, buildGeneratorInput } from './ontology-input.mjs';
const fact = extra => ({ id: 'example@1#fact', unit: 'eo', kind: 'state', sourceType: 'StateSnapshot',
  sourceRef: 'example@1#current_state', text: '9月30日完成接口部署。',
  factThrough: '2026-09-30T23:59:59+08:00', dateEvidence: '正文明确记载9月30日',
  recordedAt: '2026-10-13T10:00:00+08:00', reviewed: true, ...extra });
test('晚录入的历史事实可以使用', () => assert.equal(selectFacts([fact()]).accepted.length, 1));
test('截止前已知的未来窗口不按未来日期误删', () => {
  assert.equal(selectFacts([fact({text:'10月8日已约定10月12日入职',factThrough:'2026-10-08T12:00:00+08:00',dateEvidence:'10月8日确认记录'})]).accepted.length, 1);
});
test('10月8日当天可用，之后不可用', () => {
  assert.equal(selectFacts([fact({factThrough: '2026-10-08T23:59:59+08:00'})]).accepted.length, 1);
  assert.equal(selectFacts([fact({factThrough: '2026-10-09T00:00:00+08:00'})]).excluded.length, 1);
});
test('不能用录入日期代替事实日期', () => assert.equal(selectFacts([fact({factThrough: undefined})]).pending.length, 1));
test('旧答案无论日期多早都排除', () => {
  for (const sourceType of ['PeriodGoal', 'Mission', 'Task', 'Activity'])
    assert.equal(selectFacts([fact({sourceType})]).excluded.length, 1);
});
test('答案藏在状态或定义中也不放行', () => {
  assert.equal(selectFacts([fact({mixedAnswer: true})]).pending.length, 1);
  assert.equal(selectFacts([fact({isAnswer: true})]).excluded.length, 1);
});
test('最新LTO、组织版本不按进展截止日期误删', () => {
  assert.equal(selectFacts([fact({kind:'lto', sourceType:'LongTermGoal', factThrough:undefined, baselineSelected:true})]).accepted.length, 1);
  assert.equal(selectFacts([fact({kind:'lto', sourceType:'LongTermGoal', baselineSelected:false})]).pending.length, 1);
});
test('责任冲突不静默选边，未检查不放行', () => {
  assert.equal(selectFacts([fact({conflict:true})]).pending.length, 1);
  assert.equal(selectFacts([fact({reviewed:false})]).pending.length, 1);
});
test('原始载荷和排除正文不进入模型输入', () => {
  const input=buildGeneratorInput([fact({rawContext:'LEAK'}),fact({id:'answer',isAnswer:true,text:'ANSWER'})]);
  assert.ok(!JSON.stringify(input).includes('LEAK'));
  assert.ok(!JSON.stringify(input).includes('ANSWER'));
});
test('缺来源、重复引用和无时区日期不放行', () => {
  assert.equal(selectFacts([fact({sourceRef:undefined})]).pending.length, 1);
  assert.equal(selectFacts([fact({factThrough:'2026-10-08'})]).pending.length, 1);
  assert.throws(()=>selectFacts([fact(),fact()]));
});
test('本期 PO（周期目标，草稿或已承诺）及其 Mission、Task 是参考答案，标成什么类别都不进生成', () => {
  for (const sourceType of ['PeriodGoal', 'Mission', 'Task', 'Activity'])
    for (const confirmation of ['draft', 'committed'])
      assert.equal(selectFacts([fact({ kind: 'intent', sourceType, confirmation, baselineSelected: true, factThrough: undefined, dateEvidence: undefined })]).excluded.length, 1);
  // Other dated material about this month's direction follows the cutoff like any dated fact.
  assert.equal(selectFacts([fact({ kind: 'intent', sourceType: 'ExternalEvent' })]).accepted.length, 1);
  assert.equal(selectFacts([fact({ kind: 'intent', sourceType: 'ExternalEvent', factThrough: '2026-10-09T00:00:00+08:00' })]).excluded.length, 1);
});
test('以【10 月计划】开头的记录是参考答案，不进生成', () => {
  assert.equal(selectFacts([fact({ kind: 'state', sourceType: 'ExternalEvent', text: '【10 月计划】【M2 基础资料补充】10月23日形成材料阶段稿' })]).excluded.length, 1);
});
test('拆下个月时，上个月的 PO、Mission、Task 作为历史读入；本月的仍是参考答案', () => {
  const nov = { period: '2026-11', cutoff: '2026-10-21T23:59:59+08:00', excludedTypes: ['PeriodGoal', 'Mission', 'Task', 'Activity'] };
  const plan = extra => fact({ kind: 'history', historyPeriod: '2026-10', baselineSelected: true, factThrough: undefined, dateEvidence: undefined, ...extra });
  for (const sourceType of ['PeriodGoal', 'Mission', 'Task']) assert.equal(selectFacts([plan({ sourceType })], nov).accepted.length, 1);
  assert.equal(selectFacts([plan({ sourceType: 'Mission', historyPeriod: '2026-11' })], nov).excluded.length, 1);
  assert.equal(selectFacts([plan({ sourceType: 'Mission', baselineSelected: false })], nov).pending.length, 1);
  assert.equal(selectFacts([fact({ sourceType: 'Mission' })], nov).excluded.length, 1);
  // 【10 月计划】 is history in November, an answer in October.
  assert.equal(selectFacts([fact({ text: '【10 月计划】10月23日形成材料阶段稿', factThrough: '2026-10-19T16:40:00+08:00' })], nov).accepted.length, 1);
  assert.equal(selectFacts([fact({ text: '【11 月计划】某事', factThrough: '2026-10-19T16:40:00+08:00' })], nov).excluded.length, 1);
});
