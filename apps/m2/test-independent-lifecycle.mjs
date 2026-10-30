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

test('independent: explicit opposition is never an automatic edit instruction',()=>{
 for(const text of ['我不同意把判定理由改为已通过验收','我反对把判定理由改为已通过验收','我不认可把判定理由改为已通过验收']){let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text});queueProposals(s,scope,[{...p(s,{verdictReason:'已通过验收'}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending',text);assert.equal(currentVersion(s.cards[id]).number,1);}
});
test('independent: evidence-only request cannot auto change status on same fact row',()=>{
 let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'facts',item:0,text:'把这一项证据改为新的证据'});queueProposals(s,scope,[{...p(s,{facts:facts.map((f,i)=>i?f:{...f,evidence:'新的证据',status:'达成'})}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');assert.equal(currentVersion(s.cards[id]).content.facts[0].status,'未达成');
});
