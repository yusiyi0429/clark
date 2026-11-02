import {test} from 'node:test';
import assert from 'node:assert/strict';
import {urgentNexusEvent,validateNexusResult} from './nexus-policy.mjs';
import {quietWindowMs} from './nexus-participation.mjs';
import {createCollaborationState,currentVersion} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {reviewCardsFor} from './nexus-review.mjs';
import {queueProposals,applyOwnerAnnotations} from './nexus-memory.mjs';

const card={id:'rv:agents-m1',kind:'review',level:'mission',owner:'陈溪南',title:'内部会议',version:2,versionCreatedAt:'2026-10-30T02:00:00Z',status:'待确认',verdict:'未达成',facts:[],nextInputs:[]};
const old={id:'old',author:'陈溪南',kind:'document-comment',scope:'person:member-04',text:'请将判定改为达成',createdAt:'2026-10-30T01:00:00Z',context:{selection:{id:card.id,version:1},block:'verdict'}};
const fresh={id:'new',author:'陈溪南',kind:'document-comment',scope:'person:member-04',text:'请将判定改为达成',createdAt:'2026-10-30T03:00:00Z',context:{selection:{id:card.id,version:2},block:'verdict'}};
const proposed={cardId:card.id,baseVersion:2,sourceIds:['old','new'],patch:{verdict:'达成'}};
const check=({p=proposed,latest=fresh,history=old,freshRows=[latest],c=card}={})=>validateNexusResult({topics:[],proposals:[p]},{cards:[c],evidence:[history,latest],fresh:freshRows});

test('explicit revisions are urgent, ordinary discussion retains its 20 second batching window',()=>{
 assert.equal(quietWindowMs,20000);
 for(const event of [{text:'请把这条判定改为达成'},{text:'按这个改一下'},{text:'我不同意当前判定，请按我补充的事实修改'},{text:'这是啥？',kind:'comment'},{text:'重新出一张修订卡'},{text:'@Nexus 看一下'},{text:'能再说清楚',replyToAuthor:'Nexus'}])assert.equal(urgentNexusEvent(event),true,event.text);
 for(const text of ['我补充一下背景','今天开了两场会','我们还在讨论','暂不修改'])assert.equal(urgentNexusEvent({text}),false,text);
});
test('a fresh current-version request may revisit the V1 conclusion while retaining historical sources',()=>{
 const out=check();assert.equal(out.proposals.length,1);assert.equal(out.proposals[0].baseVersion,2);assert.equal(out.proposals[0].patch.verdict,'达成');assert.deepEqual(out.proposals[0].sourceIds,['old','new']);assert.equal(out.proposals[0].requiresConfirmation,true);
});
test('old-only requests, uncited new opinions, stale base versions and unrelated fields cannot bypass protection',()=>{
 for(const args of [{p:{...proposed,sourceIds:['old']}},{freshRows:[]},{latest:{...fresh,context:{selection:{id:card.id,version:1},block:'verdict'}}},{p:{...proposed,baseVersion:1}},{latest:{...fresh,context:{selection:{id:card.id,version:2},block:'nextInputs'}}},{latest:{...fresh,text:'收到'}},{latest:{...fresh,text:'如果需要请改为达成'}}])assert.equal(check(args).proposals.length,0);
});
test('unanchored owner follow-ups need a new report after the current version was saved',()=>{
 const latest={...fresh,kind:'chat',context:null,text:'@Nexus 事实证据中的三项都是达成了'};
 assert.equal(check({latest}).proposals.length,1);
 for(const change of [{author:'其他人'},{createdAt:'2026-10-30T01:30:00Z'},{scope:'agents'},{text:'收到'},{text:'假设三项都达成了'}])assert.equal(check({latest:{...latest,...change}}).proposals.length,0);
 assert.equal(check({latest,c:{...card,versionCreatedAt:undefined}}).proposals.length,0);
});
test('a current objection and a version changed during generation still block the candidate',()=>{
 const objection={...fresh,author:'刘明华',text:'不同意这个修改'};
 assert.equal(check({latest:objection}).proposals.length,0);
 assert.equal(check({c:{...card,version:3}}).proposals.length,0);
});
test('mixed historical evidence cannot turn an old owner instruction into automatic editing',()=>{
 let state=installReviewRound(createCollaborationState([{id:'agents',level:'po',title:'Agents',owner:'刘明华',children:[]}]),{period:'2026-10',reviews:[{ref:'agents-m1',unit:'agents',level:'mission',title:card.title,owner:card.owner,verdict:'未达成',facts:[],nextInputs:[]}]});
 const c=state.cards[card.id],first=c.versions[0];c.versions.push({...structuredClone(first),number:2,createdAt:card.versionCreatedAt,content:{...first.content,version:2}});
 state.comments=[old,fresh].map(e=>({...e,author:'member-04',channel:'group',scope:'person:member-04',cardId:card.id}));
 queueProposals(state,'person:member-04',check().proposals);state=applyOwnerAnnotations(state,'person:member-04');
 assert.equal(currentVersion(state.cards[card.id]).number,2);assert.equal(currentVersion(state.cards[card.id]).content.verdict,'未达成');assert.equal(state.proposals.at(-1).status,'pending');
 assert.equal(reviewCardsFor(state,'person:member-04')[0].versionCreatedAt,card.versionCreatedAt);
});
