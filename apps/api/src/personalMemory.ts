import { randomUUID } from 'node:crypto';
import { boundedText } from './conversationAnchor.js';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
export type PersonalSection = {
    id: string;
    title: string;
    text: string;
};
export type PersonalDocument = {
    revision: number;
    epoch: number;
    markdown: string;
    sections: PersonalSection[];
};
export type PersonalChange = {
    attributeKey: string;
    text?: string;
    title?: string;
    operation: 'add' | 'update' | 'remove';
};
export type PersonalReference = {
    handle: string;
    kind: 'personal';
    title: string;
    text: string;
};
export type PersonalMemory = ReturnType<typeof createPersonalMemory>;
type State = {
    directory_id: string;
    revision: number;
    pending_revision: number | null;
    epoch: number;
};
const clean = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim();
const fault = (code: string) => Object.assign(new Error(code), { code });
function sections(markdown: string, previous: PersonalSection[] = []): PersonalSection[] {
    const result: PersonalSection[] = [];
    let title = '个人记忆';
    let attribute: string | undefined;
    let lines: string[] = [];
    function flush() {
        const text = clean(lines.join('\n'));
        if (text) {
            const available = previous.filter(item => !result.some(saved => saved.id === item.id));
            const matching = available.find(item => item.text === text);
            const sameTitle = available.filter(item => item.title === title);
            result.push({id:attribute ?? matching?.id ?? (sameTitle.length===1 ? sameTitle[0].id : randomUUID()),title,text});
        }
        lines = [];
        attribute = undefined;
    }
    for (const line of markdown.split('\n')) {
        const heading = line.match(/^#{1,6} (.+)$/);
        const key = line.match(/^<!-- attribute:([a-zA-Z0-9_.:-]+) -->$/);
        if (heading) { flush(); title = heading[1]; }
        else if (key) { if (clean(lines.join('\n'))) flush(); attribute = key[1]; }
        else lines.push(line);
    }
    flush();
    return result;
}

const serialize = (items: PersonalSection[]) => '# Personal\n\n' + items.map(item => `## ${item.title}\n\n<!-- attribute:${item.id} -->\n${item.text}`).join('\n\n') + '\n';
const document = (state: State, body: string): PersonalDocument => ({ revision: state.revision, epoch: state.epoch, markdown: clean(body) || '# Personal\n', sections: sections(body) });
export function createPersonalMemory({ pool, storageDir }: {
    pool: Pool;
    storageDir: string;
}) {
    const handles = new Map<string, {
        personId: string;
        revision: number;
        id: string;
    }>();
    async function locked<T>(personId: string, action: (client: PoolClient, state: State, path: string, body: string) => Promise<T>, connection?: PoolClient): Promise<T> {
        const client = connection ?? await pool.connect(), key = `memory:personal:${personId}`;
        let acquired = false;
        try {
            acquired = (await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])).rows[0].locked;
            if (!acquired) throw fault('PERSONAL_MEMORY_BUSY');
            await client.query("INSERT INTO memory_documents(module,scope_key,directory_id) VALUES('personal',$1,$2) ON CONFLICT DO NOTHING", [personId, randomUUID()]);
            const state = (await client.query<State>("SELECT * FROM memory_documents WHERE module='personal' AND scope_key=$1", [personId])).rows[0];
            const directory = join(storageDir, state.directory_id);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const path = join(directory, 'Personal.md');
            let raw: string;
            try {
                raw = await readFile(path, 'utf8');
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || state.revision !== 0)
                    throw error;
                raw = '<!-- revision:0 -->\n# Personal\n';
            }
            const fileRevision = Number(raw.match(/^<!-- revision:(\d+) -->/)?.[1] ?? NaN);
            if (state.pending_revision !== null) {
                if (fileRevision === state.pending_revision)
                    state.revision = fileRevision;
                else if (fileRevision !== state.revision)
                    throw fault('MEMORY_RECOVERY_REQUIRED');
                await client.query("UPDATE memory_documents SET revision=$2,pending_revision=NULL WHERE module='personal' AND scope_key=$1", [personId, state.revision]);
                state.pending_revision = null;
            }
            if (fileRevision !== state.revision)
                throw fault('MEMORY_RECOVERY_REQUIRED');
            const excluded = new Set((await client.query('SELECT attribute_key FROM personal_memory_exclusions WHERE person_id=$1', [personId])).rows.map(row => row.attribute_key));
            const body = serialize(sections(raw.replace(/^<!-- revision:\d+ -->\n/, '')).filter(item => !excluded.has(item.id)));
            return await action(client, state, path, body);
        }
        finally {
            if (acquired) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
            if (!connection) client.release();
        }
    }
    async function invalidate(client: PoolClient, personId: string, state: State, keys: string[], previous:PersonalSection[], explicitJobId?: string) {
        await client.query('BEGIN');
        try {
            const cutoffs = (await client.query('SELECT c.id,COALESCE(MAX(m.sequence),0)::integer AS sequence FROM conversations c LEFT JOIN conversation_messages m ON m.conversation_id=c.id WHERE c.owner_id=$1 GROUP BY c.id', [personId])).rows;
            let throughJob = 0;
            if ((await client.query("SELECT to_regclass('personal_memory_jobs') AS name")).rows[0].name)
                throughJob = Number((await client.query('SELECT COALESCE(MAX(id),0) AS id FROM personal_memory_jobs')).rows[0].id);
            for (const key of keys)
                await client.query('INSERT INTO personal_memory_exclusions(person_id,attribute_key,through_job_id,conversation_cutoffs,title,text) VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(person_id,attribute_key) DO UPDATE SET through_job_id=EXCLUDED.through_job_id,conversation_cutoffs=EXCLUDED.conversation_cutoffs,title=EXCLUDED.title,text=EXCLUDED.text,created_at=now()', [personId, key, throughJob, JSON.stringify(Object.fromEntries(cutoffs.map(row => [row.id, row.sequence]))),previous.find(item=>item.id===key)?.title ?? "",previous.find(item=>item.id===key)?.text.slice(0,2048) ?? ""]);
            state.epoch++;
            await client.query("UPDATE memory_documents SET epoch=$2,last_explicit_job_id=$3 WHERE module='personal' AND scope_key=$1", [personId, state.epoch, explicitJobId ?? null]);
            await client.query("UPDATE conversations c SET runtime_entries='[]'::jsonb,pi_session_id=$2,memory_epoch=$3,memory_history_cutoff=COALESCE((SELECT MAX(sequence) FROM conversation_messages WHERE conversation_id=c.id),0) WHERE owner_id=$1", [personId, randomUUID(), state.epoch]);
            await client.query('COMMIT');
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    }
    async function write(client: PoolClient, state: State, path: string, personId: string, items: PersonalSection[]) {
        const body = serialize(items);
        if (Buffer.byteLength(body) > 16384)
            throw fault('PERSONAL_MEMORY_TOO_LARGE');
        const revision = state.revision + 1;
        await client.query("UPDATE memory_documents SET pending_revision=$2 WHERE module='personal' AND scope_key=$1", [personId, revision]);
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, `<!-- revision:${revision} -->\n${body}`, { mode: 0o600 });
        await rename(temp, path);
        await client.query("UPDATE memory_documents SET revision=$2,pending_revision=NULL,updated_at=now() WHERE module='personal' AND scope_key=$1", [personId, revision]);
        state.revision = revision;
        return document(state, body);
    }
    const api = {
        readOwn(personId: string, connection?: PoolClient) { return locked(personId, async (_client, state, _path, body) => document(state, body), connection); },
        replaceOwn(personId: string, input: {
            expectedRevision: number;
            markdown: string;
        }) {
            return locked(personId, async (client, state, path, body) => {
                if (state.revision !== input.expectedRevision)
                    throw fault('MEMORY_VERSION_CONFLICT');
                if (Buffer.byteLength(input.markdown) > 16384)
                    throw fault('PERSONAL_MEMORY_TOO_LARGE');
                const previous = sections(body), next = sections(clean(input.markdown), previous);
                await invalidate(client, personId, state, previous.filter(old => !next.some(item => item.id === old.id)).map(item => item.id),previous);
                return write(client, state, path, personId, next);
            });
        },
        forgetOwn(personId: string, input: {
            expectedRevision: number;
            sectionIds: string[];
        }) {
            return locked(personId, async (client, state, path, body) => {
                if (state.revision !== input.expectedRevision)
                    throw fault('MEMORY_VERSION_CONFLICT');
                const items = sections(body);
                if (input.sectionIds.some(id => !items.some(item => item.id === id)))
                    throw fault('PERSONAL_SECTION_NOT_FOUND');
                await invalidate(client, personId, state, input.sectionIds,items);
                return write(client, state, path, personId, items.filter(item => !input.sectionIds.includes(item.id)));
            });
        },
        apply(personId: string, input: {
            expectedRevision: number;
            epoch: number;
            changes: PersonalChange[];
            explicit?: boolean;
            explicitJobId?: string;
        }, connection?: PoolClient) {
            return locked(personId, async (client, state, path, body) => {
                if (state.epoch !== input.epoch || state.revision !== input.expectedRevision)
                    throw fault('MEMORY_VERSION_CONFLICT');
                const exclusions = new Set((await client.query('SELECT attribute_key FROM personal_memory_exclusions WHERE person_id=$1', [personId])).rows.map(row => row.attribute_key));
                const items = sections(body);
                const previous = [...items];
                for (const change of input.changes) {
                    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(change.attributeKey)) throw fault('INVALID_PERSONAL_CHANGE');
                    if (exclusions.has(change.attributeKey) && !input.explicit)
                        continue;
                    const index = items.findIndex(item => item.id === change.attributeKey);
                    if (change.operation === 'remove') {
                        if (index >= 0)
                            items.splice(index, 1);
                    }
                    else if (change.text?.trim()) {
                        const item = { id: change.attributeKey, title: clean(change.title ?? '个人记忆').replace(/[\r\n]+/g,' '),
                          text: clean(change.text).replace(/^#{1,6} (.+)$/gm, '**$1**') };
                        if (index >= 0)
                            items[index] = item;
                        else
                            items.push(item);
                    }
                }
                if (input.explicit) await invalidate(client, personId, state, input.changes.filter(change=>change.operation==='remove').map(change=>change.attributeKey),previous,input.explicitJobId);
                const saved = await write(client, state, path, personId, items);
                if (input.explicit) for (const change of input.changes) {
                    if (change.operation!=='remove') await client.query('DELETE FROM personal_memory_exclusions WHERE person_id=$1 AND attribute_key=$2',[personId,change.attributeKey]);
                }
                return saved;
            }, connection);
        },
        readBlocked(personId:string, connection?: PoolClient) {
            return locked(personId, async(client)=> (await client.query<{key:string;title:string;text:string;throughJobId:string;conversationCutoffs:Record<string,number>}>(`SELECT attribute_key AS key,title,text,through_job_id::text AS "throughJobId",conversation_cutoffs AS "conversationCutoffs" FROM personal_memory_exclusions WHERE person_id=$1 ORDER BY created_at DESC LIMIT 100`,[personId])).rows, connection);
        },
        async select(personId: string, query: string, connection?: PoolClient): Promise<PersonalReference[]> {
            const doc = await api.readOwn(personId, connection);
            const grams = (text: string) => {
                const terms: string[] = Array.from(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
                for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
                    for (let index=0; index<run.length-1; index++) terms.push(run.slice(index,index+2));
                    if (run.length===1) terms.push(run);
                }
                return new Set(terms);
            };
            const terms = grams(query);
            let bytes = 0;
            return doc.sections.map(item => ({ item, score: [...grams(item.title + ' ' + item.text)].filter(term => terms.has(term)).length, stable: /协作|沟通|表达|偏好/.test(item.title) })).filter(row => row.score > 0 || row.stable).sort((a, b) => b.score - a.score).flatMap(({ item, stable, score }) => {
                const handle = randomUUID();
                const reference = { handle, kind: 'personal' as const, title: boundedText(item.title, 200), text: boundedText(item.text, stable && score === 0 ? 1400 : 3000) };
                while (Buffer.byteLength(JSON.stringify(reference)) > (stable && score === 0 ? 2048 : 4096)) reference.text = boundedText(reference.text, Math.floor(Buffer.byteLength(reference.text) * 0.8));
                const size = Buffer.byteLength(JSON.stringify(reference));
                if (bytes + size > (stable && score === 0 ? 2048 : 8192)) return [];
                bytes += size; handles.set(handle, { personId, revision: doc.revision, id: item.id });
                if (handles.size > 1024) handles.delete(handles.keys().next().value!);
                return [reference];
            });
        },
        async readReference(personId: string, input: {
            handle: string;
            cursor?: string;
        }): Promise<{
            title: string;
            text: string;
            more: boolean;
            cursor?: string;
        } | {
            unavailable: true;
        }> { const entry = handles.get(input.handle); if (!entry || entry.personId !== personId)
            return { unavailable: true };
            const prefix = `${input.handle}:`;
            if (input.cursor && (!input.cursor.startsWith(prefix) || !/^\d+$/.test(input.cursor.slice(prefix.length)))) return { unavailable: true };
            const doc = await api.readOwn(personId), item = doc.sections.find(item => item.id === entry.id);
            if (doc.revision !== entry.revision || !item) return { unavailable: true };
            const offset = Number(input.cursor?.slice(prefix.length) ?? 0);
            if (!Number.isSafeInteger(offset) || offset > item.text.length) return { unavailable: true };
            let text = boundedText(item.text.slice(offset), 6000);
            const page = () => {
                const next = offset + text.length;
                return { title: boundedText(item.title, 300), text, more: next < item.text.length, ...(next < item.text.length ? { cursor: `${prefix}${next}` } : {}) };
            };
            while (Buffer.byteLength(JSON.stringify(page())) > 8192) text = boundedText(text, Math.floor(Buffer.byteLength(text) * 0.8));
            return page();
        }
    };
    return api;
}
