// 向量检索加相似度阈值：能不能既挡住干扰问题、又不丢召回。node threshold-sweep.mjs [规模]
import { QUERIES, poolFor } from './dataset.mjs';
import { vectorRank } from './methods.mjs';

const n = Number(process.argv[2] ?? 300);
const ranked = new Map();
for (const query of QUERIES) ranked.set(query.id, (await vectorRank('bge-m3', query, poolFor(query, n))).ranked);
console.log('阈值\t召回(前8且过阈值)\t干扰题误召回');
for (const threshold of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65]) {
  const relevant = QUERIES.filter((query) => query.type !== 5);
  const recall = relevant.reduce((sum, query) => sum + ranked.get(query.id).filter((row) => row.score >= threshold).slice(0, 8).filter((row) => query.gold.includes(row.id)).length / query.gold.length, 0) / relevant.length;
  const distractors = QUERIES.filter((query) => query.type === 5);
  const fp = distractors.filter((query) => ranked.get(query.id)[0].score >= threshold).length / distractors.length;
  console.log(`${threshold}\t${recall.toFixed(2)}\t${fp.toFixed(2)}`);
}
