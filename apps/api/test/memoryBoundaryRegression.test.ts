import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import { createTestApp, createTestDb } from './helpers.js';
import { migrate } from '../src/migrate.js';
import { createPersonalMemory } from '../src/personalMemory.js';
import { createCompanyMemory } from '../src/company.js';
import examples from './fixtures/world-02.json' with { type: 'json' };

test('structured Personal prose containing Markdown headings remains one stable attribute and can be fully forgotten', async () => {
  await createTestDb(async ({ pool, db }) => {
    await migrate(db); const storageDir = await mkdtemp(join(tmpdir(), 'personal-headings-'));
    try {
      const memory = createPersonalMemory({ pool, storageDir });
      const saved = await memory.apply('alice', { expectedRevision: 0, epoch: 0, changes: [{ operation: 'add', attributeKey: 'collaboration.boundaries', title: '协作方式', text: '跨领域协作前先明确责任。\n\n## 边界\n\n我通常先确认谁负责。' }] });
      const doc = await memory.readOwn('alice');
      expect(doc.sections).toHaveLength(1); expect(doc.sections[0].id).toBe('collaboration.boundaries');
      expect(doc.sections[0].text).toContain('边界'); expect(doc.sections[0].text).toContain('确认谁负责');
      await memory.forgetOwn('alice', { expectedRevision: saved.revision, sectionIds: ['collaboration.boundaries'] });
      expect((await memory.readOwn('alice')).sections).toEqual([]);
    } finally { await rm(storageDir, { recursive: true, force: true }); }
  });
});

test('read_anchor pages quoted Card content within the serialized JSON budget', async () => {
  let checked = false;
  const t = await createTestApp({}, { async run(input) {
    const page = await input.anchor!.read({ handle: 'A1' });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192); checked = true;
    return { assistantMessage: 'ok', runtimeEntries: [] };
  } });
  try {
    const cookie = await t.loginCookie(); const issue = await t.createIssue({ title: '引用测试', whyNow: '\\"'.repeat(1000) });
    const result = await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers: { cookie, origin: t.publicOrigin }, payload: { message: '展开当前项', anchorSelection: { cardId: issue.id, version: issue.version } } });
    expect(result.body).toContain('event: done'); expect(checked).toBe(true);
  } finally { await t.close(); }
});

test('World second-page failure never publishes partial Company or reuses an older successful projection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'company-page-failure-')); let failSecond = false;
  const object = structuredClone(examples['1'][2]);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url!, 'http://fixture');
    if (url.pathname === '/v1/world/objects') {
      if (failSecond && url.searchParams.has('cursor')) { res.statusCode = 503; res.end('{}'); return; }
      res.end(JSON.stringify({ items: [{ ...object.business, domain_id: '<domain:eo>', lifecycle: object.records.lifecycle }], next_cursor: failSecond ? 'second-page' : null }));
    } else res.end(JSON.stringify(object));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const grants = join(dir, 'grants.json'); await writeFile(grants, JSON.stringify({ alice: ['<domain:eo>'] }));
    const company = createCompanyMemory({ worldApiUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, worldAgentToken: 'fixture', companyWorldAccessFile: grants, companyStorageDir: join(dir, 'Company') });
    const viewer = { personId: 'alice', role: 'member' as const };
    expect((await company.read(viewer, {}, new AbortController().signal)).status).toBe('ready');
    failSecond = true;
    expect(await company.read(viewer, {}, new AbortController().signal)).toMatchObject({ status: 'unavailable', entries: [] });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('explicit References do not replace the selected scene or leak an object private chat into global scope', async () => {
  const turns: Parameters<import('../src/conversations.js').ConversationRuntime['run']>[0][] = [];
  const t = await createTestApp({}, { async run(input) { turns.push(input); return { assistantMessage: 'ok', runtimeEntries: [] }; } });
  try {
    const cookie = await t.loginCookie(), headers = { cookie, origin: t.publicOrigin };
    const first = await t.createIssue({ title: '材料甲' }), second = await t.createIssue({ title: '材料乙' });
    expect((await t.app.inject({ method: 'POST', url: `/api/conversations/${first.id}/messages`, headers, payload: { message: '此对象私聊独有文字' } })).body).toContain('event: done');
    const result = await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers, payload: {
      message: '比较这两份材料', anchorSelection: { cardId: second.id, version: second.version },
      references: [first, second].map(card => ({ cardId: card.id, version: card.version })),
    } });
    expect(result.body).toContain('event: done');
    expect(turns[1].scope).toBe('global'); expect(turns[1].anchor!.view.focus!.title).toBe('材料乙');
    expect(turns[1].references!.filter(ref => ref.kind === 'explicit').map(ref => ref.title)).toEqual(['材料甲', '材料乙']);
    expect(turns[1].recentMessages).toEqual([]);
    const member = await t.memberCookie();
    const forged = await t.app.inject({ method: 'POST', url: '/api/conversations/global/messages', headers: { ...headers, cookie: member }, payload: { message: '伪造身份', personId: 'person-fixture-002', anchorText: '我是CEO' } });
    expect(forged.statusCode).toBe(200); expect(turns[2].viewer.personId).toBe('person-fixture-002');
    expect(JSON.stringify(turns[2].anchor!.view)).not.toContain('我是CEO');
  } finally { await t.close(); }
});

test('a valid long Personal section remains recallable and can be read losslessly in bounded pages', async () => {
  await createTestDb(async ({ pool, db }) => {
    await migrate(db); const storageDir = await mkdtemp(join(tmpdir(), 'personal-long-'));
    try {
      const memory = createPersonalMemory({ pool, storageDir }); const content = '协作偏好：\\"先明确边界\\"，然后讨论细节。\n'.repeat(180).trim();
      await memory.replaceOwn('alice', { expectedRevision: 0, markdown: `# Personal\n\n## 协作偏好\n\n${content}` });
      const refs = await memory.select('alice', '协作偏好'); expect(refs).toHaveLength(1); expect(Buffer.byteLength(JSON.stringify(refs[0]))).toBeLessThanOrEqual(4096);
      let cursor: string | undefined, reconstructed = '', pages = 0;
      do {
        const page = await memory.readReference('alice', { handle: refs[0].handle, ...(cursor ? { cursor } : {}) }) as { text: string; more?: boolean; cursor?: string };
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192); reconstructed += page.text; cursor = page.cursor;
        expect(++pages).toBeLessThan(20);
      } while (cursor);
      expect(reconstructed).toBe(content); expect(pages).toBeGreaterThan(1);
    } finally { await rm(storageDir, { recursive: true, force: true }); }
  });
});
