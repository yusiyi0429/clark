// 汇总指标：node score.mjs [文件名过滤...]
// 每次运行分别算，再对多次运行取平均（括号里是最小–最大）。偏好类常驻条目不计入任何指标。
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { QUERIES, CORE, BY_ID } from './dataset.mjs';

const QUERY = new Map(QUERIES.map((query) => [query.id, query]));
const filters = process.argv.slice(2);
const dir = new URL('./results/', import.meta.url);
const files = readdirSync(dir).filter((file) => file.endsWith('.jsonl') && (!filters.length || filters.some((filter) => file.includes(filter))));

/** 粗估 token：中日韩字符 1 个算 1，其他字符 3.5 个算 1。 */
export const estimateTokens = (text) => { const cjk = (text.match(/[一-鿿　-〿＀-￯]/g) ?? []).length; return Math.round(cjk + (text.length - cjk) / 3.5); };
const injected = (ids) => ids.reduce((sum, id) => { const item = BY_ID.get(id); return sum + (item ? estimateTokens(JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', title: item.title, text: item.text, createdAt: item.createdAt })) : 0); }, 0);
const pct = (values, p) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

export function scoreRows(rows) {
  const recall = [], recall5 = [], precision = [], byType = { 1: [], 2: [], 3: [], 4: [] };
  let distractors = 0, distractorHits = 0, distractorItems = 0, emptyOnRelevant = 0, relevant = 0, staleCases = 0, staleHits = 0, staleAnyPick = 0;
  const latency = [], inTokens = [], outTokens = [], cached = [], injectedTokens = [], sizes = [];
  for (const row of rows) {
    const query = QUERY.get(row.qid);
    const ids = row.ids.filter((id) => !CORE.has(id));
    latency.push(row.ms);
    if (row.usage) { inTokens.push(row.usage.input); outTokens.push(row.usage.output); cached.push(row.usage.cached ?? 0); }
    injectedTokens.push(injected(ids));
    sizes.push(ids.length);
    if (query.type === 5) {
      distractors++;
      if (ids.length) distractorHits++;
      distractorItems += ids.length;
      continue;
    }
    relevant++;
    if (!ids.length) emptyOnRelevant++;
    const gold = new Set(query.gold);
    const ok = new Set([...query.gold, ...(query.related ?? []), ...Object.keys(query.stale ?? {}), ...Object.values(query.stale ?? {})]);
    const hit = ids.filter((id) => gold.has(id)).length;
    const r = hit / gold.size;
    recall.push(r);
    byType[query.type].push(r);
    recall5.push(ids.slice(0, 5).filter((id) => gold.has(id)).length / Math.min(5, gold.size));
    if (ids.length) precision.push(ids.filter((id) => ok.has(id)).length / ids.length);
    for (const [old, current] of Object.entries(query.stale ?? {})) {
      staleCases++;
      if (ids.includes(old)) staleAnyPick++;
      if (ids.includes(old) && !ids.includes(current)) staleHits++;
    }
  }
  return {
    recall: mean(recall), recall5: mean(recall5), precision: mean(precision),
    t1: mean(byType[1]), t2: mean(byType[2]), t3: mean(byType[3]), t4: mean(byType[4]),
    fullHit: recall.filter((value) => value === 1).length / Math.max(1, recall.length),
    emptyOnRelevant: emptyOnRelevant / Math.max(1, relevant),
    distractorFp: distractorHits / Math.max(1, distractors), distractorItems: distractorItems / Math.max(1, distractors),
    staleAsCurrent: staleHits, staleCases, staleAnyPick,
    p50: pct(latency, 0.5), p90: pct(latency, 0.9),
    inTok: inTokens.length ? mean(inTokens) : 0, cachedTok: cached.length ? mean(cached) : 0, outTok: outTokens.length ? mean(outTokens) : 0,
    injTok: mean(injectedTokens), size: mean(sizes),
  };
}

export function loadRuns(file) {
  const rows = readFileSync(new URL(file, dir), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const runs = new Map();
  for (const row of rows) { if (!runs.has(row.run)) runs.set(row.run, []); runs.get(row.run).push(row); }
  return [...runs.values()];
}

export function printTable() {
const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '-');
const KEYS = ['recall', 'recall5', 't1', 't2', 't3', 't4', 'fullHit', 'precision', 'distractorFp', 'staleAsCurrent', 'p50', 'p90', 'inTok', 'cachedTok', 'outTok', 'injTok', 'size'];
const header = ['config@n', 'runs', 'q', ...KEYS];
console.log(header.join('\t'));
for (const file of files.sort()) {
  const runs = loadRuns(file).filter((run) => run.length >= QUERIES.length * 0.9);
  if (!runs.length) continue;
  const scores = runs.map(scoreRows);
  const cells = KEYS.map((key) => {
    const values = scores.map((score) => score[key]);
    const avg = mean(values);
    const digits = ['p50', 'p90', 'inTok', 'cachedTok', 'outTok', 'injTok'].includes(key) ? 0 : key === 'size' || key === 'staleAsCurrent' ? 1 : 2;
    return runs.length > 1 && Math.max(...values) - Math.min(...values) > 0.015 && digits === 2 ? `${fmt(avg, digits)}(${fmt(Math.min(...values), digits)}-${fmt(Math.max(...values), digits)})` : fmt(avg, digits);
  });
  console.log([file.replace('.jsonl', ''), runs.length, runs[0].length, ...cells].join('\t'));
}
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) printTable();
