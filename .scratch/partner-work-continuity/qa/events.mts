import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceApp, actors } from './fixture.mts';
import { recordStopReport, recordSubSessionStatus } from '../../../apps/api/src/subSessionReports.js';

const f=await createAcceptanceApp();
const ok=(res:any,expected=200)=>{assert.equal(res.statusCode,expected,res.body);return res.json();};
try {
  const a=await f.login(0), b=await f.login(1);
  const owner=actors[0].personId,p=ok(await f.call(a,'POST','/api/me/projects',{name:'标志和官网'}),201);
  const token=randomUUID(), device=randomUUID(),now=new Date(),q=f.pool.query.bind(f.pool);
  await q("INSERT INTO personal_tokens(id,person_id,name,client,secret_hash,created_at) VALUES($1,$2,'测试设备','local','synthetic-only',$3)",[token,owner,now]);
  await q("INSERT INTO local_devices(owner_id,id,token_id,name,os,last_sync_at) VALUES($1,$2,$3,'验收用电脑','win32',$4)",[owner,device,token,now]);
  const request={requestId:'approval-1',toolName:'Read',title:'核对已批准的附件',outsidePaths:[]};
  const ask={kind:'permission',request};
  const make=async(name:string, state:string, blocking:boolean)=>{
    const id=randomUUID(),run=randomUUID();
    await q('INSERT INTO research_topics(id,owner_id,title,project_id) VALUES($1,$2,$3,$4)',[id,owner,name,p.projectId]);
    await q(`INSERT INTO local_runs(id,owner_id,device_id,kind,topic_id,state,title,started_at,updated_at,ask)
      VALUES($1,$2,$3,'topic',$4,$5,$6,$7,$7,$8::jsonb)`,[run,owner,device,id,state,name,now,blocking?JSON.stringify(ask):null]);
    return {id:run,kind:'topic' as const,task_id:null,topic_id:id,device_id:device};
  };
  const logo=await make('品牌 Logo','waiting_permission',true), web=await make('官网内容','running',false);
  const first=await recordSubSessionStatus(q,owner,logo,{status:'waiting_permission',permission:request},now);
  await recordSubSessionStatus(q,owner,logo,{status:'waiting_permission',permission:request},now);
  const ordinary=await recordStopReport(q,owner,web,{why:'turn_done',summary:'普通的一轮报告',blocker:null,outputs:[]} as any,now);
  const blocked=await recordStopReport(q,owner,logo,{why:'held',summary:'等签收',blocker:'缺少本人的输入',outputs:[]} as any,now);
  const path='/api/me/partner-work-events';
  const events=ok(await f.call(a,'GET',path)).items;
  const decision=events.find((x:any)=>x.id===first.decision);
  assert.ok(decision,JSON.stringify(events)); assert.equal(events.filter((x:any)=>x.id===first.decision).length,1);
  assert.ok(events.some((x:any)=>x.id===blocked.report));assert.equal(events.some((x:any)=>x.id===ordinary.report),false);
  const home=ok(await f.call(a,'GET','/api/me/work-home'));
  const waiting=home.waiting.find((x:any)=>x.id===decision.waitingId);
  assert.ok(waiting,JSON.stringify(home.waiting));assert.deepEqual(waiting.open,{kind:'project',id:p.projectId,focus:{sessionId:logo.id,requestId:request.requestId}});
  assert.equal(home.projects.find((x:any)=>x.projectId===p.projectId).subSessions.find((x:any)=>x.id===web.topic_id).state,'running');
  const feed=ok(await f.call(a,'GET',`/api/me/projects/${p.projectId}/feed`)).items;
  assert.ok(feed.some((x:any)=>x.id===first.decision));assert.ok(feed.some((x:any)=>x.id===ordinary.report));
  assert.equal(ok(await f.call(b,'GET',path)).items.length,0);assert.equal((await f.call(b,'GET',`/api/me/projects/${p.projectId}/feed`)).statusCode,404);
  assert.deepEqual(ok(await f.call(a,'GET',path)).items.map((x:any)=>x.id),events.map((x:any)=>x.id));
  await q("UPDATE local_runs SET state='running',ask=NULL WHERE id=$1",[logo.id]);
  await recordSubSessionStatus(q,owner,logo,{status:'running'},new Date());
  assert.ok(!ok(await f.call(a,'GET',path)).items.some((x:any)=>x.id===first.decision));
  console.log(JSON.stringify({eventsPassed:true,sameProjectEventId:true,homeWaitingFocusExact:true,ordinaryReportsOnlyInProject:true,
    peerWorkStillRunning:true,duplicateSyncNoExtraDecision:true,outsiderExcluded:true,resolvedDecisionRemoved:true}));
}finally{await f.close();}
