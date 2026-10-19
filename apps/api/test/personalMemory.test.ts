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

test('with a recall model, a paraphrased question still brings back the right item; preferences stay, unpicked practices do not (memory-recall)', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        const asked: { message: string; titles: string[] }[] = [];
        let picked: (items: { id: string; title: string }[]) => string[] = () => [];
        const memory = createPersonalMemory({ pool, recall: async ({ message, items }) => { asked.push({ message, titles: items.map(item => item.title) }); return picked(items); } });
        const style = await memory.add('alice', { kind: 'preference', title: '先给结论', text: '回答先给结论，再给依据。' });
        await memory.add('alice', { kind: 'practice', title: '周会先数后事', text: '周会先过 15 分钟数据看板。' });
        const expansion = await memory.add('alice', { kind: 'open_question', title: '扩编方向还没想好', text: '还没想好销售扩编往哪个方向扩：补县城地推还是加电销。' });
        const gone = await memory.add('alice', { kind: 'idea', title: '已忘的想法', text: '周末去徒步。' });
        await memory.forget('alice', gone.id);
        picked = (items) => items.filter(item => item.title === '扩编方向还没想好').map(item => item.id);
        // 「拿不定主意」「卖货团队招人」和条目没有一个二字词重合，字面重合选不出它。
        const question = '卖货团队要不要多招人，我还有什么拿不定主意的？';
        expect((await createPersonalMemory({ pool }).select('alice', question)).map(item => item.id)).not.toContain(expansion.id);
        expect((await memory.select('alice', question)).map(item => item.id)).toEqual([expansion.id, style.id]);
        // 模型只看到偏好类以外的现行条目（偏好常驻，已忘的不进目录）。
        expect(asked[0]).toEqual({ message: question, titles: ['扩编方向还没想好', '周会先数后事'] });
        // 与个人想法无关的问题：模型返回空，只剩常驻的偏好，做法类不再兜底带上。
        picked = () => [];
        expect((await memory.select('alice', 'Python 里怎么给列表去重？')).map(item => item.id)).toEqual([style.id]);
    });
});

test('items pinned on the current object always come first under recall, and a failed recall falls back to word overlap (memory-recall, R8)', async () => {
    await createTestDb(async ({ pool, db }) => {
        await migrate(db);
        let fail = false;
        const memory = createPersonalMemory({ pool, recall: async () => { if (fail) throw Object.assign(new Error('down'), { code: 'PERSONAL_MEMORY_RECALL_TIMEOUT' }); return []; } });
        const pinned = await memory.add('alice', { title: '对议题的判断', text: '预算应该砍一半。', anchors: [{ target: 'issue:i1', pinnedVersion: 2 }] });
        const hiking = await memory.add('alice', { title: '兴趣', text: '周末喜欢徒步。' });
        expect(await memory.select('alice', '这个怎么看？', { currentObject: { target: 'issue:i1', version: 5 } })).toMatchObject([{ id: pinned.id, basedOnOldVersion: true }]);
        fail = true;
        expect((await memory.select('alice', '周末徒步去哪')).map(item => item.id)).toEqual([hiking.id]);
    });
});
