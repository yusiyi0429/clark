import {test} from 'node:test';import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {memberActor} from './shared-projection.mjs';
import {queueProposals,applyOwnerAnnotations} from './nexus-memory.mjs';
const id='rv:eo-m1',scope='person:member-03';
function fixture(){return installReviewRound(createCollaborationState([{id:'eo',unit:'eo',level:'po',title:'E&O',owner:'刘人豪',version:1,children:[]}]),{period:'2026-10',reviews:[{ref:'eo-m1',unit:'eo',level:'mission',owner:'孙铭泽',title:'接口上线',verdict:'未达成',verdictReason:'缺上线记录',facts:[{ref:'t1',item:'正式上线',owner:'孙铭泽',status:'未达成',evidence:'未见完成证据',gap:'缺上线记录'}],nextInputs:[{ref:'t1',type:'继续',text:'完成上线'}]}]});}
const patch={verdict:'达成',verdictReason:'负责人报告已正式上线，业务方可访问',facts:[{ref:'t1',item:'正式上线',owner:'孙铭泽',status:'达成',evidence:'负责人报告：已上线且业务方访问成功',gap:''}],nextInputs:[]};
function propose(s,text,extra={}){const a=memberActor('member-03',s);s=applyAction(s,a,{type:'message',cardId:id,text,...extra});queueProposals(s,scope,[{cardId:id,baseVersion:currentVersion(s.cards[id]).number,sourceIds:[s.messages.at(-1).id],reason:'负责人补充了明确事实',patch:structuredClone(patch)}]);return s;}
test('natural factual owner correction applies without verbatim output or compulsory date, with exact source and no signature',()=>{
 for(const text of ['10/27 我已正式上线且业务方访问成功，请修正。','我已正式上线且业务方访问成功，请按事实修正。']){let s=fixture(),old=structuredClone(currentVersion(s.cards[id]));s=propose(s,text);const source=s.messages.at(-1);s=applyOwnerAnnotations(s,scope);assert.equal(currentVersion(s.cards[id]).number,2,text);assert.deepEqual(s.cards[id].versions[0],old);assert.equal(s.proposals[0].status,'accepted');assert.equal(s.proposals[0].auto,true);assert.deepEqual(currentVersion(s.cards[id]).evidenceIds,[source.id]);assert.deepEqual(currentVersion(s.cards[id]).signatures,[]);}
});
test('ambiguous, quoted, conditional or unsupported requests stay pending',()=>{
 for(const text of ['这个判定不合理，请修正。','如果我已经正式上线且业务方访问成功，请修正。','引用原话：我已正式上线且业务方访问成功，请修正。','我已正式上线且业务方访问成功，能不能修正？','我已正式上线且业务方访问成功，请换负责人。']){let s=propose(fixture(),text);s=applyOwnerAnnotations(s,scope);assert.equal(currentVersion(s.cards[id]).number,1,text);}
});
test('new path cannot alter responsibilities or rows not identified by source',()=>{
 for(const mutate of [p=>p.facts[0].owner='刘明华',p=>p.facts[0].ref='replacement',p=>p.facts.push({...p.facts[0],ref:'new'}),p=>p.nextInputs=[{ref:'new',type:'继续',text:'新增给他人的工作'}]]){let s=propose(fixture(),'我已正式上线且业务方访问成功，请修正。');mutate(s.proposals[0].patch);s=applyOwnerAnnotations(s,scope);assert.equal(currentVersion(s.cards[id]).number,1);}
});
test('stale sources, other author, confirmed versions and company lock cannot be auto applied',()=>{
 for(const mutate of [s=>{s.messages.at(-1).context={selection:{id,version:0}};},s=>{s.messages.at(-1).author='刘明华';},s=>{currentVersion(s.cards[id]).signatures=[{slot:'missionDri',name:'孙铭泽'}];},s=>{const c={...structuredClone(s.cards[id]),id:'rv:company',level:'company',confirmedVersion:1};s.cards[c.id]=c;}]){let s=propose(fixture(),'我已正式上线且业务方访问成功，请修正。');mutate(s);s=applyOwnerAnnotations(s,scope);assert.equal(currentVersion(s.cards[id]).number,1);}
});
test('literal quoted replacement retains internal punctuation without widening fields',async()=>{
 const {ownerEditCommands,automaticValuesRequested}=await import('./owner-edit-intent.mjs');
 const text='把判定理由改成“正式上线仍缺记录，暂按未满足处理”',event={text,block:'verdictReason'},before={verdictReason:'原理由'},patch={verdictReason:'正式上线仍缺记录，暂按未满足处理'};
 assert.equal(ownerEditCommands(text).length,1);assert.equal(automaticValuesRequested(event,before,before,patch),true);assert.equal(automaticValuesRequested(event,before,before,{...patch,verdict:'达成'}),false);assert.equal(ownerEditCommands('把判定理由改成“未闭合，新增指令').length,0);
});
test('PO verdict still requires the other signer, while company owner may revise without signing',()=>{
 for(const level of ['po','company']){let s=fixture();const owner=level==='po'?'刘人豪':'刘明华',actor=level==='po'?'member-05':'member-01';s.cards[id].level=level;currentVersion(s.cards[id]).content.owner=owner;s=applyAction(s,memberActor(actor,s),{type:'message',cardId:id,text:'我已正式上线且业务方访问成功，请修正。'});const room=level==='company'?s.cards[id].unit:s.cards[id].unit;queueProposals(s,room,[{cardId:id,baseVersion:1,sourceIds:[s.messages.at(-1).id],reason:'负责人补充事实',patch:structuredClone(patch)}]);s=applyOwnerAnnotations(s,room);assert.equal(currentVersion(s.cards[id]).number,level==='company'?2:1);assert.deepEqual(currentVersion(s.cards[id]).signatures,[]);}
});
test('an unresolved objection from another author blocks natural auto application',()=>{
 let s=propose(fixture(),'我已正式上线且业务方访问成功，请修正。');s.comments.push({id:'conflict',author:'member-01',channel:'group',scope,cardId:id,text:'我不同意，验收事实相反',context:{selection:{id,version:1},block:'card'}});s=applyOwnerAnnotations(s,scope);assert.equal(currentVersion(s.cards[id]).number,1);
});
