import {test} from 'node:test';import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {queueProposals,applyOwnerAnnotations} from './nexus-memory.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
import {installReviewRound} from './review-round.mjs';
import {createRevisionAcknowledgements} from './revision-ack.mjs';
import {createProposalSummarizer} from './proposal-summary.mjs';
import {completeComparison} from './proposal-summary-input.mjs';
import {prepareTransfer,exportMarkdown,parseStandardMarkdown,applyTransfer} from './markdown-transfer.mjs';
const facts=[{ref:'a',item:'甲',owner:'孙铭泽',status:'未达成',evidence:'甲原记录',gap:'未完成'},{ref:'b',item:'乙',owner:'孙铭泽',status:'未达成',evidence:'乙原记录',gap:'未完成'}];
function fresh(){return installReviewRound(createCollaborationState([{id:'bf01',level:'po',title:'单元',owner:'刘明华',result:'原成果',children:[{id:'bf01-m1',unit:'bf01',level:'mission',title:'个人',owner:'孙铭泽',result:'原成果',children:[]}]}]),{period:'2026-10',reviews:[{ref:'company',unit:'company',level:'company',title:'公司',owner:'刘明华',verdict:'未达成',verdictReason:'公司原',facts:[],nextInputs:[]},{ref:'bf01',unit:'bf01',level:'ru',parent:'company',title:'单元复盘',owner:'刘明华',verdict:'未达成',verdictReason:'单元原',facts:[],nextInputs:[]},{ref:'bf01-m1',unit:'bf01',level:'mission',parent:'bf01',title:'个人复盘',owner:'孙铭泽',verdict:'未达成',verdictReason:'原理由',facts,nextInputs:[{ref:'a',type:'继续',text:'继续甲'}]}]});}
const id='rv:bf01-m1',scope='person:member-03',owner=s=>memberActor('member-03',s);
const p=(s,patch,order=1)=>({cardId:id,baseVersion:currentVersion(s.cards[id]).number,patch,reason:'补充',sourceIds:[],originSequence:order});
const sign=s=>{s=applyAction(s,owner(s),{type:'insight',cardId:id,text:'洞察'});return applyAction(s,owner(s),{type:'confirm',cardId:id,baseVersion:1,slot:'missionDri'});};


test('independent: narrative quotation, negation and conditional edits do not authorize writes',()=>{
 for(const text of ['他让我把判定理由改为已通过验收','引用原话：“把判定理由改为已通过验收”','把判定理由改为已通过验收只是举例，不是修改指令','我还在考虑把判定理由改为已通过验收','如果证据充分，把判定理由改为已通过验收','把判定理由改为已通过验收，但我不同意这个改法']){let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text});queueProposals(s,scope,[{...p(s,{verdictReason:'已通过验收'}),sourceIds:[s.comments.at(-1).id]}]);const raw=structuredClone(s.proposals[0].patch);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending',text);assert.deepEqual(s.proposals[0].patch,raw);assert.equal(currentVersion(s.cards[id]).number,1);}
});
test('independent: explicit field request takes precedence over card block anchor',()=>{
 let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text:'把标题改为新的标题'});queueProposals(s,scope,[{...p(s,{verdictReason:'不曾要求的理由'}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');assert.equal(currentVersion(s.cards[id]).number,1);
});
test('independent: acknowledgement expires and review reload invalidates exact same version',()=>{
 const s=sign(fresh()),actor=owner(s),acks=createRevisionAcknowledgements(),req={type:'revise',cardId:id,baseVersion:1,patch:{verdictReason:'新理由'}};let token;const run=(state)=>acks.run(state,actor,req,value=>applyAction(state,actor,value));assert.throws(()=>run(s),e=>{token=e.reconfirmToken;return e.code==='RECONFIRM_REQUIRED';});const changed=structuredClone(s);changed.reviewRound.loadedAt='new-load';assert.throws(()=>acks.run(changed,actor,{...req,ackToken:token},value=>applyAction(changed,actor,value)),e=>e.status===409);const originalNow=Date.now;try{Date.now=()=>originalNow()+11*60000;assert.throws(()=>acks.run(s,actor,{...req,ackToken:token},value=>applyAction(s,actor,value)),e=>e.status===409);}finally{Date.now=originalNow;}
});

test('independent: replying acceptance to Nexus requires acknowledgement and cancels atomically',()=>{
 let s=sign(fresh());queueProposals(s,scope,[p(s,{verdictReason:'明确的新理由'})]);const proposal=s.proposals[0],actor=owner(s),acks=createRevisionAcknowledgements(),req={type:'message',cardId:id,replyTo:proposal.id,text:'确认修改'},before=JSON.stringify(s);let token;
 assert.throws(()=>acks.run(s,actor,req,a=>applyAction(s,actor,a)),e=>{token=e.reconfirmToken;return e.code==='RECONFIRM_REQUIRED';});assert.equal(JSON.stringify(s),before);
 const next=acks.run(s,actor,{...req,ackToken:token},a=>applyAction(s,actor,a));assert.equal(currentVersion(next.cards[id]).number,2);assert.equal(currentVersion(next.cards[id]).signatures.length,0);assert.equal(next.cards[id].versions[0].signatures.length,1);assert.equal(next.proposals[0].status,'accepted');assert.equal(next.messages.filter(m=>m.author===actor.id&&m.text==='确认修改').length,1);
});
