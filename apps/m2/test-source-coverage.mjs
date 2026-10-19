import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceCoverage} from './source-coverage.mjs';
const fact=(unit,kind,text,extra={})=>({id:unit+kind+text.length,unit,kind,sourceRef:'event:'+unit+kind,title:null,text,factThrough:'2026-10-09T23:59:59+08:00',confirmation:'unconfirmed',...extra});
const input=(facts,pending=[])=>({mode:'ontology-selected-facts',cutoff:'2026-10-09T23:59:59+08:00',sources:[...new Set(facts.map(f=>f.unit))].map(key=>({key,facts:facts.filter(f=>f.unit===key)})),audit:{pending,reviewVersion:'v',excludedAnswers:{objects:14,byType:{PeriodGoal:6,Mission:8}}}});
test('逐单元逐类列出已读、不全、缺，参考答案只计数不读',()=>{
 const c=sourceCoverage(input([
  fact('eo','lto','六个月目标',{factThrough:null}),
  fact('eo','review','## 原目标\n让数据持续沉淀'),
  fact('eo','review','## 实际结果\n架构重构'),
  fact('eo','state','截至 10/9 的现状'),
  fact('eo','resource','- 人员：DRI 刘人豪\n- 人员投入：未知｜由刘人豪补\n- 关键交付日期：未知｜由刘人豪补\n- 客户窗口：不适用'),
  fact('bf03','lto','第二客户',{factThrough:null}),
 ],[{unit:'bf03',sourceRef:'event:x',reason:'只有关联资料推断，没有本单元独立9月推进记录'},{unit:'company',sourceRef:'world:PeriodGoal?period=2026-09',reason:'本体没有 2026-09 的周期目标（9 月 PO）对象'}]));
 const eo=c.units.find(u=>u.key==='eo'),field=k=>eo.fields.find(f=>f.key===k);
 assert.equal(field('septemberPO').status,'partial');assert.match(field('septemberPO').notes[0],/下周由于斯一补录/);
 assert.equal(field('review').status,'read');assert.equal(field('review').count,1);
 assert.equal(field('resource').status,'partial');assert.deepEqual(field('resource').notes,['关键交付日期未知，由刘人豪补']);
 const bf03=c.units.find(u=>u.key==='bf03');
 assert.equal(bf03.fields.find(f=>f.key==='review').status,'missing');assert.equal(bf03.fields.find(f=>f.key==='state').status,'missing');
 assert.match(c.summary,/参考答案不读 14 个对象/);assert.equal(c.excluded.typeLabels.PeriodGoal,'10 月 PO（周期目标）');assert.match(c.excluded.rule,/10 月 PO/);
 // Each item shows where it came from and a short preview, not the full text.
 assert.ok(eo.fields.flatMap(f=>f.items).every(i=>i.sourceRef&&i.preview.length<=80));
});
test('不是本体读入的轮次不给数据清单',()=>{assert.equal(sourceCoverage({mode:'independent-foundation-only',sources:[]}),null);});
