import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcceptanceApp, actors } from './fixture.mts';
import { scanIntake } from '../../../apps/api/src/workIntake.js';

const src='https://synthetic-chat.invalid';
const key='synthetic-in-process-chat';
const previousFetch=globalThis.fetch;
const convo=randomUUID();
const calls:{message:string;clientRequestId:string;runId:string}[]=[];
const history:{role:string;text:string;runId:string}[]=[];
const attempts:string[]=[];
let upstreamBusy=false;
let finishFirst=()=>{};
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,src);
  const headers=new Headers(init?.headers);assert.equal(headers.get('x-owner-id'),actors[0].personId);assert.equal(headers.get('authorization'),'Bearer '+key);
  if(url.pathname==='/conversations' && init?.method==='POST') return reply(201,{conversationId:convo});
  if(url.pathname===`/conversations/${convo}/messages`) return reply(200,{messages:history,runs:calls.map(c=>({runId:c.runId,status:'succeeded'})),nextCursor:null});
  assert.equal(url.pathname,`/conversations/${convo}/turns`);assert.equal(init?.method,'POST');
  const {message,clientRequestId}=JSON.parse(String(init.body));const runId=randomUUID();
  attempts.push(clientRequestId);
  if(upstreamBusy) return reply(409,{error:{code:'TURN_RUNNING',message:'另一轮还在运行'}});
  calls.push({message,clientRequestId,runId});history.push({role:'user',text:message,runId});
  const source=new ReadableStream({start(controller){
    const frame=(e:any)=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({conversationId:convo,scope:'global',runId,...e})+'\n\n'));
    frame({type:'turn_started',userMessageId:randomUUID()});
    const complete=()=>{const text='已承接 '+message;history.push({role:'assistant',text,runId});frame({type:'message',delta:text});frame({type:'done',status:'completed'});controller.close();};
    if(calls.length===1) finishFirst=complete; else complete();
  }});
  return new Response(source,{headers:{'content-type':'text/event-stream'}});
};
const f=await createAcceptanceApp({env:{chatServiceUrl:src,internalChatToken:key}});
const wait=async(fn:()=>Promise<boolean>|boolean,msg:string)=>{const until=Date.now()+16000;do {if(await fn())return;await delay(40);}while(Date.now()<until);throw Error(msg);};
const ok=(response:any,expected=200)=>{assert.equal(response.statusCode,expected,response.body);return response.json();};
try {
  const a=await f.login(0), b=await f.login(1);
  const p=ok(await f.call(a,'POST','/api/me/projects',{name:'两条连续追加'}),201);
  const scope='project:'+p.projectId,base='/api/me/work-intake',list=base+'?scope='+encodeURIComponent(scope);
  const turns=[{id:randomUUID(),message:'先核对初稿'}, {id:randomUUID(),message:'再加入新材料'}];
  const state=async(id:string)=>(await f.pool.query('SELECT state,last_error FROM work_intake WHERE id=$1',[id])).rows[0]?.state;
  ok(await f.call(a,'POST',base,{...turns[0],scope,attachments:[]}));
  await wait(()=>calls.length===1,'first actual Chat command reached synthetic response engine');
  ok(await f.call(a,'POST',base,{...turns[1],scope,attachments:[]}));
  assert.deepEqual(ok(await f.call(await f.login(0),'GET',list)).items.map((i:any)=>[i.id,i.state]),[[turns[0].id,'sending'],[turns[1].id,'queued']]);
  assert.equal((await f.call(b,'GET',list)).statusCode,404);
  assert.deepEqual(calls.map(c=>c.message),[turns[0].message]);
  finishFirst();await wait(async()=>await state(turns[0].id)==='delivered','first intake did not deliver');
  await scanIntake({app:f.app,pool:f.pool,env:f.env});
  await wait(async()=>await state(turns[1].id)==='delivered','second intake did not deliver on scheduler');
  assert.deepEqual(calls.map(c=>[c.clientRequestId,c.message]),turns.map(t=>[t.id,t.message]));
  const transcript=ok(await f.call(a,'GET',`/api/conversations/${encodeURIComponent(scope)}/messages`)).messages;
  assert.deepEqual(transcript.map((m:any)=>[m.role,m.content]),turns.flatMap(t=>[['user',t.message],['assistant','已承接 '+t.message]]));
  assert.deepEqual(ok(await f.call(await f.login(0),'GET',list)).items.map((i:any)=>[i.id,i.state]),turns.map(t=>[t.id,'delivered']));
  const q=f.pool.query.bind(f.pool),quiet=new Date('2026-11-10T12:00:00.000Z');
  const existingQuestion=async()=>{const id=randomUUID();await q(`INSERT INTO buddy_questions(id,owner_id,scope,run_id,questions,created_at)
    VALUES($1,$2,$3,$4,'[]'::jsonb,now())`,[id,actors[0].personId,scope,randomUUID()]);return id;};
  const setQuiet=()=>q('UPDATE projects SET quiet_since=$2,auto_relay_count=4 WHERE id=$1',[p.projectId,quiet]);
  const markers=async(id:string)=>{const marker=(await q(`SELECT p.quiet_since,p.auto_relay_count,b.status FROM projects p,buddy_questions b
    WHERE p.id=$1 AND b.id=$2`,[p.projectId,id])).rows[0];return [marker.quiet_since?.toISOString()??null,marker.auto_relay_count,marker.status];};
  const before=await existingQuestion();await setQuiet();upstreamBusy=true;
  const third={id:randomUUID(),message:'在上游忙时追加'};
  ok(await f.call(a,'POST',base,{...third,scope,attachments:[]}));
  await wait(async()=>attempts.includes(third.id) && await state(third.id)==='queued','upstream 409 was not retained for retry');
  assert.deepEqual(await markers(before),[quiet.toISOString(),4,'open']);assert.equal(calls.length,2);
  upstreamBusy=false;await scanIntake({app:f.app,pool:f.pool,env:f.env});
  await wait(async()=>await state(third.id)==='delivered','queue retry did not deliver');
  assert.deepEqual(await markers(before),[null,0,'dismissed']);assert.equal(calls.length,3);
  const accepted=(await q('SELECT accepted_at FROM work_intake WHERE id=$1',[third.id])).rows[0];assert.ok(accepted.accepted_at);
  const nextQuestion=await existingQuestion();await setQuiet();const sentAttempts=attempts.length;
  await q(`UPDATE work_intake SET state='sending',claim_id=$2,lease_until=now()-interval '2 minutes' WHERE id=$1`,[third.id,randomUUID()]);
  await scanIntake({app:f.app,pool:f.pool,env:f.env});await wait(async()=>await state(third.id)==='delivered','accepted stale claim did not recover');
  assert.deepEqual(await markers(nextQuestion),[quiet.toISOString(),4,'open']);assert.equal(attempts.length,sentAttempts);
  console.log(JSON.stringify({freshQueuedTurns:2,firstStillRunningWhenSecondAccepted:true,realConfiguredChatDispatch:true,normalChatHistoryReturnedFourMessages:true,
    sameProjectAndSyntheticMember:true,stableChatRequestIds:true,schedulerDeliveredInOriginalOrder:true,upstream409PreservedQuestionAndQuiet:true,
    actualAcceptanceClosedAndReset:true,durableAcceptanceRestoredWithoutSecondUpstreamCall:true,newerQuestionStayedOpen:true,fixture:'in-process Chat protocol, no network'}));
}finally{globalThis.fetch=previousFetch;await f.close();}
