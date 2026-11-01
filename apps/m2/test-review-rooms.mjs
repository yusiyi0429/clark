import {test} from 'node:test';import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,roomOf} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';import {sharedProjection,memberActor} from './shared-projection.mjs';
import {reviewConversation,groupRoomAvailable,conversationDraftKey,restoreConversationDraft} from './review-rooms.mjs';
function fixture(mixed=false){
 const units=[{id:'talent',unit:'talent',level:'po',owner:'秦梦怡',title:'合成单元',children:[]}];
 const reviews=[{ref:'talent',unit:'talent',level:'ru',title:'合成单元',owner:'秦梦怡',verdict:'未达成',facts:[],nextInputs:[]},...[1,2,3].map(i=>({ref:'talent-m'+i,unit:'talent',level:'mission',title:'合成未指派'+i,owner:'秦梦怡',ownerAssigned:false,verdict:'未达成',facts:[],nextInputs:[]}))];
 if(mixed)reviews.push({ref:'talent-owned',unit:'talent',level:'mission',title:'合成已指派',owner:'秦梦怡',verdict:'未达成',facts:[],nextInputs:[]});
 const state=installReviewRound(createCollaborationState(units),{period:'2026-10',reviews});state.round={id:'fixture',units,input:{}};return state;
}
test('RU代签三卡不构成个人房间；projection只读保留权限与未指派，原404守卫不放宽',()=>{
 const state=fixture(),before=JSON.stringify(state),actor=memberActor('member-08',state),view=sharedProjection(state,actor);
 assert.equal(view.reviewRooms.personal,null);assert.deepEqual(view.reviewRooms.units,['talent']);
 for(const i of [1,2,3]){const node={...view.drafts['rv:talent-m'+i],id:'rv:talent-m'+i},context=reviewConversation(node,view.drafts,actor.id,actor.name,view.reviewRooms);assert.equal(context.unassigned,true);assert.equal(context.personal,null);assert.deepEqual(context.units,['talent']);assert.equal(roomOf(state.cards[node.id]),'talent');assert.equal(node.ownerAssigned,false);}
 assert.throws(()=>applyAction(state,actor,{type:'message',cardId:'rv:person:秦梦怡',text:'不能发送'}),e=>e.status===404);assert.equal(JSON.stringify(state),before);
});
test('混合卡片按当前归属选房间，不能借用另一张已指派卡的私人房间',()=>{
 const state=fixture(true),actor=memberActor('member-08',state),view=sharedProjection(state,actor),personal='person:member-08';assert.equal(view.reviewRooms.personal,personal);
 const unassigned=reviewConversation({level:'person',person:'未指派'},view.drafts,actor.id,actor.name,view.reviewRooms);assert.equal(unassigned.personal,null);assert.equal(groupRoomAvailable(personal,view.reviewRooms,'review',unassigned),false);assert.equal(groupRoomAvailable('talent',view.reviewRooms,'review',unassigned),true);
 const own=reviewConversation({level:'person',person:actor.name},view.drafts,actor.id,actor.name,view.reviewRooms);assert.equal(own.personal,personal);assert.equal(groupRoomAvailable(personal,view.reviewRooms,'review',own),true);
 const stale={...view.drafts['rv:talent-owned'],id:'rv:talent-owned'};view.drafts[stale.id]={...view.drafts[stale.id],ownerAssigned:false};const revoked=reviewConversation(stale,view.drafts,actor.id,actor.name,view.reviewRooms);assert.equal(revoked.unassigned,true);assert.equal(revoked.personal,null);assert.equal(groupRoomAvailable(personal,view.reviewRooms,'review',revoked),false);
 delete view.drafts[stale.id];assert.equal(reviewConversation(stale,view.drafts,actor.id,actor.name,view.reviewRooms).personal,null);
});
test('加载中、房间消失和跨身份均无个人发送目标，CEO也不能冒充本人',()=>{
 const state=fixture(true),qin=memberActor('member-08',state),view=sharedProjection(state,qin),node={level:'person',person:qin.name};
 assert.equal(reviewConversation(node,view.drafts,qin.id,qin.name,null).pending,true);assert.equal(groupRoomAvailable('person:member-08',null),false);assert.equal(groupRoomAvailable('talent',{personal:null,units:[]}),false);
 assert.equal(reviewConversation(node,view.drafts,'member-04','陈溪南',view.reviewRooms).personal,null);
 const ceo=memberActor('member-01',state),other=sharedProjection(state,ceo);assert.notEqual(other.reviewRooms.personal,'person:member-08');assert.throws(()=>applyAction(state,ceo,{type:'message',cardId:'rv:person:秦梦怡',text:'越权'}),e=>e.status===403);
});
test('草稿按身份、房间、环节和复盘轮隔离；异步失败不能将私人输入转到新公开房间',()=>{
 const base={memberId:'member-08',tab:'agent',scope:null,stage:'review',reviewRound:'r1'},personal=conversationDraftKey(base),publicKey=conversationDraftKey({...base,tab:'group',scope:'talent'});
 assert.notEqual(personal,publicKey);assert.notEqual(publicKey,conversationDraftKey({...base,tab:'group',scope:'talent',memberId:'member-04'}));assert.notEqual(publicKey,conversationDraftKey({...base,tab:'group',scope:'talent',reviewRound:'r2'}));assert.notEqual(publicKey,conversationDraftKey({...base,tab:'group',scope:'talent',stage:'plan'}));
 let current='单元群新输入';const cache={};restoreConversationDraft(cache,personal,'私人未发送内容',publicKey,v=>{current=v;});assert.equal(current,'单元群新输入');assert.equal(cache[personal],'私人未发送内容');assert.equal(cache[publicKey],undefined);
 let text='失败后继续编辑';restoreConversationDraft(cache,personal,'原发送内容',personal,update=>{text=typeof update==='function'?update(text):update;},{merge:true});assert.equal(text,'原发送内容\n\n失败后继续编辑');
 restoreConversationDraft(cache,personal,'原发送内容',personal,update=>{text=update(text);},{merge:true});assert.equal(text,'原发送内容\n\n失败后继续编辑');
});

test('单元群入口带服务端实际目标；仅有复盘、没有旧拆解卡时仍能投递，非真实目标不开放',()=>{
 const state=fixture();delete state.cards.talent;state.round=null;const actor=memberActor('member-08',state),view=sharedProjection(state,actor);assert.equal(view.reviewRooms.unitTargets.talent,'rv:talent');
 const sent=applyAction(state,actor,{type:'message',cardId:view.reviewRooms.unitTargets.talent,text:'合成单元反馈'});assert.equal(sent.messages.at(-1).scope,'talent');assert.deepEqual(sent.cards,state.cards);
 assert.equal(groupRoomAvailable('talent',{personal:null,units:['talent'],unitTargets:{}}),false);
});
