import { expect, test } from 'vitest';
import { createTestApp } from './helpers.js';
test('authenticated people edit only their own Personal, reject stale revisions and forgery', async () => {
    const t = await createTestApp();
    try {
        const alice = await t.loginCookie(), bob = await t.memberCookie();
        const call = (method: 'GET' | 'PUT' | 'POST', cookie: string, payload?: unknown, url = '/api/me/memory/personal') => t.app.inject({ method, url, headers: { cookie, origin: t.publicOrigin }, ...(payload ? { payload } : {}) });
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal' })).statusCode).toBe(401);
        const initial = await call('GET', alice);
        expect(initial.statusCode).toBe(200);
        expect(initial.headers['cache-control']).toBe('no-store');
        const saved = await call('PUT', alice, { expectedRevision: 0, markdown: '# Personal\n\n## 协作偏好\n\n请先给结论。' });
        expect(saved.statusCode).toBe(200);
        expect((await call('GET', bob)).json().markdown).not.toContain('结论');
        expect((await call('PUT', alice, { expectedRevision: 0, markdown: '旧内容' })).statusCode).toBe(409);
        expect((await call('PUT', alice, { expectedRevision: 1, markdown: '非法', owner: 'bob' })).statusCode).toBe(400);
        const removed = await call('POST', alice, { expectedRevision: 1, sectionIds: [saved.json().sections[0].id] }, '/api/me/memory/personal/forget');
        expect(removed.statusCode).toBe(200);
        expect(removed.json().markdown).not.toContain('结论');
    }
    finally {
        await t.close();
    }
});
test('main chat receives clean personal references and forget discards pre-forget history across scopes', async () => {
    const inputs: Parameters<import('../src/conversations.js').ConversationRuntime['run']>[0][] = [];
    const t = await createTestApp({}, { async run(input) { inputs.push(input); return { assistantMessage: '回复', runtimeEntries: [{ old: '曾经的偏好' }] }; } });
    try {
        const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin };
        await t.app.inject({ method: 'PUT', url: '/api/me/memory/personal', headers, payload: { expectedRevision: 0, markdown: '# Personal\n\n## 协作偏好\n\n先给结论。' } });
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '帮我分析一下' } });
        expect(inputs[0].references?.some(ref => ref.kind === 'personal' && ref.text === '先给结论。')).toBe(true);
        const saved = (await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers })).json();
        await t.app.inject({ method: 'POST', url: '/api/me/memory/personal/forget', headers, payload: { expectedRevision: 1, sectionIds: [saved.sections[0].id] } });
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '继续' } });
        expect(inputs[1].references?.some(ref => ref.kind === 'personal')).toBe(false);
        expect(inputs[1].recentMessages).toEqual([]);
        expect(inputs[1].runtimeEntries).toEqual([]);
        const history = await t.app.inject({ method: 'GET', url: '/api/conversations/global/messages', headers });
        expect(history.json().messages.length).toBe(4);
    }
    finally {
        await t.close();
    }
});

test('a finishing pre-forget turn cannot resurrect its runtime checkpoint or old history', async()=>{
 let start!:()=>void,finish!:()=>void;
 const started=new Promise<void>(resolve=>{start=resolve;}),release=new Promise<void>(resolve=>{finish=resolve;});
 let calls=0;const inputs:Parameters<import('../src/conversations.js').ConversationRuntime['run']>[0][]=[];
 const t=await createTestApp({}, {async run(input){inputs.push(input);calls++;if(calls===1){start();await release;await input.checkpoint?.([{stale:'先给结论'}]);}return {assistantMessage:'这是一条旧助手回答，先给结论。',runtimeEntries:[{stale:'先给结论'}]};}});
 try{const cookie=await t.loginCookie(),headers={cookie,origin:t.publicOrigin};
 const doc=(await t.app.inject({method:'PUT',url:'/api/me/memory/personal',headers,payload:{expectedRevision:0,markdown:'# Personal\n\n## 协作偏好\n\n先给结论。'}})).json();
 const pending=t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'帮我分析'}}).then(result=>result);
 await started;
 const forgotten=await t.app.inject({method:'POST',url:'/api/me/memory/personal/forget',headers,payload:{expectedRevision:1,sectionIds:[doc.sections[0].id]}});expect(forgotten.statusCode).toBe(200);
 finish();await pending;
 await t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'继续'}});
 expect(inputs[1].runtimeEntries).toEqual([]);expect(inputs[1].recentMessages).toEqual([]);
 }finally{finish();await t.close();}
});

test('a busy personal document degrades main chat promptly instead of holding the turn',async()=>{
 const t=await createTestApp();const blocker=await t.pool.connect();let timer:ReturnType<typeof setTimeout>|undefined;
 try{const cookie=await t.loginCookie();await blocker.query('SELECT pg_advisory_lock(hashtext($1))',['memory:personal:person-fixture-001']);
 const pending=t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers:{cookie,origin:t.publicOrigin},payload:{message:'你好'}});
 const result=await Promise.race([pending,new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),1000);})]);
 expect(result).not.toBe('timeout');if(result!=='timeout')expect(result.body).toContain('event: done');
 }finally{if(timer)clearTimeout(timer);await blocker.query('SELECT pg_advisory_unlock(hashtext($1))',['memory:personal:person-fixture-001']);blocker.release();await t.close();}
});

test('forget acknowledged during pre-runtime assembly removes previously loaded history and entries',async()=>{
 const inputs:Parameters<import('../src/conversations.js').ConversationRuntime['run']>[0][]=[];
 const t=await createTestApp({}, {async run(input){inputs.push(input);return {assistantMessage:'先给结论的旧内容',runtimeEntries:[{stale:'先给结论'}]};}});
 const blocker=await t.pool.connect();let locked=false;
 try{const cookie=await t.loginCookie(),headers={cookie,origin:t.publicOrigin};
 const doc=(await t.app.inject({method:'PUT',url:'/api/me/memory/personal',headers,payload:{expectedRevision:0,markdown:'# Personal\n\n## 协作偏好\n\n先给结论。'}})).json();
 await t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'第一轮'}});
 await blocker.query('BEGIN');await blocker.query('LOCK TABLE agent_runs IN ACCESS EXCLUSIVE MODE');locked=true;
 const pending=t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers,payload:{message:'第二轮'}}).then(result=>result);
 for(let attempt=0;attempt<100;attempt++){
  const history=(await t.app.inject({method:'GET',url:'/api/conversations/global/messages',headers})).json();
  if(history.messages.length===3)break;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 const forgotten=await t.app.inject({method:'POST',url:'/api/me/memory/personal/forget',headers,payload:{expectedRevision:1,sectionIds:[doc.sections[0].id]}});expect(forgotten.statusCode).toBe(200);
 await blocker.query('COMMIT');locked=false;await pending;
 expect(inputs[1].runtimeEntries).toEqual([]);expect(inputs[1].recentMessages).toEqual([]);expect(inputs[1].references?.some(ref=>ref.kind==='personal')).toBe(false);
 }finally{if(locked)await blocker.query('ROLLBACK');blocker.release();await t.close();}
});
