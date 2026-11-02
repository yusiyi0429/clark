import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startValues,reviewEditRequest} from './review-edit.mjs';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {memberActor} from './shared-projection.mjs';
function fixture(){return installReviewRound(createCollaborationState([{id:'eo',unit:'eo',level:'po',title:'E&O',owner:'刘人豪',version:1,children:[]}]),{period:'2026-10',reviews:[{ref:'eo-m1',unit:'eo',level:'mission',owner:'孙铭泽',title:'接口上线',verdict:'未达成',verdictReason:'缺上线记录 [E1]',facts:[{ref:'t1',item:'正式上线',owner:'孙铭泽',status:'未达成',evidence:'**缺记录** [E1]',gap:'待验收'}],nextInputs:[{ref:'t1',type:'继续',text:'完成上线'}]}]});}
const view=s=>({id:'rv:eo-m1',...currentVersion(s.cards['rv:eo-m1']).content,version:currentVersion(s.cards['rv:eo-m1']).number});
test('manual revision requires no model, preserves evidence/originals/history and never signs',()=>{
 let state=fixture();const actor=memberActor('member-03',state),node=view(state),original=structuredClone(state.cards[node.id].versions[0]);
 const values=startValues(node);values.verdictReason='负责人已提供上线记录';values.facts[0].evidence='10/27 已上线，业务方可访问';
 const action=reviewEditRequest(node,node,values);state=applyAction(state,actor,action);
 assert.deepEqual(state.cards[node.id].versions[0],original);assert.equal(currentVersion(state.cards[node.id]).number,2);assert.deepEqual(currentVersion(state.cards[node.id]).signatures,[]);assert.equal(currentVersion(state.cards[node.id]).content.facts[0].evidence,values.facts[0].evidence);assert.match(currentVersion(state.cards[node.id]).content.verdictReason,/\[E1\]/);assert.ok(state.audit.some(x=>x.type==='revise'&&x.actorId===actor.id));
});
test('unchanged manual fields preserve exact evidence and optional metadata',()=>{
 const node=view(fixture()),values=startValues(node);assert.deepEqual(reviewEditRequest(node,node,values).patch,{});
});
test('polling cannot rebase old input onto a new version; server also rejects a race after submit',()=>{
 let state=fixture();const actor=memberActor('member-03',state),baseline=view(state),values=startValues(baseline);values.verdictReason='尚未保存的输入';
 const request=reviewEditRequest(baseline,baseline,values);state=applyAction(state,actor,{type:'revise',cardId:baseline.id,baseVersion:1,patch:{verdictReason:'其他窗口已修改'}});const before=JSON.stringify(state);
 assert.throws(()=>reviewEditRequest(baseline,view(state),values),e=>e.status===409);assert.throws(()=>applyAction(state,actor,request),e=>e.status===409);assert.equal(JSON.stringify(state),before);assert.equal(values.verdictReason,'尚未保存的输入');
});
