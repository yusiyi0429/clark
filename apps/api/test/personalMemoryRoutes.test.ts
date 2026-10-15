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
