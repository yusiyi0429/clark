import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCollaborationState,currentVersion} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {readDebugReviews,mayDebugReviews,debugReviewAudit} from './debug-review.mjs';

function fixture(){
 const base=createCollaborationState([{id:'agents',level:'po',title:'Agents',owner:'刘明华',version:1,children:[]}]);
 const state=installReviewRound(base,{period:'2026-10',reviews:[
  {unit:'company',level:'company',ref:'company',title:'公司',owner:'刘明华',verdict:'未达成',facts:[],nextInputs:[]},
  {unit:'agents',level:'ru',ref:'agents',title:'Agents',owner:'刘明华',verdict:'未达成',facts:[],nextInputs:[]},
  {unit:'agents',level:'mission',ref:'agents-m1',title:'参会',owner:'陈溪南',verdict:'部分达成',facts:[],nextInputs:[]},
 ]});
 state.messages.push(
  {id:'public',channel:'group',scope:'agents',author:'member-04',text:'公开反馈',createdAt:'2026-10-30T01:00:00Z'},
  {id:'personal',channel:'group',scope:'person:member-04',author:'member-04',text:'PERSONAL_SECRET',createdAt:'2026-10-30T01:01:00Z'},
  {id:'private',channel:'private',memberId:'member-04',author:'Agent',text:'AGENT_SECRET',createdAt:'2026-10-30T01:02:00Z'},
 );
 state.comments.push({id:'private-comment',cardId:'rv:agents-m1',scope:'person:member-04',author:'member-04',text:'COMMENT_SECRET',createdAt:'2026-10-30T01:03:00Z'});
 currentVersion(state.cards['rv:agents-m1']).content.insights={mine:[{text:'INSIGHT_SECRET'}]};
 return state;
}
test('debug entry is restricted to the three approved actual members',async()=>{
 assert.deepEqual(['member-01','member-04','member-08'].map(mayDebugReviews),[true,true,true]);
 const state=fixture();let calls=0;
 for(const memberId of ['member-02','member-03','member-07',null])await assert.rejects(readDebugReviews({session:{memberId},targetId:'member-01',state},()=>calls++),{status:403});
 assert.equal(calls,0);
 for(const memberId of ['member-01','member-04','member-08'])assert.equal((await readDebugReviews({session:{memberId},targetId:'member-04',state},()=>calls++)).actorId,memberId);
});
test('target projection returns review cards and public rooms, never private conversations, unpublished insights or plan cards',async()=>{
 const state=fixture(),before=structuredClone(state),session={memberId:'member-08'},audit=[];
 const view=await readDebugReviews({session,targetId:'member-04',state},e=>audit.push(e));
 assert.equal(view.readOnly,true);assert.equal(view.targetId,'member-04');assert.equal(view.actorId,'member-08');
 assert.ok(view.cards.some(c=>c.id==='rv:agents-m1'));assert.ok(!view.cards.some(c=>c.id==='rv:company'||c.id==='agents'));
 assert.ok(view.groups.some(g=>g.messages.some(m=>m.text==='公开反馈')));
 assert.doesNotMatch(JSON.stringify(view),/PERSONAL_SECRET|AGENT_SECRET|COMMENT_SECRET|INSIGHT_SECRET|group:person:|private:/);
 assert.deepEqual(state,before);assert.deepEqual(session,{memberId:'member-08'});assert.equal(audit[0].actorId,'member-08');assert.equal(audit[0].targetId,'member-04');
});
test('invalid targets and all mutating methods fail without an audit success',async()=>{
 const state=fixture();let calls=0;const audit=()=>calls++;
 for(const targetId of ['__proto__','constructor','unknown',''])await assert.rejects(readDebugReviews({session:{memberId:'member-01'},targetId,state},audit),{status:400});
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD'])await assert.rejects(readDebugReviews({session:{memberId:'member-01'},targetId:'member-04',state,method},audit),{status:405});
 assert.equal(calls,0);
});
test('an unavailable audit sink blocks disclosure; audit file contains principals without review content',async()=>{
 const request={session:{memberId:'member-01'},targetId:'member-04',state:fixture()};
 await assert.rejects(readDebugReviews(request,async()=>{throw Error('disk full');}),{status:503});
 const dir=await mkdtemp(join(tmpdir(),'m2-debug-'));
 try{const path=join(dir,'access.jsonl');await readDebugReviews(request,debugReviewAudit(path));const log=await readFile(path,'utf8'),entry=JSON.parse(log);assert.equal(entry.actorId,'member-01');assert.equal(entry.targetId,'member-04');assert.doesNotMatch(log,/SECRET|公开反馈/);}finally{await rm(dir,{recursive:true,force:true});}
});

test('debug shows published insights and Nexus synthesis without exposing newer private edits by the target',async()=>{
 const state=fixture(),id='rv:agents-m1';
 state.cards[id].confirmedVersion=1;state.insightsRevealed={at:'2026-10-31T01:00:00Z'};
 state.insightPublications={[id]:{version:1,items:[{id:'published',author:'member-04',text:'PUBLIC_INSIGHT',createdAt:'2026-10-30T01:00:00Z'}]}};
 state.insights={[id]:[{id:'later-draft',author:'member-04',text:'LATER_PRIVATE_INSIGHT',createdAt:'2026-11-01T01:00:00Z'}]};
 state.insightNexus={[id]:{text:'PUBLIC_SYNTHESIS'}};
 const view=await readDebugReviews({session:{memberId:'member-08'},targetId:'member-04',state},()=>{});
 assert.match(JSON.stringify(view),/PUBLIC_INSIGHT/);assert.match(JSON.stringify(view),/PUBLIC_SYNTHESIS/);
 assert.doesNotMatch(JSON.stringify(view),/LATER_PRIVATE_INSIGHT/);
 const mission=view.cards.find(c=>c.id===id);assert.equal(mission.publicInsights.items[0].text,'PUBLIC_INSIGHT');assert.equal(mission.publicInsights.nexus.text,'PUBLIC_SYNTHESIS');
 delete state.insightsRevealed;
 const closed=await readDebugReviews({session:{memberId:'member-08'},targetId:'member-04',state},()=>{});
 assert.doesNotMatch(JSON.stringify(closed.cards.find(c=>c.id===id)),/PUBLIC_SYNTHESIS|LATER_PRIVATE_INSIGHT/);
 assert.match(JSON.stringify(closed.cards.find(c=>c.id==='rv:agents')),/PUBLIC_INSIGHT/,'already published Mission insights remain visible in their PO rollup');
});
