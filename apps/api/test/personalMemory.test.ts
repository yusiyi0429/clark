import { expect, test } from 'vitest';
import { createTestDb } from './helpers.js';
import { migrate } from '../src/migrate.js';
import { createPersonalMemory } from '../src/personalMemory.js';

const reference = { ref: 'chat:c1#1', quote: '先给结论', at: '2026-10-01T00:00:00.000Z' };

test('each item carries time, status, anchors and references, and only its owner sees it (3a)', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        const memory = createPersonalMemory({ pool });
        const saved = await memory.add('alice', { title: '沟通偏好', text: '先给结论，再给依据。', anchors: [{ target: 'topic:沟通' }], references: [reference] });
        expect(saved).toMatchObject({ status: 'active', supersededBy: null, anchors: [{ target: 'topic:沟通' }], references: [reference] });
        expect(Date.parse(saved.createdAt)).not.toBeNaN();
        expect(Date.parse(saved.updatedAt)).not.toBeNaN();
        expect(await memory.list('bob')).toEqual([]);
        expect(await memory.get('bob', saved.id)).toBeNull();
        await expect(memory.forget('bob', saved.id)).rejects.toMatchObject({ code: 'PERSONAL_ITEM_NOT_FOUND' });
        await expect(memory.edit('bob', saved.id, { text: '改' })).rejects.toMatchObject({ code: 'PERSONAL_ITEM_NOT_FOUND' });
        expect((await memory.list('alice')).map(item => item.text)).toEqual(['先给结论，再给依据。']);
    });
});

test('a correction creates a new item and marks the old one superseded instead of overwriting it (3a)', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        const memory = createPersonalMemory({ pool });
        const old = await memory.add('alice', { title: '渠道立场', text: '先做一线城市。' });
        const next = await memory.supersede('alice', old.id, { title: '渠道立场', text: '改成先做县城样板。', references: [reference] });
        expect((await memory.list('alice')).map(item => item.text)).toEqual(['改成先做县城样板。']);
        expect(await memory.get('alice', old.id)).toMatchObject({ status: 'superseded', supersededBy: next.id, text: '先做一线城市。' });
        // 同一条旧说法只能被替代一次：并发的第二次纠正报错，不会悄悄覆盖。
        await expect(memory.supersede('alice', old.id, { title: '渠道立场', text: '又改了' })).rejects.toMatchObject({ code: 'PERSONAL_ITEM_NOT_ACTIVE' });
        expect((await memory.list('alice', { status: 'all' })).map(item => item.text).sort()).toEqual(['先做一线城市。', '改成先做县城样板。']);
    });
});

test('concurrent writes never lose each other and there is no whole-document size cliff (3a)', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        const memory = createPersonalMemory({ pool });
        await Promise.all(Array.from({ length: 20 }, (_, index) => memory.add('alice', { title: `想法 ${index}`, text: `第 ${index} 个想法。` + '展开说明。'.repeat(500) })));
        const items = await memory.list('alice');
        expect(items).toHaveLength(20);
        // 以前整份 Personal.md 超过 16 KiB 就整批拒绝；现在 20 条、每条约 2.5 KB 全部保存。
        expect(items.reduce((bytes, item) => bytes + Buffer.byteLength(item.text), 0)).toBeGreaterThan(16384 * 3);
    });
});

test('forget hides an item from conversations but keeps it as a learning barrier; owner edits only active items (3a)', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        const memory = createPersonalMemory({ pool });
        const hobby = await memory.add('alice', { title: '兴趣', text: '周末喜欢徒步。' });
        const style = await memory.add('alice', { title: '协作偏好', text: '先给结论。' });
        expect((await memory.select('alice', '徒步')).map(item => item.id)).toContain(hobby.id);
        await memory.forget('alice', hobby.id);
        expect((await memory.select('alice', '徒步')).map(item => item.id)).toEqual([style.id]);
        expect((await memory.blocked('alice')).map(item => item.text)).toEqual(['周末喜欢徒步。']);
        await expect(memory.edit('alice', hobby.id, { text: '改' })).rejects.toMatchObject({ code: 'PERSONAL_ITEM_NOT_ACTIVE' });
        const edited = await memory.edit('alice', style.id, { text: '先给结论，再给推导。' });
        expect(edited).toMatchObject({ id: style.id, text: '先给结论，再给推导。', status: 'active' });
        expect(Date.parse(edited.updatedAt)).toBeGreaterThanOrEqual(Date.parse(style.updatedAt));
    });
});

test('anchors match the current object regardless of version and mark ideas based on an older version (3a, R8)', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        const memory = createPersonalMemory({ pool });
        const pinned = await memory.add('alice', { title: '对议题的判断', text: '预算应该砍一半。', anchors: [{ target: 'issue:i1', pinnedVersion: 2 }] });
        await memory.add('alice', { title: '无关想法', text: '明年去看看东南亚。', anchors: [{ target: 'issue:i2', pinnedVersion: 1 }] });
        const [first] = await memory.select('alice', '这个怎么看？', { currentObject: { target: 'issue:i1', version: 5 } });
        expect(first).toMatchObject({ id: pinned.id, basedOnOldVersion: true });
        const [same] = await memory.select('alice', '这个怎么看？', { currentObject: { target: 'issue:i1', version: 2 } });
        expect(same.id).toBe(pinned.id);
        expect(same.basedOnOldVersion).toBeUndefined();
        expect(await memory.select('alice', '这个怎么看？', { currentObject: { target: 'issue:i9', version: 1 } })).toEqual([]);
    });
});
