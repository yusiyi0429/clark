import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createTestDb } from './helpers.js';
import { migrate } from '../src/migrate.js';
import { createPersonalMemory } from '../src/personalMemory.js';
test('own document persists, edits conflict, and another person never sees it', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        const storageDir = await mkdtemp(join(tmpdir(), 'personal-'));
        try {
            const memory = createPersonalMemory({ pool, storageDir });
            expect((await memory.readOwn('alice')).revision).toBe(0);
            const saved = await memory.replaceOwn('alice', { expectedRevision: 0, markdown: '# Personal\n\n## 协作偏好\n\n喜欢先给结论，再给依据。' });
            expect(saved.revision).toBe(1);
            expect(saved.sections[0].text).toContain('先给结论');
            expect((await createPersonalMemory({ pool, storageDir }).readOwn('alice')).markdown).toContain('先给结论');
            expect((await memory.readOwn('bob')).markdown).not.toContain('先给结论');
            await expect(memory.replaceOwn('alice', { expectedRevision: 0, markdown: '旧编辑' })).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
        }
        finally {
            await rm(storageDir, { recursive: true, force: true });
        }
    });
});
test('forget blocks stale jobs, invalidates issued references, preserves unrelated attributes', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        const storageDir = await mkdtemp(join(tmpdir(), 'personal-forget-'));
        try {
            const memory = createPersonalMemory({ pool, storageDir });
            const saved = await memory.replaceOwn('alice', { expectedRevision: 0, markdown: '# Personal\n\n## 协作偏好\n\n先给结论。\n\n## 兴趣\n\n周末喜欢徒步。' });
            const references = await memory.select('alice', '徒步');
            const forgotten = await memory.forgetOwn('alice', { expectedRevision: 1, sectionIds: [saved.sections[1].id] });
            expect(forgotten.markdown).not.toContain('徒步');
            expect(forgotten.markdown).toContain('结论');
            await expect(memory.apply('alice', { expectedRevision: 1, epoch: saved.epoch, changes: [{ operation: 'add', attributeKey: 'old', text: '徒步' }] })).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
            expect(await memory.readReference('alice', { handle: references[0].handle })).toEqual({ unavailable: true });
            expect(await memory.readReference('bob', { handle: references[0].handle })).toEqual({ unavailable: true });
            expect((await memory.select('alice', '徒步')).map(ref => ref.text).join('')).not.toContain('徒步');
        }
        finally {
            await rm(storageDir, { recursive: true, force: true });
        }
    });
});
