// 跑一组配置：node run.mjs <配置> <规模> <次数> [并发] [查询 id 前缀过滤]
// 结果写 results/<配置>@<规模>.jsonl（每次运行一行一条查询）。
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { QUERIES, poolFor, PADDING } from './dataset.mjs';
import { lexicalCurrent, vectorSelect, llmIndexSelect, hierarchicalSelect, hybridSelect, bm25 } from './methods.mjs';
import { pool as runPool } from './llm.mjs';


export const CONFIGS = {
  'a-lexical': (query, pool) => lexicalCurrent(query, pool),
  'bm25-top8': async (query, pool) => { const started = performance.now(); const ranked = bm25(query, pool, 30); return { ids: ranked.slice(0, 8).map((row) => row.id), ranked, ms: performance.now() - started }; },
  'd-small': (query, pool) => vectorSelect('bge-small-zh', query, pool),
  'd-m3': (query, pool) => vectorSelect('bge-m3', query, pool),
  'b-terra-snippet': (query, pool) => llmIndexSelect(query, pool, { model: 'gpt-5.6-terra', mode: 'snippet' }),
  'b-terra-title': (query, pool) => llmIndexSelect(query, pool, { model: 'gpt-5.6-terra', mode: 'title' }),
  'b-luna-snippet': (query, pool) => llmIndexSelect(query, pool, { model: 'gpt-5.6-luna', mode: 'snippet' }),
  'b-flash-snippet': (query, pool) => llmIndexSelect(query, pool, { model: 'deepseek-v4.1-flash', mode: 'snippet' }),
  'b-6luna-snippet': (query, pool) => llmIndexSelect(query, pool, { model: 'gpt-6-luna', mode: 'snippet' }),
  'b-terra-12': (query, pool) => llmIndexSelect(query, pool, { model: 'gpt-5.6-terra', mode: 'snippet', max: 12 }),
  'b-flash-12': (query, pool) => llmIndexSelect(query, pool, { model: 'deepseek-v4.1-flash', mode: 'snippet', max: 12 }),
  'b-haiku-snippet': (query, pool) => llmIndexSelect(query, pool, { model: 'claude-haiku-5-5', mode: 'snippet' }),
  'c-terra': (query, pool) => hierarchicalSelect(query, pool, { model: 'gpt-5.6-terra' }),
  'e-m3-terra': (query, pool) => hybridSelect(query, pool, { model: 'gpt-5.6-terra', vector: 'bge-m3' }),
  'e-small-terra': (query, pool) => hybridSelect(query, pool, { model: 'gpt-5.6-terra', vector: 'bge-small-zh' }),
  'e-lex-terra': (query, pool) => hybridSelect(query, pool, { model: 'gpt-5.6-terra', vector: null, lexicalK: 30 }),
  'c-flash': (query, pool) => hierarchicalSelect(query, pool, { model: 'deepseek-v4.1-flash' }),
  'e-m3-flash': (query, pool) => hybridSelect(query, pool, { model: 'deepseek-v4.1-flash', vector: 'bge-m3' }),
  'e-lex-flash': (query, pool) => hybridSelect(query, pool, { model: 'deepseek-v4.1-flash', vector: null, lexicalK: 30 }),
  'e-m3-flash-wide': (query, pool) => hybridSelect(query, pool, { model: 'deepseek-v4.1-flash', vector: 'bge-m3', vectorK: 50, lexicalK: 15 }),
  'e-m3-terra-wide': (query, pool) => hybridSelect(query, pool, { model: 'gpt-5.6-terra', vector: 'bge-m3', vectorK: 50, lexicalK: 15 }),
};

const [config, sizeArg = '300', runsArg = '1', concurrencyArg = '3', filter = ''] = process.argv.slice(2);
if (!CONFIGS[config]) { console.error('配置：', Object.keys(CONFIGS).join(' ')); process.exit(1); }
const n = Number(sizeArg);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const out = new URL(`./results/${config}@${n}.jsonl`, import.meta.url);
const queries = QUERIES.filter((query) => query.id.startsWith(filter));
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((line) => { const row = JSON.parse(line); return `${row.run}:${row.qid}`; }) : []);
for (let run = 1; run <= Number(runsArg); run++) {
  const todo = queries.filter((query) => !done.has(`${run}:${query.id}`));
  await runPool(todo, Number(concurrencyArg), async (query) => {
    const pool = poolFor(query, n, n > 300 ? PADDING : []);
    try {
      const result = await CONFIGS[config](query, pool);
      appendFileSync(out, `${JSON.stringify({ config, n, run, qid: query.id, poolSize: pool.length, ...result, ranked: result.ranked?.slice(0, 30) })}\n`);
    } catch (error) {
      console.error(config, run, query.id, error.message.slice(0, 200));
    }
  });
  console.log(config, n, 'run', run, 'done', todo.length);
}
