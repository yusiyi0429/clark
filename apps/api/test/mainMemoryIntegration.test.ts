import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createTestApp, testEnv } from './helpers.js';
import { createPiConversationRuntime } from '../src/piConversationRuntime.js';
import { loadPeopleDirectory } from '../src/peopleDirectory.js';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function response(tool?: { name: string; arguments: Record<string, unknown> }) {
  const content: AssistantMessage['content'] = tool ? [{ type: 'toolCall', id: randomUUID(), ...tool }] : [{ type: 'text', text: '受控回答' }];
  const message: AssistantMessage = { role: 'assistant', api: 'openai-responses', provider: 'warmap', model: 'fake-light', content, stopReason: tool ? 'toolUse' : 'stop', usage, timestamp: Date.now() };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push(tool ? { type: 'done', reason: 'toolUse', message } : { type: 'done', reason: 'stop', message }));
  return stream;
}
const options = { peopleDirectory: loadPeopleDirectory(testEnv), baseUrl: 'https://provider.invalid/v1', apiKey: 'test', modelId: 'fake-light' };

test('legacy JSON context is replaced from raw chat without losing history or importing old Personal', async () => {
  const t = await createTestApp();
  const captures: Context[] = [];
  const runtime = await createPiConversationRuntime({ ...options, streamSimple: (_model, context) => { captures.push({ ...context, messages: structuredClone(context.messages) }); return response(); } });
  try {
    const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin }, id = randomUUID();
    await t.sql('INSERT INTO conversations(id,owner_id,scope,pi_session_id,runtime_entries,context_schema_version) VALUES($1,$2,$3,$4,$5,0)', [id, 'person-fixture-001', 'global', randomUUID(), JSON.stringify([{ old: { globalContext: '过期公司秘密' } }])]);
    await t.sql("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,1,'user','旧用户原话：通常先看结论。',$2),($1,2,'assistant','旧助手原话。',$2)", [id, randomUUID()]);
    await t.app.close(); const app = await t.restart(runtime);
    const result = await app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '现在润色这句话。' } });
    expect(result.body).toContain('event: done');
    expect(JSON.stringify(captures[0].messages)).toContain('旧用户原话：通常先看结论。');
    expect(JSON.stringify(captures[0].messages)).not.toContain('过期公司秘密');
    const history = (await app.inject({ url: '/api/conversations/global/messages', headers })).json();
    expect(history.messages.map((item: { content: string }) => item.content)).toEqual(['旧用户原话：通常先看结论。', '旧助手原话。', '现在润色这句话。', '受控回答']);
    expect((await app.inject({ url: '/api/me/memory/personal', headers })).json().sections).toEqual([]);
  } finally { await runtime.close?.(); await t.close(); }
});

test('HTTP Personal references and search expand P1 using the real Personal service through Pi', async () => {
  let calls = 0; const values: unknown[] = [];
  const t = await createTestApp({}, undefined, { conversationStream: (_model, context) => {
    calls++; if (calls > 1) values.push(context.messages.at(-1));
    if (calls === 1) { expect(JSON.stringify(context.messages)).toContain('P1'); return response({ name: 'read_reference', arguments: { handle: 'P1' } }); }
    if (calls === 2) return response({ name: 'search_memory', arguments: { module: 'personal', query: '结论' } });
    if (calls === 3) return response({ name: 'read_reference', arguments: { handle: 'P1' } });
    return response();
  } });
  try {
    const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin };
    expect((await t.app.inject({ method: 'PUT', url: '/api/me/memory/personal', headers, payload: { expectedRevision: 0, markdown: '# Personal\n\n## 协作偏好\n\n喜欢先给结论。' } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '分析当前问题' } })).body).toContain('event: done');
    expect(calls).toBe(4);
    for (const value of values) { expect(JSON.stringify(value)).toContain('喜欢先给结论'); expect(JSON.stringify(value)).not.toContain('<!--'); }
  } finally { await t.close(); }
});

test('attachment expansion pages escaped text below 8 KiB and reconstructs the entire authorized document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-integration-'));
  const t = await createTestApp({ conversationAttachmentStorageDir: dir });
  const content = '\\"'.repeat(7000); let calls = 0, expanded = '';
  const runtime = await createPiConversationRuntime({ ...options, streamSimple: (_model, context) => {
    calls++;
    if (calls > 1) {
      const last = context.messages.at(-1); if (last?.role !== 'toolResult') throw new Error('missing tool result');
      const text = last.content.filter(item => item.type === 'text').map(item => item.text).join('');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
      const page = JSON.parse(text); expanded += page.text;
      if (!page.more) return response();
      expect(page.cursor).toBeTruthy(); return response({ name: 'read_reference', arguments: { handle: 'R1', cursor: page.cursor } });
    }
    return response({ name: 'read_reference', arguments: { handle: 'R1' } });
  } });
  try {
    const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin }, boundary = 'memory-acceptance';
    const uploaded = await t.app.inject({ method: 'POST', url: '/api/conversations/global/attachments', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="quoted.md"\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--${boundary}--\r\n`) });
    expect(uploaded.statusCode).toBe(200);
    await t.app.close(); const app = await t.restart(runtime);
    const result = await app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '完整阅读这份材料。', attachments: [{ id: uploaded.json().attachments[0].id }] } });
    expect(result.body).toContain('event: done'); expect(expanded).toBe(content); expect(calls).toBeGreaterThan(2);
  } finally { await runtime.close?.(); await t.close(); await rm(dir, { recursive: true, force: true }); }
});

test('oversized references are reduced before the complete query and necessary focus; irreducible query never reaches provider', async () => {
  const query = '用户完整问题'.repeat(15000);
  let calls = 0;
  const runtime = await createPiConversationRuntime({ ...options, streamSimple: (_model, context) => {
    calls++;
    const user = context.messages.findLast(item => item.role === 'user');
    const current = JSON.parse(typeof user!.content === 'string' ? user!.content : (user!.content[0] as { text: string }).text);
    expect(current.query).toBe(query); expect(current.anchor.focus.title).toBe('必须保留的选择');
    expect(JSON.stringify(context.messages)).not.toContain('超长参考'.repeat(100));
    return response();
  } });
  const input = { scope: 'global' as const, viewer: { personId: 'person-fixture-001', displayName: '甲', role: 'ceo' as const }, message: query, currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: () => undefined,
    anchor: { view: { scene: '公司首页', summary: '当前页面', focus: { handle: 'A1', title: '必须保留的选择' }, items: [], more: false }, read: async () => ({}) },
    references: [{ handle: 'R1', kind: 'attachment' as const, title: '巨大材料', text: '超长参考'.repeat(100000) }] };
  try {
    await runtime.run(input); expect(calls).toBe(1);
    await expect(runtime.run({ ...input, message: 'z'.repeat(500000), references: [] })).rejects.toMatchObject({ code: 'TURN_CONTEXT_TOO_LARGE' });
    expect(calls).toBe(1);
  } finally { await runtime.close?.(); }
});

test('ephemeral tool bodies exist only in the current provider turn even when a later turn reuses a tool call id', async () => {
  let calls = 0; const captured: Context[] = [];
  const runtime = await createPiConversationRuntime({ ...options, streamSimple: (_model, context) => {
    captured.push({ ...context, messages: structuredClone(context.messages) }); calls++;
    if (calls % 2 === 1) {
      const message: AssistantMessage = { role: 'assistant', api: 'openai-responses', provider: 'warmap', model: 'fake-light', content: [{ type: 'toolCall', id: 'reused-id', name: 'read_anchor', arguments: { handle: 'A1' } }], stopReason: 'toolUse', usage, timestamp: Date.now() };
      const events = createAssistantMessageEventStream(); queueMicrotask(() => events.push({ type: 'done', reason: 'toolUse', message })); return events;
    }
    return response();
  } });
  const input = { scope: 'global' as const, viewer: { personId: 'person-fixture-001', role: 'ceo' as const, displayName: '甲' }, currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: () => undefined };
  const anchor = (text: string) => ({ view: { scene: '首页', summary: '目录', items: [], more: false }, read: async () => ({ text }) });
  try {
    const first = await runtime.run({ ...input, message: 'first', anchor: anchor('OLD_EPHEMERAL_BODY') });
    expect(JSON.stringify(captured[1].messages)).toContain('OLD_EPHEMERAL_BODY');
    expect(JSON.stringify(first.runtimeEntries)).not.toContain('OLD_EPHEMERAL_BODY');
    const second = await runtime.run({ ...input, message: 'next', runtimeEntries: first.runtimeEntries, anchor: anchor('NEW_EPHEMERAL_BODY') });
    expect(JSON.stringify(captured[3].messages)).not.toContain('OLD_EPHEMERAL_BODY');
    expect(JSON.stringify(captured[3].messages).match(/NEW_EPHEMERAL_BODY/g)).toHaveLength(1);
    expect(JSON.stringify(second.runtimeEntries)).not.toContain('NEW_EPHEMERAL_BODY');
    const results = captured[3].messages.filter(item => item.role === 'toolResult');
    expect(results).toHaveLength(2); expect(results.every(item => item.toolCallId === 'reused-id')).toBe(true);
  } finally { await runtime.close?.(); }
});

test('production main chat expands a long Personal section losslessly using only per-turn short cursors', async () => {
  const content = '协作偏好：\\"先明确边界\\"，然后讨论细节。\n'.repeat(180).trim();
  let calls = 0, expanded = '';
  const t = await createTestApp({}, undefined, { conversationStream: (_model, context) => {
    calls++;
    if (calls > 1) {
      const result = context.messages.at(-1); if (result?.role !== 'toolResult') throw new Error('missing reference result');
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192); const page = JSON.parse(text); expanded += page.text;
      if (!page.more) return response();
      expect(page.cursor).toMatch(/^PC\d+$/);
      return response({ name: 'read_reference', arguments: { handle: 'P1', cursor: page.cursor } });
    }
    return response({ name: 'read_reference', arguments: { handle: 'P1' } });
  } });
  try {
    const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin };
    expect((await t.app.inject({ method: 'PUT', url: '/api/me/memory/personal', headers, payload: { expectedRevision: 0, markdown: `# Personal\n\n## 协作偏好\n\n${content}` } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '谈谈协作偏好' } })).body).toContain('event: done');
    expect(expanded).toBe(content); expect(calls).toBeGreaterThan(2);
  } finally { await t.close(); }
});

test('all memory read tools expose live bodies to this turn but persist only paired placeholders', async () => {
  const requests = [
    { name: 'read_anchor', arguments: { handle: 'A1' } },
    { name: 'query_company', arguments: {} },
    { name: 'search_memory', arguments: { module: 'personal', query: '偏好' } },
    { name: 'read_reference', arguments: { handle: 'P1' } },
    { name: 'read_reference', arguments: { handle: 'C1' } },
  ];
  let calls = 0;
  const live: string[] = [];
  const runtime = await createPiConversationRuntime({ ...options,
    company: { read: async () => ({ status: 'ready', entries: [{ handle: 'internal-company', title: '公司章节', text: 'COMPANY_TOOL_ONLY' }] }) },
    personal: { select: async () => [{ handle: 'internal-personal', kind: 'personal', title: '偏好', text: 'PERSONAL_TOOL_ONLY' }], readReference: async () => ({ title: '偏好', text: 'PERSONAL_TOOL_ONLY' }) },
    streamSimple: (_model, context) => {
      if (calls) live.push(JSON.stringify(context.messages.at(-1)));
      return calls < requests.length ? response(requests[calls++]) : response();
    },
  });
  try {
    const result = await runtime.run({ scope: 'global', viewer: { personId: 'alice', displayName: '甲', role: 'ceo' }, message: '依次查询', currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: () => undefined,
      anchor: { view: { scene: '首页', summary: '目录', items: [], more: false }, read: async () => ({ text: 'ANCHOR_TOOL_ONLY' }) } });
    expect(live[0]).toContain('ANCHOR_TOOL_ONLY'); expect(live[1]).toContain('COMPANY_TOOL_ONLY');
    expect(live[2]).toContain('PERSONAL_TOOL_ONLY'); expect(live[3]).toContain('PERSONAL_TOOL_ONLY'); expect(live[4]).toContain('COMPANY_TOOL_ONLY');
    expect(JSON.stringify(result.runtimeEntries)).not.toMatch(/ANCHOR_TOOL_ONLY|COMPANY_TOOL_ONLY|PERSONAL_TOOL_ONLY/);
  } finally { await runtime.close?.(); }
});
