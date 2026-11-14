import assert from 'node:assert/strict';
import { createAcceptanceApp, actors } from './fixture.mts';
import { createMockBitable } from '../../../apps/api/src/feishu/bitable.js';

const f=await createAcceptanceApp({runtime:{now:()=>new Date('2026-11-09T02:00:00Z'),bitable:createMockBitable(),
  collectionAgent:{async draft(){return {scenario:'expense',title:'每周开销核对',recipientIds:[actors[1].personId,actors[2].personId],deadline:null,weekly:true};}}}});
const ok=(response:any)=>{assert.equal(response.statusCode,200,response.body);return response.json();};
try {
  const a=await f.login(0),b=await f.login(1),c=await f.login(2),d=await f.login(3);
  const draft=ok(await f.call(a,'POST','/api/collections/draft',{prompt:'每周请乙丙核对开销'})).collection;
  assert.equal(draft.weekly,true);assert.equal(draft.status,'draft');
  const act=async(who:string,view:any,kind:string,input?:unknown)=>{
    const action=view.actions.find((a:any)=>a.actionType===kind);assert.ok(action,kind);
    return ok(await f.call(who,'POST','/api/collections/actions/execute',{actionId:action.actionId,...(input?{input}:{})})).collection;
  };
  const sent=await act(a,draft,'collection.send',{recipientIds:[actors[1].personId,actors[2].personId],deadlineAt:draft.deadlineAt,weekly:true});
  const id=sent.round.requestId, path='/api/requests/'+id+'/collection';
  const original=async(who:string)=>ok(await f.call(who,'GET',path)).collection;
  assert.deepEqual((await original(b)).entries.map((row:any)=>row.personId),[actors[1].personId]);
  assert.deepEqual((await original(c)).entries.map((row:any)=>row.personId),[actors[2].personId]);
  assert.equal((await f.call(d,'GET',path)).statusCode,404);
  const save=await act(b,await original(b),'collection.save',{values:{amount:'50',purpose:'试用',project:'现有项目',receipt:'已有票据'}});
  await act(b,save,'collection.confirm');const summary=await original(a);
  assert.equal(summary.counts.confirmed,1);assert.equal(summary.counts.total,2);
  assert.deepEqual((await original(c)).entries.map((row:any)=>row.status),['empty']);
  assert.ok(ok(await f.call(b,'GET','/api/me/requests?box=inbox')).items.some((row:any)=>row.id===id));
  console.log(JSON.stringify({fixedWeekly:true,realExistingRequestsAndCollectionFlow:true,oneOfTwoConfirmed:true,otherPersonIndependent:true,outsideCeoCannotRead:true,externalTable:'fixture'}));
}finally{await f.close();}
