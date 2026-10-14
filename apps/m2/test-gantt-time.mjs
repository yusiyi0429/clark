import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ganttPeriod,ganttCardPeriod,poPeriod} from './gantt-time.mjs';
import {validateUnit,normalizePoCycle} from './round-runner.mjs';
test('PO、Mission、Task均按技能原日期显示，程序不纠正输出',()=>{
 const time='2026-10-09—2026-10-16';
 assert.equal(poPeriod(),'2026-10-01—2026-10-31');
 assert.deepEqual(ganttCardPeriod({level:'po',time}),ganttPeriod(time));
 for(const level of ['mission','task'])assert.deepEqual(ganttCardPeriod({level,time}),ganttPeriod(time));
 const task={title:'Task',result:'结果',checks:['验收'],owner:'刘明华',time};
 const unit={title:'PO',result:'结果',checks:['验收'],time,missions:[{...task,tasks:[{...task}]}]};
 validateUnit(unit);assert.equal(unit.time,time);normalizePoCycle(unit);assert.equal(unit.time,time);assert.equal(unit.generatedFieldSources,undefined);assert.equal(unit.missions[0].time,time);assert.equal(unit.missions[0].tasks[0].time,time);
});
test('甘特横条起点和长度与日期一致，结束日期计入周期',()=>{
 assert.deepEqual(ganttPeriod('2026.10.12—2026.10.19'),{left:396,width:288,label:'10.12—10.19'});
 assert.deepEqual(ganttPeriod('2026.10.23'),{left:792,width:36,label:'10.23'});
 assert.equal(ganttPeriod('2026.10.01—2026.10.31').width,1116);
 for(const s of ['待定','','2026.10.32','2026.10.20—2026.10.12','2026.11.01'])assert.equal(ganttPeriod(s),null);
});
