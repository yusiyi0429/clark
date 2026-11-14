import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAcceptanceApp, actors } from './fixture.mts';
import { NEXUS_DRI_REQUESTS_PATH, nexusDriIdempotencyKey } from '../../../packages/contracts/src/nexusDri.js';
import { requestFingerprint } from '../../../apps/api/src/nexusDri.js';

const sample=JSON.parse(await readFile(new URL('../../../apps/api/test/fixtures/nexus-dri-contract-examples.json',import.meta.url),'utf8')).request;
const serviceToken='fixture-service-only';
const f=await createAcceptanceApp({worldPeople:{[actors[0].personId]:sample.proposedConfirmers[0]},env:{
  nexusDri:{serviceToken,tenantId:sample.recipientTenant,agentId:sample.agentId}},runtime:{now:()=>new Date(sample.createdAt+60_000)}});
const ok=(response:any,...statuses:number[])=>{assert.ok((statuses.length?statuses:[200]).includes(response.statusCode),`${response.statusCode}: ${response.body}`);return response.json();};
const base='/api/me/meeting-work-handoffs';
try {
  const a=await f.login(0),b=await f.login(1);
  const project=ok(await f.call(a,'POST','/api/me/projects',{name:'品牌建设'}),201);
  const topics=[];
  for(const name of ['Logo','词元云集官网','睿积官网']) {const id=randomUUID();topics.push({id,kind:'topic',projectId:project.projectId,instruction:'按已有工作范围接续：'+name});
    await f.pool.query('INSERT INTO research_topics(id,owner_id,title,project_id) VALUES($1,$2,$3,$4)',[id,actors[0].personId,name,project.projectId]);}
  const feed=async()=>ok(await f.call(a,'GET',`/api/me/projects/${project.projectId}/feed`)).items.filter((row:any)=>row.kind==='meeting_handoff');
  const req={...sample, question:'确认这次品牌调整？',content:{...sample.content,value:'已确认品牌方向和两个官网内容。'}};
  req.fingerprint=requestFingerprint(req);
  ok(await f.call(undefined,'POST',NEXUS_DRI_REQUESTS_PATH,JSON.stringify(req),{'content-type':'application/json',authorization:'Bearer '+serviceToken,'idempotency-key':nexusDriIdempotencyKey(req.requestId,req.revision)}));
  const confirmable=ok(await f.call(a,'GET','/api/me/nexus-confirmations')).items;
  assert.equal(confirmable.length,1);assert.deepEqual(ok(await f.call(a,'GET',base)).items,[]);
  const confirmed=ok(await f.call(a,'POST',`/api/me/nexus-confirmations/${confirmable[0].id}/decision`,{decision:'confirmed'}));
  const url=`${base}/${confirmed.confirmationRef}`;
  assert.equal(ok(await f.call(a,'GET',base)).items[0].receipts.length,0);assert.deepEqual(await feed(),[]);
  assert.deepEqual(ok(await f.call(b,'GET',base)).items,[]);
  assert.ok([403,404].includes((await f.call(b,'POST',url,{authorization:'continue',revision:1,targets:topics})).statusCode));
  assert.equal((await f.call(a,'POST',url,{revision:1,targets:topics})).statusCode,400);
  assert.equal((await f.call(a,'POST',url,{authorization:'continue',revision:2,targets:topics})).statusCode,409);
  // Independent outcomes: the two original topics are active, the third target is temporarily unavailable.
  await f.pool.query("UPDATE research_topics SET status='archived' WHERE id=$1",[topics[2].id]);
  const send=async(targets:any[])=>ok(await f.call(a,'POST',url,{authorization:'continue',revision:1,targets})).receipts;
  const first=await send(topics);
  const forTopic=(rows:any[],index:number)=>rows.find((r:any)=>r.target.id===topics[index].id);
  assert.deepEqual(topics.map((_,i)=>forTopic(first,i).status),['delivered','delivered','failed']);
  assert.equal((await feed()).length,2);
  const brief=(id:string)=>f.call(a,'GET',`/api/me/topics/${id}/brief`);
  for (const topic of topics.slice(0,2)) {
    const loaded=ok(await brief(topic.id)).markdown;
    assert.ok(loaded.includes(confirmed.confirmationRef));assert.ok(loaded.includes(topic.instruction));
    assert.ok(loaded.includes(req.content.value));
  }
  await f.pool.query("UPDATE research_topics SET status='active' WHERE id=$1",[topics[2].id]);
  const retried=await send([topics[2]]);assert.equal(retried[0].status,'delivered');assert.equal(retried[0].id,forTopic(first,2).id);
  assert.ok(ok(await brief(topics[2].id)).markdown.includes(topics[2].instruction));
  assert.equal((await f.call(b,'GET',`/api/me/topics/${topics[2].id}/brief`)).statusCode,404);
  const replay=await send(topics);assert.deepEqual(topics.map((_,i)=>forTopic(replay,i).id),topics.map((_,i)=>forTopic(first,i).id));
  const all=await feed();assert.equal(all.length,3);assert.equal(new Set(all.map((row:any)=>row.conclusion.meetingId)).size,1);
  const work=await f.pool.query('SELECT count(*)::int AS n FROM local_runs');assert.equal(work.rows[0].n,0);
  const deliveries=await f.pool.query('SELECT count(*)::int AS n FROM deliverable_versions');assert.equal(deliveries.rows[0].n,0);
  console.log(JSON.stringify({handoffsPassed:true, confirmedOnlyNoWork:true,nonConfirmingOwnerDenied:true,wrongRevisionDenied:true,
    threeExistingDestinations:true, firstReceiptStates:first.map((r:any)=>r.status),successfulTargetsUnaffected:true,
    sameSourceAllThree:true,projectFeedShowsThree:true,threeExistingTopicExecutionBriefsReceivedInstructions:true,localRuns:0,deliverableVersions:0}));
}finally{await f.close();}
