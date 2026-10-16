import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState} from './governance.mjs';
import {normalize,allNodes} from './domain.mjs';
import {memberProfiles} from './member-profiles.mjs';
import {canGenerateActivities,activityRequest,readActivities,attachActivities} from './activity-plan.mjs';
const owner=key=>Object.values(memberProfiles).find(p=>p.unitDri.includes(key)).name;
const card=(key,title)=>({title,result:'结果',owner:owner(key),time:'2026-10-05—2026-10-20',checks:['证据']});
const units=normalize([{...card('bf01','PO'),key:'bf01',name:'Battlefield 灯塔项目',missions:[{...card('bf01','M1'),tasks:[{...card('bf01','T1'),activities:[]},{...card('bf01','T2'),activities:[]}]}]}]);
const state={...createCollaborationState(units),round:{id:'r1',units:structuredClone(units),input:{sources:[{key:'bf01',content:'本领域'},{key:'eo',content:'别的领域'},{key:'company',content:'公司'}]}}};
const actor=(over={})=>({name:'路人',ceo:false,unitDri:[],missionDri:[],...over});
test('只有 Task 负责人、Mission 负责人、领域负责人或 CEO 能生成 Activity',()=>{
 assert.equal(canGenerateActivities(actor(),state,'bf01-m1-t1'),false);
 assert.equal(canGenerateActivities(actor({name:owner('bf01')}),state,'bf01-m1-t1'),true);
 assert.equal(canGenerateActivities(actor({missionDri:['bf01-m1']}),state,'bf01-m1-t1'),true);
 assert.equal(canGenerateActivities(actor({ceo:true}),state,'bf01-m1'),false);
});
test('请求只带这个 Task、所属 Mission 和 PO、同 Mission 的其他 Task 和本领域资料',()=>{
 const q=activityRequest(state,'bf01-m1-t1');
 assert.equal(q.stage,'activity-generate');assert.match(q.task,/按需生成 Activity/);
 assert.equal(q.taskCard.title,'T1');assert.equal(q.mission.title,'M1');assert.deepEqual(q.siblingTasks.map(t=>t.title),['T2']);
 assert.deepEqual(q.context.map(s=>s.key).sort(),['bf01','company']);
});
test('结果按卡片规则检查；可以直接执行时不加卡片；新卡片挂在 Task 下并进入当前轮',()=>{
 assert.throws(()=>readActivities('{"activities":[],"gaps":[]}'),/没有给出 Activity/);
 assert.deepEqual(readActivities('{"directlyExecutable":true,"activities":[],"gaps":["一步就能做完"]}'),{activities:[],directlyExecutable:true,gaps:['一步就能做完']});
 assert.throws(()=>readActivities('{"activities":[{"title":"只写了标题"}]}'));
 const read=readActivities(JSON.stringify({activities:[{type:'Agent Activity',title:'整理样本',owner:'Risk Agent',result:'样本表',checks:['来源可回溯'],time:'2026-10-06—2026-10-08',inputs:['授权数据'],rollback:{when:'样本不足',then:'暂停'}}],gaps:[]}));
 assert.equal(read.activities[0].owner,'Risk Agent');assert.equal(typeof read.activities[0].rollback,'string');
 const next=attachActivities(state,'bf01-m1-t1',read.activities);
 assert.equal(next.cards['bf01-m1-t1-a1'].parentId,'bf01-m1-t1');assert.equal(next.cards['bf01-m1-t1-a1'].level,'activity');
 assert.deepEqual(allNodes(next.round.units).find(n=>n.id==='bf01-m1-t1').children.map(c=>c.title),['整理样本']);
 assert.equal(state.cards['bf01-m1-t1-a1'],undefined);
 assert.equal(attachActivities(next,'bf01-m1-t1',read.activities).cards['bf01-m1-t1-a2'].title,'整理样本');
});
