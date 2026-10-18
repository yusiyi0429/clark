import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import examples from './fixtures/world-02.json' with { type: 'json' };
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createPiConversationRuntime } from '../src/piConversationRuntime.js';
import { loadCompanyMemory } from '../src/companyMemory.js';
import { testEnv } from './helpers.js';

import { createCompanyMemory } from '../src/company.js';

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

  // 主对话里的 query_company：与 main 已有的看板、企业知识工具并存；本体读不到时工具结果要求先如实说明、再回退本地。
  const runCompanyTurn = async (t: Awaited<ReturnType<typeof setup>>) => {
    let calls = 0;
    const toolResults: string[] = [];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const runtime = await createPiConversationRuntime({
      company: t.company, companyMemory: loadCompanyMemory(testEnv),
      baseUrl: 'https://provider.invalid/v1', apiKey: 'test-key', modelId: 'fake-light',
      streamSimple: (_model, context) => {
        calls++;
        const tools = context.tools?.map((tool) => tool.name) ?? [];
        expect(tools).toContain('query_company');
        expect(tools).toContain('search_sections');
        if (calls > 1) toolResults.push(JSON.stringify(context.messages.findLast((item) => item.role === 'toolResult')));
        const content: AssistantMessage['content'] = calls === 1 ? [{ type: 'toolCall', id: 'company-call', name: 'query_company', arguments: {} }]
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

  it('main runtime reads authorized World company facts without protocol metadata', async () => {
    const t = await setup();
    try {
      const [text] = await runCompanyTurn(t);
      expect(text).toContain('草稿');
      expect(text).not.toMatch(/mission-1|sourceFingerprint|canonical_hash|revision_id|来源：/);
    } finally { await t.close(); }
  });

  it('when World is unreadable the tool tells the agent to say so first, then answer from local data', async () => {
    const t = await setup();
    try {
      t.fail();
      const [text] = await runCompanyTurn(t);
      expect(text).toContain('unavailable');
      expect(text).toContain('如实告诉用户这次没有读到本体');
      expect(text).toContain('本地资料');
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
