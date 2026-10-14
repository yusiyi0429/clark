import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planLabels,orderPlanUnits} from './plan-labels.mjs';
test('展示先排全部战场再排领域，保留组内顺序和原始对象',()=>{
 const units=['Battlefield A','Battlefield B','Domain A','Battlefield C','Domain B'].map((name,i)=>({id:String(i),level:'po',name,children:[]}));
 const before=JSON.stringify(units),ordered=orderPlanUnits(units);
 assert.deepEqual(ordered.map(n=>n.id),['0','1','3','2','4']);
 assert.equal(JSON.stringify(units),before);
 assert.equal(ordered[2],units[3]);
 assert.deepEqual([...planLabels(ordered).values()].map(n=>n.referenceLabel),['Battlefield 1','Battlefield 2','Battlefield 3','Domain 1','Domain 2']);
});
test('完整树统一编号，父级内编号不随筛选变化，不修改业务对象',()=>{
 const units=[{id:'bf01',level:'po',name:'Battlefield 灯塔项目',children:[{id:'m1',level:'mission',children:[]},{id:'m2',level:'mission',children:[{id:'t1',level:'task',children:[]},{id:'t2',level:'task',children:[]}]}]},{id:'d1',level:'po',name:'Domain Agents',children:[{id:'m3',level:'mission',children:[]}]}];
 const before=JSON.stringify(units),labels=planLabels(units);
 assert.equal(labels.get('bf01').planLabel,'Battlefield 1 灯塔项目');assert.equal(labels.get('bf01').groupName,'灯塔项目');assert.equal(labels.get('d1').planLabel,'Domain 1 Agents');assert.equal(labels.get('m2').referenceLabel,'Mission 02');assert.equal(labels.get('t2').referenceLabel,'Task 02');assert.equal(labels.get('m3').referenceLabel,'Mission 01');assert.equal(JSON.stringify(units),before);
 assert.equal(units[0].children.filter(n=>n.id==='m2').map(n=>labels.get(n.id).referenceLabel)[0],'Mission 02');
});
test('战场与 Domain 分别连续编号，交错排列不影响各自序号',()=>{
 const units=['Battlefield A','Domain A','Battlefield B','Domain B','Battlefield C','Domain C'].map((name,i)=>({id:String(i),level:'po',name,children:[]}));
 const labels=planLabels(units);
 assert.deepEqual(units.map(u=>labels.get(u.id).referenceLabel),['Battlefield 1','Domain 1','Battlefield 2','Domain 2','Battlefield 3','Domain 3']);
});
