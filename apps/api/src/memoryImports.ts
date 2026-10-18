import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { TConfirmMemoryImportRequest, TCreateMemoryImportRequest, TMemoryImport, TMemoryImportCandidate, TMemoryImportDetail } from '@warmap/contracts';
import { classifyCandidates, countsOf, decide, reconcileCandidates, readFiles, splitDocs,
    type Candidate, type ImportCounts, type ImportSource, type MemoryImportModel } from './memoryImport.js';
import type { TurnStep } from './conversationSteps.js';
import { logEvent } from './observability.js';
import type { PersonalMemory } from './personalMemory.js';

/**
 * 记忆导入的持久化与五步流程（7a-3）。收到请求时就读取、拆分（原文不落库），然后在后台分类、去重找冲突，停在「等你确认」。
 * 每一步的变化写进 memory_imports.steps（界面轮询显示当前步骤）并记一条 memory_import.step 日志。
 * 出错的那一步标 stopped、整次标 failed；重试从停住的那一步接着做，前面做完的不重做（已分好类的条目不再送模型）。
 * 确认：勾选的条目写进个人记忆（出处 import:<来源>:<导入 id>:<条目 id>，原话附上）；冲突按本人的选择保留旧的、用新的替代旧的、或两条都不要。
 */
const STEP_LABELS: [string, string][] = [['read', '读取'], ['split', '拆分'], ['classify', '分类'], ['reconcile', '去重和冲突'], ['confirm', '等你确认']];
const CATEGORY_SHORT: Record<string, string> = { personal_preference: '偏好', company_fact: '公司', project_instruction: '项目', drop: '不导入' };
const QUOTE_CHARS = 500;

const fault = (code: string) => Object.assign(new Error(code), { code });
/** 没配模型时：只做规则能做的（精确去重）；真要用到模型的地方在调用前就报 MEMORY_IMPORT_MODEL_UNAVAILABLE。 */
const NO_MODEL: MemoryImportModel = { classify: async () => { throw fault('MEMORY_IMPORT_MODEL_UNAVAILABLE'); }, reconcile: async () => { throw fault('MEMORY_IMPORT_MODEL_UNAVAILABLE'); } };

type ImportRow = { id: string; person_id: string; source: ImportSource; status: TMemoryImport['status']; steps: TurnStep[]; counts: ImportCounts; created_at: Date; updated_at: Date };
type CandidateRow = {
    id: string; source: ImportSource; path: string; locator: string; section: string | null; project: string | null; title: string; text: string; mtime: Date;
    hints: Candidate['hints']; fingerprint: string; category: Candidate['category']; kind: Candidate['kind']; drop_reason: Candidate['dropReason']; confidence: number | null;
    alternative: Candidate['alternative']; locked: boolean; duplicate_of_memory: string | null; duplicate_of_candidate: string | null; conflict_memory: string | null;
    conflict_candidate: string | null; grp: Candidate['group']; checked: boolean; resolution: TMemoryImportCandidate['resolution']; memory_item_id: string | null;
};

const view = (row: ImportRow): TMemoryImport => ({ id: row.id, source: row.source, status: row.status, steps: row.steps, counts: { ...EMPTY_COUNTS, ...row.counts },
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const EMPTY_COUNTS: ImportCounts = { files: 0, items: 0, truncated: false, personal: 0, company: 0, project: 0, dropped: 0, duplicates: 0, conflicts: 0, review: 0, checked: 0 };
const candidateOf = (row: CandidateRow): Candidate => ({
    key: row.id, source: row.source, path: row.path, locator: row.locator, ...(row.section ? { section: row.section } : {}), ...(row.project ? { project: row.project } : {}),
    title: row.title, text: row.text, mtime: row.mtime.toISOString(), hints: row.hints, fingerprint: row.fingerprint, category: row.category, kind: row.kind,
    dropReason: row.drop_reason, confidence: row.confidence, alternative: row.alternative, locked: row.locked,
    duplicateOf: row.duplicate_of_memory ? { memoryId: row.duplicate_of_memory } : row.duplicate_of_candidate ? { key: row.duplicate_of_candidate } : null,
    conflictWith: row.conflict_memory ? { memoryId: row.conflict_memory } : row.conflict_candidate ? { key: row.conflict_candidate } : null,
    group: row.grp, checked: row.checked,
});

export type MemoryImports = ReturnType<typeof createMemoryImports>;

export function createMemoryImports(options: { pool: Pool; personalMemory: PersonalMemory; model?: (personId: string) => MemoryImportModel | null; now?: () => Date }) {
    const { pool, personalMemory } = options;
    const running = new Map<string, Promise<void>>();
    /** 同一次导入的步骤写入排队，分类进度和后面的步骤不会乱序覆盖。 */
    const writes = new Map<string, Promise<unknown>>();

    async function load(personId: string, id: string, connection: Pick<PoolClient, 'query'> = pool): Promise<ImportRow | null> {
        return ((await connection.query(`SELECT * FROM memory_imports WHERE person_id = $1 AND id::text = $2`, [personId, id])).rows[0] as ImportRow | undefined) ?? null;
    }
    async function candidates(importId: string, connection: Pick<PoolClient, 'query'> = pool): Promise<CandidateRow[]> {
        return (await connection.query(`SELECT * FROM memory_import_candidates WHERE import_id = $1 ORDER BY position`, [importId])).rows as CandidateRow[];
    }
    /** 改一步：同时写库和日志。 */
    async function step(row: ImportRow, id: string, status: TurnStep['status'], result?: string, extra: { status?: TMemoryImport['status']; counts?: ImportCounts; errorCode?: string } = {}) {
        row.steps = row.steps.map(current => (current.id === id ? { id: current.id, label: current.label, status, ...(result ? { result } : {}) } : current));
        if (extra.status) row.status = extra.status;
        if (extra.counts) row.counts = extra.counts;
        const params = [row.id, JSON.stringify(row.steps), row.status, JSON.stringify(row.counts), extra.errorCode ?? null];
        const write = (writes.get(row.id) ?? Promise.resolve()).catch(() => undefined).then(() =>
            pool.query(`UPDATE memory_imports SET steps = $2::jsonb, status = $3, counts = $4::jsonb, error_code = $5, updated_at = now() WHERE id = $1 RETURNING updated_at`, params));
        writes.set(row.id, write);
        const updated = (await write).rows[0] as { updated_at: Date };
        if (writes.get(row.id) === write) writes.delete(row.id);
        row.updated_at = updated.updated_at;
        logEvent({ event: 'memory_import.step', importId: row.id, step: id, status, ...(extra.errorCode ? { errorCode: extra.errorCode } : {}) });
    }
    async function save(list: Candidate[]) {
        for (const candidate of list) {
            await pool.query(`UPDATE memory_import_candidates SET title = $2, category = $3, kind = $4, drop_reason = $5, confidence = $6, alternative = $7, locked = $8,
                duplicate_of_memory = $9, duplicate_of_candidate = $10, conflict_memory = $11, conflict_candidate = $12, grp = $13, default_checked = $14, checked = $14 WHERE id = $1`,
                [candidate.key, candidate.title, candidate.category, candidate.kind, candidate.dropReason, candidate.confidence, candidate.alternative, candidate.locked,
                    candidate.duplicateOf?.memoryId ?? null, candidate.duplicateOf?.key ?? null, candidate.conflictWith?.memoryId ?? null, candidate.conflictWith?.key ?? null,
                    candidate.group, candidate.checked]);
        }
    }

    /** 后台：分类 → 去重和冲突 → 停在等你确认。从第一个没做完的步骤开始。 */
    async function process(personId: string, id: string): Promise<void> {
        const row = await load(personId, id);
        if (!row || row.status !== 'processing') return;
        let current = 'classify';
        try {
            const model = options.model?.(personId) ?? null;
            const list = (await candidates(id)).map(candidateOf);
            const files = row.counts.files, truncated = row.counts.truncated;
            // 以前导入过的（别的导入里指纹相同的条目）：照搬当时的分类，不再送模型；去重时记为重复，不再导入一次。
            const prior = (await pool.query(`SELECT * FROM memory_import_candidates WHERE person_id = $1 AND import_id <> $2 AND category IS NOT NULL ORDER BY created_at, position`,
                [personId, id])).rows as CandidateRow[];
            const seen = new Map<string, CandidateRow>();
            for (const candidate of prior) if (!seen.has(candidate.fingerprint)) seen.set(candidate.fingerprint, candidate);
            if (row.steps.find(item => item.id === 'classify')?.status !== 'done') {
                await step(row, 'classify', 'active', list.length ? `0/${list.length}` : undefined);
                for (const candidate of list) {
                    const earlier = candidate.category === null ? seen.get(candidate.fingerprint) : undefined;
                    if (earlier) Object.assign(candidate, { category: earlier.category, kind: earlier.kind, dropReason: earlier.drop_reason, confidence: earlier.confidence,
                        alternative: earlier.alternative, locked: earlier.locked, title: earlier.title });
                }
                if (list.some(candidate => candidate.category === null)) {
                    if (!model) throw fault('MEMORY_IMPORT_MODEL_UNAVAILABLE');
                    let lastWrite = 0;
                    await classifyCandidates(list, model, (done, total) => {
                        // 进度最多一秒写一次。
                        if (Date.now() - lastWrite < 1000 && done < total) return;
                        lastWrite = Date.now();
                        void step(row, 'classify', 'active', `${done}/${total}`).catch(() => undefined);
                    });
                }
                await save(list);
                const summary = countsOf(list, files, truncated);
                await step(row, 'classify', 'done', `偏好 ${summary.personal} · 公司 ${summary.company} · 项目 ${summary.project} · 不导入 ${summary.dropped}`, { counts: summary });
            }
            current = 'reconcile';
            await step(row, 'reconcile', 'active');
            const existing = (await personalMemory.list(personId, { status: 'active' })).map(({ id: memoryId, kind, title, text, createdAt }) => ({ id: memoryId, kind, title, text, createdAt }));
            if (list.some(candidate => candidate.category === 'personal_preference' && !seen.has(candidate.fingerprint)) && !model) throw fault('MEMORY_IMPORT_MODEL_UNAVAILABLE');
            await reconcileCandidates(list, existing, model ?? NO_MODEL, new Map([...seen].map(([print, earlier]) => [print, earlier.id])));
            decide(list);
            await save(list);
            const counts = countsOf(list, files, truncated);
            await step(row, 'reconcile', 'done', `重复 ${counts.duplicates} · 冲突 ${counts.conflicts}`, { counts });
            current = 'confirm';
            await step(row, 'confirm', 'active', String(counts.review), { status: 'awaiting_review', counts });
        } catch (error) {
            const code = (error as { code?: string }).code ?? 'MEMORY_IMPORT_FAILED';
            logEvent({ event: 'memory_import.failed', importId: id, step: current, errorCode: code });
            await step(row, current, 'stopped', undefined, { status: 'failed', errorCode: code }).catch(() => undefined);
        }
    }
    function start(personId: string, id: string): Promise<void> {
        const job = process(personId, id).finally(() => running.delete(id));
        running.set(id, job);
        return job;
    }

    async function detail(personId: string, id: string): Promise<TMemoryImportDetail> {
        const row = await load(personId, id);
        if (!row) throw fault('MEMORY_IMPORT_NOT_FOUND');
        const rows = await candidates(id);
        const byId = new Map(rows.map(candidate => [candidate.id, candidate]));
        const memoryIds = rows.flatMap(candidate => (candidate.conflict_memory ? [candidate.conflict_memory] : []));
        const memories = new Map(memoryIds.length ? (await personalMemory.list(personId, { status: 'all' })).filter(item => memoryIds.includes(item.id)).map(item => [item.id, item]) : []);
        return {
            ...view(row),
            candidates: rows.map((candidate): TMemoryImportCandidate => {
                const memory = candidate.conflict_memory ? memories.get(candidate.conflict_memory) : undefined;
                const partner = candidate.conflict_candidate ? byId.get(candidate.conflict_candidate) : undefined;
                return {
                    id: candidate.id, title: candidate.title, text: candidate.text, source: candidate.source, path: candidate.path, category: candidate.category, kind: candidate.kind,
                    dropReason: candidate.drop_reason, confidence: candidate.confidence, group: candidate.grp, checked: candidate.checked, locked: candidate.locked,
                    conflict: memory ? { memoryId: memory.id, title: memory.title, text: memory.text, at: memory.createdAt }
                        : partner ? { candidateId: partner.id, title: partner.title, text: partner.text, at: partner.mtime.toISOString() } : null,
                    resolution: candidate.resolution, memoryItemId: candidate.memory_item_id,
                };
            }),
        };
    }

    return {
        /** 收到导入：读取、拆分（原文不落库），建好五步，后台接着分类。via=collector 是采集器令牌上报的。 */
        async create(personId: string, via: 'session' | 'collector', input: TCreateMemoryImportRequest): Promise<TMemoryImport> {
            const docs = await readFiles(input.source, input.files);
            const { candidates: list, truncated } = splitDocs(docs);
            const keyOf = new Map(list.map(candidate => [candidate.key, randomUUID()]));
            const id = randomUUID();
            const counts = countsOf(list, input.files.length, truncated);
            const steps: TurnStep[] = STEP_LABELS.map(([stepId, label]) => ({ id: stepId, label, status: 'pending' }));
            steps[0] = { ...steps[0], status: 'done', result: `${input.files.length} 个文件` };
            steps[1] = { ...steps[1], status: 'done', result: `${list.length} 条${truncated ? ' · 未完' : ''}` };
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(`INSERT INTO memory_imports (id, person_id, source, via, steps, counts, files) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
                    [id, personId, input.source, via, JSON.stringify(steps), JSON.stringify(counts),
                        JSON.stringify(input.files.map(file => ({ path: file.path, sha256: file.sha256.toLowerCase(), mtime: file.mtime, bytes: Buffer.byteLength(file.content) })))]);
                for (const [position, candidate] of list.entries()) {
                    await client.query(`INSERT INTO memory_import_candidates (id, import_id, person_id, position, source, path, locator, section, project, title, text, mtime, hints, fingerprint,
                        category, drop_reason, confidence, locked) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18)`,
                        [keyOf.get(candidate.key), id, personId, position, candidate.source, candidate.path, candidate.locator, candidate.section ?? null, candidate.project ?? null,
                            candidate.title, candidate.text, candidate.mtime, JSON.stringify(candidate.hints), candidate.fingerprint, candidate.category, candidate.dropReason, candidate.confidence, candidate.locked]);
                }
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally { client.release(); }
            for (const [stepId, status] of [['read', 'done'], ['split', 'done']] as const) logEvent({ event: 'memory_import.step', importId: id, step: stepId, status });
            void start(personId, id);
            const row = await load(personId, id);
            return view(row!);
        },
        async list(personId: string): Promise<TMemoryImport[]> {
            return ((await pool.query(`SELECT * FROM memory_imports WHERE person_id = $1 ORDER BY created_at DESC LIMIT 20`, [personId])).rows as ImportRow[]).map(view);
        },
        detail,
        /** 停住的导入从停住那一步接着做。 */
        async retry(personId: string, id: string): Promise<TMemoryImport> {
            const row = await load(personId, id);
            if (!row) throw fault('MEMORY_IMPORT_NOT_FOUND');
            if (row.status !== 'failed') throw fault('MEMORY_IMPORT_NOT_FAILED');
            const stopped = row.steps.find(item => item.status === 'stopped');
            row.status = 'processing';
            if (stopped) await step(row, stopped.id, 'pending', undefined, { status: 'processing' });
            void start(personId, id);
            return view((await load(personId, id))!);
        },
        /** 本人确认：勾选的写进个人记忆，冲突按选择处理；整次在一个事务里。 */
        async confirm(personId: string, id: string, input: TConfirmMemoryImportRequest): Promise<TMemoryImport> {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const row = ((await client.query(`SELECT * FROM memory_imports WHERE person_id = $1 AND id::text = $2 FOR UPDATE`, [personId, id])).rows[0] as ImportRow | undefined);
                if (!row) throw fault('MEMORY_IMPORT_NOT_FOUND');
                if (row.status !== 'awaiting_review') throw fault('MEMORY_IMPORT_NOT_READY');
                const list = await candidates(row.id, client);
                const byId = new Map(list.map(candidate => [candidate.id, candidate]));
                const checked = new Set(input.checked);
                const choices = new Map(input.resolutions.map(item => [item.id, item.choice]));
                const outcome = new Map<string, { checked: boolean; resolution?: TMemoryImportCandidate['resolution']; memoryItemId?: string }>();
                const value = (candidate: CandidateRow) => ({
                    kind: candidate.kind ?? 'preference', title: candidate.title, text: candidate.text,
                    references: [{ ref: `import:${candidate.source}:${row.id}:${candidate.id}`, quote: candidate.text.slice(0, QUOTE_CHARS), at: candidate.mtime.toISOString() }],
                });
                const add = async (candidate: CandidateRow, resolution?: TMemoryImportCandidate['resolution']) => {
                    const saved = await personalMemory.add(personId, value(candidate), client);
                    outcome.set(candidate.id, { checked: true, memoryItemId: saved.id, ...(resolution ? { resolution } : {}) });
                };
                for (const candidate of list) {
                    if (candidate.locked || candidate.grp === 'partner') continue;
                    if (candidate.grp === 'conflict') {
                        const choice = choices.get(candidate.id) ?? 'keep_old';
                        const partner = candidate.conflict_candidate ? byId.get(candidate.conflict_candidate) : undefined;
                        if (partner) {
                            if (choice === 'keep_old') await add(partner);
                            if (choice === 'use_new') await add(candidate, choice);
                            else outcome.set(candidate.id, { checked: false, resolution: choice });
                        } else if (candidate.conflict_memory) {
                            if (choice === 'use_new') {
                                const saved = await personalMemory.supersede(personId, candidate.conflict_memory, value(candidate), client)
                                    .catch(async error => { if ((error as { code?: string }).code !== 'PERSONAL_ITEM_NOT_ACTIVE') throw error; return personalMemory.add(personId, value(candidate), client); });
                                outcome.set(candidate.id, { checked: true, resolution: choice, memoryItemId: saved.id });
                            } else {
                                if (choice === 'neither') await personalMemory.forget(personId, candidate.conflict_memory, client).catch(() => undefined);
                                outcome.set(candidate.id, { checked: false, resolution: choice });
                            }
                        } else if (choice === 'use_new') await add(candidate, choice);
                        continue;
                    }
                    if (checked.has(candidate.id)) await add(candidate);
                    else outcome.set(candidate.id, { checked: false });
                }
                for (const [candidateId, result] of outcome) {
                    await client.query(`UPDATE memory_import_candidates SET checked = $2, resolution = COALESCE($3, resolution), memory_item_id = $4 WHERE id = $1`,
                        [candidateId, result.checked, result.resolution ?? null, result.memoryItemId ?? null]);
                }
                const imported = [...outcome.values()].filter(result => result.memoryItemId).length;
                row.steps = row.steps.map(item => (item.id === 'confirm' ? { id: item.id, label: item.label, status: 'done', result: `导入 ${imported}` } : item));
                const counts = { ...EMPTY_COUNTS, ...row.counts, imported };
                const saved = (await client.query(`UPDATE memory_imports SET status = 'confirmed', steps = $2::jsonb, counts = $3::jsonb, confirmed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
                    [row.id, JSON.stringify(row.steps), JSON.stringify(counts)])).rows[0] as ImportRow;
                await client.query('COMMIT');
                logEvent({ event: 'memory_import.step', importId: row.id, step: 'confirm', status: 'done', imported });
                return view(saved);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally { client.release(); }
        },
        /** 丢弃本次导入（确认前）：候选一起删掉。 */
        async discard(personId: string, id: string): Promise<void> {
            const row = await load(personId, id);
            if (!row) throw fault('MEMORY_IMPORT_NOT_FOUND');
            if (row.status === 'confirmed') throw fault('MEMORY_IMPORT_CONFIRMED');
            await running.get(id)?.catch(() => undefined);
            await pool.query(`DELETE FROM memory_imports WHERE id = $1`, [id]);
        },
    };
}
