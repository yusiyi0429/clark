import { expect, test } from 'vitest';
import { createTestApp, TEST_CEO } from './helpers.js';
import type { ConversationRuntime } from '../src/conversations.js';

type T = Awaited<ReturnType<typeof createTestApp>>;
const seed = async (t: T, title: string, text: string, owner: string = TEST_CEO.personId) =>
    String((await t.sql('INSERT INTO personal_memory_items (id, person_id, title, text) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id', [owner, title, text]))[0].id);

test('people list, edit and forget only their own personal memory (R7)', async () => {
    const t = await createTestApp();
    try {
        const alice = { cookie: await t.loginCookie(), origin: t.publicOrigin }, bob = { cookie: await t.memberCookie(), origin: t.publicOrigin };
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal' })).statusCode).toBe(401);
        const id = await seed(t, '协作偏好', '请先给结论。');
        const listed = await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers: alice });
        expect(listed.statusCode).toBe(200);
        expect(listed.headers['cache-control']).toBe('no-store');
        expect(listed.json().items).toMatchObject([{ id, title: '协作偏好', text: '请先给结论。', status: 'active', anchors: [], references: [] }]);
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers: bob })).json().items).toEqual([]);
        expect((await t.app.inject({ method: 'PATCH', url: `/api/me/memory/personal/items/${id}`, headers: bob, payload: { text: '改别人的' } })).statusCode).toBe(404);
        expect((await t.app.inject({ method: 'DELETE', url: `/api/me/memory/personal/items/${id}`, headers: bob })).statusCode).toBe(404);
        expect((await t.app.inject({ method: 'PATCH', url: `/api/me/memory/personal/items/${id}`, headers: alice, payload: { text: '先给结论，再给依据。', owner: 'bob' } })).statusCode).toBe(400);
        const edited = await t.app.inject({ method: 'PATCH', url: `/api/me/memory/personal/items/${id}`, headers: alice, payload: { text: '先给结论，再给依据。' } });
        expect(edited.json()).toMatchObject({ id, text: '先给结论，再给依据。' });
        expect((await t.app.inject({ method: 'DELETE', url: `/api/me/memory/personal/items/${id}`, headers: alice })).json()).toMatchObject({ id, status: 'forgotten' });
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers: alice })).json().items).toEqual([]);
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal?status=all', headers: alice })).json().items).toMatchObject([{ id, status: 'forgotten' }]);
        expect((await t.app.inject({ method: 'PATCH', url: `/api/me/memory/personal/items/${id}`, headers: alice, payload: { text: '再改' } })).statusCode).toBe(409);
    } finally {
        await t.close();
    }
});

test('main chat receives the owner\'s relevant personal memory and no longer after forget', async () => {
    const inputs: Parameters<ConversationRuntime['run']>[0][] = [];
    const t = await createTestApp({}, { async run(input) { inputs.push(input); return { assistantMessage: '回复', runtimeEntries: input.runtimeEntries }; } });
    try {
        const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
        const id = await seed(t, '协作偏好', '先给结论。');
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '帮我分析一下' } });
        expect(await inputs[0].personalMemory).toMatchObject([{ id, title: '协作偏好', text: '先给结论。' }]);
        // 别人的对话里看不到。
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers: { cookie: await t.memberCookie(), origin: t.publicOrigin }, payload: { message: '帮我分析一下' } });
        expect(await inputs[1].personalMemory).toEqual([]);
        await t.app.inject({ method: 'DELETE', url: `/api/me/memory/personal/items/${id}`, headers });
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '继续' } });
        expect(await inputs[2].personalMemory).toEqual([]);
    } finally {
        await t.close();
    }
});

test('the answer records which personal memory was actually put into context this turn, and only that', async () => {
    const t = await createTestApp({}, { async run(input) {
        await input.personalMemoryTools!.search('县城样板');
        return { assistantMessage: '回复', runtimeEntries: input.runtimeEntries };
    } });
    try {
        const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
        const style = await seed(t, '协作偏好', '先给结论。');
        const channel = await seed(t, '渠道想法', '渠道下沉先做县城样板。');
        await seed(t, '饮食', '喜欢咖啡。');
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '帮我分析一下' } });
        const rows = await t.sql("SELECT role, memory_used FROM conversation_messages ORDER BY sequence");
        expect(rows[0]).toEqual({ role: 'user', memory_used: null });
        expect(rows[1].role).toBe('assistant');
        expect([...rows[1].memory_used].sort()).toEqual([style, channel].sort());
    } finally {
        await t.close();
    }
});

test('the recall model picks alongside the runtime instead of before it, and memory_used records what it picked (memory-recall)', async () => {
    let release: ((ids: string[]) => void) | undefined;
    let wanted: string[] = [];
    const t = await createTestApp({}, { async run(input) {
        // 运行时开始时召回还没返回：路由没有先等召回、再把这一轮交给运行时（召回与分诊同时跑）。
        if (!release) throw new Error('recall did not start before the runtime');
        release(wanted);
        const memory = await input.personalMemory;
        return { assistantMessage: `回复：${(memory ?? []).map((item) => item.title).join('、')}`, runtimeEntries: input.runtimeEntries };
    } }, { personalMemoryRecall: () => new Promise<string[]>((resolve) => { release = resolve; }) });
    try {
        const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
        const expansion = await seed(t, '扩编方向还没想好', '还没想好销售扩编往哪个方向扩。');
        await seed(t, '饮食', '喜欢咖啡。');
        wanted = [expansion];
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '卖货团队还有什么没定的？' } });
        const rows = await t.sql("SELECT role, content, memory_used FROM conversation_messages ORDER BY sequence");
        expect(rows[1]).toEqual({ role: 'assistant', content: '回复：扩编方向还没想好', memory_used: [expansion] });
    } finally {
        await t.close();
    }
});

test('history carries memoryUsed on the answer; a memory mark with an id not used this turn is recorded as a quality signal', async () => {
    let answer = '';
    const t = await createTestApp({}, { async run(input) { return { assistantMessage: answer, runtimeEntries: input.runtimeEntries }; } });
    try {
        const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
        const style = await seed(t, '协作偏好', '先给结论。');
        answer = `先说结论[记忆](cite:pmem:${style})。另一条[记忆](cite:pmem:made-up-id)。`;
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '帮我分析一下' } });
        const history = (await t.app.inject({ method: 'GET', url: '/api/conversations/global/messages', headers })).json();
        expect(history.messages[0]).not.toHaveProperty('memoryUsed');
        expect(history.messages[1].memoryUsed).toEqual([style]);
        const [run] = await t.sql("SELECT input_snapshot->'qualitySignals' AS signals FROM agent_runs WHERE kind = 'conversation'");
        expect(run.signals).toEqual([{ signal: 'memory_mark_unknown_id', ids: ['made-up-id'] }]);
        // 标记都对得上时没有质量信号。
        answer = `先说结论[记忆](cite:pmem:${style})。`;
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '再分析一下' } });
        const runs = await t.sql("SELECT input_snapshot ? 'qualitySignals' AS has FROM agent_runs WHERE kind = 'conversation' ORDER BY started_at");
        expect(runs.map((row) => row.has)).toEqual([true, false]);
    } finally {
        await t.close();
    }
});

test('forgetting a memory keeps the model context of every conversation of that person (3d)', async () => {
    const inputs: Parameters<ConversationRuntime['run']>[0][] = [];
    const t = await createTestApp({}, { async run(input) { inputs.push(input); return { assistantMessage: '回复', runtimeEntries: [{ turn: inputs.length }] }; } });
    try {
        const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
        const id = await seed(t, '协作偏好', '先给结论。');
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '第一轮' } });
        // 同一个人在另一个页面的对话。
        await t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id, runtime_entries) VALUES (gen_random_uuid(), 'person-fixture-001', 'issue:other', gen_random_uuid(), '[{\"other\":1}]'::jsonb)");
        const before = await t.sql("SELECT scope, runtime_entries, pi_session_id FROM conversations WHERE owner_id = 'person-fixture-001' ORDER BY scope");
        expect((await t.app.inject({ method: 'DELETE', url: `/api/me/memory/personal/items/${id}`, headers })).statusCode).toBe(200);
        expect(await t.sql("SELECT scope, runtime_entries, pi_session_id FROM conversations WHERE owner_id = 'person-fixture-001' ORDER BY scope")).toEqual(before);
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '第二轮' } });
        expect(inputs[1].runtimeEntries).toEqual([{ turn: 1 }]);
        expect(await inputs[1].personalMemory).toEqual([]);
    } finally {
        await t.close();
    }
});

test('an explicit memory request whose memory update fails keeps the main answer and the model context (3c)', async () => {
    const inputs: Parameters<ConversationRuntime['run']>[0][] = [];
    const t = await createTestApp({}, { async run(input) { inputs.push(input); input.emit({ type: 'message', delta: '主回答' }); return { assistantMessage: '主回答', runtimeEntries: [{ turn: inputs.length }] }; } },
        { personalDistillationStream: () => { throw new Error('memory model down'); } });
    try {
        const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
        await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '第一轮' } });
        const reply = await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '忘掉我先看结论的偏好。' } });
        expect(reply.body).toContain('主回答');
        expect(inputs).toHaveLength(2);
        expect(inputs[1].runtimeEntries).toEqual([{ turn: 1 }]);
        expect(await t.sql("SELECT runtime_entries FROM conversations WHERE owner_id = 'person-fixture-001'")).toEqual([{ runtime_entries: [{ turn: 2 }] }]);
        const history = (await t.app.inject({ method: 'GET', url: '/api/conversations/global/messages', headers })).json();
        expect(history.messages.map((message: { content: string }) => message.content)).toEqual(['第一轮', '主回答', '忘掉我先看结论的偏好。', '主回答']);
    } finally {
        await t.close();
    }
});

test('the main agent remembers, corrects and forgets through its own tools with the current words as reference (3c)', async () => {
    const outcomes: unknown[] = [];
    const t = await createTestApp({}, { async run(input) {
        const tools = input.personalMemoryTools!;
        if (input.message === '记住我习惯先看结论。') outcomes.push(await tools.remember({ title: '沟通偏好', text: '习惯先看结论。' }));
        if (input.message === '不对，改成先看推导。') {
            const [entry] = await tools.search('先看结论');
            outcomes.push(await tools.remember({ title: '沟通偏好', text: '习惯先看推导。', replaces: entry.id }));
        }
        if (input.message === '忘掉那条偏好。') {
            const [entry] = await tools.search('先看推导');
            outcomes.push(await tools.forget({ id: entry.id }));
            outcomes.push(await tools.forget({ id: entry.id }).catch((error: Error) => error.message));
        }
        return { assistantMessage: '好的', runtimeEntries: input.runtimeEntries };
    } });
    try {
        const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
        const send = (message: string) => t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message } });
        await send('记住我习惯先看结论。');
        const [remembered] = (await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers })).json().items;
        expect(remembered).toMatchObject({ text: '习惯先看结论。', references: [{ ref: expect.stringMatching(/^chat:.+#1$/), quote: '记住我习惯先看结论。' }] });
        await send('不对，改成先看推导。');
        const all = (await t.app.inject({ method: 'GET', url: '/api/me/memory/personal?status=all', headers })).json().items;
        const corrected = all.find((item: { text: string }) => item.text === '习惯先看推导。');
        expect(all.find((item: { id: string }) => item.id === remembered.id)).toMatchObject({ status: 'superseded', supersededBy: corrected.id });
        const reply = await send('忘掉那条偏好。');
        expect(reply.body).toContain('completed');
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers })).json().items).toEqual([]);
        expect(outcomes[3]).toContain('PERSONAL_ITEM_NOT_ACTIVE');
        expect((await t.app.inject({ method: 'GET', url: '/api/me/memory/personal', headers: { cookie: await t.memberCookie(), origin: t.publicOrigin } })).json().items).toEqual([]);
    } finally {
        await t.close();
    }
});
