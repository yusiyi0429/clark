import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import examples from './fixtures/world-02.json' with { type: 'json' };
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createPiConversationRuntime } from '../src/piConversationRuntime.js';
import { loadPeopleDirectory } from '../src/peopleDirectory.js';
import { testEnv } from './helpers.js';

import { LOCATED_PAGE_BYTES, createCompanyMemory, locateHeads, locateHints, readWorldSource } from '../src/company.js';
import type { WorldHead } from '../src/worldClient.js';

const viewer = { personId: 'ceo', role: 'ceo' as const };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'company-test-'));
  const grantFile = join(dir, 'access.json');
  await writeFile(grantFile, JSON.stringify({ ceo: ['<domain:eo>'] }));
  const object = structuredClone(examples['1'][2]) as any;
  let failed = false;
  const requests: string[] = [];
  let onList: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    expect(req.headers.authorization).toBe('Bearer test-token');
    res.setHeader('content-type', 'application/json');
    if (failed) { res.statusCode = 503; res.end('{}'); return; }
    if (req.url!.startsWith('/v1/world/objects?')) {
      await onList?.();
      res.end(JSON.stringify({ items: [{ ...object.business, domain_id: '<domain:eo>', lifecycle: object.records.lifecycle }], next_cursor: null }));
    } else res.end(JSON.stringify(object));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const company = createCompanyMemory({ worldApiUrl: `http://127.0.0.1:${address.port}`, worldAgentToken: 'test-token', companyWorldAccessFile: grantFile, companyStorageDir: join(dir, 'stored') });
  return { company, object, requests, grantFile, dir, onList: (callback: () => Promise<void>) => { onList = callback; }, fail: () => { failed = true; }, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('World company public read boundary', () => {
  it('governs full World blocks into readable sections without protocol metadata or duplicate content', async () => {
    const t = await setup();
    try {
      const result = await t.company.read(viewer, {}, new AbortController().signal);
      expect(result.status).toBe('ready');
      const text = result.entries.map((entry) => entry.text).join('\n');
      expect(text).toContain('草稿');
      expect(text).toContain('E&O Mission Owner');
      expect(text).toContain('定义');
      expect(text).toContain('示例：Mission 定义');
      expect(text.match(/示例：交付可用/g)).toHaveLength(1);
      expect(text).not.toMatch(/canonical_hash|sourceFingerprint|revision_id|event_id|来源：/);
      expect(t.requests.every((request) => request.startsWith('GET '))).toBe(true);
    } finally { await t.close(); }
  });
  it('returns relevant Chinese facts with a bounded UTF-8 page and readable fallback directory', async () => {
    const t = await setup();
    try {
      t.object.business.blocks.push({ id: 'opaque-unknown-id', value: { text: '供应链升级：提升交付准确率。' + '经营进展。'.repeat(6000) } });
      const result = await t.company.read(viewer, { query: '供应链目前应该怎么升级？' }, new AbortController().signal);
      expect(result.status).toBe('ready');
      expect(result.entries[0].text).toContain('供应链升级');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
      expect(result.entries.map((entry) => entry.text).join('')).not.toContain('opaque-unknown-id');
      expect(result.nextCursor).toBeDefined();
    } finally { await t.close(); }
  });

  // 主对话里的 query_company：本体读不到时工具结果要求如实说没读到，不用本地资料补公司事实（D-48）。
  const runCompanyTurn = async (t: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown> = {}) => {
    let calls = 0;
    const toolResults: string[] = [];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const runtime = await createPiConversationRuntime({
      company: t.company, peopleDirectory: loadPeopleDirectory(testEnv),
      baseUrl: 'https://provider.invalid/v1', apiKey: 'test-key', modelId: 'fake-light',
      streamSimple: (_model, context) => {
        calls++;
        const tools = context.tools?.map((tool) => tool.name) ?? [];
        expect(tools).toContain('query_company');
        expect(tools).toContain('search_people');
        expect(tools).not.toContain('search_sections');
        if (calls > 1) toolResults.push(JSON.stringify(context.messages.findLast((item) => item.role === 'toolResult')));
        const content: AssistantMessage['content'] = calls === 1 ? [{ type: 'toolCall', id: 'company-call', name: 'query_company', arguments: args }]
          : [{ type: 'text', text: '这是一份草稿。' }];
        const message: AssistantMessage = { role: 'assistant', api: 'openai-responses', provider: 'warmap', model: 'fake-light', content, stopReason: calls < 2 ? 'toolUse' : 'stop', usage, timestamp: Date.now() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: 'done', reason: calls < 2 ? 'toolUse' : 'stop', message } as any));
        return stream;
      },
    });
    try {
      const result = await runtime.run({ viewer: { ...viewer, displayName: 'CEO' }, scope: 'global', message: '公司目前的方向是什么？', currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: '11111111-1111-4111-8111-111111111111', signal: new AbortController().signal, emit: () => {} });
      expect(result.assistantMessage).toBe('这是一份草稿。');
      return toolResults;
    } finally { await runtime.close?.(); }
  };

  // 11/06「答案带出处」：每条带对象 ref（id@version）和类型；协议元数据（修订号、哈希等）仍不进正文。
  it('main runtime reads authorized World company facts with the object ref but without protocol metadata', async () => {
    const t = await setup();
    try {
      const [text] = await runCompanyTurn(t);
      expect(text).toContain('草稿');
      expect(text).toContain('<mission-1>@2');
      expect(text).toContain('Mission');
      expect(text).not.toMatch(/sourceFingerprint|canonical_hash|revision_id|<revision-9>|来源：/);
    } finally { await t.close(); }
  });

  it('the conversation tool locates before reading: one listing, only the matched object, no full re-list', async () => {
    const t = await setup();
    try {
      const [text] = await runCompanyTurn(t, { query: `${t.object.business.title} 怎么样了` });
      expect(text).toContain('<mission-1>@2');
      expect(t.requests.filter((request) => request.startsWith('GET /v1/world/objects?'))).toHaveLength(1);
      expect(t.requests.filter((request) => request.startsWith('GET /v1/world/objects/'))).toHaveLength(1);
    } finally { await t.close(); }
  });

  it('when World is unreadable the tool says so and forbids filling company facts from local data', async () => {
    const t = await setup();
    try {
      t.fail();
      const [text] = await runCompanyTurn(t);
      expect(text).toContain('unavailable');
      expect(text).toContain('这次没有读到本体');
      expect(text).toContain('不要用本地资料补公司事实');
    } finally { await t.close(); }
  });

  it('revocation during a World read prevents publication and consumption of that scope', async () => {
    const t = await setup();
    let lists = 0;
    t.onList(async () => { if (++lists === 2) await writeFile(t.grantFile, '{}'); });
    try {
      const result = await t.company.read(viewer, {}, new AbortController().signal);
      expect(result.status).toBe('coverage_unavailable');
      expect(result.entries).toEqual([]);
    } finally { await t.close(); }
  });

  it('denies ungranted people even with the CEO role and an all-powerful service bearer', async () => {
    const t = await setup();
    try {
      expect(await t.company.read({ personId: 'ungranted', role: 'ceo' }, {}, new AbortController().signal)).toMatchObject({ status: 'coverage_unavailable', entries: [] });
      expect(t.requests).toEqual([]);
      await writeFile(t.grantFile, '{}');
      expect(await t.company.read(viewer, {}, new AbortController().signal)).toMatchObject({ status: 'coverage_unavailable', entries: [] });
      expect(t.requests).toEqual([]);
    } finally { await t.close(); }
  });

  it('reports World failure instead of consuming a previously successful projection', async () => {
    const t = await setup();
    try {
      expect((await t.company.read(viewer, {}, new AbortController().signal)).status).toBe('ready');
      t.fail();
      expect(await t.company.read(viewer, {}, new AbortController().signal)).toMatchObject({ status: 'unavailable', entries: [] });
      expect(await createCompanyMemory({}).read(viewer, {}, new AbortController().signal)).toMatchObject({ status: 'not_configured', entries: [] });
    } finally { await t.close(); }
  });

  it('preserves business dates and authorized relation titles without disclosing unreadable targets', async () => {
    const t = await setup();
    try {
      t.object.business.attributes.due_date = '2026-11-01';
      t.object.business.relations.push({ relation: 'depends_on', value: { object_id: '<secret-goal>', title: 'secret company strategy' } });
      t.object.records.lifecycle = { status: 'withdrawn', display_name: '已撤回' };
      const result = await t.company.read(viewer, {}, new AbortController().signal);
      const text = result.entries.map((entry) => entry.text).join('');
      expect(text).toContain('2026-11-01');
      expect(text).toContain('已撤回');
      expect(text).not.toContain('secret company strategy');
      expect(text).not.toContain('<secret-goal>');
    } finally { await t.close(); }
  });

  it('rechecks World on unchanged reads and returns revised facts without relying on a TTL', async () => {
    const t = await setup();
    try {
      await t.company.read(viewer, {}, new AbortController().signal);
      const firstReads = t.requests.length;
      await t.company.read(viewer, {}, new AbortController().signal);
      expect(t.requests.length).toBeGreaterThan(firstReads);
      t.object.business.object_version++;
      t.object.business.blocks[0].value.text = '新版方向：优先客户留存';
      const result = await t.company.read(viewer, {}, new AbortController().signal);
      expect(result.entries.map((entry) => entry.text).join('')).toContain('新版方向：优先客户留存');
    } finally { await t.close(); }
  });

  it('rejects company continuation after the authorized facts change instead of skipping new content', async () => {
    const t = await setup();
    try {
      t.object.business.blocks[0].value.text = '经营进展。'.repeat(4000);
      const first = await t.company.read(viewer, {}, new AbortController().signal);
      expect(first.nextCursor).toBeDefined();
      t.object.business.object_version++;
      const next = await t.company.read(viewer, { cursor: first.nextCursor }, new AbortController().signal);
      expect(next).toMatchObject({ status: 'unavailable', entries: [] });
      expect(next.message).toContain('变化');
    } finally { await t.close(); }
  });

  it('rejects an old company reference when that document changes before expansion', async () => {
    const t = await setup();
    try {
      const first = await t.company.read(viewer, {}, new AbortController().signal);
      t.object.business.object_version++;
      t.object.business.blocks[0].value.text = '修订后的公司方向';
      const expanded = await t.company.read(viewer, { handle: first.entries[0].handle }, new AbortController().signal);
      expect(expanded).toMatchObject({ status: 'unavailable', entries: [] });
      expect(expanded.message).toContain('变化');
    } finally { await t.close(); }
  });

  it('keeps every expanded page within the JSON byte budget even for escaped business prose', async () => {
    const t = await setup();
    try {
      t.object.business.blocks[0].value.text = ('"' + String.fromCharCode(92)).repeat(6000);
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await t.company.read(viewer, { cursor }, new AbortController().signal);
        expect(page.status).toBe('ready');
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);
        cursor = page.nextCursor;
        expect(++pages).toBeLessThan(20);
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
    } finally { await t.close(); }
  });

});

// 11/06「答案带出处」：先按类型、周期和标题定位，只读定位到的对象；定位不到才全量读（和原来一样）。
describe('World company facts: locate before reading', () => {
  type Seed = { id: string; type: string; title: string; period?: string; latestState?: unknown; body?: string };
  async function world(seeds: Seed[]) {
    const dir = await mkdtemp(join(tmpdir(), 'company-locate-'));
    const grantFile = join(dir, 'access.json');
    await writeFile(grantFile, JSON.stringify({ ceo: ['<domain:eo>'] }));
    const objects = new Map(seeds.map((seed) => {
      const object = structuredClone(examples['1'][2]) as any;
      object.object_id = seed.id;
      Object.assign(object.business, { object_id: seed.id, object_type: seed.type, title: seed.title, relations: [] });
      if (seed.latestState) object.records.latest_state = seed.latestState;
      if (seed.body) object.business.blocks[0].value.text = seed.body;
      return [seed.id, { object, period: seed.period }];
    }));
    const requests: URL[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://world.test');
      requests.push(url);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/v1/world/objects') {
        const period = url.searchParams.get('period');
        const items = [...objects.values()].filter((item) => !period || item.period === period)
          .map(({ object }) => ({ ...object.business, domain_id: '<domain:eo>', lifecycle: object.records.lifecycle }));
        res.end(JSON.stringify({ items, next_cursor: null }));
      } else res.end(JSON.stringify(objects.get(decodeURIComponent(url.pathname.split('/').at(-1)!))!.object));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const env = { worldApiUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, worldAgentToken: 'test-token',
      companyWorldAccessFile: grantFile, companyStorageDir: join(dir, 'stored') };
    const company = createCompanyMemory(env);
    const reads = () => requests.filter((url) => url.pathname.startsWith('/v1/world/objects/')).map((url) => decodeURIComponent(url.pathname.split('/').at(-1)!));
    return { company, env, requests, reads, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  const SEEDS: Seed[] = [
    { id: 'mission-lh', type: 'Mission', title: '灯塔交付', period: '2026-10' },
    { id: 'po-oct', type: 'PeriodGoal', title: '10 月：灯塔启动', period: '2026-10' },
    { id: 'strategy', type: 'Strategy', title: '总体战略定位' },
    { id: 'mission-hr', type: 'Mission', title: '招聘体系', period: '2026-10' },
  ];
  const read = (t: Awaited<ReturnType<typeof world>>, query: string) => t.company.read(viewer, { query, locate: true }, new AbortController().signal);

  it('reads only the objects whose titles match, preferring the hinted type, and every entry carries ref and type', async () => {
    const t = await world(SEEDS);
    try {
      const result = await read(t, '灯塔交付这个 Mission 现在怎么样了');
      expect(result.status).toBe('ready');
      expect(t.reads()).toEqual(['mission-lh']);
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.entries.every((entry) => entry.ref === 'mission-lh@2' && entry.type === 'Mission' && entry.title === '灯塔交付')).toBe(true);
      expect(t.requests.every((url) => !url.pathname.endsWith('/context'))).toBe(true);
    } finally { await t.close(); }
  });

  it('asks World to filter by the asked period, and drops the period when that month has nothing', async () => {
    const t = await world(SEEDS);
    try {
      expect((await read(t, '10 月目标是什么')).entries[0]).toMatchObject({ ref: 'po-oct@2', type: 'PeriodGoal' });
      expect(t.requests.some((url) => url.searchParams.get('period') === '2026-10')).toBe(true);
      expect(t.reads()).toEqual(['po-oct']);
      const empty = await read(t, '2026 年 12 月的目标是什么');
      expect(t.requests.some((url) => url.searchParams.get('period') === '2026-12')).toBe(true);
      expect(empty.status).toBe('ready');
      expect(empty.entries[0]).toMatchObject({ ref: 'po-oct@2', type: 'PeriodGoal' });
    } finally { await t.close(); }
  });

  it('without locate (background jobs) reads everything as before, even when a title matches', async () => {
    const t = await world(SEEDS);
    try {
      const result = await t.company.read(viewer, { query: '灯塔交付' }, new AbortController().signal);
      expect(result.status).toBe('ready');
      expect(new Set(t.reads())).toEqual(new Set(SEEDS.map((seed) => seed.id)));
    } finally { await t.close(); }
  });

  it('falls back to the full read (every object, ranked by text) when nothing can be located', async () => {
    const t = await world(SEEDS);
    try {
      const result = await read(t, '最近有什么需要我拍板的风险');
      expect(result.status).toBe('ready');
      expect(new Set(t.reads())).toEqual(new Set(SEEDS.map((seed) => seed.id)));
      expect(result.entries.every((entry) => /^[a-z-]+@2$/.test(entry.ref))).toBe(true);
    } finally { await t.close(); }
  });

  it('shows the latest StateSnapshot first, with its ref, date, author and unconfirmed flag', async () => {
    const t = await world([{ id: 'mission-lh', type: 'Mission', title: '灯塔交付', latestState: {
      object_type: 'StateSnapshot', ref: 'snap-1@1', as_of: '2026-11-05T10:10:00Z', unconfirmed: true,
      generator: { principal_type: 'agent', display_name: '于斯一的 Claude Code' },
      blocks: [
        { id: 'current_state', display_name: '当前状态', value: { text: '首版已上线，等真实会议读回', components: [] } },
        { id: 'progress', display_name: '进展', value: { text: '', components: [{ id: 'p1', type: 'progress_item', text: '11/4 换版完成' }] } },
      ],
    } }]);
    try {
      const [entry] = (await read(t, '灯塔交付怎么样了')).entries;
      expect(entry.text).toContain('### 当前进展\n\n快照 snap-1@1 · 2026-11-05 · 于斯一的 Claude Code · 未确认\n\n当前状态：首版已上线，等真实会议读回\n\n11/4 换版完成');
      expect(entry.text.indexOf('### 当前进展')).toBeLessThan(entry.text.indexOf('### 定义'));
    } finally { await t.close(); }
  });

  it('puts the opening of every located object on the first page before any continuation, within the located page budget', async () => {
    const body = Array.from({ length: 12 }, () => '定义正文。'.repeat(100)).join('\n\n');
    const latestState = { object_type: 'StateSnapshot', ref: 'snap@1', as_of: '2026-11-05T00:00:00Z', blocks: [{ id: 'current_state', display_name: '当前状态', value: { text: '首版已上线', components: [] } }] };
    const t = await world([
      { id: 'mission-a', type: 'Mission', title: '灯塔成本核算', latestState, body },
      { id: 'po-b', type: 'PeriodGoal', title: '10 月：灯塔首版核算', latestState, body },
      { id: 'strategy', type: 'Strategy', title: '总体战略定位' },
    ]);
    try {
      const first = await read(t, '灯塔这件事到底怎么样了');
      expect(first.status).toBe('ready');
      expect(new Set(t.reads())).toEqual(new Set(['mission-a', 'po-b']));
      expect(first.entries.slice(0, 2).map((entry) => [entry.ref, entry.handle.split(':').at(-1)])).toEqual([['mission-a@2', '0'], ['po-b@2', '0']]);
      expect(first.entries.slice(0, 2).every((entry) => entry.text.includes('### 当前进展\n\n快照 snap@1'))).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(first.entries))).toBeLessThanOrEqual(LOCATED_PAGE_BYTES + 200);
      expect(first.nextCursor).toBeDefined();
      const second = await t.company.read(viewer, { query: '灯塔这件事到底怎么样了', locate: true, cursor: first.nextCursor }, new AbortController().signal);
      expect(second.entries.length).toBeGreaterThan(0);
      expect(second.entries.every((entry) => !entry.handle.endsWith(':0'))).toBe(true);
    } finally { await t.close(); }
  });

  it('source card: reads one granted object with type, title, version, status, owners and the current snapshot, GET only', async () => {
    const t = await world([...SEEDS.slice(0, 1).map((seed) => ({ ...seed, latestState: {
      object_type: 'StateSnapshot', ref: 'snap-1@1', as_of: '2026-11-05T10:10:00Z', unconfirmed: true, generator: { display_name: '于斯一的 Claude Code' },
      blocks: [{ id: 'current_state', display_name: '当前状态', value: { text: '首版已上线', components: [] } }] } })), ...SEEDS.slice(1)]);
    try {
      const result = await readWorldSource(t.env, viewer, 'mission-lh', new AbortController().signal);
      expect(result).toEqual({ status: 'ready', source: {
        ref: 'mission-lh@2', objectId: 'mission-lh', version: 2, type: 'Mission', title: '灯塔交付', status: '草稿', owners: ['E&O Mission Owner'],
        progress: { ref: 'snap-1@1', asOf: '2026-11-05', author: '于斯一的 Claude Code', unconfirmed: true, lines: ['当前状态：首版已上线'] } } });
      expect(t.reads()).toEqual(['mission-lh']);
      expect(t.requests.every((url) => !url.pathname.endsWith('/context'))).toBe(true);
      const plain = await readWorldSource(t.env, viewer, 'strategy', new AbortController().signal);
      expect(plain.status === 'ready' && plain.source.progress).toBeNull();
    } finally { await t.close(); }
  });

  it('source card: objects outside the granted domains and people without a grant read as not found, without fetching the object', async () => {
    const t = await world(SEEDS);
    try {
      expect(await readWorldSource(t.env, viewer, 'not-granted', new AbortController().signal)).toEqual({ status: 'not_found' });
      expect(await readWorldSource(t.env, { personId: 'someone-else', role: 'member' }, 'mission-lh', new AbortController().signal)).toEqual({ status: 'coverage_unavailable' });
      expect(t.reads()).toEqual([]);
    } finally { await t.close(); }
  });

  it('recognises object types and periods in the question', () => {
    const now = new Date('2026-11-06T04:00:00Z');
    expect(locateHints('TokenHub 本月目标是什么', now)).toEqual({ types: ['PeriodGoal'], period: '2026-11' });
    expect(locateHints('上个月的 Mission 完成得怎么样', now)).toEqual({ types: ['Mission'], period: '2026-10' });
    expect(locateHints('Agents 六个月目标', now)).toEqual({ types: ['LongTermGoal'] });
    expect(locateHints('我们公司的战略是什么', now)).toEqual({ types: ['Strategy'] });
    expect(locateHints('2026 年 1 月的 task 有哪些', now)).toEqual({ types: ['Task'], period: '2026-01' });
    expect(locateHints('1 月的安排', now)).toEqual({ types: [], period: '2027-01' });
  });

  it('keeps only titles scoring at least half of the best match, at most LOCATE_MAX, and returns nothing to locate when no title matches', () => {
    const head = (object_id: string, object_type: string, title: string) => ({ object_id, object_type, title } as WorldHead);
    const heads = [head('a', 'Mission', '企业经营 Context 建模与数据供给'), head('b', 'Mission', '高质量企业上下文构建'), head('c', 'PeriodGoal', '10 月：企业经营数据')];
    expect(locateHeads(heads, '企业经营 Context 建模与数据供给这个 Mission 进展如何', ['Mission']).map((item) => item.object_id)).toEqual(['a']);
    expect(locateHeads(heads, '企业经营数据', []).map((item) => item.object_id)).toEqual(['c', 'a']);
    expect(locateHeads(heads, '最近有什么风险', [])).toEqual([]);
    expect(locateHeads(heads, '有哪些本月目标', ['PeriodGoal']).map((item) => item.object_id)).toEqual(['c']);
  });
});
