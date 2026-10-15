import { randomUUID } from 'node:crypto';
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
    for (const block of markdown.split(/\n\s*\n/)) {
        const text = clean(block);
        if (!text)
            continue;
        if (/^#{1,6} /.test(text)) {
            title = text.replace(/^#+\s*/, '');
            continue;
        }
        result.push({ id: block.match(/<!-- attribute:([a-zA-Z0-9_-]+) -->/)?.[1] ?? previous.find(item => item.text === text)?.id ?? randomUUID(), title, text });
    }
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
    async function locked<T>(personId: string, action: (client: PoolClient, state: State, path: string, body: string) => Promise<T>): Promise<T> {
        const client = await pool.connect(), key = `memory:personal:${personId}`;
        try {
            await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
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
            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
            client.release();
        }
    }
    async function invalidate(client: PoolClient, personId: string, state: State, keys: string[]) {
        await client.query('BEGIN');
        try {
            const cutoffs = (await client.query('SELECT c.id,COALESCE(MAX(m.sequence),0)::integer AS sequence FROM conversations c LEFT JOIN conversation_messages m ON m.conversation_id=c.id WHERE c.owner_id=$1 GROUP BY c.id', [personId])).rows;
            let throughJob = 0;
            if ((await client.query("SELECT to_regclass('personal_memory_jobs') AS name")).rows[0].name)
                throughJob = Number((await client.query('SELECT COALESCE(MAX(id),0) AS id FROM personal_memory_jobs')).rows[0].id);
            for (const key of keys)
                await client.query('INSERT INTO personal_memory_exclusions(person_id,attribute_key,through_job_id,conversation_cutoffs) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(person_id,attribute_key) DO UPDATE SET through_job_id=EXCLUDED.through_job_id,conversation_cutoffs=EXCLUDED.conversation_cutoffs,created_at=now()', [personId, key, throughJob, JSON.stringify(Object.fromEntries(cutoffs.map(row => [row.id, row.sequence])))]);
            state.epoch++;
            await client.query("UPDATE memory_documents SET epoch=$2 WHERE module='personal' AND scope_key=$1", [personId, state.epoch]);
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
        readOwn(personId: string) { return locked(personId, async (_client, state, _path, body) => document(state, body)); },
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
                await invalidate(client, personId, state, previous.filter(old => !next.some(item => item.id === old.id)).map(item => item.id));
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
                await invalidate(client, personId, state, input.sectionIds);
                return write(client, state, path, personId, items.filter(item => !input.sectionIds.includes(item.id)));
            });
        },
        apply(personId: string, input: {
            expectedRevision: number;
            epoch: number;
            changes: PersonalChange[];
        }) {
            return locked(personId, async (client, state, path, body) => {
                if (state.epoch !== input.epoch || state.revision !== input.expectedRevision)
                    throw fault('MEMORY_VERSION_CONFLICT');
                const exclusions = new Set((await client.query('SELECT attribute_key FROM personal_memory_exclusions WHERE person_id=$1', [personId])).rows.map(row => row.attribute_key));
                const items = sections(body);
                for (const change of input.changes) {
                    if (exclusions.has(change.attributeKey))
                        continue;
                    const index = items.findIndex(item => item.id === change.attributeKey);
                    if (change.operation === 'remove') {
                        if (index >= 0)
                            items.splice(index, 1);
                    }
                    else if (change.text?.trim()) {
                        const item = { id: change.attributeKey, title: change.title ?? '个人记忆', text: clean(change.text) };
                        if (index >= 0)
                            items[index] = item;
                        else
                            items.push(item);
                    }
                }
                return write(client, state, path, personId, items);
            });
        },
        async select(personId: string, query: string): Promise<PersonalReference[]> {
            const doc = await api.readOwn(personId);
            const grams = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{1,2}/g) ?? []), terms = grams(query);
            let bytes = 0;
            return doc.sections.map(item => ({ item, score: [...grams(item.title + ' ' + item.text)].filter(term => terms.has(term)).length, stable: /协作|沟通|表达|偏好/.test(item.title) })).filter(row => row.score > 0 || row.stable).sort((a, b) => b.score - a.score).flatMap(({ item, stable, score }) => { const size = Buffer.byteLength(item.text); if (size > 4096 || bytes + size > (stable && score === 0 ? 2048 : 8192))
                return []; bytes += size; const handle = randomUUID(); handles.set(handle, { personId, revision: doc.revision, id: item.id }); if (handles.size > 1024)
                handles.delete(handles.keys().next().value!); return [{ handle, kind: 'personal' as const, title: item.title, text: item.text }]; });
        },
        async readReference(personId: string, input: {
            handle: string;
        }): Promise<{
            title: string;
            text: string;
        } | {
            unavailable: true;
        }> { const entry = handles.get(input.handle); if (!entry || entry.personId !== personId)
            return { unavailable: true }; const doc = await api.readOwn(personId), item = doc.sections.find(item => item.id === entry.id); return doc.revision === entry.revision && item ? { title: item.title, text: item.text } : { unavailable: true }; }
    };
    return api;
}
