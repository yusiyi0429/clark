import {test} from 'node:test';import assert from 'node:assert/strict';
import {frozenAgreedOutcome} from './review-agreed-outcome.mjs';
import {reviewFile} from './review-generation.mjs';
import {installReviewRound} from './review-round.mjs';
import {createCollaborationState,currentVersion,applyAction} from './governance.mjs';
import {memberActor} from './shared-projection.mjs';
test('outcome/result source text stays exact and frozen; missing source is explicit, never guessed from title or commitment',()=>{
 const basis={period:'2026-10',objectId:'mission',sourceVersion:4,effective:false,basisMode:'latest-source-candidate'},object={business:{title:'不能拿标题当成果',blocks:[{components:[{type:'outcome',ref:'mission@4#definition/outcome',text:'第一行\n第二行，保持原文。'}]}]}};
 const result=frozenAgreedOutcome(object,basis);assert.equal(result.items[0].text,'第一行\n第二行，保持原文。');assert.equal(result.sourceBasis.period,'2026-10');assert.equal(result.sourceBasis.sourceVersion,4);assert.equal(result.sourceBasis.effective,false);
 object.business.blocks[0].components[0].text='十一月后来改了';basis.period='2026-11';assert.equal(result.items[0].text,'第一行\n第二行，保持原文。');assert.equal(result.sourceBasis.period,'2026-10');
 assert.equal(frozenAgreedOutcome({business:{title:'不能猜',commitment:'不能截取'}},{}).missing,true);assert.equal(frozenAgreedOutcome({business:{result:'原成果字段'}},{}).items[0].text,'原成果字段');
});
test('source projection survives review file/install without changing verdict, history or confirmation rights',()=>{
 const agreedOutcome=frozenAgreedOutcome({business:{result:'10月原约定成果'}},{period:'2026-10',objectId:'ontology',sourceVersion:3,effective:false});
 const input={period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00',readAt:'2026-11-02T01:00:00Z',stages:[[{id:'eo-m1',unit:'eo',level:'mission',objectId:'ontology',agreedOutcome}],[],[]]};
 const review={ref:'eo-m1',unit:'eo',level:'mission',owner:'孙铭泽',title:'接口上线',verdict:'未达成',verdictReason:'仍缺证据',facts:[],nextInputs:[{ref:'a',type:'继续',text:'继续验收'}]},run={reviews:{'eo-m1':review},raw:{},failed:[]};
 const file=reviewFile(run,input,{skill:{version:'2.1.11',hash:'test'},model:'no-model-called',label:'10月'}),state=installReviewRound(createCollaborationState([{id:'eo',unit:'eo',level:'po',title:'E&O',owner:'刘人豪',children:[]}]),file),card=state.cards['rv:eo-m1'];
 assert.equal(currentVersion(card).content.agreedOutcome.items[0].text,'10月原约定成果');assert.equal(currentVersion(card).content.verdict,'未达成');assert.deepEqual(currentVersion(card).signatures,[]);assert.equal(card.confirmedVersion,null);
 assert.throws(()=>applyAction(state,memberActor('member-03',state),{type:'revise',cardId:card.id,baseVersion:1,patch:{agreedOutcome:{items:[{text:'篡改约定'}]}}}),/修订字段不允许/);
});
