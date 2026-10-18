// 实现自查：用分支上的生产代码（createPersonalMemory + createMemoryRecall，真实网关）在一次性库里跑同一套 300 条记忆与 79 条查询，
// 看指标是否和实验一致。用法（仓库根目录）：apps/api/node_modules/.bin/tsx .scratch/memory-recall/impl-smoke.mts <快模型> [次数]
// 需要 TEST_PG_URL 指向一次性 PostgreSQL（只建临时库，跑完删掉）。不打印密钥。
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const pg = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg') as typeof import('pg');
import { migrate } from '../../apps/api/src/migrate.js';
import { createPersonalMemory } from '../../apps/api/src/personalMemory.js';
import { createMemoryRecall } from '../../apps/api/src/personalMemoryRecall.js';
// @ts-ignore 实验脚本（.mjs）
import { gateway } from './env.mjs';
// @ts-ignore
import { QUERIES, ACTIVE } from './dataset.mjs';
// @ts-ignore
import { pool as runPool } from './llm.mjs';

const [modelId = 'deepseek-v4.1-flash', runsArg = '1'] = process.argv.slice(2);
const adminUrl = process.env.TEST_PG_URL!;
const database = `memory_recall_smoke_${Date.now()}`;
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
await admin.query(`CREATE DATABASE ${database}`);
const pool = new pg.Pool({ connectionString: adminUrl.replace(/\/postgres$/, `/${database}`), max: 6 });
const uuidOf = (id: string) => { const hex = createHash('sha256').update(`pmem:${id}`).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
type Item = { id: string; kind: string; title: string; text: string; createdAt: string; anchors: unknown[] };
const itemOf = new Map((ACTIVE as Item[]).map((item) => [uuidOf(item.id), item.id]));
try {
  const client = await pool.connect();
  await migrate(client);
  client.release();
  for (const item of ACTIVE as Item[]) {
    await pool.query(`INSERT INTO personal_memory_items (id, person_id, kind, title, text, anchors, refs, created_at, updated_at) VALUES ($1, 'linzhou', $2, $3, $4, $5::jsonb, '[]'::jsonb, $6, $6)`,
      [uuidOf(item.id), item.kind, item.title, item.text, JSON.stringify(item.anchors), item.createdAt]);
  }
  const memory = createPersonalMemory({ pool, recall: createMemoryRecall({ baseUrl: gateway.responsesUrl, apiKey: gateway.apiKey, modelId, fallbackModelId: gateway.light,
    now: () => new Date('2026-10-16T04:00:00.000Z') }) });
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  const out = new URL(`./results/impl-${modelId}@300.jsonl`, import.meta.url);
  for (let run = 1; run <= Number(runsArg); run++) {
    await runPool(QUERIES, 3, async (query: { id: string; text: string }) => {
      const started = performance.now();
      const selected = await memory.select('linzhou', query.text);
      appendFileSync(out, `${JSON.stringify({ config: `impl-${modelId}`, n: 300, run, qid: query.id, ids: selected.map((entry) => itemOf.get(entry.id)), ms: performance.now() - started })}\n`);
    });
    console.log('run', run, 'done');
  }
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}
