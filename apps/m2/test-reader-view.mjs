import test from 'node:test';
import assert from 'node:assert/strict';
import {readerSource,readerView,plainCardTitle,fieldPoints,formatPlanDate,cleanCandidatePrefix,inheritedPlanField} from './reader-view.mjs';
import {formatReaderViews} from './reader-format.mjs';
import {validateUnit} from './round-runner.mjs';
test('标题移除日期与类型前缀；分点保留原文；旧摘要不套到新内容',()=>{
 const node={id:'x',level:'po',name:'Domain Agents',title:'2026-10-01—2026-10-31 PO：Agents 完成首次应用',result:'首次应用',milestones:[]};
 assert.equal(plainCardTitle(node),'完成首次应用');
 assert.deepEqual(fieldPoints('本项负责接口；客户参与由战场推动'),['本项负责接口','客户参与由战场推动']);
 const view={source:readerSource(node),result:'首次应用'};
 assert.equal(readerView(node,{x:view}),view);
 assert.equal(readerView({...node,result:'持续应用'},{x:view}),null);
});
test('日期易读；仅移除重复候选前缀，不移除条件候选；PO汇总保持子项来源',()=>{
 assert.equal(formatPlanDate('2026-10-10—2026-10-23'),'2026.10.10 – 10.23');
 assert.equal(formatPlanDate('2026-10-01—2026-10-31'),'2026.10.1 – 10.31');
 assert.equal(formatPlanDate('2026-12-28—2027-01-05'),'2026.12.28 – 2027.1.5');
 assert.equal(formatPlanDate('2026-10-16'),'2026.10.16');
 assert.equal(cleanCandidatePrefix('候选：首次使用'),'首次使用');
 assert.equal(cleanCandidatePrefix('条件候选：外部窗口未确认'),'条件候选：外部窗口未确认');
 const node={level:'po',children:[{dependencies:'供应商通道未确认；未满足则调用受阻',milestones:['通道验收，2026-10-28 完成'],humanView:{milestones:['通道验收']}}]};
 assert.deepEqual(inheritedPlanField(node,'milestones').value,['10/28 通道验收']);
 assert.match(inheritedPlanField(node,'dependencies').value[0],/Mission 01：供应商通道未确认/);
 assert.equal(inheritedPlanField({...node,dependencies:['原始依赖']},'dependencies'),null);
 assert.equal(node.dependencies,undefined);
});
test('真实生成检查PO与Mission计划漏项，缺资料不能被空字段冒充完整',()=>{
 const card={title:'结果',result:'状态',checks:['标准'],owner:'刘明华'};
 const u={...card,missions:[{...card,tasks:[{...card}]}]};
 assert.throws(()=>validateUnit(u,{requirePlanFields:true}),/缺少约束与依赖/);
 u.dependencies=['接口状态待核对，影响接入'];u.milestones=['10/28 接入验证'];
 assert.throws(()=>validateUnit(u,{requirePlanFields:true}),/PO 缺少时间边界/);
 Object.assign(u,{time:'2026-10-01—2026-10-31',why:['理由'],boundary:['分工'],logic:['交接'],tradeoff:['取舍']});
 assert.throws(()=>validateUnit(u,{requirePlanFields:true}),/Mission 缺少约束与依赖/);
 Object.assign(u.missions[0],{dependencies:['接口状态待核对，影响接入'],milestones:['10/28 接入验证']});
 assert.throws(()=>validateUnit(u,{requirePlanFields:true}),/缺少时间边界/);
 Object.assign(u.missions[0],{time:'2026-10-10—2026-10-28',why:['理由'],boundary:['分工'],path:['交接'],tradeoff:['取舍']});
 u.missions[0].tasks[0].time='2026-10-10—2026-10-28';
 assert.equal(validateUnit(u,{requirePlanFields:true}),u);
 u.tradeoff=[' '];assert.throws(()=>validateUnit(u,{requirePlanFields:true}),/缺少关键取舍/);
});
test('显式分点保留因果与加粗短标题，界面不重复序号',()=>{
 assert.deepEqual(fieldPoints(['1. **客户使用：**完成首次使用；保留客户判断。','2. **人员分工：**田田负责方法。']),['**客户使用：**完成首次使用；保留客户判断。','**人员分工：**田田负责方法。']);
 assert.deepEqual(fieldPoints('1. **客户使用：**首次使用；保留客户判断。\n2. **人员分工：**田田负责方法。'),['**客户使用：**首次使用；保留客户判断。','**人员分工：**田田负责方法。']);
});
test('生成分点数组不再被拼成长段',()=>{
 const card={title:'结果',result:'状态',checks:['标准'],owner:'刘明华',why:['理由一','理由二'],boundary:['本项','他项']};
 const u={...card,missions:[{...card,tasks:[{...card}]}]};
 validateUnit(u);assert.deepEqual(u.boundary,['本项','他项']);assert.deepEqual(u.missions[0].why,['理由一','理由二']);
});
test('二次摘要入口停用，不调用模型、不改原卡片',async()=>{
 const node={id:'x',level:'po',title:'标题',result:'结果与原始完整条件',milestones:['10/16 客户确认（Task：某任务）'],children:[]},before=JSON.stringify(node);
 const gateway={complete:async()=>({answer:JSON.stringify({cards:[{id:'x',title:'客户首次应用',result:'客户完成首次应用。',milestones:['客户确认']}]}),model:'fixture'})};
 await assert.rejects(()=>formatReaderViews([node],gateway),{code:'READER_REWRITE_DISABLED'});assert.equal(JSON.stringify(node),before);
});
