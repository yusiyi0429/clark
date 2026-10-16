import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createTestDb } from './helpers.js';
import { migrate } from '../src/migrate.js';
import { createPersonalMemory } from '../src/personalMemory.js';
import { createPersonalDistillation, isExplicitMemoryRequest } from '../src/personalDistillation.js';

const usage = { input:1, output:1, cacheRead:0, cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
function candidate(value: unknown) {
  if (value && typeof value === 'object' && 'changes' in value && !('status' in value)) {
    const result = value as { changes: unknown[]; clarification: string };
    value = { ...result, status: result.clarification ? 'needs_clarification' : result.changes.length ? 'apply' : 'noop' };
  }
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
   const audit=await db.query("SELECT input_snapshot,candidate_output,error FROM agent_runs WHERE kind='personal-memory-distillation'");
   expect(audit.rows[0]).toMatchObject({input_snapshot:{currentSequence:1},candidate_output:{status:'apply',changes:[{attributeKey:'communication_order'}]},error:null});
   expect(JSON.stringify(audit.rows)).toContain('先看结论');
   expect(JSON.stringify(audit.rows)).not.toContain('apiKey');
   expect(await worker.processNext()).toBe(false);expect(calls).toBe(1);
  } finally {await rm(storageDir,{recursive:true,force:true});}
 });
});

test('main reply success queues natural learning, restart consumes it, and failed replies still honor explicit forget',async()=>{
 const { buildApp }=await import('../src/app.js');const { testEnv,seedTestAccess,TEST_CEO }=await import('./helpers.js');
 await createTestDb(async({db,pool})=>{await migrate(db);await seedTestAccess(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-http-'));let failReply=false;let mode='learn';
 const memory=createPersonalMemory({pool,storageDir});
 // A brand-new scope still inherits the person's current epoch after earlier edits.
 await memory.replaceOwn(TEST_CEO.personId,{expectedRevision:0,markdown:'# Personal\n'});
 const provider=()=>candidate(mode==='learn'?{changes:[{operation:'add',attributeKey:'communication_order',title:'沟通偏好',text:'先看结论。',evidence:[{sequence:1,quote:'我一直先看结论。'}],inferred:false}],clarification:''}:{changes:[{operation:'remove',attributeKey:'communication_order',title:'沟通偏好',text:'',evidence:[{sequence:3,quote:'删除先看结论这个偏好。'}],inferred:false}],clarification:''});
 const app=await buildApp({pool,env:{...testEnv,personalMemoryStorageDir:storageDir},personalDistillationStream:provider,conversationRuntime:{async run(input){if(failReply)throw new Error('provider failed');return {assistantMessage:'明白',runtimeEntries:input.runtimeEntries};}}});
 try {const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:testEnv.publicOrigin},payload:{loginId:TEST_CEO.loginId,passcode:TEST_CEO.passcode}});const headers={cookie:(login.headers['set-cookie'] as string).split(';')[0],origin:testEnv.publicOrigin};
 await app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'我一直先看结论。'}});
 const worker=createPersonalDistillation({pool,memory,baseUrl:testEnv.piBaseUrl,apiKey:'test',modelId:'test',streamSimple:provider});await worker.processNext(TEST_CEO.personId);
 expect((await app.inject({url:'/api/me/memory/personal',headers})).json().markdown).toContain('先看结论');
 failReply=true;mode='forget';const reply=await app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'删除先看结论这个偏好。'}});
 expect(reply.body).toContain('RUNTIME_FAILED');expect((await memory.readOwn(TEST_CEO.personId)).markdown).not.toContain('先看结论');
 }finally{await app.close();await rm(storageDir,{recursive:true,force:true});}
 });
});

test('forget supersedes pending older jobs across restart and malformed evidence retries at most twice',async()=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-exclusion-'));
 try {const memory=createPersonalMemory({pool,storageDir}),id=randomUUID();
 await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);
 await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我一直喜欢徒步。',$2)",[id,randomUUID()]);
 const saved=await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'hobby',text:'喜欢徒步。'}]});let calls=0;
 const opts={pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>{calls++;return candidate({changes:[{operation:'add',attributeKey:'hobby',title:'兴趣',text:'喜欢徒步。',inferred:false,evidence:[{sequence:1,quote:'不存在的本人消息'}]}],clarification:''});}};
 const worker=createPersonalDistillation(opts),stale=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'natural',epoch:saved.epoch});
 await memory.forgetOwn('alice',{expectedRevision:saved.revision,sectionIds:['hobby']});await createPersonalDistillation(opts).processNext();
 expect(await worker.status(stale)).toMatchObject({status:'superseded'});expect(calls).toBe(0);expect((await memory.readOwn('alice')).markdown).not.toContain('徒步');
 await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,2,'user','我一直喜欢游泳。',$2)",[id,randomUUID()]);
 const job=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:2,kind:'natural',epoch:(await memory.readOwn('alice')).epoch});
 await worker.processNext();await worker.processNext();await worker.processNext();expect(await worker.processNext()).toBe(false);
 expect(await worker.status(job)).toMatchObject({status:'failed',attempts:3,errorCode:'INVALID_USER_EVIDENCE'});expect(calls).toBe(3);
 }finally{await rm(storageDir,{recursive:true,force:true});}
 });
});

test('a later unrelated turn cannot rewrite a preference using only an older quote',async()=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-new-evidence-'));
 try {const memory=createPersonalMemory({pool,storageDir}),id=randomUUID();await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);
 await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我喜欢咖啡。',$2),($1,3,'user','今天帮我写封信。',$2)",[id,randomUUID()]);
 const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>candidate({changes:[{operation:'add',attributeKey:'drink',title:'偏好',text:'喜欢咖啡。',inferred:false,evidence:[{sequence:1,quote:'我喜欢咖啡。'}]}],clarification:''})});
 const job=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:3,kind:'natural',epoch:0});await worker.processNext();
 expect(await worker.status(job)).toMatchObject({status:'pending',errorCode:'NO_CURRENT_USER_EVIDENCE'});expect((await memory.readOwn('alice')).sections).toHaveLength(0);
 }finally{await rm(storageDir,{recursive:true,force:true});}});
});

test('an ambiguous explicit request asks for clarification without editing unrelated attributes',async()=>{
 const {buildApp}=await import('../src/app.js');const {testEnv,seedTestAccess,TEST_CEO}=await import('./helpers.js');
 await createTestDb(async({db,pool})=>{await migrate(db);await seedTestAccess(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-ambiguous-'));const memory=createPersonalMemory({pool,storageDir});
 await memory.apply(TEST_CEO.personId,{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'hobby',text:'喜欢徒步。'},{operation:'add',attributeKey:'communication',text:'先看结论。'}]});let calls=0;
 const app=await buildApp({pool,env:{...testEnv,personalMemoryStorageDir:storageDir},personalDistillationStream:()=>candidate({changes:[],clarification:'你想忘掉徒步偏好，还是表达偏好？'}),conversationRuntime:{async run(){calls++;throw new Error('should clarify first');}}});
 try{const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:testEnv.publicOrigin},payload:{loginId:TEST_CEO.loginId,passcode:TEST_CEO.passcode}});const headers={cookie:(login.headers['set-cookie'] as string).split(';')[0],origin:testEnv.publicOrigin};
 const reply=await app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'忘掉那个偏好。'}});expect(reply.body).toContain('completed');const history=await app.inject({url:'/api/conversations/global/messages',headers});expect(history.body).toContain('你想忘掉');expect(calls).toBe(0);expect((await memory.readOwn(TEST_CEO.personId)).sections).toHaveLength(2);
 const worker=createPersonalDistillation({pool,memory,baseUrl:testEnv.piBaseUrl,apiKey:'test',modelId:'test',streamSimple:()=>{throw new Error('No second classification before clarification');}});
 expect(await worker.processNext(TEST_CEO.personId)).toBe(false);
 }finally{await app.close();await rm(storageDir,{recursive:true,force:true});}
 });
});

test('forgotten semantics cannot return under a new key, but explicit new permission can restore the exact attribute',async()=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-tombstone-'));
 try{const memory=createPersonalMemory({pool,storageDir}),id=randomUUID();await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);
 const saved=await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'manual-uuid',title:'兴趣',text:'喜欢徒步。'}]});await memory.forgetOwn('alice',{expectedRevision:saved.revision,sectionIds:['manual-uuid']});
 await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我周末经常徒步。',$2)",[id,randomUUID()]);
 let explicit=false;const contexts:string[]=[];const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:(_model,context)=>{contexts.push(JSON.stringify(context));return candidate({changes:[{operation:'add',attributeKey:explicit?'manual-uuid':'new-hiking-key',matchedBlockedAttributeKey:'manual-uuid',title:'兴趣',text:'喜欢徒步。',inferred:false,evidence:[{sequence:explicit?2:1,quote:explicit?'我重新允许你记住我喜欢徒步。':'我周末经常徒步。'}]}],clarification:''});}});
 const job=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'natural',epoch:(await memory.readOwn('alice')).epoch});await worker.processNext();expect(await worker.status(job)).toMatchObject({status:'succeeded'});expect((await memory.readOwn('alice')).sections).toHaveLength(0);expect(contexts[0]).toContain('manual-uuid');
 explicit=true;await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,2,'user','我重新允许你记住我喜欢徒步。',$2)",[id,randomUUID()]);await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:2,kind:'explicit',epoch:(await memory.readOwn('alice')).epoch});await worker.processNext();expect((await memory.readOwn('alice')).markdown).toContain('喜欢徒步');expect(await memory.readBlocked('alice')).toHaveLength(0);
 }finally{await rm(storageDir,{recursive:true,force:true});}
 });
});

test('a malformed structured submission has a bounded model call budget',async()=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-budget-'));
 try{const id=randomUUID(),memory=createPersonalMemory({pool,storageDir});await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我通常先看结论。',$2)",[id,randomUUID()]);let calls=0;
 const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>{calls++;if(calls>2)throw new Error('test cap');return candidate({invalid:'submission'});}});const idJob=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'natural',epoch:0});await worker.processNext();expect(calls).toBe(2);expect(await worker.status(idJob)).toMatchObject({status:'pending',attempts:1});expect((await memory.readOwn('alice')).sections).toHaveLength(0);
 }finally{await rm(storageDir,{recursive:true,force:true});}});
});

test('newer explicit intents survive an earlier explicit epoch change, while a manual forget cancels old intents',async()=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-intents-'));
 try{const memory=createPersonalMemory({pool,storageDir}),first=randomUUID(),second=randomUUID();
 await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'drink',text:'喜欢咖啡。'},{operation:'add',attributeKey:'communication',text:'先看结论。'}]});
 for(const [id,scope,text] of [[first,'global','更正：我喜欢喝茶。'],[second,'task:test','更正：我想先看依据。']]){await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice',$2,$3)",[id,scope,randomUUID()]);await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user',$2,$3)",[id,text,randomUUID()]);}
 let calls=0;const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>{calls++;return candidate({changes:[{operation:'update',attributeKey:calls===1?'drink':'communication',title:'偏好',text:calls===1?'喜欢喝茶。':'先看依据。',inferred:false,evidence:[{sequence:1,quote:calls===1?'更正：我喜欢喝茶。':'更正：我想先看依据。'}]}],clarification:''});}});
 const a=await worker.enqueue(db,{personId:'alice',conversationId:first,throughSequence:1,kind:'explicit',epoch:0}),b=await worker.enqueue(db,{personId:'alice',conversationId:second,throughSequence:1,kind:'explicit',epoch:0});await worker.processNext();await worker.processNext();
 expect(await worker.status(a)).toMatchObject({status:'succeeded'});expect(await worker.status(b)).toMatchObject({status:'succeeded'});expect((await memory.readOwn('alice')).markdown).toContain('先看依据');expect((await memory.readOwn('alice')).markdown).toContain('喜欢喝茶');
 const doc=await memory.readOwn('alice');await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,2,'user','更正：我又喜欢咖啡了。',$2)",[first,randomUUID()]);const pending=await worker.enqueue(db,{personId:'alice',conversationId:first,throughSequence:2,kind:'explicit',epoch:doc.epoch});await memory.forgetOwn('alice',{expectedRevision:doc.revision,sectionIds:['communication']});await worker.processNext();expect(await worker.status(pending)).toMatchObject({status:'superseded'});expect(calls).toBe(2);expect((await memory.readOwn('alice')).markdown).not.toContain('喜欢咖啡');
 }finally{await rm(storageDir,{recursive:true,force:true});}});
});

test('a held route connection is reused through worker and personal writes even when the pool is full',async()=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-pool-'));const held:import('pg').PoolClient[]=[];
 try{const memory=createPersonalMemory({pool,storageDir}),id=randomUUID();await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我通常先看结论。',$2)",[id,randomUUID()]);
 const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>candidate({changes:[{operation:'add',attributeKey:'communication',title:'沟通',text:'先看结论。',inferred:false,evidence:[{sequence:1,quote:'我通常先看结论。'}]}],clarification:''})});await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'natural',epoch:0});held.push(...await Promise.all(Array.from({length:4},()=>pool.connect())));
 expect(await worker.processNext('alice',db)).toBe(true);expect((await memory.readOwn('alice',db)).markdown).toContain('先看结论');
 }finally{held.forEach(connection=>connection.release());await rm(storageDir,{recursive:true,force:true});}});
});

test('an incomplete exclusion view pauses automatic additions instead of silently dropping old forget barriers',async()=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-capacity-'));
 try{const memory=createPersonalMemory({pool,storageDir}),id=randomUUID();const saved=await memory.apply('alice',{expectedRevision:0,epoch:0,changes:Array.from({length:100},(_,i)=>({operation:'add' as const,attributeKey:`old_${i}`,text:`过去偏好${i}。`}))});await memory.forgetOwn('alice',{expectedRevision:saved.revision,sectionIds:saved.sections.map(s=>s.id)});
 await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我通常先看结论。',$2)",[id,randomUUID()]);const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>candidate({changes:[{operation:'add',attributeKey:'new',title:'沟通',text:'先看结论。',inferred:false,evidence:[{sequence:1,quote:'我通常先看结论。'}]}],clarification:''})});const job=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'natural',epoch:(await memory.readOwn('alice')).epoch});await worker.processNext();expect(await worker.status(job)).toMatchObject({status:'succeeded'});expect((await memory.readOwn('alice')).sections).toHaveLength(0);
 }finally{await rm(storageDir,{recursive:true,force:true});}});
});

test('an explicit forget with arbitrary wording survives main failure and a worker restart',async()=>{
 const {buildApp}=await import('../src/app.js');const {testEnv,seedTestAccess,TEST_CEO}=await import('./helpers.js');
 await createTestDb(async({db,pool})=>{await migrate(db);await seedTestAccess(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-arbitrary-'));const memory=createPersonalMemory({pool,storageDir});await memory.apply(TEST_CEO.personId,{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'drink',text:'喜欢咖啡。'}]});
 const provider=()=>candidate({changes:[{operation:'remove',attributeKey:'drink',title:'饮食偏好',text:'',inferred:false,evidence:[{sequence:1,quote:'把咖啡偏好从档案拿掉。'}]}],clarification:''});const app=await buildApp({pool,env:{...testEnv,personalMemoryStorageDir:storageDir},personalDistillationStream:provider,conversationRuntime:{async run(){throw new Error('main unavailable');}}});
 try{const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:testEnv.publicOrigin},payload:{loginId:TEST_CEO.loginId,passcode:TEST_CEO.passcode}});const headers={cookie:(login.headers['set-cookie'] as string).split(';')[0],origin:testEnv.publicOrigin};const response=await app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'把咖啡偏好从档案拿掉。'}});expect(response.body).toContain('RUNTIME_FAILED');await app.close();
 const worker=createPersonalDistillation({pool,memory,baseUrl:testEnv.piBaseUrl,apiKey:'test',modelId:'test',streamSimple:provider});await worker.processNext(TEST_CEO.personId);expect((await memory.readOwn(TEST_CEO.personId)).markdown).not.toContain('咖啡');
 }finally{await app.close();await rm(storageDir,{recursive:true,force:true});}});
});

test('a removal found during natural distillation creates a forget barrier against older delayed jobs',async()=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-natural-remove-'));
 try{const memory=createPersonalMemory({pool,storageDir}),id=randomUUID();await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'drink',text:'喜欢咖啡。'}]});await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我通常喜欢咖啡。',$2),($1,2,'user','饮食偏好要整理，现在我不喝咖啡了。',$2)",[id,randomUUID()]);let calls=0;const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>{calls++;return candidate({changes:[{operation:calls===1?'remove':'add',attributeKey:'drink',title:'饮食偏好',text:calls===1?'':'喜欢咖啡。',inferred:false,evidence:[{sequence:calls===1?2:1,quote:calls===1?'饮食偏好要整理，现在我不喝咖啡了。':'我通常喜欢咖啡。'}]}],clarification:''});}});
 await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:2,kind:'natural',epoch:0});const old=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'natural',epoch:0});await worker.processNext();await worker.processNext();expect(await worker.status(old)).toMatchObject({status:'superseded'});expect((await memory.readOwn('alice')).markdown).not.toContain('咖啡');expect(await memory.readBlocked('alice')).toMatchObject([{key:'drink',text:'喜欢咖啡。'}]);expect(calls).toBe(1);
 }finally{await rm(storageDir,{recursive:true,force:true});}});
});

test('the current long user message keeps its tail intent and evidence while older context is bounded', async () => {
 await createTestDb(async ({db,pool}) => { await migrate(db); const storageDir = await mkdtemp(join(tmpdir(),'distill-long-query-'));
 try {
  const memory=createPersonalMemory({pool,storageDir}), id=randomUUID(); await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'drink',text:'喜欢咖啡。'}]});
  const intent='忘掉我的咖啡偏好。', content='背景'.repeat(9000)+intent;
  await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);
  await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user',$2,$4),($1,2,'user',$3,$4)",[id,'无关旧前文'.repeat(3000),content,randomUUID()]);
  let current=''; const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:(_model,context)=>{
   const user=context.messages[0]; const input=JSON.parse(typeof user.content==='string'?user.content:(user.content[0] as {text:string}).text).input;
   current=input.messages.find((message:{sequence:number})=>message.sequence===2).content;
   return candidate({changes:[{operation:'remove',attributeKey:'drink',title:'饮食偏好',text:'',inferred:false,evidence:[{sequence:2,quote:intent}]}],clarification:''});
  }});
  const job=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:2,kind:'explicit',epoch:0}); await worker.processNext();
  expect(current.length).toBe(content.length); expect(current.endsWith(intent)).toBe(true); expect(await worker.status(job)).toMatchObject({status:'succeeded'}); expect((await memory.readOwn('alice')).sections).toEqual([]);
 } finally { await rm(storageDir,{recursive:true,force:true}); }
 });
});

test.each(['clarification', 'failed', 'noop'] as const)('natural learning respects the same-turn explicit classification across restart: %s', async mode => {
 await createTestDb(async ({db,pool}) => { await migrate(db); const storageDir=await mkdtemp(join(tmpdir(),'distill-classification-barrier-'));
 try {
  const memory=createPersonalMemory({pool,storageDir}), id=randomUUID();
  await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'drink',text:'喜欢咖啡。'}]});
  const quote=mode==='noop'?'我通常先给结论。':'把档案里那项拿掉。';
  expect(isExplicitMemoryRequest(quote)).toBe(false);
  await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);
  await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user',$2,$3)",[id,quote,randomUUID()]);
  let naturalCalls=0;
  const options={pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:(_model:unknown,context:import('@earendil-works/pi-ai').Context)=>{
   const message=context.messages[0]; const input=JSON.parse(typeof message.content==='string'?message.content:(message.content[0] as {text:string}).text).input;
   if(input.kind==='explicit') {if(mode==='failed')throw new Error('classification unavailable');return candidate({changes:[],clarification:mode==='clarification'?'想拿掉哪一项？':''});}
   naturalCalls++;
   return candidate({changes:[mode==='noop'?{operation:'add',attributeKey:'communication',title:'偏好',text:'通常先给结论。',inferred:false,evidence:[{sequence:1,quote}]}:{operation:'remove',attributeKey:'drink',title:'偏好',text:'',inferred:false,evidence:[{sequence:1,quote}]}],clarification:''});
  }};
  const worker=createPersonalDistillation(options);
  const explicit=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'explicit',epoch:0});
  const natural=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'natural',epoch:0});
  for(let attempt=0;attempt<(mode==='failed'?3:1);attempt++)await worker.processNext('alice');
  expect(await worker.status(explicit)).toMatchObject({status:mode==='failed'?'failed':'succeeded'});
  await createPersonalDistillation(options).processNext('alice');
  expect((await memory.readOwn('alice')).markdown).toContain('喜欢咖啡');
  expect(naturalCalls).toBe(mode==='noop'?1:0);
  expect(await worker.status(natural)).toMatchObject({status:mode==='noop'?'succeeded':'superseded'});
 } finally {await rm(storageDir,{recursive:true,force:true});}
 });
});


test('current learning contract distinguishes history context from current evidence', async () => {
 await createTestDb(async ({db,pool}) => { await migrate(db); const storageDir=await mkdtemp(join(tmpdir(),'distill-current-contract-'));
 try {
  const memory=createPersonalMemory({pool,storageDir}), id=randomUUID();
  await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);
  await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我一直用中文沟通。',$2),($1,3,'user','我通常先看结论。',$2)",[id,randomUUID()]);
  let prompt=''; let schema:unknown;
  const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:(_model,context)=>{
   prompt=context.systemPrompt ?? ''; schema=context.tools?.find(tool=>tool.name==='submit_candidate')?.parameters;
   return candidate({status:'apply',changes:[{operation:'add',attributeKey:'communication',title:'沟通偏好',text:'通常先看结论。',inferred:false,evidence:[{sequence:3,quote:'我通常先看结论。'}]}],clarification:''});
  }});
  const job=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:3,kind:'natural',epoch:0}); await worker.processNext();
  expect(prompt).toContain('currentSequence'); expect(prompt).toContain('历史消息仅用于理解指代'); expect(prompt).toContain('明确记住、纠正、忘记或重新授权'); expect(JSON.stringify(schema)).toContain('needs_clarification');
  expect(await worker.status(job)).toMatchObject({status:'succeeded'}); expect((await memory.select('alice','给我建议'))[0].text).toContain('先看结论');
 } finally { await rm(storageDir,{recursive:true,force:true}); }
 });
});

test.each([
 {status:'noop',changes:true,clarification:''},
 {status:'apply',changes:true,clarification:'已记住你的偏好。'},
 {status:'needs_clarification',changes:false,clarification:''},
] as const)('invalid candidate outcome is rejected atomically: $status / $clarification',async result=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-outcome-'));
 try {const memory=createPersonalMemory({pool,storageDir}),id=randomUUID();
  await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);
  await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我通常先看结论。',$2)",[id,randomUUID()]);
  const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>candidate({...result,changes:result.changes?[{operation:'add',attributeKey:'communication',title:'沟通偏好',text:'通常先看结论。',inferred:false,evidence:[{sequence:1,quote:'我通常先看结论。'}]}]:[]})});
  const job=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:1,kind:'natural',epoch:0}); await worker.processNext();
  expect(await worker.status(job)).toMatchObject({status:'pending',errorCode:'INVALID_CANDIDATE_STATUS'});expect((await memory.readOwn('alice')).revision).toBe(0);
 } finally {await rm(storageDir,{recursive:true,force:true});}
 });
});


test.each([false,true])('old-only evidence rejects the batch even when the historical preference is already stored: %s',async stored=>{
 await createTestDb(async({db,pool})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'distill-old-batch-'));
 try {const memory=createPersonalMemory({pool,storageDir}),id=randomUUID();
  if(stored)await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'language',title:'沟通偏好',text:'长期使用中文沟通。'}]});
  await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice','global',$2)",[id,randomUUID()]);
  await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','我长期使用中文沟通。',$2),($1,3,'user','我通常先看结论。',$2)",[id,randomUUID()]);
  const worker=createPersonalDistillation({pool,memory,baseUrl:'https://provider.invalid/v1',apiKey:'test',modelId:'test',streamSimple:()=>candidate({status:'apply',changes:[{operation:'add',attributeKey:'language',title:'沟通偏好',text:'长期使用中文沟通。',inferred:false,evidence:[{sequence:1,quote:'我长期使用中文沟通。'}]},{operation:'add',attributeKey:'order',title:'沟通偏好',text:'通常先看结论。',inferred:false,evidence:[{sequence:3,quote:'我通常先看结论。'}]}],clarification:''})});
  const job=await worker.enqueue(db,{personId:'alice',conversationId:id,throughSequence:3,kind:'natural',epoch:0});await worker.processNext();
  expect(await worker.status(job)).toMatchObject({status:'pending',errorCode:'NO_CURRENT_USER_EVIDENCE'});const doc=await memory.readOwn('alice');expect(doc.revision).toBe(stored?1:0);expect(doc.markdown).not.toContain('先看结论');
 }finally{await rm(storageDir,{recursive:true,force:true});}
 });
});
