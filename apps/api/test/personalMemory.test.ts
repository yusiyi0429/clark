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
            expect(forgotten.markdown).not.toContain('徒步');expect((await memory.readBlocked('alice'))[0]).toMatchObject({key:saved.sections[1].id,title:'兴趣',text:'周末喜欢徒步。'});
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

test('forget fails visibly on interrupted persistence but old content cannot return, and pending rename recovers', async () => {
 await createTestDb(async ({pool,db})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'personal-crash-'));
 try{const memory=createPersonalMemory({pool,storageDir});const saved=await memory.replaceOwn('alice',{expectedRevision:0,markdown:'# Personal\n\n## 兴趣\n\n周末喜欢徒步。'});
 await db.query(`CREATE FUNCTION fail_memory_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pending_revision IS NOT NULL THEN RAISE EXCEPTION 'disk update interrupted'; END IF; RETURN NEW; END $$; CREATE TRIGGER interrupt_memory BEFORE UPDATE ON memory_documents FOR EACH ROW EXECUTE FUNCTION fail_memory_write()`);
 await expect(memory.forgetOwn('alice',{expectedRevision:1,sectionIds:[saved.sections[0].id]})).rejects.toThrow('disk update interrupted');
 expect((await createPersonalMemory({pool,storageDir}).readOwn('alice')).markdown).not.toContain('徒步');
 expect(await memory.select('alice','徒步')).toEqual([]);
 await db.query('DROP TRIGGER interrupt_memory ON memory_documents');
 // Fixture at the crash boundary: atomic rename completed, final control-state update did not.
 const state=(await db.query("SELECT directory_id FROM memory_documents WHERE scope_key='alice'")).rows[0];
 const {readFile,writeFile}=await import('node:fs/promises');const path=join(storageDir,state.directory_id,'Personal.md');
 const raw=await readFile(path,'utf8');await writeFile(path,raw.replace('revision:1','revision:2'));
 await db.query("UPDATE memory_documents SET pending_revision=2 WHERE scope_key='alice'");
 const recovered=await createPersonalMemory({pool,storageDir}).readOwn('alice');expect(recovered.revision).toBe(2);expect(recovered.markdown).not.toContain('徒步');
 }finally{await rm(storageDir,{recursive:true,force:true});}});
});

test('only a fresh explicit personal instruction may reauthorize a forgotten stable attribute', async()=>{
 await createTestDb(async({pool,db})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'personal-reauthorize-'));
 try{const memory=createPersonalMemory({pool,storageDir});const saved=await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'communication',title:'协作偏好',text:'先给结论。'}]});
 const forgotten=await memory.forgetOwn('alice',{expectedRevision:saved.revision,sectionIds:['communication']});
 const blocked=await memory.apply('alice',{expectedRevision:forgotten.revision,epoch:forgotten.epoch,changes:[{operation:'add',attributeKey:'communication',title:'协作偏好',text:'先给结论。'}]});expect(blocked.markdown).not.toContain('结论');
 const restored=await memory.apply('alice',{expectedRevision:blocked.revision,epoch:blocked.epoch,explicit:true,changes:[{operation:'add',attributeKey:'communication',title:'协作偏好',text:'现在希望先讲推导过程。'}]});
 expect(restored.markdown).toContain('推导过程');expect((await memory.readOwn('alice')).markdown).toContain('推导过程');
 }finally{await rm(storageDir,{recursive:true,force:true});}});
});

test('a section keeps its stable identity through multi-paragraph corrections and overlapping Chinese recall',async()=>{
 await createTestDb(async({pool,db})=>{await migrate(db);const storageDir=await mkdtemp(join(tmpdir(),'personal-sections-'));
 try{const memory=createPersonalMemory({pool,storageDir});const saved=await memory.apply('alice',{expectedRevision:0,epoch:0,changes:[{operation:'add',attributeKey:'hobby.outdoors',title:'兴趣',text:'我喜欢在周末徒步旅行。\n\n每周选择不同的路线。'}]});
 const loaded=await memory.readOwn('alice');expect(loaded.sections).toHaveLength(1);expect(loaded.sections[0].id).toBe('hobby.outdoors');
 expect((await memory.select('alice','徒步')).map(ref=>ref.text).join('')).toContain('不同的路线');
 const edited=await memory.replaceOwn('alice',{expectedRevision:saved.revision,markdown:'# Personal\n\n## 兴趣\n\n我更喜欢短途徒步。\n\n通常只用半天。'});expect(edited.sections[0].id).toBe('hobby.outdoors');
 expect((await memory.select('alice','徒步')).some(ref=>ref.text.includes('<!--'))).toBe(false);
 }finally{await rm(storageDir,{recursive:true,force:true});}});
});
