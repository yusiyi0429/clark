import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { createAcceptanceApp } from "./fixture.mts";
import { deliverIntake } from "../../../apps/api/src/workIntake.js";

const origin = "https://qa-queue-rotation.invalid";
const firstSegment = randomUUID();
const laterSegment = randomUUID();
const itemId = randomUUID();
const runtimeFetch = globalThis.fetch;
let busy = true;
let listReads = 0;
const sent: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin,origin);
  if (url.pathname === "/conversations" && (init?.method ?? "GET") === "GET") {
    listReads++;
    const at = new Date().toISOString();
    return Response.json({ conversations:[{conversationId:busy ? firstSegment : laterSegment, createdAt:at,updatedAt:at}] });
  }
  assert.equal(init?.method,"POST");
  const { clientRequestId } = JSON.parse(String(init?.body));
  assert.equal(clientRequestId,itemId);
  assert.equal(url.pathname,`/conversations/${firstSegment}/turns`);
  sent.push(url.pathname);
  if (busy) return Response.json({error:{code:"TURN_IN_PROGRESS",message:"目前还有一轮"}},{status:409});
  const runId = randomUUID();
  const frames = [{type:"turn_started"}, {type:"message",delta:"收到了"}, {type:"done",status:"completed"}];
  return new Response(frames.map(frame=>"data: "+JSON.stringify({...frame,runId,conversationId:firstSegment})+"\n\n").join(""),{headers:{"content-type":"text/event-stream"}});
};
const f = await createAcceptanceApp({env:{chatServiceUrl:origin,internalChatToken:"isolated-queue",chatSessionRotation:true}});
const deps = {app:f.app,pool:f.pool,env:f.env};
try {
  const cookie = await f.login(0);
  const session = (await f.call(cookie,"GET","/api/auth/session")).json();
  const message = "继续原来的首页工作";
  const added = await f.call(cookie,"POST","/api/me/work-intake",{id:itemId,scope:"global",message,attachments:[]});
  assert.equal(added.statusCode,200,added.body);
  const state = async () => (await f.pool.query("SELECT state,chat_segment,accepted_at FROM work_intake WHERE id=$1",[itemId])).rows[0];
  const deadline = Date.now()+12000;
  while (Date.now()<deadline && (!sent.length || (await state()).state !== "queued")) await pause(30);
  assert.equal((await state()).state,"queued");
  assert.equal((await state()).chat_segment.conversationId,firstSegment);
  assert.equal((await state()).accepted_at,null);
  busy = false;
  assert.equal(await deliverIntake(deps,session.personId,"global"),"delivered");
  assert.ok((await state()).accepted_at);
  assert.equal(listReads,1);
  assert.equal(sent.length,2);
  const forged = await f.call(cookie,"POST","/api/conversations/global/messages",{message,attachments:[],queuedInputId:itemId});
  assert.equal(forged.statusCode,409);
  await f.pool.query("UPDATE work_intake SET state='sending',lease_until=now()-interval '1 minute' WHERE id=$1",[itemId]);
  assert.equal(await deliverIntake(deps,session.personId,"global"),"delivered");
  assert.equal(sent.length,2);
  console.log(JSON.stringify({retryUsedOriginalGlobalSegment:true,busyRequeued:true,receivedTurnNotResentAfterRestart:true,clientCannotClaimWorkerOperation:true}));
} finally {
  globalThis.fetch = runtimeFetch;
  await f.close();
}
