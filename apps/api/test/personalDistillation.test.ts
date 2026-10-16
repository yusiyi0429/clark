import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createTestApp, createTestDb, TEST_CEO } from './helpers.js';
import { migrate } from '../src/migrate.js';
import { createPersonalMemory } from '../src/personalMemory.js';
import { createPersonalDistillation } from '../src/personalDistillation.js';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function candidate(value: unknown) {
  if (value && typeof value === 'object' && 'items' in value && !('status' in value)) {
    const result = value as { items: unknown[]; clarification: string };
    value = { ...result, status: result.clarification ? 'needs_clarification' : result.items.length ? 'apply' : 'noop' };
  }
  const events = createAssistantMessageEventStream();
  const call = { type: 'toolCall' as const, id: randomUUID(), name: 'submit_candidate', arguments: value as Record<string, unknown> };
  const final: AssistantMessage = { role: 'assistant', api: 'openai-responses', provider: 'warmap', model: 'test', content: [call], usage, stopReason: 'toolUse', timestamp: Date.now() };
  queueMicrotask(() => { events.push({ type: 'start', partial: final }); events.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: final }); events.push({ type: 'done', reason: 'toolUse', message: final }); });
  return events;
}
const inputOf = (context: Context) => {
  const message = context.messages[0];
  return JSON.parse(typeof message.content === 'string' ? message.content : (message.content[0] as { text: string }).text).input;
};
const add = (key: string, text: string, sequence: number, quote: string, extra: Record<string, unknown> = {}) =>
  ({ op: 'add', kind: 'preference', title: '偏好', text, anchor: 'topic:沟通', inferred: false, evidence: [{ sequence, quote }], ...extra });

/** 一个人、一段对话、若干条消息；返回 worker 工厂与记忆。 */
async function setup(db: import('pg').PoolClient, pool: import('pg').Pool, messages: [number, 'user' | 'assistant', string][], scope = 'global') {
  const memory = createPersonalMemory({ pool }), conversationId = randomUUID();
  await db.query("INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,'alice',$2,$3)", [conversationId, scope, randomUUID()]);
  for (const [sequence, role, content] of messages)
    await db.query('INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,$2,$3,$4,$5)', [conversationId, sequence, role, content, randomUUID()]);
  const worker = (streamSimple: (model: unknown, context: Context) => ReturnType<typeof candidate>) =>
    createPersonalDistillation({ pool, memory, baseUrl: 'https://provider.invalid/v1', apiKey: 'test', modelId: 'test', streamSimple: streamSimple as never });
  return { memory, conversationId, worker };
}

test('the worker learns only from the owner\'s own words, records time, anchor and reference, and duplicate delivery is harmless', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', '我一直喜欢先看结论，再看依据。'], [2, 'assistant', '公司目标是十家客户，张三喜欢咖啡。']], 'issue:i1');
    const contexts: string[] = []; let calls = 0;
    const make = () => worker((_model, context) => { calls++; contexts.push(JSON.stringify(context)); return candidate({ items: [add('communication_order', '喜欢先看结论，再看依据。', 1, '我一直喜欢先看结论，再看依据。', { anchor: 'issue:i1' })], clarification: '' }); });
    const job = await make().enqueue(db, { personId: 'alice', conversationId, throughSequence: 1 });
    await make().enqueue(db, { personId: 'alice', conversationId, throughSequence: 1 });
    await make().processNext();
    const [saved] = await memory.list('alice');
    expect(saved).toMatchObject({ text: '喜欢先看结论，再看依据。', status: 'active', anchors: [{ target: 'issue:i1' }],
      references: [{ ref: `chat:${conversationId}#1`, quote: '我一直喜欢先看结论，再看依据。' }] });
    expect(Date.parse(saved.references[0].at)).not.toBeNaN();
    expect(contexts.join('')).not.toContain('十家客户');
    expect(contexts.join('')).not.toContain('张三');
    expect(await make().status(job)).toMatchObject({ status: 'succeeded', attempts: 1 });
    const audit = await db.query("SELECT input_snapshot, candidate_output, error FROM agent_runs WHERE kind='personal-memory-distillation'");
    expect(audit.rows[0]).toMatchObject({ input_snapshot: { currentSequence: 1 }, error: null });
    expect(await make().processNext()).toBe(false);
    expect(calls).toBe(1);
  });
});

test('a successful main reply queues natural learning that a later worker consumes', async () => {
  const learn = () => candidate({ items: [add('communication_order', '先看结论。', 1, '我一直先看结论。')], clarification: '' });
  const t = await createTestApp({}, undefined, { personalDistillationStream: learn });
  try {
    const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
    await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '我一直先看结论。' } });
    expect(await t.sql('SELECT person_id, through_sequence FROM personal_memory_jobs')).toEqual([{ person_id: TEST_CEO.personId, through_sequence: 1 }]);
    const worker = createPersonalDistillation({ pool: t.pool, memory: createPersonalMemory({ pool: t.pool }), baseUrl: 'https://provider.invalid/v1', apiKey: 'test', modelId: 'test', streamSimple: learn });
    await worker.processNext(TEST_CEO.personId);
    expect((await t.app.inject({ url: '/api/me/memory/personal', headers })).json().items).toMatchObject([{ text: '先看结论。' }]);
  } finally { await t.close(); }
});

test('fabricated evidence retries at most three times and a malformed submission has a bounded model call budget', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', '我一直喜欢游泳。']]);
    let calls = 0;
    const fake = worker(() => { calls++; return candidate({ items: [add('hobby', '喜欢游泳。', 1, '不存在的本人消息')], clarification: '' }); });
    const job = await fake.enqueue(db, { personId: 'alice', conversationId, throughSequence: 1 });
    await fake.processNext(); await fake.processNext(); await fake.processNext();
    expect(await fake.processNext()).toBe(false);
    expect(await fake.status(job)).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'INVALID_USER_EVIDENCE' });
    expect(calls).toBe(3);
    let budgetCalls = 0;
    const malformed = worker(() => { budgetCalls++; if (budgetCalls > 2) throw new Error('test cap'); return candidate({ invalid: 'submission' }); });
    await db.query("INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id) VALUES($1,2,'user','我通常先看结论。',$2)", [conversationId, randomUUID()]);
    const second = await malformed.enqueue(db, { personId: 'alice', conversationId, throughSequence: 2 });
    await malformed.processNext();
    expect(budgetCalls).toBe(2);
    expect(await malformed.status(second)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await memory.list('alice')).toEqual([]);
  });
});

test.each([false, true])('old-only evidence rejects the whole batch (stored before: %s)', async stored => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', '我长期使用中文沟通。'], [3, 'user', '我通常先看结论。']]);
    if (stored) await memory.add('alice', { title: '沟通偏好', text: '长期使用中文沟通。' });
    const fake = worker(() => candidate({ status: 'apply', items: [add('language', '长期使用中文沟通。', 1, '我长期使用中文沟通。'), add('order', '通常先看结论。', 3, '我通常先看结论。')], clarification: '' }));
    const job = await fake.enqueue(db, { personId: 'alice', conversationId, throughSequence: 3 });
    await fake.processNext();
    expect(await fake.status(job)).toMatchObject({ status: 'pending', errorCode: 'NO_CURRENT_USER_EVIDENCE' });
    expect((await memory.list('alice')).map(item => item.text)).toEqual(stored ? ['长期使用中文沟通。'] : []);
  });
});

test('an update supersedes the old item and a removal forgets it, both with current evidence', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', '我现在更喜欢先看推导，不喝咖啡了。']]);
    const style = await memory.add('alice', { title: '沟通偏好', text: '先看结论。' });
    const drink = await memory.add('alice', { title: '饮食偏好', text: '喜欢咖啡。' });
    const fake = worker(() => candidate({ items: [
      { op: 'supersede', kind: 'preference', replaces: style.id, title: '沟通偏好', text: '更喜欢先看推导。', anchor: 'topic:沟通', inferred: false, evidence: [{ sequence: 1, quote: '我现在更喜欢先看推导' }] },
      { op: 'forget', kind: 'preference', replaces: drink.id, title: '饮食偏好', text: '', anchor: 'topic:饮食', inferred: false, evidence: [{ sequence: 1, quote: '不喝咖啡了' }] },
    ], clarification: '' }));
    await fake.enqueue(db, { personId: 'alice', conversationId, throughSequence: 1 });
    await fake.processNext();
    const [current] = await memory.list('alice');
    expect(current.text).toBe('更喜欢先看推导。');
    expect(await memory.get('alice', style.id)).toMatchObject({ status: 'superseded', supersededBy: current.id, text: '先看结论。' });
    expect(await memory.get('alice', drink.id)).toMatchObject({ status: 'forgotten' });
  });
});

test('forgotten content is not learned back, under its own key, a new key, or the same words', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', '我周末经常徒步。']]);
    const hobby = await memory.add('alice', { title: '兴趣', text: '喜欢徒步。' });
    await memory.forget('alice', hobby.id);
    const contexts: string[] = [];
    const fake = worker((_model, context) => { contexts.push(JSON.stringify(inputOf(context))); return candidate({ items: [
      add('new-hiking-key', '周末徒步。', 1, '我周末经常徒步。', { matchedForgottenId: hobby.id }),
      add('other-key', '喜欢徒步。', 1, '我周末经常徒步。'),
    ], clarification: '' }); });
    const job = await fake.enqueue(db, { personId: 'alice', conversationId, throughSequence: 1 });
    await fake.processNext();
    expect(await fake.status(job)).toMatchObject({ status: 'succeeded' });
    expect(await memory.list('alice')).toEqual([]);
    expect(contexts[0]).toContain(hobby.id);
  });
});

test('the current long user message keeps its tail intent while older context is bounded', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const intent = '我以后都先看推导。', content = '背景'.repeat(9000) + intent;
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', '无关旧前文'.repeat(3000)], [2, 'user', content]]);
    let current = '';
    const fake = worker((_model, context) => {
      current = inputOf(context).messages.find((message: { sequence: number }) => message.sequence === 2).content;
      return candidate({ items: [add('order', '先看推导。', 2, intent)], clarification: '' });
    });
    await fake.enqueue(db, { personId: 'alice', conversationId, throughSequence: 2 });
    await fake.processNext();
    expect(current.length).toBe(content.length);
    expect(current.endsWith(intent)).toBe(true);
    expect((await memory.list('alice')).map(item => item.text)).toEqual(['先看推导。']);
  });
});

test.each([
  { status: 'noop', changes: true, clarification: '' },
  { status: 'apply', changes: true, clarification: '已记住你的偏好。' },
  { status: 'needs_clarification', changes: false, clarification: '' },
] as const)('invalid candidate outcome is rejected atomically: $status / $clarification', async result => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', '我通常先看结论。']]);
    const fake = worker(() => candidate({ status: result.status, clarification: result.clarification, items: result.changes ? [add('communication', '通常先看结论。', 1, '我通常先看结论。')] : [] }));
    const job = await fake.enqueue(db, { personId: 'alice', conversationId, throughSequence: 1 });
    await fake.processNext();
    expect(await fake.status(job)).toMatchObject({ status: 'pending', errorCode: 'INVALID_CANDIDATE_STATUS' });
    expect(await memory.list('alice')).toEqual([]);
  });
});

test('the prompt asks for ideas, stances, open questions, reasons and preferences, each with anchor and reference (3b)', async () => {
  const { DISTILLATION_PROMPT } = await import('../src/personalDistillation.js');
  for (const word of ['想法（idea）', '立场（stance）', '未决问题（open_question）', '理由（reason）', '偏好与习惯（preference）', 'anchorCandidates', 'topic:<主题>', 'op=supersede', '旧条目不改'])
    expect(DISTILLATION_PROMPT).toContain(word);
  expect(DISTILLATION_PROMPT).not.toContain('记忆是长期个人偏好、习惯、个人约束');
});

test('ideas are anchored to the page object with its version pinned, or to a topic; anything else is rejected (3b, R5)', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const quote = '这个议题我的立场是预算砍一半，理由是回报周期太长；还没想清楚的是砍哪一块。';
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', quote]], 'issue:i1');
    // 当时页面上的对象（议题第 4 版）记在那一轮的运行记录里。
    const runId = (await db.query('SELECT run_id FROM conversation_messages WHERE conversation_id=$1', [conversationId])).rows[0].run_id;
    await db.query(`INSERT INTO agent_runs (id, kind, object_ref, status, model_slot, prompt_hash, input_snapshot) VALUES ($1, 'conversation', 'null', 'succeeded', 'light', 'x', $2::jsonb)`,
      [runId, JSON.stringify({ currentObject: { cardId: 'issue-card', version: 4, kind: 'issue', title: '渠道预算', objectRef: { type: 'issue', id: 'i1', version: 4 } } })]);
    let seen: unknown;
    const fake = (anchor: string) => worker((_model, context) => { seen = inputOf(context).anchorCandidates; return candidate({ items: [
      { op: 'add', kind: 'stance', title: '渠道预算砍一半', text: '倾向把渠道预算砍一半，理由是回报周期太长。', anchor, inferred: false, evidence: [{ sequence: 1, quote }] },
      { op: 'add', kind: 'open_question', title: '砍哪一块', text: '还没想清楚砍哪一块预算。', anchor: 'topic:渠道预算', inferred: false, evidence: [{ sequence: 1, quote }] },
    ], clarification: '' }); });
    const bad = fake('issue:someone-else');
    const rejected = await bad.enqueue(db, { personId: 'alice', conversationId, throughSequence: 1 });
    await bad.processNext();
    expect(await bad.status(rejected)).toMatchObject({ status: 'pending', errorCode: 'INVALID_ANCHOR' });
    expect(await memory.list('alice')).toEqual([]);
    await fake('issue:i1').processNext();
    expect(seen).toEqual([{ target: 'issue:i1', title: '渠道预算' }]);
    const items = await memory.list('alice');
    expect(items.find(item => item.kind === 'stance')).toMatchObject({ anchors: [{ target: 'issue:i1', pinnedVersion: 4 }], references: [{ ref: `chat:${conversationId}#1` }] });
    expect(items.find(item => item.kind === 'open_question')).toMatchObject({ anchors: [{ target: 'topic:渠道预算' }] });
  });
});

test('a correction is a new item that supersedes the old one; inferred corrections are refused (3b)', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, conversationId, worker } = await setup(db, pool, [[1, 'user', '我之前说先做一线城市，不对，改成先做县城样板。']]);
    const old = await memory.add('alice', { kind: 'stance', title: '渠道立场', text: '先做一线城市。' });
    const correction = (inferred: boolean) => worker(() => candidate({ items: [{ op: 'supersede', kind: 'stance', replaces: old.id, title: '渠道立场', text: '先做县城样板，不再先做一线城市。',
      anchor: 'topic:渠道', inferred, evidence: [{ sequence: 1, quote: '改成先做县城样板' }] }], clarification: '' }));
    const job = await correction(true).enqueue(db, { personId: 'alice', conversationId, throughSequence: 1 });
    await correction(true).processNext();
    expect(await correction(true).status(job)).toMatchObject({ status: 'pending', errorCode: 'INVALID_EXPLICIT_EVIDENCE' });
    await correction(false).processNext();
    const [current] = await memory.list('alice');
    expect(current).toMatchObject({ kind: 'stance', text: '先做县城样板，不再先做一线城市。' });
    expect(await memory.get('alice', old.id)).toMatchObject({ status: 'superseded', supersededBy: current.id, text: '先做一线城市。' });
  });
});
