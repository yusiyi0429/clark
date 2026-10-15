import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { composeContext, makeAnchor, textOf, worldReadable } from './prototype.mjs';

// Resolve the installed import-only packages from the API workspace; no new dependencies.
const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } =
  await import(new URL('../../apps/api/node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url));
const { InMemoryCredentialStore, InMemoryModelsStore, createAssistantMessageEventStream } =
  await import(new URL('../../apps/api/node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.url));
const rules = '主私聊 Rules：权限不随参考资料改变；Anchor 只描述当前场景。';
const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const turn = (query, label = '本月目标', references = []) => ({ query,
  anchor: { scene: '公司首页', items: [{ handle: 'A1', title: label, meaning: '当前页面状态' }] }, references });

function stream(content, use = usage) {
  const result = { role: 'assistant', api: 'openai-responses', provider: 'probe', model: 'probe-main',
    content, usage: use, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: 'start', partial: result });
    events.push({ type: 'done', reason: result.stopReason, message: result });
  });
  return events;
}

async function harness(respond = () => stream([{ type: 'text', text: '回答' }])) {
  const captures = [], local = new AsyncLocalStorage();
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('probe', { name: 'Offline probe', baseUrl: 'https://provider.invalid/v1', api: 'openai-responses',
    streamSimple: (model, context, options) => {
      captures.push({ model: model.id, systemPrompt: context.systemPrompt,
        messages: structuredClone(context.messages), tools: (context.tools || []).map(tool => ({ name: tool.name })) });
      return respond(model, context, options);
    },
    models: ['probe-main', 'probe-compact'].map(id => ({ id, name: id, api: 'openai-responses', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 })) });
  await runtime.setRuntimeApiKey('probe', 'offline-not-a-credential');
  const dispatch = runtime.streamSimple.bind(runtime);
  // Public provider-dispatch boundary. ALS isolates simultaneous conversations.
  runtime.streamSimple = (model, context, options) => {
    if (!context.systemPrompt.includes(rules)) return dispatch(model, context, options); // SDK compaction request
    const current = local.getStore();
    if (!current) throw Error('MISSING_TURN_CONTEXT');
    return dispatch(model, composeContext(context, current), options);
  };
  const loader = { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => rules, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {} };
  async function session(entries, id = '11111111-1111-4111-8111-111111111111', tools = []) {
    const manager = SessionManager.inMemory(process.cwd(), { id }, entries);
    const { session } = await createAgentSession({ model: runtime.getModel('probe', 'probe-main'), modelRuntime: runtime,
      resourceLoader: loader, tools: tools.map(t => t.name), customTools: tools, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        retry: { enabled: false } }), thinkingLevel: 'off' });
    return { session, manager, run: input => local.run(input, () => session.prompt(input.query, { expandPromptTemplates: false, source: 'rpc' })),
      entries: () => JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()])) };
  }
  return { captures, runtime, session };
}

test('Anchor derives from authorized Cards, with a bounded index and no hidden counts', () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: `卡片${i}`, state: '草稿', summary: '待讨论', visible: i < 20 }));
  const anchor = makeAnchor(cards, card => card.visible, 12);
  assert.equal(anchor.items.length, 12); assert.equal(anchor.more, true);
  assert.equal(anchor.summary, '当前可见 20 张卡片'); assert.ok(!JSON.stringify(anchor).includes('卡片20'));
});

test('latest user gets Anchor + Query; References precede it, system and tool pairing remain untouched', () => {
  const source = { systemPrompt: rules, messages: [
    { role: 'user', content: '旧问题', timestamp: 1 }, { role: 'assistant', content: [], timestamp: 2 },
    { role: 'user', content: '现在呢', timestamp: 3 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read_anchor', arguments: {} }], timestamp: 4 },
    { role: 'toolResult', toolCallId: 't1', toolName: 'read_anchor', content: [{ type: 'text', text: '展开结果' }], timestamp: 5 } ] };
  const before = structuredClone(source), result = composeContext(source, turn('现在呢', '当前计划', [{ kind: 'company', text: '公司方向' }]));
  assert.deepEqual(source, before); assert.equal(result.systemPrompt, rules);
  assert.equal(JSON.parse(textOf(result.messages[3])).query, '现在呢');
  assert.match(textOf(result.messages[2]), /^Reference/); assert.deepEqual(result.messages.slice(-2), source.messages.slice(-2));
  assert.throws(() => composeContext(source, turn('错误的最新消息')), /CURRENT_QUERY_MISMATCH/);
});

test('actual Pi first call sees ephemeral context, but entries keep raw user words', async () => {
  const h = await harness(), s = await h.session();
  try {
    await s.run(turn('请解释当前计划', '页面当前计划', [{ kind: 'personal', text: '通常喜欢先给结论' }]));
    const sent = h.captures[0];
    assert.equal(JSON.parse(textOf(sent.messages.at(-1))).anchor.items[0].title, '页面当前计划');
    assert.deepEqual(sent.tools || [], []);
    const saved = JSON.stringify(s.entries());
    assert.ok(saved.includes('请解释当前计划')); assert.ok(!saved.includes('页面当前计划')); assert.ok(!saved.includes('通常喜欢先给结论'));
  } finally { s.session.dispose(); }
});

test('JSON restoration changes Anchor without accumulating old Anchor or Personal snippets', async () => {
  const h = await harness(), first = await h.session(); let next;
  try {
    await first.run(turn('看旧页面', '旧锚点', [{ kind: 'personal', text: '旧偏好内容' }]));
    next = await h.session(first.entries());
    await next.run(turn('看新页面', '新锚点'));
    const request = JSON.stringify(h.captures.at(-1));
    assert.ok(request.includes('新锚点')); assert.ok(!request.includes('旧锚点')); assert.ok(!request.includes('旧偏好内容'));
    assert.ok(request.includes('看旧页面'));
  } finally { first.session.dispose(); next?.session.dispose(); }
});

test('actual tool follow-up keeps exactly one Anchor and an intact call/result pair', async () => {
  let count = 0;
  const h = await harness(() => ++count === 1
    ? stream([{ type: 'toolCall', id: 'read-1', name: 'read_anchor', arguments: {} }])
    : stream([{ type: 'text', text: '已展开' }]));
  const tool = { name: 'read_anchor', label: '展开锚点', description: '测试工具', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: '本轮授权详情' }], details: {} }) };
  const s = await h.session(undefined, undefined, [tool]);
  try {
    await s.run(turn('展开 A1', '单轮锚点'));
    assert.equal(h.captures.length, 2, JSON.stringify(s.session.messages.at(-1)));
    for (const request of h.captures) assert.equal(JSON.stringify(request).split('单轮锚点').length - 1, 1);
    assert.equal(h.captures[1].messages.at(-1).role, 'toolResult');
    assert.equal(h.captures[1].messages.at(-1).toolCallId, 'read-1');
  } finally { s.session.dispose(); }
});

test('two simultaneous people share a ModelRuntime without sharing private References', async () => {
  const h = await harness(), a = await h.session(), b = await h.session(undefined, '22222222-2222-4222-8222-222222222222');
  try {
    await Promise.all([a.run(turn('甲的问题', '甲页面', [{ kind: 'personal', text: '甲的私有情况' }])),
      b.run(turn('乙的问题', '乙页面', [{ kind: 'personal', text: '乙的私有情况' }]))]);
    for (const request of h.captures) {
      const text = JSON.stringify(request), query = JSON.parse(textOf(request.messages.at(-1))).query;
      assert.ok(text.includes(query.startsWith('甲') ? '甲的私有情况' : '乙的私有情况'));
      assert.ok(!text.includes(query.startsWith('甲') ? '乙的私有情况' : '甲的私有情况'));
    }
  } finally { a.session.dispose(); b.session.dispose(); }
});

test('missing turn context blocks dispatch rather than sending an unanchored main request', async () => {
  const h = await harness();
  assert.throws(() => h.runtime.streamSimple(h.runtime.getModel('probe', 'probe-main'), {
    systemPrompt: rules, messages: [{ role: 'user', content: '没有本轮上下文', timestamp: 1 }],
  }), /MISSING_TURN_CONTEXT/);
  assert.equal(h.captures.length, 0);
});

test('manual Pi compaction does not receive ephemeral Anchor/Reference; next request reinjects current ones', async () => {
  const h = await harness((_model, context) => stream([{ type: 'text', text:
    context.systemPrompt.includes(rules) ? '已讨论计划' : '保留用户尚未解决的问题。' }]));
  const s = await h.session();
  try {
    await s.run(turn('讨论材料'.repeat(30000), '压缩前锚点', [{ kind: 'personal', text: '不应固化到压缩的偏好' }]));
    await s.run(turn('继续讨论'.repeat(30000), '压缩前锚点'));
    await s.session.setModel(h.runtime.getModel('probe', 'probe-compact'));
    await s.session.compact('只保留用户问题与讨论结果，不产生公司事实。');
    const compact = h.captures.filter(c => !c.systemPrompt.includes(rules));
    assert.ok(compact.length > 0);
    assert.ok(!JSON.stringify(compact).includes('压缩前锚点'));
    assert.ok(!JSON.stringify(compact).includes('不应固化到压缩的偏好'));
    await s.session.setModel(h.runtime.getModel('probe', 'probe-main'));
    await s.run(turn('现在处理什么', '压缩后锚点'));
    assert.ok(JSON.stringify(h.captures.at(-1)).includes('压缩后锚点'));
    assert.ok(!JSON.stringify(s.entries()).includes('压缩后锚点'));
  } finally { s.session.dispose(); }
});

test('checked-in World projection yields readable blocks and status, without protocol/source metadata', async () => {
  const examples = JSON.parse(await readFile(new URL('../../apps/api/test/fixtures/world-02.json', import.meta.url), 'utf8'));
  const object = structuredClone(examples['1'][2]);
  object.protocol.sourceFingerprint = 'private-machine-marker';
  object.business.blocks[0].value = { text: '必须保留的公司正文', components: [{ text: '验收口径' }] };
  object.business.blocks[0].text = '必须保留的公司正文';
  const text = worldReadable(object);
  assert.match(text, /必须保留的公司正文/); assert.match(text, /验收口径/); assert.match(text, /状态：/);
  assert.equal(text.split('必须保留的公司正文').length - 1, 1);
  for (const noise of ['sourceFingerprint', 'private-machine-marker', 'canonical_hash', 'revision_id', '来源：']) assert.ok(!text.includes(noise));
});

test('automatic in-turn compaction retains current Anchor on the tool follow-up without persisting it', async () => {
  let regular = 0;
  const high = { ...usage, input: 120000, totalTokens: 120002 };
  const h = await harness((_model, context) => {
    if (!context.systemPrompt.includes(rules)) return stream([{ type: 'text', text: '自动压缩的讨论摘要。' }]);
    regular++;
    if (regular === 3) return stream([{ type: 'toolCall', id: 'auto-read', name: 'read_anchor', arguments: {} }], high);
    return stream([{ type: 'text', text: '普通回答' }], regular >= 3 ? high : usage);
  });
  const tool = { name: 'read_anchor', label: '读取', description: '离线桩', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: '本轮展开的页面信息' }], details: {} }) };
  const s = await h.session(undefined, undefined, [tool]), events = [];
  s.session.subscribe(event => events.push(event.type));
  try {
    await s.run(turn('历史问题'.repeat(30000), '历史锚点'));
    await s.run(turn('近期问题'.repeat(30000), '近期锚点'));
    await s.run(turn('请展开当前卡片', '自动压缩后应保留的锚点'));
    assert.ok(events.includes('compaction_start'));
    const final = h.captures.filter(c => c.systemPrompt.includes(rules)).at(-1);
    assert.ok(JSON.stringify(final).includes('自动压缩后应保留的锚点'));
    assert.ok(!JSON.stringify(s.entries()).includes('自动压缩后应保留的锚点'));
    assert.ok(h.captures.some(c => !c.systemPrompt.includes(rules)));
  } finally { s.session.dispose(); }
});
