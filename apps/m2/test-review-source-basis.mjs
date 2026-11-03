import {test} from 'node:test';import assert from 'node:assert/strict';
import {reviewFile} from './review-generation.mjs';import {reviewCards} from './review-round.mjs';import {exportMarkdown,parseStandardMarkdown} from './markdown-transfer.mjs';import {handoffPackage} from './review-handoff.mjs';
test('来源身份由冻结输入保存；模型不能改来源；MD往返和下期引用保留',()=>{
 const sourceBasis={basisMode:'latest-source-candidate',snapshotHash:'snapshot',objectId:'m',sourceVersion:7,sourceRevision:'r7',sourceStatus:'draft',formal:{lifecycle_status:'draft',effective_revision_id:null},effective:false,period:'2026-10',cutoff:'2026-10-30'};
 const childCommitments={complete:true,basisMode:'latest-source-candidate',snapshotHash:'snapshot',items:[{ref:'task',inBaseline:true,effective:null,version:8,parentRef:'m',source:'object',formal:null}]};
 const input={period:'2026-10',cutoff:'2026-10-30',basis:{mode:'latest-source-candidate',snapshotHash:'snapshot'},stages:[[{id:'eo-m1',sourceBasis,childCommitments,objectId:'m'}],[],[]]};
 const r={ref:'eo-m1',unit:'eo',level:'mission',owner:'测试负责人',title:'任务成果',verdict:'未达成',verdictReason:'缺验收',facts:[{ref:'task',item:'任务',owner:'',status:'未达成',evidence:'缺验收',gap:'缺记录'}],nextInputs:[{ref:'task',type:'继续',text:'补验收'}],sourceBasis:{effective:true},childCommitments:{items:[]}};
 const file=reviewFile({reviews:{'eo-m1':r},failed:[],dropped:[]},input,{skill:{version:'2.1.11',hash:'skill'},model:'fixture'});assert.deepEqual(file.reviews['eo-m1'].sourceBasis,sourceBasis);assert.deepEqual(file.reviews['eo-m1'].childCommitments,childCommitments);
 const cards=reviewCards(file),state={cards,comments:[],reviewRound:{period:'2026-10'}};
 const saved=cards['rv:eo-m1'].versions[0].content;assert.deepEqual(saved.sourceBasis,sourceBasis);assert.deepEqual(saved.childCommitments,childCommitments);
 const md=exportMarkdown(state,{ceo:true},{stage:'review',rootId:'rv:eo-m1',onlyRoot:true});assert.match(md,/未确认内容不代表正式生效/);assert.match(md,/m2-source-basis:/);const parsed=parseStandardMarkdown(md);assert.deepEqual(parsed[0].fields.facts,r.facts);assert.ok(!('sourceBasis' in parsed[0].fields));
 const next=handoffPackage(state).units[0].missions[0];assert.deepEqual(next.sourceBasis,sourceBasis);assert.deepEqual(next.childCommitments,childCommitments);assert.deepEqual(next.nextInputs,r.nextInputs);
});
