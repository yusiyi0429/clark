// 第一阶段召回曲线：向量 / BM25 / 二者合并，在前 k 条里能找回多少 gold；以及向量阈值对干扰问题的误召回。
// node recall-curve.mjs [规模]
import { QUERIES, poolFor } from './dataset.mjs';
import { vectorRank, bm25 } from './methods.mjs';

const n = Number(process.argv[2] ?? 300);
const ks = [5, 8, 10, 20, 30, 50, 80];
const relevantQueries = QUERIES.filter((query) => query.type !== 5);
const sums = {};
const add = (name, k, value) => { sums[name] ??= {}; sums[name][k] = (sums[name][k] ?? 0) + value; };
const byType = {};
const scoresFor = { 'bge-small-zh': { rel: [], dis: [] }, 'bge-m3': { rel: [], dis: [] } };
for (const query of QUERIES) {
  const pool = poolFor(query, n);
  const vectors = {};
  for (const model of ['bge-small-zh', 'bge-m3']) {
    const { ranked } = await vectorRank(model, query, pool);
    vectors[model] = ranked.map((row) => row.id);
    if (query.type === 5) scoresFor[model].dis.push(ranked[0].score);
    else scoresFor[model].rel.push(...ranked.filter((row) => query.gold.includes(row.id)).map((row) => row.score));
  }
  if (query.type === 5) continue;
  const lexical = bm25(query, pool, 200).map((row) => row.id);
  const gold = new Set(query.gold);
  for (const k of ks) {
    const hit = (list) => list.slice(0, k).filter((id) => gold.has(id)).length / gold.size;
    add('bge-small', k, hit(vectors['bge-small-zh']));
    add('bge-m3', k, hit(vectors['bge-m3']));
    add('bm25', k, hit(lexical));
    const merged = [...new Set([...vectors['bge-m3'].slice(0, k), ...lexical.slice(0, Math.ceil(k / 2))])];
    add('m3+bm25(k/2)', k, merged.filter((id) => gold.has(id)).length / gold.size);
    byType[`m3 T${query.type}`] ??= {};
    byType[`m3 T${query.type}`][k] = (byType[`m3 T${query.type}`][k] ?? 0) + hit(vectors['bge-m3']) / relevantQueries.filter((item) => item.type === query.type).length;
  }
}
console.log(['first stage', ...ks.map((k) => `@${k}`)].join('\t'));
for (const [name, values] of Object.entries(sums)) console.log([name, ...ks.map((k) => (values[k] / relevantQueries.length).toFixed(2))].join('\t'));
for (const [name, values] of Object.entries(byType)) console.log([name, ...ks.map((k) => values[k].toFixed(2))].join('\t'));
for (const [model, { rel, dis }] of Object.entries(scoresFor)) {
  const quant = (values, p) => [...values].sort((a, b) => a - b)[Math.floor(p * (values.length - 1))].toFixed(3);
  console.log(model, 'gold 相似度 p10/p50', quant(rel, 0.1), quant(rel, 0.5), '| 干扰问题最高分 p50/max', quant(dis, 0.5), quant(dis, 1));
}
