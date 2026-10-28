import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fieldCommentTarget,fieldCommentAction,fieldCommentActive} from './field-comment.mjs';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {memberActor} from './shared-projection.mjs';

const state=()=>installReviewRound(createCollaborationState([{id:'agents',unit:'agents',level:'po',title:'Agents',owner:'刘明华',version:1,children:[]}]),{period:'2026-10',reviews:[
 {ref:'agents-m1',unit:'agents',level:'mission',owner:'陈溪南',title:'复盘与分解',verdict:'未达成',verdictReason:'缺完成证据',facts:[{ref:'t1',item:'读取',owner:'陈溪南',status:'未达成',evidence:'缺完成证据',gap:''}],nextInputs:[]},
 {ref:'agents-m2',unit:'agents',level:'mission',owner:'陈溪南',title:'会议',verdict:'未达成',verdictReason:'缺完成证据',facts:[{ref:'t2',item:'入会',owner:'陈溪南',status:'未达成',evidence:'缺完成证据',gap:''}],nextInputs:[]},
 {ref:'agents-m3',unit:'agents',level:'mission',owner:'孙铭泽',title:'天枢',verdict:'未达成',verdictReason:'缺完成证据',facts:[],nextInputs:[]},
]});

test('个人汇总页里的批注使用点中的实际复盘卡，并留在本人房间',()=>{
 const s=state(),actor=memberActor('member-04',s);
 assert.throws(()=>applyAction(s,actor,{type:'comment',cardId:'rv:person:陈溪南',baseVersion:1,text:'补证'}),/不在当前领域/);
 for(const id of ['rv:agents-m1','rv:agents-m2']){
  const node={...currentVersion(s.cards[id]).content,id},target=fieldCommentTarget(node,'facts#0');
  const next=applyAction(s,actor,fieldCommentAction(target,'这行需要补证'));
  assert.equal(next.comments.at(-1).cardId,id);assert.equal(next.comments.at(-1).scope,'person:member-04');assert.equal(next.comments.at(-1).item,0);
  assert.equal(fieldCommentActive({cardId:id,anchor:'facts#0'},id,'facts#0'),true);
  assert.equal(fieldCommentActive({cardId:id,anchor:'facts#0'},id==='rv:agents-m1'?'rv:agents-m2':'rv:agents-m1','facts#0'),false);
 }
 const other={...currentVersion(s.cards['rv:agents-m3']).content,id:'rv:agents-m3'};
 assert.throws(()=>applyAction(s,actor,fieldCommentAction(fieldCommentTarget(other,'facts'),'不能借此进入他人房间')),/个人复盘的讨论/);
});

test('批注保留开始写时的卡片版本，后台更新后不悄悄换成新版',()=>{
 const s=state(),id='rv:agents-m1',node={...currentVersion(s.cards[id]).content,id};
 const target=fieldCommentTarget(node,'verdict');node.version=2;
 assert.equal(fieldCommentAction(target,'旧版意见').baseVersion,1);
});
