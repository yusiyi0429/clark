import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createTestDb } from './helpers.js';
import { migrate } from '../src/migrate.js';
import { createPersonalMemory } from '../src/personalMemory.js';
import { createPersonalDistillation } from '../src/personalDistillation.js';

const usage = { input:1, output:1, cacheRead:0, cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
function candidate(value: unknown) {
  const events=createAssistantMessageEventStream();
  const call={type:'toolCall' as const,id:randomUUID(),name:'submit_candidate',arguments:value as Record<string,unknown>};
  const final:AssistantMessage={role:'assistant',api:'openai-responses',provider:'warmap',model:'test',content:[call],usage,stopReason:'toolUse',timestamp:Date.now()};
  queueMicrotask(()=>{events.push({type:'start',partial:final});events.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:final});events.push({type:'done',reason:'toolUse',message:final});});return events;
}
test('durable worker distills only own user messages and duplicate delivery is harmless',async()=>{
 await createTestDb(async({db,pool})=>{
  await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-'));
  try {
   const memory=createPersonalMemory({pool,storageDir}), conversationId=randomUUID();
   await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[conversationId,randomUUID()]);
   await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我一直喜欢先看结论，再看依据。',$2),($1,2,'assistant','公司目标是十家客户，张三喜欢咖啡。',$2)",[conversationId,randomUUID()]);
   const contexts:string[]=[];let calls=0;
   const options={pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:(_model:unknown,context:unknown)=>{calls++;contexts.push(JSON.stringify(context));return candidate({changes:[{operation:'add',attributeKey:'communication_order',title:'沟通偏好',text:'喜欢先看结论，再看依据。',evidence:[{sequence:1,quote:'我一直喜欢先看结论，再看依据。'}],inferred:false}],clarification:''});}};
   const worker=createPersonalDistillation(options);
   const job=await worker.enqueue(db,{personId:'alice',conversationId,throughSequence:1,kind:'natural',epoch:0});
   await worker.enqueue(db,{personId:'alice',conversationId,throughSequence:1,kind:'natural',epoch:0});
   await createPersonalDistillation(options).processNext();
   expect((await memory.readOwn('alice')).markdown).toContain('先看结论');
   expect(contexts.join('')).not.toContain('十家客户');expect(contexts.join('')).not.toContain('张三');
   expect(await worker.status(job)).toMatchObject({status:'succeeded',attempts:1});
   expect(await worker.processNext()).toBe(false);expect(calls).toBe(1);
  } finally {await rm(storageDir,{recursive:true,force:true});}
 });
});

test('main reply success queues natural learning, restart consumes it, and failed replies still honor explicit forget',async()=>{
 const { buildApp }=await import('../src/app.js');const { testEnv,seedTestAccess,TEST_CEO }=await import('./helpers.js');
 await createTestDb(async({db,pool})=>{await migrate(db);await seedTestAccess(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-http-'));let failReply=false;let mode='learn';
 const memory=createPersonalMemory({pool,storageDir});
 const provider=()=>candidate(mode==='learn'?{changes:[{operation:'add',attributeKey:'communication_order',title:'沟通偏好',text:'先看结论。',evidence:[{sequence:1,quote:'我一直先看结论。'}],inferred:false}],clarification:''}:{changes:[{operation:'remove',attributeKey:'communication_order',title:'沟通偏好',text:'',evidence:[{sequence:3,quote:'忘掉先看结论这个偏好。'}],inferred:false}],clarification:''});
 const app=await buildApp({pool,env:{...testEnv,personalMemoryStorageDir:storageDir},personalDistillationStream:provider,conversationRuntime:{async run(input){if(failReply)throw new Error('provider failed');return {assistantMessage:'明白',runtimeEntries:input.runtimeEntries};}}});
 try {const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:testEnv.publicOrigin},payload:{loginId:TEST_CEO.loginId,passcode:TEST_CEO.passcode}});const headers={cookie:(login.headers['set-cookie'] as string).split(';')[0],origin:testEnv.publicOrigin};
 await app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'我一直先看结论。'}});
 const worker=createPersonalDistillation({pool,memory,baseUrl:testEnv.piBaseUrl,apiKey:'test',modelId:'test',streamSimple:provider});await worker.processNext(TEST_CEO.personId);
 expect((await app.inject({url:'/api/me/memory/personal',headers})).json().markdown).toContain('先看结论');
 failReply=true;mode='forget';const reply=await app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'忘掉先看结论这个偏好。'}});
 expect(reply.body).toContain('RUNTIME_FAILED');expect((await memory.readOwn(TEST_CEO.personId)).markdown).not.toContain('先看结论');
 }finally{await app.close();await rm(storageDir,{recursive:true,force:true});}
 });
});
