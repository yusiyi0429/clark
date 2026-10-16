import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PersonalMemoryTools } from './conversations.js';

/**
 * 个人记忆（只有本人可见，不写进本体，R6）：每条一行（personal_memory_items），不再是一份整写的 Personal.md。
 * - 每条带时间（created_at / updated_at）、状态（active / superseded / forgotten）、被谁替代（superseded_by）；
 * - anchor（关于什么）与 reference（依据在哪）分开存（R5）：anchors [{ target, pinnedVersion? }]，references [{ ref, quote?, at }]；
 * - 纠正 = 新建一条，旧条目标 superseded；忘掉 = 标 forgotten（留着，后台提炼据此不再学回来）。
 * 一次只改一行，没有整份覆盖，也没有 16 KiB 的总量上限。
 */
export type MemoryStatus = 'active' | 'superseded' | 'forgotten';
/** 记什么（R4）：想法、立场、未决问题、理由、偏好与习惯。 */
export const MEMORY_KINDS = ['idea', 'stance', 'open_question', 'reason', 'preference'] as const;
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

export function createPersonalMemory({ pool }: { pool: Pool }) {
    const api = {
        async list(personId: string, options: { status?: MemoryStatus | 'all' } = {}, connection?: Q): Promise<PersonalItem[]> {
            const status = options.status ?? 'active';
            const rows = (await (connection ?? pool).query(`SELECT ${ROW} FROM personal_memory_items WHERE person_id = $1 AND ($2::text = 'all' OR status = $2) ORDER BY created_at DESC, id`,
                [personId, status])).rows;
            return rows.map(item);
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
         * 每轮装进对话的条目：只取 active 的，按与本轮原话的重合度、是否钉在当前对象上排序，偏好类小条目兜底，总量有上限。
         * currentObject 给出时，钉在它上面但版本比现在旧的条目标 basedOnOldVersion（R8）。
         */
        async select(personId: string, query: string, options: { currentObject?: { target: string; version?: number } } = {}, connection?: Q): Promise<PersonalSelection[]> {
            const items = await api.list(personId, { status: 'active' }, connection);
            const terms = grams(query);
            const current = options.currentObject;
            let bytes = 0;
            return items.map(entry => {
                const onCurrent = Boolean(current && entry.anchors.some(anchor => sameTarget(anchor.target, current.target)));
                const score = [...grams(`${entry.title} ${entry.text}`)].filter(term => terms.has(term)).length + (onCurrent ? 3 : 0);
                return { entry, onCurrent, score, stable: entry.kind === 'preference' || /协作|沟通|表达|偏好/.test(entry.title) };
            }).filter(row => row.score > 0 || row.stable).sort((left, right) => right.score - left.score).flatMap(({ entry, onCurrent }) => {
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
