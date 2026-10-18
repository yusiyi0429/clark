import { createHash } from 'node:crypto';
import JSZip from 'jszip';

/**
 * 记忆导入（上手第五步、「我的记忆」页的导入，7a-3、D-06）的纯逻辑：读取 → 按规则拆分 → （模型）分四类 → （模型）去重、找冲突 → 定默认勾选和要本人看的。
 * 这里不碰数据库和模型：模型调用在 memoryImportAgent.ts，持久化与步骤在 memoryImports.ts。H12 评测（scripts/memory-import-eval.ts）直接调这里的函数。
 *
 * 四类：personal_preference（个人偏好，进个人记忆）、company_fact（公司事实，不进个人记忆）、project_instruction（只对某个项目有效，不导入）、
 * drop（不导入：过期进度、一次性、私人生活、密钥、别人的信息、针对导入方的指令）。
 */
export const IMPORT_SOURCES = ['chatgpt', 'claude', 'claude_code', 'codex'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const CATEGORIES = ['personal_preference', 'company_fact', 'project_instruction', 'drop'] as const;
export type Category = (typeof CATEGORIES)[number];
export const DROP_REASONS = ['stale_state', 'one_off', 'private_life', 'secret', 'other_person', 'injection'] as const;
export type DropReason = (typeof DROP_REASONS)[number];
export type ImportKind = 'preference' | 'practice';
/** 确认页的分组：conflict / uncertain 是要本人看的两组；partner 是同批冲突里较早的那条（跟着冲突那条一起定）。 */
export const GROUPS = ['conflict', 'uncertain', 'import', 'company', 'project', 'duplicate', 'dropped', 'skipped', 'partner'] as const;
export type Group = (typeof GROUPS)[number];

/** 默认勾选：分到个人偏好且把握 ≥ 这个值（H12 在开发集上标定，见 .scratch/memory-page-import/评测.md）。 */
export const DEFAULT_CHECK_THRESHOLD = 0.85;
/** 个人偏好把握在 [REVIEW_FLOOR, DEFAULT_CHECK_THRESHOLD) 的请本人看；更低的不导入、不打扰。 */
export const REVIEW_FLOOR = 0.6;
/** 要本人看的上限：本批的 15%，最多 15 条；超出的不导入（之后能在导入记录里补勾）。 */
export const REVIEW_SHARE = 0.15;
export const REVIEW_MAX = 15;
/** 只在过往对话里出现过的（提示词输出的来源字段），把握再高也只算中：不默认勾选。 */
const HEARSAY_CAP = 0.8;
const LOW_CAP = 0.55;

export const MAX_FILES = 200;
export const MAX_FILE_CHARS = 512 * 1024;
export const MAX_TOTAL_CHARS = 2 * 1024 * 1024;
export const MAX_ITEMS = 600;
const MAX_ITEM_CHARS = 2000;

export type ImportFileInput = { path: string; content: string; sha256: string; mtime: string; encoding?: 'base64' };
export type ReadDoc = { source: ImportSource; path: string; text: string; mtime: string; scope?: 'project' };
export type Hints = {
    /** Claude Code 记忆 frontmatter 里的 type（user / feedback / project / reference）。 */
    memoryType?: string;
    /** 提示词输出的五个字段。 */
    promptCategory?: string;
    promptSource?: string;
    promptTime?: string;
    promptConfidence?: string;
    /** 文件的性质：auto_memory（AI 自己记的）、instructions（CLAUDE.md / AGENTS.md）、prompt_output、export、paste。 */
    fileKind: 'auto_memory' | 'instructions' | 'prompt_output' | 'export' | 'paste';
    /** 写在全局说明（~/.claude/CLAUDE.md、~/.codex/AGENTS.md）里的。 */
    global?: boolean;
};
export type Candidate = {
    key: string;
    source: ImportSource;
    path: string;
    locator: string;
    section?: string;
    project?: string;
    text: string;
    title: string;
    mtime: string;
    hints: Hints;
    fingerprint: string;
    category: Category | null;
    kind: ImportKind | null;
    dropReason: DropReason | null;
    confidence: number | null;
    alternative: Category | null;
    /** 被规则拦下的（密钥、注入）：不送模型，不能手动勾回。 */
    locked: boolean;
    duplicateOf: { memoryId?: string; key?: string } | null;
    conflictWith: { memoryId?: string; key?: string } | null;
    group: Group | null;
    checked: boolean;
};
export type ExistingMemory = { id: string; kind: string; title: string; text: string; createdAt: string };

const fault = (code: string, message?: string) => Object.assign(new Error(message ?? code), { code });
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** 指纹：去掉空白和标点、统一大小写与全半角后的 sha256。同一份 CLAUDE.md 在几个 worktree 里的副本、重复导入，都靠它认出来。 */
export function fingerprint(text: string): string {
    return sha256(text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')).slice(0, 32);
}

// ── 读取 ────────────────────────────────────────────────────────────────────

/** Claude 导出包里和记忆有关的文件：memories/*.json（7 月叫 memories.json）和 projects/*.json（只取项目指令）。聊天记录读完就丢。 */
const EXPORT_MEMORY = /(^|\/)memories(\/[^/]+)?\.json$/i;
const EXPORT_PROJECT = /(^|\/)projects\/[^/]+\.json$/i;
const TEXT_FILE = /\.(md|markdown|txt|json|toml|rules)$/i;

function exportDocs(source: ImportSource, path: string, json: string, mtime: string): ReadDoc[] {
    let value: unknown;
    try { value = JSON.parse(json); } catch { return [{ source, path, text: json, mtime }]; }
    const docs: ReadDoc[] = [];
    const add = (suffix: string, text: unknown, scope?: 'project') => {
        if (typeof text === 'string' && text.trim()) docs.push({ source, path: `${path}#${suffix}`, text, mtime, ...(scope ? { scope } : {}) });
    };
    const visit = (entry: unknown) => {
        if (!entry || typeof entry !== 'object') return;
        const record = entry as Record<string, unknown>;
        add('conversations_memory', record.conversations_memory);
        if (record.project_memories && typeof record.project_memories === 'object') {
            for (const [id, text] of Object.entries(record.project_memories as Record<string, unknown>)) add(`project_memories/${id}`, text, 'project');
        }
        if (Array.isArray(record.memory_files)) {
            for (const file of record.memory_files as { path?: unknown; content?: unknown }[]) {
                const filePath = typeof file?.path === 'string' ? file.path : 'memory_file';
                add(`memory_files/${filePath}`, file?.content, /^projects\//.test(filePath) ? 'project' : undefined);
            }
        }
        if (typeof record.prompt_template === 'string') add(`prompt_template${typeof record.name === 'string' ? `/${record.name}` : ''}`, record.prompt_template, 'project');
    };
    if (Array.isArray(value)) value.forEach(visit); else visit(value);
    return docs;
}

/** 校验每个文件的 sha256，解开 base64 的 zip、Claude 导出的 json；超出上限报 IMPORT_TOO_LARGE。 */
export async function readFiles(source: ImportSource, files: ImportFileInput[]): Promise<ReadDoc[]> {
    if (files.length > MAX_FILES) throw fault('IMPORT_TOO_LARGE');
    const docs: ReadDoc[] = [];
    for (const file of files) {
        const bytes = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
        if (sha256(bytes) !== file.sha256.toLowerCase()) throw fault('IMPORT_HASH_MISMATCH', file.path);
        const zip = /\.zip$/i.test(file.path) || file.encoding === 'base64' ? await JSZip.loadAsync(bytes).catch(() => null) : null;
        if (/\.zip$/i.test(file.path) && !zip) throw fault('IMPORT_UNREADABLE', file.path);
        if (zip) {
            // 大账号拆成几个 batch 包，包里还可能套包：只认记忆和项目文件。
            for (const entry of Object.values(zip.files)) {
                if (entry.dir) continue;
                if (EXPORT_MEMORY.test(entry.name) || EXPORT_PROJECT.test(entry.name)) docs.push(...exportDocs(source, `${file.path}!${entry.name}`, await entry.async('string'), file.mtime));
                else if (/\.zip$/i.test(entry.name)) {
                    const inner = await entry.async('nodebuffer');
                    docs.push(...await readFiles(source, [{ path: `${file.path}!${entry.name}`, content: inner.toString('base64'), sha256: sha256(inner), mtime: file.mtime, encoding: 'base64' }]));
                }
            }
            continue;
        }
        if (!TEXT_FILE.test(file.path) && /\.[a-z0-9]{1,6}$/i.test(file.path)) continue;
        const text = file.encoding === 'base64' ? bytes.toString('utf8') : file.content;
        if (text.length > MAX_FILE_CHARS) throw fault('IMPORT_TOO_LARGE', file.path);
        if (/\.json$/i.test(file.path)) docs.push(...exportDocs(source, file.path, text, file.mtime));
        else docs.push({ source, path: file.path, text, mtime: file.mtime });
    }
    if (docs.reduce((sum, doc) => sum + doc.text.length, 0) > MAX_TOTAL_CHARS) throw fault('IMPORT_TOO_LARGE');
    return docs;
}

// ── 拆分 ────────────────────────────────────────────────────────────────────

const PROMPT_CATEGORIES = new Set(['规则', '偏好', '身份', '公司', '项目', '其他']);
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)、])\s+(.+?)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

const baseName = (path: string) => path.split(/[\\/!#]/).filter(Boolean).pop() ?? path;
/** Claude Code 项目记忆目录名（-Users-x-work-repo）、说明文件所在的仓库目录，当作「哪个项目」的线索交给模型。 */
function projectOf(rawPath: string): string | undefined {
    const path = rawPath.replace(/\\/g, '/');
    const memory = /projects\/([^/]+)\/memory\//.exec(path);
    if (memory) return memory[1];
    const parts = path.split('/').filter(Boolean);
    const file = parts.pop();
    if (!file || !/^(CLAUDE|AGENTS)(\.override|\.local)?\.md$/i.test(file)) return undefined;
    const worktree = parts.indexOf('worktrees');
    const dirs = worktree > 0 ? parts.slice(0, worktree) : parts;
    const repo = dirs.filter(dir => !dir.startsWith('.')).pop();
    return repo && !/^(~|home|users)$/i.test(repo) ? repo : undefined;
}
/** 用户级说明（家目录下的 ~/.claude/CLAUDE.md、~/.codex/AGENTS.md），对所有项目生效。 */
const isGlobalInstructions = (path: string) =>
    /^(~|[A-Za-z]:\/Users\/[^/]+|\/Users\/[^/]+|\/home\/[^/]+|\/root)\/\.(claude|codex)\/(CLAUDE|AGENTS)(\.override)?\.md$/i.test(path.replace(/\\/g, '/'));

function frontmatter(text: string): { fields: Record<string, string>; body: string } | null {
    const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!match) return null;
    const fields: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
        const field = /^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
        // type 有时写在顶层，有时在 metadata 下面（本机实际），两种都认；外层同名字段优先。
        if (field && field[2] && !(field[1] in fields)) fields[field[1]] = field[2].replace(/^["']|["']$/g, '');
    }
    return { fields, body: match[2].trim() };
}

type Draft = Omit<Candidate, 'key' | 'fingerprint' | 'category' | 'kind' | 'dropReason' | 'confidence' | 'alternative' | 'locked' | 'duplicateOf' | 'conflictWith' | 'group' | 'checked'>;
const clip = (text: string) => (text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}…` : text);
const shortTitle = (text: string) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > 24 ? `${line.slice(0, 24)}…` : line; };

function splitDoc(doc: ReadDoc): { drafts: Draft[]; truncated: boolean } {
    const base = { source: doc.source, path: doc.path, mtime: doc.mtime, project: doc.scope === 'project' ? baseName(doc.path) : projectOf(doc.path) };
    const name = baseName(doc.path);
    if (/^MEMORY\.md$/i.test(name)) return { drafts: [], truncated: false };
    const front = frontmatter(doc.text);
    if (front) {
        const text = front.body || front.fields.description || '';
        if (!text) return { drafts: [], truncated: false };
        return { drafts: [{ ...base, locator: doc.path, text: clip(text), title: front.fields.name || front.fields.description || shortTitle(text),
            hints: { fileKind: 'auto_memory', ...(front.fields.type ? { memoryType: front.fields.type } : {}) } }], truncated: false };
    }
    const lines = doc.text.split(/\r?\n/);
    // 提示词输出：「类别 | 内容 | 来源 | 时间 | 把握」，代码块后一行写「完整」或「未完」。
    const promptLines = lines.map((line, index) => ({ index, fields: line.split(/\s*[|｜]\s*/).map(field => field.trim()) }))
        .filter(({ fields }) => fields.length >= 5 && PROMPT_CATEGORIES.has(fields[0].replace(/^`+/, '')));
    if (promptLines.length) {
        const truncated = lines.some(line => /^\s*未完/.test(line)) || !lines.some(line => /^\s*完整\s*$/.test(line));
        const drafts = promptLines.filter(({ fields }) => fields[1] && fields[1] !== '无').map(({ index, fields }) => {
            const [category, content, from, time, confidence] = fields;
            return { ...base, locator: `${doc.path}#L${index + 1}`, text: clip(content), title: shortTitle(content),
                hints: { fileKind: 'prompt_output' as const, promptCategory: category.replace(/^`+/, ''), promptSource: from, promptTime: time, promptConfidence: confidence } };
        });
        return { drafts, truncated };
    }
    const fileKind: Hints['fileKind'] = /^(CLAUDE|AGENTS)(\.override|\.local)?\.md$/i.test(name) ? 'instructions' : /#/.test(doc.path) ? 'export' : 'paste';
    const global = fileKind === 'instructions' && isGlobalInstructions(doc.path);
    const headings: string[] = [];
    let fenced = false;
    const units: { index: number; text: string; section?: string; list: boolean }[] = [];
    lines.forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
        if (fenced) return;
        const heading = HEADING.exec(line);
        if (heading) { headings.length = heading[1].length - 1; headings[heading[1].length - 1] = heading[2]; return; }
        const section = headings.filter(Boolean).join(' › ') || undefined;
        const item = LIST_ITEM.exec(line);
        if (item) units.push({ index, text: item[1], section, list: true });
        else if (line.trim()) units.push({ index, text: line.trim(), section, list: false });
    });
    // 有列表的文件只取列表项（标题下的说明段落、「How would you like ChatGPT to respond?」这类提问不是记忆）；没有列表的一行一条。
    const picked = units.some(unit => unit.list) ? units.filter(unit => unit.list) : units;
    return {
        drafts: picked.filter(unit => unit.text.replace(/[\s\p{P}]/gu, '').length >= 2).map(unit => ({ ...base, locator: `${doc.path}#L${unit.index + 1}`, text: clip(unit.text), title: shortTitle(unit.text),
            ...(unit.section ? { section: unit.section } : {}), hints: { fileKind, ...(global ? { global: true } : {}) } })),
        truncated: false,
    };
}

// ── 规则 ────────────────────────────────────────────────────────────────────

/** 密钥、令牌、口令、私钥、内网地址加登录方式：整条不导入，原文不送模型。 */
const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{12,}/, /\blsv2_[A-Za-z0-9_-]{8,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abp]-[A-Za-z0-9-]{10,}/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\btsm_[0-9a-f]{32}_/, /\.pem\b|\bid_(rsa|ed25519)\b/i, /\bssh\s+(-\S+\s+)*[\w.-]+@[\w.-]+/i,
    /(口令|密码|password|passwd|passcode|api[ _-]?key|secret|令牌|token)\s*(?:是|为|[:：=])\s*[`'"]?[A-Za-z0-9_\-+/=.]{4,}/i,
    /(口令|密码)\s*[A-Za-z0-9_-]{4,}/,
    /\b10(?:\.\d{1,3}){3}\b/, /\b192\.168(?:\.\d{1,3}){2}\b/, /\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/,
];
/** 针对导入方的指令：整条不导入，不执行。 */
const INJECTION_PATTERNS = [
    /忽略(之前|以上|上面|前面|先前|所有)的?(规则|指令|要求|设定|说明)/, /\bignore\s+(all\s+|the\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)/i,
    /^\s*(system|assistant)\s*[:：]/i, /(导入|整理|读取)(这些|本|此|下面的?)?(记忆|条目|文件|内容)的\s*(AI|模型|助手|agent)/i,
    /\b(mark|label|classify|import)\s+(every|all)\b.*\b(memor|item|entr)/i, /(全部|所有)(条目|记忆)(都)?(标成|标为|设为|当成).*(高置信|偏好|默认勾选)/,
];
export const looksSecret = (text: string) => SECRET_PATTERNS.some(pattern => pattern.test(text));
export const looksInjection = (text: string) => INJECTION_PATTERNS.some(pattern => pattern.test(text));

/** 拆成单条，套上规则：密钥、注入直接分到不导入并锁住；超过 MAX_ITEMS 的截掉（truncated）。 */
export function splitDocs(docs: ReadDoc[]): { candidates: Candidate[]; truncated: boolean } {
    let truncated = false;
    const drafts: Draft[] = [];
    for (const doc of docs) {
        const result = splitDoc(doc);
        truncated ||= result.truncated;
        drafts.push(...result.drafts);
    }
    if (drafts.length > MAX_ITEMS) { truncated = true; drafts.length = MAX_ITEMS; }
    const candidates = drafts.map((draft, index): Candidate => {
        const secret = looksSecret(draft.text), injection = !secret && looksInjection(draft.text);
        return { ...draft, key: `c${index + 1}`, fingerprint: fingerprint(draft.text),
            ...(secret ? { text: '[已省略：敏感信息]', title: '敏感信息' } : {}),
            category: secret || injection ? 'drop' : null, kind: null, dropReason: secret ? 'secret' : injection ? 'injection' : null,
            confidence: secret || injection ? 1 : null, alternative: null, locked: secret || injection,
            duplicateOf: null, conflictWith: null, group: null, checked: false };
    });
    return { candidates, truncated };
}

// ── 分类（模型） ────────────────────────────────────────────────────────────

export type ClassifyInputItem = { id: string; text: string; source: ImportSource; path: string; section?: string; project?: string; hints: Hints };
export type ClassifyResult = { id: string; category: Category; kind: ImportKind | null; dropReason: DropReason | null; confidence: number; alternative: Category | null; title: string };
export type ReconcileInput = {
    candidates: { id: string; title: string; text: string; project?: string }[];
    existing: { id: string; title: string; text: string }[];
};
export type ReconcileResult = { id: string; duplicateOf: string | null; conflictsWith: string | null };
export type MemoryImportModel = {
    classify(items: ClassifyInputItem[]): Promise<ClassifyResult[]>;
    reconcile(input: ReconcileInput): Promise<ReconcileResult[]>;
};

export const CLASSIFY_BATCH = 20;
const CLASSIFY_CONCURRENCY = 3;

/** 把还没分类的条目分批交给模型（重试时已分好的不重做）；精确重复的条目不送，跟着第一次出现的那条走。onProgress(已分, 总数)。 */
export async function classifyCandidates(candidates: Candidate[], model: MemoryImportModel, onProgress?: (done: number, total: number) => void): Promise<void> {
    const firstByPrint = new Map<string, Candidate>();
    for (const candidate of candidates) if (!firstByPrint.has(candidate.fingerprint)) firstByPrint.set(candidate.fingerprint, candidate);
    const todo = [...firstByPrint.values()].filter(candidate => candidate.category === null);
    const total = candidates.length;
    const settled = () => candidates.filter(candidate => (firstByPrint.get(candidate.fingerprint) ?? candidate).category !== null).length;
    const batches: Candidate[][] = [];
    for (let index = 0; index < todo.length; index += CLASSIFY_BATCH) batches.push(todo.slice(index, index + CLASSIFY_BATCH));
    let next = 0;
    const worker = async () => {
        while (next < batches.length) {
            const batch = batches[next++];
            const results = await model.classify(batch.map(candidate => ({ id: candidate.key, text: candidate.text, source: candidate.source, path: candidate.path,
                ...(candidate.section ? { section: candidate.section } : {}), ...(candidate.project ? { project: candidate.project } : {}), hints: candidate.hints })));
            const byId = new Map(results.map(result => [result.id, result]));
            for (const candidate of batch) {
                const result = byId.get(candidate.key);
                if (!result) throw fault('MEMORY_IMPORT_CLASSIFY_INCOMPLETE');
                candidate.category = result.category;
                // kind 每条都留着：没分到个人偏好的，本人改成导入时也知道它是表达方式还是做法。
                candidate.kind = result.kind ?? 'preference';
                candidate.dropReason = result.category === 'drop' ? (result.dropReason ?? 'stale_state') : null;
                candidate.confidence = Math.max(0, Math.min(1, result.confidence));
                candidate.alternative = result.alternative && result.alternative !== result.category ? result.alternative : null;
                if (result.title.trim()) candidate.title = result.title.trim().slice(0, 60);
                // 模型分出来的密钥、注入也锁住，不能手动勾回。
                candidate.locked = result.category === 'drop' && (result.dropReason === 'secret' || result.dropReason === 'injection');
            }
            onProgress?.(settled(), total);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, batches.length) }, worker));
    for (const candidate of candidates) {
        const first = firstByPrint.get(candidate.fingerprint);
        if (first && first !== candidate && candidate.category === null) {
            Object.assign(candidate, { category: first.category, kind: first.kind, dropReason: first.dropReason, confidence: first.confidence, alternative: first.alternative, locked: first.locked, title: first.title });
        }
    }
}

// ── 去重和冲突 ──────────────────────────────────────────────────────────────

const RECONCILE_BATCH = 40;
const MAX_EXISTING = 400;
const isPersonal = (candidate: Candidate) => candidate.category === 'personal_preference' && !candidate.locked;

/**
 * 先精确：同批里指纹相同的（同一份 CLAUDE.md 的副本）、和已有记忆正文指纹相同的、以前导入过的（seen：指纹 → 以前那条的 id），记为重复。
 * 再交给模型：个人偏好里和已有记忆、同批更早的条目说的是同一件事（换了说法）的记为重复，说法相反的记为冲突。只核对个人偏好（别的类本来就不进个人记忆）。
 */
export async function reconcileCandidates(candidates: Candidate[], existing: ExistingMemory[], model: MemoryImportModel,
    seen: Map<string, string> = new Map()): Promise<void> {
    const firstByPrint = new Map<string, Candidate>();
    const existingByPrint = new Map(existing.map(memory => [fingerprint(memory.text), memory.id]));
    for (const candidate of candidates) {
        candidate.duplicateOf = null;
        candidate.conflictWith = null;
        const first = firstByPrint.get(candidate.fingerprint);
        if (first) candidate.duplicateOf = { key: first.key };
        else if (existingByPrint.has(candidate.fingerprint)) candidate.duplicateOf = { memoryId: existingByPrint.get(candidate.fingerprint)! };
        else if (seen.has(candidate.fingerprint)) candidate.duplicateOf = { key: seen.get(candidate.fingerprint)! };
        if (!first) firstByPrint.set(candidate.fingerprint, candidate);
    }
    const personal = candidates.filter(candidate => isPersonal(candidate) && !candidate.duplicateOf && (candidate.confidence ?? 0) >= REVIEW_FLOOR);
    if (!personal.length) return;
    const directory = [...existing].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-MAX_EXISTING);
    const memoryHandle = new Map(directory.map((memory, index) => [`M${index + 1}`, memory.id]));
    const candidateHandle = new Map(personal.map((candidate, index) => [`N${index + 1}`, candidate]));
    const handleOf = new Map(personal.map((candidate, index) => [candidate.key, `N${index + 1}`]));
    const existingInput = directory.map((memory, index) => ({ id: `M${index + 1}`, title: memory.title, text: memory.text.slice(0, 300) }));
    for (let index = 0; index < personal.length; index += RECONCILE_BATCH) {
        // 每批带上它前面的同批条目，冲突和重复都只指向更早的那条。
        const batch = personal.slice(0, index + RECONCILE_BATCH);
        const results = await model.reconcile({
            candidates: batch.map(candidate => ({ id: handleOf.get(candidate.key)!, title: candidate.title, text: candidate.text.slice(0, 500), ...(candidate.project ? { project: candidate.project } : {}) })),
            existing: existingInput,
        });
        for (const result of results) {
            const candidate = candidateHandle.get(result.id);
            if (!candidate || personal.indexOf(candidate) < index) continue;
            const target = (handle: string | null) => {
                if (!handle) return null;
                if (memoryHandle.has(handle)) return { memoryId: memoryHandle.get(handle)! };
                const other = candidateHandle.get(handle);
                return other && other !== candidate && personal.indexOf(other) < personal.indexOf(candidate) ? { key: other.key } : null;
            };
            candidate.duplicateOf = target(result.duplicateOf);
            if (!candidate.duplicateOf) candidate.conflictWith = target(result.conflictsWith);
        }
    }
}

// ── 默认勾选和要本人看的 ────────────────────────────────────────────────────

/**
 * 来源可信度：只在过往对话里出现过的、提示词自评把握低的，打折；
 * 写在项目级说明文件（项目里的 CLAUDE.md / AGENTS.md、Claude 导出里的项目指令）里的个人偏好，可能只对那个项目成立，
 * 不默认勾选、请本人看（导入设计 4.5「在个人偏好和项目指令之间摇摆的」）。
 */
export function effectiveConfidence(candidate: Candidate): number {
    let confidence = candidate.confidence ?? 0;
    if ((candidate.hints.fileKind === 'instructions' && !candidate.hints.global) || (candidate.hints.fileKind === 'export' && candidate.project)) confidence = Math.min(confidence, HEARSAY_CAP);
    if (candidate.hints.promptConfidence === '低') confidence = Math.min(confidence, LOW_CAP);
    if (candidate.hints.promptSource === '过往对话' || candidate.hints.promptSource === '不确定') confidence = Math.min(confidence, HEARSAY_CAP);
    return confidence;
}

/**
 * 分组与默认勾选（7a-3、导入设计 4.5）：
 * - 只有分到个人偏好、把握 ≥ DEFAULT_CHECK_THRESHOLD、没有冲突、不重复的才默认勾选（import）；
 * - 要本人看的两组：有冲突的（conflict，和已有记忆或同批更早的一条说法相反）、没把握的（uncertain：个人偏好把握中等，或在个人偏好和别的类之间摇摆）；
 *   合计不超过本批的 15%、最多 15 条，冲突优先、表达方式类其次，超出的不导入（skipped）；
 * - 其余：公司事实、项目指令、重复、不导入、把握低的个人偏好（skipped），都不勾。
 */
export function decide(candidates: Candidate[], thresholds: { defaultCheck?: number; reviewFloor?: number } = {}): void {
    const DEFAULT_CHECK = thresholds.defaultCheck ?? DEFAULT_CHECK_THRESHOLD, FLOOR = thresholds.reviewFloor ?? REVIEW_FLOOR;
    const byKey = new Map(candidates.map(candidate => [candidate.key, candidate]));
    const review: Candidate[] = [];
    for (const candidate of candidates) {
        candidate.checked = false;
        const confidence = effectiveConfidence(candidate);
        if (candidate.category === 'drop' || candidate.locked) candidate.group = 'dropped';
        else if (candidate.duplicateOf) candidate.group = 'duplicate';
        else if (candidate.category === 'personal_preference') {
            if (candidate.conflictWith) candidate.group = 'conflict';
            else if (confidence >= DEFAULT_CHECK) candidate.group = 'import';
            else if (confidence >= FLOOR) candidate.group = 'uncertain';
            else candidate.group = 'skipped';
        } else if (candidate.alternative === 'personal_preference' && confidence < DEFAULT_CHECK && confidence >= FLOOR - 0.1) candidate.group = 'uncertain';
        else candidate.group = candidate.category === 'company_fact' ? 'company' : 'project';
        if (candidate.group === 'conflict' || candidate.group === 'uncertain') review.push(candidate);
    }
    // 同批冲突：较早的那条跟着冲突那条一起定，不单独勾。
    for (const candidate of candidates) {
        const partner = candidate.group === 'conflict' && candidate.conflictWith?.key ? byKey.get(candidate.conflictWith.key) : undefined;
        if (partner && partner.group !== 'conflict') {
            if (review.includes(partner)) review.splice(review.indexOf(partner), 1);
            partner.group = 'partner';
        }
    }
    const cap = Math.min(REVIEW_MAX, Math.max(1, Math.floor(candidates.length * REVIEW_SHARE)));
    const rank = (candidate: Candidate) => (candidate.group === 'conflict' ? 0 : 1) * 10 + (candidate.kind === 'preference' ? 0 : 1) - effectiveConfidence(candidate);
    review.sort((left, right) => rank(left) - rank(right));
    for (const extra of review.slice(cap)) {
        if (extra.group === 'conflict' && extra.conflictWith?.key) { const partner = byKey.get(extra.conflictWith.key); if (partner?.group === 'partner') partner.group = 'skipped'; }
        extra.group = 'skipped';
    }
    for (const candidate of candidates) candidate.checked = candidate.group === 'import';
}

export type ImportCounts = {
    files: number; items: number; truncated: boolean;
    personal: number; company: number; project: number; dropped: number;
    duplicates: number; conflicts: number; review: number; checked: number; imported?: number;
};
export function countsOf(candidates: Candidate[], files: number, truncated: boolean): ImportCounts {
    const count = (test: (candidate: Candidate) => boolean) => candidates.filter(test).length;
    return {
        files, items: candidates.length, truncated,
        personal: count(candidate => candidate.category === 'personal_preference'), company: count(candidate => candidate.category === 'company_fact'),
        project: count(candidate => candidate.category === 'project_instruction'), dropped: count(candidate => candidate.category === 'drop'),
        duplicates: count(candidate => candidate.group === 'duplicate'), conflicts: count(candidate => candidate.group === 'conflict'),
        review: count(candidate => candidate.group === 'conflict' || candidate.group === 'uncertain'), checked: count(candidate => candidate.checked),
    };
}
