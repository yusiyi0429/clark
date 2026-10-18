// 各选取方案。每个方案：select(query, pool, options) → { ids（按相关程度排好）, ms, usage?, calls? }
// pool 里含偏好类常驻条目；除方案 a 照现状处理外，其余方案只在非偏好条目里挑。
import { complete, parseJson } from './llm.mjs';
import { CORE } from './dataset.mjs';
import { embed, itemVectors, cosine } from './embed.mjs';

const nonCore = (pool) => pool.filter((item) => !CORE.has(item.id));
const KIND_LABEL = { idea: '想法', stance: '立场', open_question: '未决问题', reason: '理由', preference: '偏好', practice: '做法' };
const day = (iso) => iso.slice(0, 10);

// ———————————————— a. 现状：字面重合（照抄 apps/api/src/personalMemory.ts 的 select）
function grams(text) {
  const terms = Array.from(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    for (let index = 0; index < run.length - 1; index++) terms.push(run.slice(index, index + 2));
    if (run.length === 1) terms.push(run);
  }
  return new Set(terms);
}
const FAKE_UUID = '00000000-0000-4000-8000-000000000000';
export function lexicalCurrent(query, pool) {
  const started = performance.now();
  const terms = grams(query.text);
  let bytes = 0;
  const ranked = pool.map((entry) => {
    const score = [...grams(`${entry.title} ${entry.text}`)].filter((term) => terms.has(term)).length;
    return { entry, score, stable: entry.kind === 'preference' || entry.kind === 'practice' || /协作|沟通|表达|偏好/.test(entry.title) };
  }).filter((row) => row.score > 0 || row.stable).sort((left, right) => right.score - left.score);
  const selected = [];
  for (const { entry } of ranked) {
    const size = Buffer.byteLength(JSON.stringify({ id: FAKE_UUID, kind: entry.kind, title: entry.title, text: entry.text, createdAt: entry.createdAt, anchors: entry.anchors }));
    if (bytes + size > 8192) continue;
    bytes += size;
    selected.push(entry.id);
  }
  return { ids: selected, ms: performance.now() - started };
}

// ———————————————— BM25（二字词 + 英文词），给混合方案做字面召回
function tokens(text) {
  const terms = Array.from(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    for (let index = 0; index < run.length - 1; index++) terms.push(run.slice(index, index + 2));
    if (run.length === 1) terms.push(run);
  }
  return terms;
}
export function bm25(query, pool, k = 30) {
  const docs = nonCore(pool).map((item) => ({ item, terms: tokens(`${item.title} ${item.text}`) }));
  const avg = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / Math.max(1, docs.length);
  const df = new Map();
  for (const doc of docs) for (const term of new Set(doc.terms)) df.set(term, (df.get(term) ?? 0) + 1);
  const queryTerms = [...new Set(tokens(query.text))];
  return docs.map((doc) => {
    const tf = new Map();
    for (const term of doc.terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * doc.terms.length / avg));
    }
    return { id: doc.item.id, score };
  }).filter((row) => row.score > 0).sort((left, right) => right.score - left.score).slice(0, k);
}

// ———————————————— d. 向量检索（本地 bge 模型）
const queryVectorCache = new Map();
export async function vectorRank(model, query, pool) {
  const items = nonCore(pool);
  const vectors = await itemVectors(model, items);
  const key = `${model}:${query.text}`;
  const started = performance.now();
  const [vector] = queryVectorCache.get(key) ?? await embed(model, [query.text], { query: true });
  queryVectorCache.set(key, [vector]);
  const embedMs = performance.now() - started;
  const ranked = items.map((item) => ({ id: item.id, score: cosine(vector, vectors.get(item.id)) })).sort((left, right) => right.score - left.score);
  return { ranked, ms: performance.now() - started, embedMs };
}
export async function vectorSelect(model, query, pool, { k = 8, threshold = -1 } = {}) {
  const { ranked, ms } = await vectorRank(model, query, pool);
  return { ids: ranked.filter((row) => row.score >= threshold).slice(0, k).map((row) => row.id), ranked: ranked.slice(0, 30), ms };
}

// ———————————————— b. 轻模型从目录里挑
export const PICK_PROMPT = `你替一位用户从他的个人记忆里挑出这一轮回答用得上的条目，交给主助手参考。每条记忆是他自己以前说过的想法、立场、还没定的问题、理由或做法。
挑选规则：
- 直接相关的要选；问题没明说、但他的这些想法会影响怎么回答的也要选（比如问要不要加人，他关于人效、预算、现金的立场也算）。
- 问题只提了上位概念（比如「渠道」「组织」「明年」）时，选这个范围里最核心的几条。
- 他在问自己以前说过的某句话时，把那条找出来，措辞不同也要认得出。
- 同一件事前后说法不同时，较新的那条一定要选，旧的可以一起选。
- 和他个人想法无关的问题（常识、翻译、计算、写诗、闲聊、外部新闻等）返回空数组，不要硬凑。
最多 {{MAX}} 条，最相关的在前。只输出 JSON：{"ids":["M3","M17"]}`;

function directoryLines(items, mode) {
  return items.map((item, index) => {
    const head = `M${index + 1}｜${day(item.createdAt)}｜${KIND_LABEL[item.kind]}｜${item.title}`;
    if (mode === 'title') return head;
    if (mode === 'full') return `${head}：${item.text}`;
    return `${head}：${item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text}`;
  }).join('\n');
}

async function pickFrom(items, query, { model, mode = 'snippet', max = 8, intro = '个人记忆目录（编号｜日期｜类别｜标题：内容）：' }) {
  const instructions = `${PICK_PROMPT.replace('{{MAX}}', String(max))}\n\n${intro}\n${directoryLines(items, mode)}`;
  const result = await complete({ model, instructions, input: `今天是 2026-10-16。本轮问题：${query.text}`, maxOutputTokens: /^claude-/.test(model) ? 2000 : 200 });
  const parsed = parseJson(result.text);
  const handles = Array.isArray(parsed?.ids) ? parsed.ids : [];
  const ids = [...new Set(handles.map((handle) => items[Number(String(handle).replace(/^M/i, '')) - 1]?.id).filter(Boolean))].slice(0, max);
  return { ids, ms: result.ms, usage: result.usage, raw: parsed ? undefined : result.text.slice(0, 200) };
}

export async function llmIndexSelect(query, pool, { model, mode = 'snippet', max = 8 }) {
  return { ...(await pickFrom(nonCore(pool), query, { model, mode, max })), calls: 1 };
}

// ———————————————— c. 分层目录：先挑主题，再在主题里挑条目（Claude Code 的「索引 → 按需展开」）
const GROUP_PROMPT = `你替一位用户从他的个人记忆里找这一轮回答用得上的内容。记忆按主题分了组，下面是主题目录（每组：编号、主题、条数、几条标题示例）。
挑出可能装着有用记忆的组，最多 4 组：直接相关的、问题没明说但会影响回答的（比如问要不要加人，预算、现金相关的组也算）都要考虑。
和他个人想法无关的问题（常识、翻译、计算、写诗、闲聊、外部新闻等）返回空数组。只输出 JSON：{"groups":["G2","G7"]}`;
export async function hierarchicalSelect(query, pool, { model }) {
  const items = nonCore(pool);
  const groups = new Map();
  for (const item of items) {
    const name = item.anchors[0]?.target.replace(/^topic:/, '') ?? '其他';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  const list = [...groups.entries()];
  const directory = list.map(([name, members], index) => `G${index + 1}｜${name}（${members.length} 条）：${members.slice(0, 4).map((item) => item.title).join('；')}${members.length > 4 ? '…' : ''}`).join('\n');
  const first = await complete({ model, instructions: `${GROUP_PROMPT}\n\n主题目录：\n${directory}`, input: `今天是 2026-10-16。本轮问题：${query.text}`, maxOutputTokens: /^claude-/.test(model) ? 2000 : 120 });
  const picked = (parseJson(first.text)?.groups ?? []).map((handle) => list[Number(String(handle).replace(/^G/i, '')) - 1]).filter(Boolean).slice(0, 4);
  const usage = { ...first.usage };
  if (!picked.length) return { ids: [], ms: first.ms, usage, calls: 1 };
  const members = picked.flatMap(([, entries]) => entries);
  const second = await pickFrom(members, query, { model, mode: 'full', intro: '这几个主题下的个人记忆（编号｜日期｜类别｜标题：内容）：' });
  return { ids: second.ids, ms: first.ms + second.ms, usage: { input: usage.input + second.usage.input, cached: usage.cached + second.usage.cached, output: usage.output + second.usage.output }, calls: 2 };
}

// ———————————————— e. 混合：向量 / 字面召回候选，再交给轻模型挑
export async function hybridSelect(query, pool, { model, vector = 'bge-m3', vectorK = 20, lexicalK = 10 }) {
  const started = performance.now();
  const byId = new Map(pool.map((item) => [item.id, item]));
  const candidates = [];
  let recallMs = 0;
  if (vector) {
    const { ranked, ms } = await vectorRank(vector, query, pool);
    recallMs += ms;
    candidates.push(...ranked.slice(0, vectorK).map((row) => row.id));
  }
  if (lexicalK) {
    const lexicalStarted = performance.now();
    candidates.push(...bm25(query, pool, lexicalK).map((row) => row.id));
    recallMs += performance.now() - lexicalStarted;
  }
  const unique = [...new Set(candidates)].map((id) => byId.get(id));
  // 候选按时间排，避免模型偏向位置靠前的
  unique.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const picked = await pickFrom(unique, query, { model, mode: 'full', intro: '和这一轮可能相关的个人记忆（编号｜日期｜类别｜标题：内容）：' });
  return { ids: picked.ids, ms: performance.now() - started, recallMs, usage: picked.usage, calls: 1, candidates: unique.map((item) => item.id) };
}
