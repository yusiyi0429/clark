import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';

function fixture(){
 const units=['agents','method'].map(id=>({id,unit:id,level:'po',title:id,owner:'刘明华',version:1,children:[]}));
 const reviews=[['agents-m1','agents','陈溪南'],['method-m1','method','陈溪南'],['agents-m2','agents','孙铭泽']].map(([ref,unit,owner])=>({ref,unit,level:'mission',owner,title:ref,verdict:'未达成',verdictReason:'缺完成证据',facts:[],nextInputs:[]}));
 const s=installReviewRound(createCollaborationState(units),{period:'2026-10',reviews});
 const ctx={scope:'person:member-04',selection:{id:'rv:method-m1',version:1},block:'verdict'};
 s.messages.push({id:'nexus-person',author:'Nexus',channel:'group',scope:'person:member-04',text:'现有记录还不能改成达成，请补会议记录。',context:ctx,threadId:'original-thread'});
 s.messages.push({id:'nexus-other',author:'Nexus',channel:'group',scope:'person:member-03',text:'他人房间消息'});
 s.messages.push({id:'nexus-unit',author:'Nexus',channel:'group',scope:'agents',text:'单元群消息'});
 s.messages.push({id:'agent-private',author:'Agent',channel:'private',scope:'person:member-04',text:'私人 Agent 消息'});
 s.proposals=[{id:'proposal-person',scope:'person:member-04',cardId:'rv:method-m1',baseVersion:1,patch:{verdictReason:'补充记录后再核对'},sourceIds:[],status:'pending'}];
 for(const e of [...s.messages,...s.proposals])e.createdAt??='2026-10-28T07:00:00Z';
 return s;
}

test('个人汇总页可回复本房间 Nexus，保留跨 Mission 上下文和线程，别人读不到',()=>{
 const s=fixture(),actor=memberActor('member-04',s),before=structuredClone(s.cards);
 const next=applyAction(s,actor,{type:'message',cardId:'rv:person:陈溪南',replyTo:'nexus-person',text:'本体中应该有真实会议记录，请核对。'});
 const reply=next.messages.at(-1);
 assert.equal(reply.scope,'person:member-04');assert.equal(reply.replyTo,'nexus-person');assert.equal(reply.replyToAuthor,'Nexus');assert.equal(reply.threadId,'original-thread');
 assert.deepEqual(reply.context,s.messages.find(m=>m.id==='nexus-person').context);assert.match(reply.replyPreview.text,/现有记录/);
 assert.deepEqual(next.cards,before);
 const own=sharedProjection(next,actor);assert.ok(own.records['group:person:member-04'].some(m=>m.id===reply.id));
 for(const id of ['member-01','member-03'])assert.equal(sharedProjection(next,memberActor(id,next)).records['group:person:member-04'],undefined);
});

test('个人卡可回复同房间批注和修订卡；正常回复不修改复盘或签字',()=>{
 let s=fixture();const actor=memberActor('member-04',s);
 s=applyAction(s,actor,{type:'comment',cardId:'rv:method-m1',baseVersion:1,block:'verdict',text:'请核对这条'});
 for(const id of [s.comments.at(-1).id,'proposal-person']){
  const next=applyAction(s,actor,{type:'message',cardId:'rv:agents-m1',replyTo:id,text:'这条我有补充材料'});
  assert.equal(next.messages.at(-1).scope,'person:member-04');assert.equal(next.messages.at(-1).replyTo,id);
  assert.equal(currentVersion(next.cards['rv:method-m1']).number,1);
  assert.deepEqual(currentVersion(next.cards['rv:method-m1']).signatures,[]);
 }
});

test('个人房间不能引用他人房间、单元群、私人 Agent 或不存在的消息；单元群不能引用个人房间',()=>{
 const s=fixture(),actor=memberActor('member-04',s);
 for(const replyTo of ['nexus-other','nexus-unit','agent-private','missing'])assert.throws(()=>applyAction(s,actor,{type:'message',cardId:'rv:person:陈溪南',replyTo,text:'引用'}),/引用消息/);
 assert.throws(()=>applyAction(s,actor,{type:'message',cardId:'agents',replyTo:'nexus-person',text:'引用'}),/引用消息/);
 const next=applyAction(s,actor,{type:'message',cardId:'agents',replyTo:'nexus-unit',text:'单元群正常回复'});
 assert.equal(next.messages.at(-1).scope,'agents');
});
