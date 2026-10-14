import {test} from 'node:test';
import assert from 'node:assert/strict';
import {templateFields,editableTemplateFields,templateSources} from './document-template.mjs';
import {draftRevision} from './review-workflow.mjs';
test('新版 PO Card + Mission Plan、Mission Card + Task Plan 字段分层',()=>{
 assert.equal(templateSources.po.version,'v1.2');
 assert.deepEqual(templateFields.po.detail.map(x=>x[0]),['why','checks','boundary']);
 assert.deepEqual(templateFields.po.plan.map(x=>x[0]),['logic','tradeoff','dependencies','milestones']);
 assert.equal(templateSources.combined.revision,372);
 assert.ok(!editableTemplateFields('po').some(([k])=>k==='parentLtoReference'));
 assert.ok(editableTemplateFields('po',{parentLtoReference:'v1',handoffs:'交接条件'}).some(([k])=>k==='handoffs'));
 assert.deepEqual(templateFields.mission.plan.map(x=>x[0]),['path','tradeoff','dependencies','milestones']);
 assert.ok(!editableTemplateFields('task').some(([k])=>k==='path'||k==='tradeoff'));
 assert.ok(editableTemplateFields('po').some(([k])=>k==='time'));
});
test('新版模板已有逻辑、取舍修订仍保留历史，不改变未编辑字段',()=>{
 const node={version:1,title:'PO',logic:'原逻辑',tradeoff:'原取舍',expectedProgress:''};
 const r=draftRevision(node,{logic:'新逻辑'},'DRI');
 assert.equal(r.history[0].changes[0].field,'logic');assert.equal({...node,...r}.tradeoff,'原取舍');
 assert.equal(node.expectedProgress,'');
});
