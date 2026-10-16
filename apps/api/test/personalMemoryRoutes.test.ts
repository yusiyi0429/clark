import { expect, test } from 'vitest';
import { createTestApp } from './helpers.js';
import type { ConversationRuntime } from '../src/conversations.js';

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

test('main chat receives the owner\'s relevant personal memory and no longer after forget', async () => {
    const inputs: Parameters<ConversationRuntime['run']>[0][] = [];
    const t = await createTestApp({}, { async run(input) { inputs.push(input); return { assistantMessage: '回复', runtimeEntries: input.runtimeEntries }; } });
    try {
        const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin };
        await t.app.inject({ method: 'PUT', url: '/api/me/memory/personal', headers, payload: { expectedRevision: 0, markdown: '# Personal\n\n## 协作偏好\n\n先给结论。' } });
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '帮我分析一下' } });
        expect(inputs[0].personalMemory).toMatchObject([{ title: '协作偏好', text: '先给结论。' }]);
        // 别人的对话里看不到。
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers: { cookie: await t.memberCookie(), origin: t.publicOrigin }, payload: { message: '帮我分析一下' } });
        expect(inputs[1].personalMemory).toBeUndefined();
        const saved = (await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers })).json();
        await t.app.inject({ method: 'POST', url: '/api/me/memory/personal/forget', headers, payload: { expectedRevision: 1, sectionIds: [saved.sections[0].id] } });
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '继续' } });
        expect(inputs[2].personalMemory).toBeUndefined();
    }
    finally {
        await t.close();
    }
});

test('forgetting a memory keeps the model context of every conversation of that person (3d)', async () => {
    const inputs: Parameters<ConversationRuntime['run']>[0][] = [];
    const t = await createTestApp({}, { async run(input) { inputs.push(input); return { assistantMessage: '回复', runtimeEntries: [{ turn: inputs.length }] }; } });
    try {
        const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin };
        const doc = (await t.app.inject({ method: 'PUT', url: '/api/me/memory/personal', headers, payload: { expectedRevision: 0, markdown: '# Personal\n\n## 协作偏好\n\n先给结论。' } })).json();
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '第一轮' } });
        // 同一个人在另一个页面的对话。
        await t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id, runtime_entries) VALUES (gen_random_uuid(), 'person-fixture-001', 'issue:other', gen_random_uuid(), '[{\"other\":1}]'::jsonb)");
        const before = await t.sql("SELECT scope, runtime_entries, pi_session_id FROM conversations WHERE owner_id = 'person-fixture-001' ORDER BY scope");
        expect((await t.app.inject({ method: 'POST', url: '/api/me/memory/personal/forget', headers, payload: { expectedRevision: doc.revision, sectionIds: [doc.sections[0].id] } })).statusCode).toBe(200);
        expect(await t.sql("SELECT scope, runtime_entries, pi_session_id FROM conversations WHERE owner_id = 'person-fixture-001' ORDER BY scope")).toEqual(before);
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '第二轮' } });
        expect(inputs[1].runtimeEntries).toEqual([{ turn: 1 }]);
        expect(inputs[1].personalMemory).toBeUndefined();
    }
    finally {
        await t.close();
    }
});

test('an explicit memory request whose memory update fails keeps the main answer and the model context (3c)', async () => {
    const inputs: Parameters<ConversationRuntime['run']>[0][] = [];
    const t = await createTestApp({}, { async run(input) { inputs.push(input); input.emit({ type: 'message', delta: '主回答' }); return { assistantMessage: '主回答', runtimeEntries: [{ turn: inputs.length }] }; } },
        { personalDistillationStream: () => { throw new Error('memory model down'); } });
    try {
        const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin };
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '第一轮' } });
        const reply = await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '忘掉我先看结论的偏好。' } });
        expect(reply.body).toContain('主回答');
        expect(inputs).toHaveLength(2);
        expect(inputs[1].runtimeEntries).toEqual([{ turn: 1 }]);
        expect(await t.sql("SELECT runtime_entries FROM conversations WHERE owner_id = 'person-fixture-001'")).toEqual([{ runtime_entries: [{ turn: 2 }] }]);
        const history = (await t.app.inject({ method: 'GET', url: '/api/conversations/global/messages', headers })).json();
        expect(history.messages.map((message: { content: string }) => message.content)).toEqual(['第一轮', '主回答', '忘掉我先看结论的偏好。', '主回答']);
    }
    finally {
        await t.close();
    }
});

test('the main agent remembers, corrects and forgets through its own tools; a failed tool call does not touch the answer (3c)', async () => {
    const outcomes: unknown[] = [];
    const t = await createTestApp({}, { async run(input) {
        const tools = input.personalMemoryTools!;
        if (input.message === '记住我习惯先看结论。') outcomes.push(await tools.remember({ title: '沟通偏好', text: '习惯先看结论。' }));
        if (input.message === '忘掉那条偏好。') {
            const [entry] = await tools.search('先看结论');
            outcomes.push(await tools.forget({ id: entry.id }));
            outcomes.push(await tools.forget({ id: entry.id }).catch((error: Error) => error.message));
        }
        return { assistantMessage: '好的', runtimeEntries: input.runtimeEntries };
    } });
    try {
        const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin };
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '记住我习惯先看结论。' } });
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers })).json().markdown).toContain('习惯先看结论');
        const reply = await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '忘掉那条偏好。' } });
        expect(reply.body).toContain('completed');
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers })).json().markdown).not.toContain('习惯先看结论');
        expect(outcomes[2]).toContain('PERSONAL_SECTION_NOT_FOUND');
        // 别人看不到，也改不了。
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers: { cookie: await t.memberCookie(), origin: t.publicOrigin } })).json().sections).toEqual([]);
    }
    finally {
        await t.close();
    }
});

test('a busy personal document degrades main chat promptly instead of holding the turn',async()=>{
 const t=await createTestApp();const blocker=await t.pool.connect();let timer:ReturnType<typeof setTimeout>|undefined;
 try{const cookie=await t.loginCookie();await blocker.query('SELECT pg_advisory_lock(hashtext($1))',['memory:personal:person-fixture-001']);
 const pending=t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers:{cookie,origin:t.publicOrigin},payload:{message:'你好'}});
 const result=await Promise.race([pending,new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),1000);})]);
 expect(result).not.toBe('timeout');if(result!=='timeout')expect(result.body).toContain('event: done');
 }finally{if(timer)clearTimeout(timer);await blocker.query('SELECT pg_advisory_unlock(hashtext($1))',['memory:personal:person-fixture-001']);blocker.release();await t.close();}
});
