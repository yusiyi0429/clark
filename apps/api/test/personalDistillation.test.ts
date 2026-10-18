import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createTestApp, createTestDb, TEST_CEO } from './helpers.js';
import { migrate } from '../src/migrate.js';
import { createPersonalMemory } from '../src/personalMemory.js';
import { createPersonalDistillation, DISTILLATION_PROMPT, type DistillationSettings } from '../src/personalDistillation.js';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function candidate(value: Record<string, unknown>) {
  if ('items' in value && !('status' in value)) {
    const items = value.items as unknown[];
    value = { clarification: '', ...value, status: value.clarification ? 'needs_clarification' : items.length ? 'apply' : 'noop' };
  }
  const events = createAssistantMessageEventStream();
  const call = { type: 'toolCall' as const, id: randomUUID(), name: 'submit_candidate', arguments: value };
  const final: AssistantMessage = { role: 'assistant', api: 'openai-responses', provider: 'warmap', model: 'test', content: [call], usage, stopReason: 'toolUse', timestamp: Date.now() };
  queueMicrotask(() => { events.push({ type: 'start', partial: final }); events.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: final }); events.push({ type: 'done', reason: 'toolUse', message: final }); });
  return events;
}
type Input = { messages: { ref: string; content: string; reply?: string; page: string; anchorCandidates: { target: string; title?: string }[] }[]; earlier: string[]; memory: { id: string; text: string }[]; forgotten: { id: string }[] };
const inputOf = (context: Context): Input => {
  const message = context.messages[0];
  return JSON.parse(typeof message.content === 'string' ? message.content : (message.content[0] as { text: string }).text).input;
};
const add = (text: string, message: string, quote: string, extra: Record<string, unknown> = {}) =>
  ({ op: 'add', kind: 'idea', title: '想法', text, anchor: 'topic:想法', inferred: false, evidence: [{ message, quote }], ...extra });

/** 本人（alice）在若干页面说的话；返回 worker 工厂与记忆。时间按给出顺序递增。 */
async function setup(db: import('pg').PoolClient, pool: import('pg').Pool) {
  const memory = createPersonalMemory({ pool });
  const conversations = new Map<string, string>();
  let clock = Date.now() - 2 * 86_400_000;
  const say = async (scope: string, content: string, options: { owner?: string; role?: 'user' | 'assistant'; runId?: string; at?: Date | string } = {}) => {
    const key = `${options.owner ?? 'alice'}|${scope}`;
    if (!conversations.has(key)) {
      const id = randomUUID();
      await db.query('INSERT INTO conversations(id,owner_id,scope,pi_session_id) VALUES($1,$2,$3,$4)', [id, options.owner ?? 'alice', scope, randomUUID()]);
      conversations.set(key, id);
    }
    const conversationId = conversations.get(key)!;
    const sequence = Number((await db.query('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM conversation_messages WHERE conversation_id=$1', [conversationId])).rows[0].next);
    clock += 60_000;
    await db.query('INSERT INTO conversation_messages(conversation_id,sequence,role,content,run_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [conversationId, sequence, options.role ?? 'user', content, options.runId ?? randomUUID(), options.at ?? new Date(clock)]);
    return { conversationId, sequence };
  };
  const worker = (streamSimple: (model: unknown, context: Context) => ReturnType<typeof candidate>, settings: Partial<DistillationSettings> = { idleMs: 0 }) =>
    createPersonalDistillation({ pool, memory, baseUrl: 'https://provider.invalid/v1', apiKey: 'test', modelId: 'test', streamSimple: streamSimple as never, settings });
  return { memory, say, worker };
}

test('one batch covers the owner\'s new words across pages, with replies only as context; others and Mission card pages are excluded (3f, R1)', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, say, worker } = await setup(db, pool);
    const home = await say('global', '我觉得渠道下沉要先做县城样板。');
    await say('global', '公司目标是十家客户。', { role: 'assistant' });
    const issue = await say('issue:i1', '这个议题我倾向先不扩编。');
    await say('mission-card:c1', 'Mission 卡页里的话');
    await say('global', 'bob 的话', { owner: 'bob' });
    const inputs: Input[] = [];
    const run = worker((_model, context) => { inputs.push(inputOf(context)); return candidate({ items: [
      add('渠道下沉先做县城样板。', 'M1', '渠道下沉要先做县城样板'),
      add('倾向先不扩编。', 'M2', '我倾向先不扩编', { kind: 'stance', anchor: 'issue:i1' }),
    ] }); });
    expect(await run.processNext('alice')).toBe(true);
    expect(inputs[0].messages.map(message => [message.ref, message.page, message.content])).toEqual([
      ['M1', 'global', '我觉得渠道下沉要先做县城样板。'], ['M2', 'issue:i1', '这个议题我倾向先不扩编。']]);
    expect(inputs[0].messages[0].reply).toBe('公司目标是十家客户。');
    expect(JSON.stringify(inputs)).not.toContain('Mission 卡页');
    expect(JSON.stringify(inputs)).not.toContain('bob 的话');
    const items = await memory.list('alice');
    expect(items.find(item => item.kind === 'stance')).toMatchObject({ anchors: [{ target: 'issue:i1' }], references: [{ ref: `chat:${issue.conversationId}#${issue.sequence}` }] });
    expect(items.find(item => item.kind === 'idea')).toMatchObject({ references: [{ ref: `chat:${home.conversationId}#${home.sequence}`, quote: '渠道下沉要先做县城样板' }] });
    // 回答里的话不能当证据。
    await say('global', '好的，就按你说的。');
    const fromReply = worker(() => candidate({ items: [add('公司目标是十家客户。', 'M1', '公司目标是十家客户')] }));
    await fromReply.processNext('alice');
    expect(await fromReply.cursor('alice')).toMatchObject({ attempts: 1, lastError: 'INVALID_USER_EVIDENCE' });
  });
});

test('the cursor makes each run see only messages after the last processed one, with a little earlier context (3f)', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { say, worker } = await setup(db, pool);
    await say('global', '第一句想法。');
    await say('global', '第二句想法。');
    const inputs: Input[] = [];
    const run = worker((_model, context) => { inputs.push(inputOf(context)); return candidate({ items: [] }); });
    await run.processNext('alice');
    expect(await run.processNext('alice')).toBe(false);
    const third = await say('issue:i2', '第三句想法。');
    await run.processNext('alice');
    expect(inputs.map(input => input.messages.map(message => message.content))).toEqual([['第一句想法。', '第二句想法。'], ['第三句想法。']]);
    expect(inputs[1].earlier).toEqual(['第一句想法。', '第二句想法。']);
    expect((await run.cursor('alice')).cursor).toMatchObject({ conversationId: third.conversationId, sequence: third.sequence });
  });
});

test('messages in the same millisecond with different microseconds are each learned once (cursor keeps full precision)', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { say, worker } = await setup(db, pool);
    const at = (micros: string) => new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, `.123${micros}Z`);
    await say('global', '同一毫秒第一句。', { at: at('101') });
    await say('global', '同一毫秒第二句。', { at: at('202') });
    await say('global', '同一毫秒第三句。', { at: at('303') });
    const inputs: string[][] = [];
    const run = worker((_model, context) => { inputs.push(inputOf(context).messages.map(message => message.content)); return candidate({ items: [] }); }, { idleMs: 0, windowMessages: 2 });
    expect(await run.processNext('alice')).toBe(true);
    expect(await run.processNext('alice')).toBe(true);
    expect(inputs).toEqual([['同一毫秒第一句。', '同一毫秒第二句。'], ['同一毫秒第三句。']]);
  });
});

test('after a batch is distilled and nothing new is said, no further model call is made', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { say, worker } = await setup(db, pool);
    await say('global', '带微秒的一句话。', { at: new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, '.456789Z') });
    let calls = 0;
    const run = worker(() => { calls++; return candidate({ items: [] }); });
    expect(await run.processNext()).toBe(true);
    expect(calls).toBe(1);
    expect(await run.processNext()).toBe(false);
    expect(await run.processNext('alice')).toBe(false);
    expect(calls).toBe(1);
  });
});

test('a run waits until a batch has accumulated or the person has been idle long enough; each window is capped (3f)', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { say, worker } = await setup(db, pool);
    let calls = 0;
    const sizes: number[] = [];
    const run = (settings: Partial<DistillationSettings>) => worker((_model, context) => { calls++; sizes.push(inputOf(context).messages.length); return candidate({ items: [] }); }, settings);
    for (let index = 0; index < 3; index++) await say('global', `想法 ${index}`);
    // 攒不够一批、也没空闲够久：不跑。
    expect(await run({ batchSize: 5, idleMs: 10 * 365 * 86_400_000 }).processNext()).toBe(false);
    expect(calls).toBe(0);
    for (let index = 3; index < 25; index++) await say('global', `想法 ${index}`);
    // 攒够了就跑；一次最多 windowMessages 条，剩下的下一批。
    const batched = run({ batchSize: 5, idleMs: 10 * 365 * 86_400_000, windowMessages: 20 });
    expect(await batched.processNext()).toBe(true);
    expect(await batched.processNext()).toBe(true);
    expect(sizes).toEqual([20, 5]);
    // 剩下不到一批：空闲够久才跑。
    await say('global', '最后一句');
    expect(await batched.processNext()).toBe(false);
    expect(await run({ batchSize: 5, idleMs: 0 }).processNext()).toBe(true);
    expect(sizes).toEqual([20, 5, 1]);
  });
});

test('a failed run keeps the cursor, backs off, and the same messages are learned on retry (3f, R9)', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, say, worker } = await setup(db, pool);
    await say('global', '我的立场是先做样板。');
    const failing = worker(() => { throw new Error('model down'); });
    expect(await failing.processNext()).toBe(true);
    const state = await failing.cursor('alice');
    expect(state).toMatchObject({ cursor: null, attempts: 1, lastError: 'MODEL_GENERATION_FAILED' });
    expect(state.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // 退避中：不跑。
    expect(await failing.processNext()).toBe(false);
    await failing.processNext('alice', undefined, true);
    const second = await failing.cursor('alice');
    expect(second.attempts).toBe(2);
    // 第二次退避更久。
    expect(second.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(state.nextAttemptAt!.getTime() - Date.now() + 10_000);
    await db.query('UPDATE personal_memory_cursors SET next_attempt_at = now()');
    const ok = worker(() => candidate({ items: [add('先做样板。', 'M1', '我的立场是先做样板', { kind: 'stance' })] }));
    expect(await ok.processNext()).toBe(true);
    expect((await memory.list('alice')).map(item => item.text)).toEqual(['先做样板。']);
    expect(await ok.cursor('alice')).toMatchObject({ attempts: 0, nextAttemptAt: null, lastError: null });
  });
});

test('a person without a cursor is backfilled with the last 30 days only; practices are learned as their own kind', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, say, worker } = await setup(db, pool);
    await say('global', '两个月前说的：周报我先列风险。', { at: new Date(Date.now() - 60 * 86_400_000) });
    await say('global', '十天前说的：周会我先过阻塞再过进展。', { at: new Date(Date.now() - 10 * 86_400_000) });
    const inputs: Input[] = [];
    const run = worker((_model, context) => { inputs.push(inputOf(context)); return candidate({ items: [
      add('周会先过阻塞再过进展。', 'M1', '周会我先过阻塞再过进展', { kind: 'practice' })] }); });
    expect(await run.processNext('alice')).toBe(true);
    expect(inputs[0].messages.map(message => message.content)).toEqual(['十天前说的：周会我先过阻塞再过进展。']);
    expect(await memory.list('alice')).toMatchObject([{ kind: 'practice', text: '周会先过阻塞再过进展。' }]);
    expect(await run.processNext('alice')).toBe(false);
  });
});

test('a conversation turn no longer queues memory work per message (3f)', async () => {
  let calls = 0;
  const t = await createTestApp({}, undefined, { personalDistillationStream: () => { calls++; return candidate({ items: [] }); } });
  try {
    const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
    await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '我一直先看结论。' } });
    await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: { message: '还有一个想法。' } });
    expect(calls).toBe(0);
    expect(await t.sql("SELECT to_regclass('personal_memory_jobs') AS jobs")).toEqual([{ jobs: null }]);
    const worker = createPersonalDistillation({ pool: t.pool, memory: createPersonalMemory({ pool: t.pool }), baseUrl: 'https://provider.invalid/v1', apiKey: 'test', modelId: 'test',
      streamSimple: () => { calls++; return candidate({ items: [add('先看结论。', 'M1', '我一直先看结论', { kind: 'preference' })] }); }, settings: { idleMs: 0 } });
    await worker.processNext(TEST_CEO.personId);
    expect(calls).toBe(1);
    expect((await t.app.inject({ url: '/api/me/memory/personal', headers })).json().items).toMatchObject([{ text: '先看结论。', kind: 'preference' }]);
  } finally { await t.close(); }
});

test('fabricated evidence or a malformed submission fails the batch within a bounded model call budget', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, say, worker } = await setup(db, pool);
    await say('global', '我一直喜欢游泳。');
    await worker(() => candidate({ items: [add('喜欢游泳。', 'M1', '不存在的本人消息')] })).processNext();
    expect(await worker(() => candidate({ items: [] })).cursor('alice')).toMatchObject({ cursor: null, lastError: 'INVALID_USER_EVIDENCE' });
    let calls = 0;
    await db.query('UPDATE personal_memory_cursors SET next_attempt_at = now()');
    await worker(() => { calls++; if (calls > 2) throw new Error('test cap'); return candidate({ invalid: 'submission' }); }).processNext();
    expect(calls).toBe(2);
    expect(await memory.list('alice')).toEqual([]);
  });
});

test('an update supersedes the old item, a removal forgets it, and forgotten content is not learned back', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, say, worker } = await setup(db, pool);
    const style = await memory.add('alice', { kind: 'preference', title: '沟通偏好', text: '先看结论。' });
    const drink = await memory.add('alice', { kind: 'preference', title: '饮食偏好', text: '喜欢咖啡。' });
    const hobby = await memory.add('alice', { title: '兴趣', text: '喜欢徒步。' });
    await memory.forget('alice', hobby.id);
    await say('global', '我现在更喜欢先看推导，不喝咖啡了，周末还是经常徒步。');
    const seen: Input[] = [];
    await worker((_model, context) => { seen.push(inputOf(context)); return candidate({ items: [
      { op: 'supersede', kind: 'preference', replaces: style.id, title: '沟通偏好', text: '更喜欢先看推导。', anchor: 'topic:沟通', inferred: false, evidence: [{ message: 'M1', quote: '我现在更喜欢先看推导' }] },
      { op: 'forget', kind: 'preference', replaces: drink.id, title: '饮食偏好', text: '', anchor: 'topic:饮食', inferred: false, evidence: [{ message: 'M1', quote: '不喝咖啡了' }] },
      add('周末徒步。', 'M1', '周末还是经常徒步', { matchedForgottenId: hobby.id }),
      add('喜欢徒步。', 'M1', '周末还是经常徒步'),
    ] }); }).processNext();
    expect(seen[0].forgotten.map(item => item.id)).toEqual([hobby.id]);
    const [current] = await memory.list('alice');
    expect((await memory.list('alice')).map(item => item.text)).toEqual(['更喜欢先看推导。']);
    expect(await memory.get('alice', style.id)).toMatchObject({ status: 'superseded', supersededBy: current.id });
    expect(await memory.get('alice', drink.id)).toMatchObject({ status: 'forgotten' });
  });
});

test('anchors come from the page object of the evidence message with its version pinned, or a topic; others are rejected (3b, R5)', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, say, worker } = await setup(db, pool);
    const runId = randomUUID();
    await db.query(`INSERT INTO agent_runs (id, kind, object_ref, status, model_slot, prompt_hash, input_snapshot) VALUES ($1, 'conversation', 'null', 'succeeded', 'light', 'x', $2::jsonb)`,
      [runId, JSON.stringify({ currentObject: { cardId: 'issue-card', version: 4, kind: 'issue', title: '渠道预算', objectRef: { type: 'issue', id: 'i1', version: 4 } } })]);
    const quote = '这个议题我的立场是预算砍一半，理由是回报周期太长；还没想清楚的是砍哪一块。';
    await say('issue:i1', quote, { runId });
    let seen: Input | undefined;
    const run = (anchor: string) => worker((_model, context) => { seen = inputOf(context); return candidate({ items: [
      { op: 'add', kind: 'stance', title: '渠道预算砍一半', text: '倾向把渠道预算砍一半，理由是回报周期太长。', anchor, inferred: false, evidence: [{ message: 'M1', quote }] },
      { op: 'add', kind: 'open_question', title: '砍哪一块', text: '还没想清楚砍哪一块预算。', anchor: 'topic:渠道预算', inferred: false, evidence: [{ message: 'M1', quote }] },
    ] }); });
    await run('issue:someone-else').processNext();
    expect(await run('x').cursor('alice')).toMatchObject({ lastError: 'INVALID_ANCHOR' });
    expect(await memory.list('alice')).toEqual([]);
    await db.query('UPDATE personal_memory_cursors SET next_attempt_at = now()');
    await run('issue:i1').processNext();
    expect(seen!.messages[0].anchorCandidates).toEqual([{ target: 'issue:i1', title: '渠道预算' }]);
    const items = await memory.list('alice');
    expect(items.find(item => item.kind === 'stance')).toMatchObject({ anchors: [{ target: 'issue:i1', pinnedVersion: 4 }] });
    expect(items.find(item => item.kind === 'open_question')).toMatchObject({ anchors: [{ target: 'topic:渠道预算' }] });
  });
});

test('an inferred correction is refused; the first message of a window is kept whole even when very long', async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, say, worker } = await setup(db, pool);
    const old = await memory.add('alice', { kind: 'stance', title: '渠道立场', text: '先做一线城市。' });
    const intent = '不对，改成先做县城样板。', content = '背景'.repeat(13000) + intent;
    await say('global', content);
    let current = '';
    const correction = (inferred: boolean) => worker((_model, context) => { current = inputOf(context).messages[0].content; return candidate({ items: [{ op: 'supersede', kind: 'stance', replaces: old.id,
      title: '渠道立场', text: '先做县城样板。', anchor: 'topic:渠道', inferred, evidence: [{ message: 'M1', quote: intent }] }] }); });
    await correction(true).processNext();
    expect(await correction(true).cursor('alice')).toMatchObject({ lastError: 'INVALID_EXPLICIT_EVIDENCE' });
    await db.query('UPDATE personal_memory_cursors SET next_attempt_at = now()');
    await correction(false).processNext();
    expect(current.length).toBe(content.length);
    expect((await memory.list('alice')).map(item => item.text)).toEqual(['先做县城样板。']);
    expect(await memory.get('alice', old.id)).toMatchObject({ status: 'superseded' });
  });
});

test.each([
  { status: 'noop', items: true, clarification: '' },
  { status: 'apply', items: true, clarification: '已记住你的偏好。' },
  { status: 'needs_clarification', items: false, clarification: '' },
] as const)('an inconsistent candidate outcome is rejected atomically: $status / $clarification', async result => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const { memory, say, worker } = await setup(db, pool);
    await say('global', '我通常先看结论。');
    const run = worker(() => candidate({ status: result.status, clarification: result.clarification, items: result.items ? [add('通常先看结论。', 'M1', '我通常先看结论')] : [] }));
    await run.processNext();
    expect(await run.cursor('alice')).toMatchObject({ cursor: null, lastError: 'INVALID_CANDIDATE_STATUS' });
    expect(await memory.list('alice')).toEqual([]);
  });
});

test('the prompt asks for ideas, stances, open questions, reasons and preferences, each with anchor and reference (3b)', () => {
  for (const word of ['想法（idea）', '立场（stance）', '未决问题（open_question）', '理由（reason）', '偏好与表达方式（preference）', '做法（practice', 'anchorCandidates', 'topic:<主题>', 'op=supersede', '旧条目不改'])
    expect(DISTILLATION_PROMPT).toContain(word);
  expect(DISTILLATION_PROMPT).not.toContain('记忆是长期个人偏好、习惯、个人约束');
});
