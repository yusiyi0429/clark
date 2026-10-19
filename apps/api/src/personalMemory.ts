import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PersonalMemoryTools } from './conversations.js';
import { logEvent } from './observability.js';
import type { MemoryRecall } from './personalMemoryRecall.js';

/**
 * 个人记忆（只有本人可见，不写进本体，R6）：每条一行（personal_memory_items），不再是一份整写的 Personal.md。
 * - 每条带时间（created_at / updated_at）、状态（active / superseded / forgotten）、被谁替代（superseded_by）；
 * - anchor（关于什么）与 reference（依据在哪）分开存（R5）：anchors [{ target, pinnedVersion? }]，references [{ ref, quote?, at }]；
 * - 纠正 = 新建一条，旧条目标 superseded；忘掉 = 标 forgotten（留着，后台提炼据此不再学回来）。
 * 一次只改一行，没有整份覆盖，也没有 16 KiB 的总量上限。
 */
export type MemoryStatus = 'active' | 'superseded' | 'forgotten';
/** 记什么（R4）：想法、立场、未决问题、理由、偏好与表达方式、做法。 */
export const MEMORY_KINDS = ['idea', 'stance', 'open_question', 'reason', 'preference', 'practice'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryAnchor = { target: string; pinnedVersion?: number };
export type MemoryReference = { ref: string; quote?: string; at: string };
export type PersonalItem = {
    id: string; kind: MemoryKind; title: string; text: string; status: MemoryStatus; supersededBy: string | null;
    anchors: MemoryAnchor[]; references: MemoryReference[]; createdAt: string; updatedAt: string;
};
export type NewPersonalItem = { kind?: MemoryKind; title: string; text: string; anchors?: MemoryAnchor[]; references?: MemoryReference[] };
/** 装进对话的一条：basedOnOldVersion 表示它钉住的对象已经改版（R8）。 */
export type PersonalSelection = { id: string; kind: MemoryKind; title: string; text: string; createdAt: string; anchors: MemoryAnchor[]; basedOnOldVersion?: boolean };
export type PersonalMemory = ReturnType<typeof createPersonalMemory>;
type Q = Pick<PoolClient, 'query'>;

export const MAX_TITLE = 200;
export const MAX_TEXT = 4000;
const SELECT_BUDGET_BYTES = 8192;

const fault = (code: string) => Object.assign(new Error(code), { code });

/** 按 UTF-8 字节截断，不切断字符。 */
export function boundedText(text: string, bytes: number): string {
    if (Buffer.byteLength(text) <= bytes) return text;
    let result = '';
    for (const character of text) { if (Buffer.byteLength(result) + Buffer.byteLength(character) > bytes) break; result += character; }
    return result;
}

/** 回答里的记忆标记 [记忆](cite:pmem:<id>) 中，不是本轮实际装进上下文的那些 id（质量信号：模型编了或抄错了 id）。 */
export function unknownMemoryMarks(text: string, used: ReadonlySet<string>): string[] {
    const ids = [...text.matchAll(/\(cite:pmem:([^)\s]+)\)/g)].map((match) => match[1]);
    return [...new Set(ids.filter((id) => !used.has(id)))];
}

/** anchor 检索时去掉版本：只比 target。 */
const sameTarget = (left: string, right: string) => left === right;

function validItem(input: NewPersonalItem) {
    const title = input.title.replace(/[\r\n]+/g, ' ').trim();
    const text = input.text.trim();
    if (!title || !text || title.length > MAX_TITLE || text.length > MAX_TEXT) throw fault('INVALID_PERSONAL_ITEM');
    if (input.kind && !MEMORY_KINDS.includes(input.kind)) throw fault('INVALID_PERSONAL_ITEM');
    for (const anchor of input.anchors ?? []) if (!anchor.target || anchor.target.length > 300) throw fault('INVALID_PERSONAL_ITEM');
    return { kind: input.kind ?? 'idea', title, text, anchors: input.anchors ?? [], references: input.references ?? [] };
}

const ROW = `id, kind, title, text, status, superseded_by, anchors, refs, created_at, updated_at`;
const INSERT = `INSERT INTO personal_memory_items (id, person_id, kind, title, text, anchors, refs) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) RETURNING ${ROW}`;
const insertParams = (id: string, personId: string, value: ReturnType<typeof validItem>) =>
    [id, personId, value.kind, value.title, value.text, JSON.stringify(value.anchors), JSON.stringify(value.references)];
function item(row: { id: string; kind: MemoryKind; title: string; text: string; status: MemoryStatus; superseded_by: string | null; anchors: MemoryAnchor[]; refs: MemoryReference[]; created_at: Date; updated_at: Date }): PersonalItem {
    return { id: row.id, kind: row.kind, title: row.title, text: row.text, status: row.status, supersededBy: row.superseded_by, anchors: row.anchors, references: row.refs,
        createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

/** 中文按二字词、英文按词，用来给条目和本轮原话算重合度。 */
function grams(text: string): Set<string> {
    const terms: string[] = Array.from(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    for (const run of text.match(/[一-鿿]+/g) ?? []) {
        for (let index = 0; index < run.length - 1; index++) terms.push(run.slice(index, index + 2));
        if (run.length === 1) terms.push(run);
    }
    return new Set(terms);
}

/** 字面重合排序（召回模型没配或失败时用）：重合的二字词数，钉在当前对象上加 3 分；偏好、做法与协作类标题即使不重合也带上。 */
function lexical(items: PersonalItem[], query: string, onCurrentOf: (entry: PersonalItem) => boolean): PersonalItem[] {
    const terms = grams(query);
    return items.map(entry => {
        const score = [...grams(`${entry.title} ${entry.text}`)].filter(term => terms.has(term)).length + (onCurrentOf(entry) ? 3 : 0);
        return { entry, score, stable: entry.kind === 'preference' || entry.kind === 'practice' || /协作|沟通|表达|偏好/.test(entry.title) };
    }).filter(row => row.score > 0 || row.stable).sort((left, right) => right.score - left.score).map(row => row.entry);
}

export function createPersonalMemory({ pool, recall }: { pool: Pool; recall?: MemoryRecall }) {
    /**
     * 模型召回：钉在当前对象上的先放，再放模型从目录（偏好类以外的现行条目）里挑出的，偏好类常驻、放最后。
     * 没配模型返回 null；召回失败、超时也返回 null（记日志），由调用方退回字面重合。
     */
    async function recalled(items: PersonalItem[], query: string, onCurrentOf: (entry: PersonalItem) => boolean): Promise<PersonalItem[] | null> {
        if (!recall) return null;
        const candidates = items.filter(entry => entry.kind !== 'preference');
        const startedAt = Date.now();
        try {
            const picked = candidates.length ? await recall({ message: query, items: candidates }) : [];
            logEvent({ event: 'personal_memory.recall', status: 'succeeded', candidates: candidates.length, picked: picked.length, durationMs: Date.now() - startedAt });
            const byId = new Map(items.map(entry => [entry.id, entry]));
            return [...new Set([...items.filter(onCurrentOf), ...picked.flatMap(id => byId.get(id) ?? []), ...items.filter(entry => entry.kind === 'preference')])];
        } catch (error) {
            logEvent({ event: 'personal_memory.recall', status: 'failed', candidates: candidates.length, durationMs: Date.now() - startedAt,
                errorCode: (error as { code?: string }).code ?? 'PERSONAL_MEMORY_RECALL_FAILED' });
            return null;
        }
    }
    const api = {
        /** q：标题、正文、原话（refs）里含这段文字的（不分大小写）。 */
        async list(personId: string, options: { status?: MemoryStatus | 'all'; q?: string } = {}, connection?: Q): Promise<PersonalItem[]> {
            const status = options.status ?? 'active';
            const q = options.q?.trim() ?? '';
            const rows = (await (connection ?? pool).query(`SELECT ${ROW} FROM personal_memory_items WHERE person_id = $1 AND ($2::text = 'all' OR status = $2)
                AND ($3::text = '' OR strpos(lower(title || ' ' || text || ' ' || refs::text), lower($3)) > 0) ORDER BY created_at DESC, id`,
                [personId, status, q])).rows;
            return rows.map(item);
        },
        /** 列表展示用：anchor 指向的议题、会议、Mission、执行事项现在叫什么（只读，不存）。查不到的不填。 */
        async withAnchorTitles(items: PersonalItem[], connection?: Q): Promise<PersonalItem[]> {
            const ids: Record<string, Set<string>> = { issue: new Set(), meeting: new Set(), task: new Set(), mission: new Set() };
            for (const entry of items) for (const anchor of entry.anchors) {
                const [type, id] = [anchor.target.slice(0, anchor.target.indexOf(':')), anchor.target.slice(anchor.target.indexOf(':') + 1)];
                if (ids[type] && id) ids[type].add(id);
            }
            const titles = new Map<string, string>();
            const read = async (type: string, sql: string) => {
                if (!ids[type].size) return;
                for (const row of (await (connection ?? pool).query(sql, [[...ids[type]]])).rows as { id: string; title: string }[]) titles.set(`${type}:${row.id}`, row.title);
            };
            await read('issue', `SELECT id::text, title FROM issues WHERE id::text = ANY($1::text[])`);
            await read('meeting', `SELECT id::text, title FROM meetings WHERE id::text = ANY($1::text[])`);
            await read('task', `SELECT id::text, title FROM tasks WHERE id::text = ANY($1::text[])`);
            await read('mission', `SELECT id, title FROM missions WHERE id = ANY($1::text[])`);
            return items.map(entry => ({ ...entry, anchors: entry.anchors.map(anchor => titles.has(anchor.target) ? { ...anchor, title: titles.get(anchor.target)! } : anchor) }));
        },
        async get(personId: string, id: string, connection?: Q): Promise<PersonalItem | null> {
            const row = (await (connection ?? pool).query(`SELECT ${ROW} FROM personal_memory_items WHERE person_id = $1 AND id::text = $2`, [personId, id])).rows[0];
            return row ? item(row) : null;
        },
        async add(personId: string, input: NewPersonalItem, connection?: Q): Promise<PersonalItem> {
            const value = validItem(input);
            return item((await (connection ?? pool).query(INSERT, insertParams(randomUUID(), personId, value))).rows[0]);
        },
        /** 纠正：新建一条，旧条目标为被它替代（R4）；旧条目已不是 active 时不改，报 PERSONAL_ITEM_NOT_ACTIVE。 */
        async supersede(personId: string, oldId: string, input: NewPersonalItem, connection?: PoolClient): Promise<PersonalItem> {
            const value = validItem(input);
            const client = connection ?? await pool.connect();
            const own = !connection;
            try {
                await client.query(own ? 'BEGIN' : 'SAVEPOINT personal_supersede');
                try {
                    const id = randomUUID();
                    const row = (await client.query(INSERT, insertParams(id, personId, value))).rows[0];
                    const old = await client.query(`UPDATE personal_memory_items SET status = 'superseded', superseded_by = $3, updated_at = now()
                        WHERE person_id = $1 AND id::text = $2 AND status = 'active'`, [personId, oldId, id]);
                    if (!old.rowCount) throw fault((await api.get(personId, oldId, client)) ? 'PERSONAL_ITEM_NOT_ACTIVE' : 'PERSONAL_ITEM_NOT_FOUND');
                    await client.query(own ? 'COMMIT' : 'RELEASE SAVEPOINT personal_supersede');
                    return item(row);
                } catch (error) {
                    await client.query(own ? 'ROLLBACK' : 'ROLLBACK TO SAVEPOINT personal_supersede');
                    throw error;
                }
            } finally { if (own) client.release(); }
        },
        /** 忘掉：标 forgotten，不再装进对话；留着正文，后台提炼据此不再把它学回来。 */
        async forget(personId: string, id: string, connection?: Q): Promise<PersonalItem> {
            const row = (await (connection ?? pool).query(`UPDATE personal_memory_items SET status = 'forgotten', updated_at = now()
                WHERE person_id = $1 AND id::text = $2 AND status <> 'forgotten' RETURNING ${ROW}`, [personId, id])).rows[0];
            if (!row) throw fault((await api.get(personId, id, connection)) ? 'PERSONAL_ITEM_NOT_ACTIVE' : 'PERSONAL_ITEM_NOT_FOUND');
            return item(row);
        },
        /** 恢复忘掉的一条：重新装进对话。只恢复 forgotten 的，别的状态报 PERSONAL_ITEM_NOT_FORGOTTEN。 */
        async restore(personId: string, id: string, connection?: Q): Promise<PersonalItem> {
            const row = (await (connection ?? pool).query(`UPDATE personal_memory_items SET status = 'active', updated_at = now()
                WHERE person_id = $1 AND id::text = $2 AND status = 'forgotten' RETURNING ${ROW}`, [personId, id])).rows[0];
            if (!row) throw fault((await api.get(personId, id, connection)) ? 'PERSONAL_ITEM_NOT_FORGOTTEN' : 'PERSONAL_ITEM_NOT_FOUND');
            return item(row);
        },
        /**
         * 彻底删除：删掉这一行，不能恢复，后台提炼也不再记得它被忘掉过。
         * 被它替代的旧条目没有了「替代者」，改成 forgotten（不回到现行，免得旧说法重新装进对话；本人可以恢复）。
         */
        async purge(personId: string, id: string): Promise<void> {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const own = (await client.query(`SELECT id FROM personal_memory_items WHERE person_id = $1 AND id::text = $2 FOR UPDATE`, [personId, id])).rows[0];
                if (!own) throw fault('PERSONAL_ITEM_NOT_FOUND');
                await client.query(`UPDATE personal_memory_items SET status = 'forgotten', superseded_by = NULL, updated_at = now() WHERE person_id = $1 AND superseded_by = $2`, [personId, own.id]);
                await client.query(`DELETE FROM personal_memory_items WHERE person_id = $1 AND id = $2`, [personId, own.id]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally { client.release(); }
        },
        /** 本人在界面上改一条（R7）：原地改标题、正文，只改 active 的。 */
        async edit(personId: string, id: string, input: { title?: string; text?: string }, connection?: Q): Promise<PersonalItem> {
            const current = await api.get(personId, id, connection);
            if (!current) throw fault('PERSONAL_ITEM_NOT_FOUND');
            if (current.status !== 'active') throw fault('PERSONAL_ITEM_NOT_ACTIVE');
            const value = validItem({ kind: current.kind, title: input.title ?? current.title, text: input.text ?? current.text, anchors: current.anchors });
            const row = (await (connection ?? pool).query(`UPDATE personal_memory_items SET title = $3, text = $4, updated_at = now()
                WHERE person_id = $1 AND id::text = $2 AND status = 'active' RETURNING ${ROW}`, [personId, id, value.title, value.text])).rows[0];
            if (!row) throw fault('PERSONAL_ITEM_NOT_ACTIVE');
            return item(row);
        },
        /** 本人要求忘掉的条目（最近 100 条）：后台提炼不得再学回来。 */
        async blocked(personId: string, connection?: Q): Promise<PersonalItem[]> {
            const rows = (await (connection ?? pool).query(`SELECT ${ROW} FROM personal_memory_items WHERE person_id = $1 AND status = 'forgotten' ORDER BY updated_at DESC LIMIT 100`, [personId])).rows;
            return rows.map(item);
        },
        /**
         * 每轮装进对话的条目：只取 active 的，总量有上限。
         * 配了召回模型（personalMemoryRecall.ts）：钉在当前对象上的、模型从目录里挑出的、偏好类（常驻）依次放进来；
         * 没配或这次召回失败、超时：按与本轮原话的字面重合度、是否钉在当前对象上排序，偏好与做法类兜底。
         * currentObject 给出时，钉在它上面但版本比现在旧的条目标 basedOnOldVersion（R8）。
         */
        async select(personId: string, query: string, options: { currentObject?: { target: string; version?: number } } = {}, connection?: Q): Promise<PersonalSelection[]> {
            const items = await api.list(personId, { status: 'active' }, connection);
            const current = options.currentObject;
            const onCurrentOf = (entry: PersonalItem) => Boolean(current && entry.anchors.some(anchor => sameTarget(anchor.target, current.target)));
            const ordered = await recalled(items, query, onCurrentOf) ?? lexical(items, query, onCurrentOf);
            let bytes = 0;
            return ordered.flatMap(entry => {
                const onCurrent = onCurrentOf(entry);
                const pinned = onCurrent ? entry.anchors.find(anchor => sameTarget(anchor.target, current!.target))?.pinnedVersion : undefined;
                const selection: PersonalSelection = { id: entry.id, kind: entry.kind, title: boundedText(entry.title, 200), text: boundedText(entry.text, 3000), createdAt: entry.createdAt, anchors: entry.anchors,
                    ...(pinned !== undefined && current?.version !== undefined && pinned < current.version ? { basedOnOldVersion: true } : {}) };
                const size = Buffer.byteLength(JSON.stringify(selection));
                if (bytes + size > SELECT_BUDGET_BYTES) return [];
                bytes += size;
                return [selection];
            });
        },
    };
    return api;
}

/**
 * 主 Agent 的个人记忆工具（3c）：绑定本人，只改本人的记忆。
 * 「记住」「改成」「忘掉」由主 Agent 在回答过程中调用；失败只抛错给工具，不影响主回答与上下文。
 * 依据（reference）由服务端写：本轮这条原话。
 */
export function personalMemoryToolsFor(memory: PersonalMemory, personId: string, log: (event: { event: string } & Record<string, unknown>) => void,
    context: { reference?: MemoryReference; anchors?: MemoryAnchor[] } = {}): PersonalMemoryTools {
    const logged = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
        try {
            const result = await action();
            log({ event: 'personal_memory.tool', operation, status: 'succeeded' });
            return result;
        } catch (error) {
            log({ event: 'personal_memory.tool', operation, status: 'failed', errorCode: (error as { code?: string }).code ?? 'PERSONAL_MEMORY_UNAVAILABLE' });
            throw error;
        }
    };
    // anchor：当前页面对象；没有对象、或本人说的是一个主题时用 topic:<主题>（R5）。
    const evidence = (topic?: string) => ({
        anchors: [...(context.anchors ?? []), ...(topic?.trim() ? [{ target: `topic:${topic.trim()}` }] : [])],
        references: context.reference ? [context.reference] : [],
    });
    return {
        search: async (query) => (await memory.select(personId, query)).map(({ id, title, text }) => ({ id, title, text })),
        remember: (input) => logged(input.replaces ? 'correct' : 'remember', async () => {
            const value = { kind: input.kind, title: input.title, text: input.text, ...evidence(input.topic) };
            const saved = input.replaces ? await memory.supersede(personId, input.replaces, value) : await memory.add(personId, value);
            return { id: saved.id, title: saved.title, text: saved.text };
        }),
        forget: (input) => logged('forget', async () => ({ id: (await memory.forget(personId, input.id)).id })),
    };
}
