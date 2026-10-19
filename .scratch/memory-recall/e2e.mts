// 端到端：用真实的主对话运行时（piConversationRuntime，真实系统提示与工具、网关上的主答模型），
// 把各方案选出的个人记忆装进上下文包，看最终回答有没有用对记忆、有没有写 [记忆](cite:pmem:<id>) 标记。
// 用法（在仓库根目录）：apps/api/node_modules/.bin/tsx .scratch/memory-recall/e2e.mts <方案> <次数> [并发]
// 结果写 .scratch/memory-recall/results-e2e/<方案>.jsonl；不打印密钥。
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createPiConversationRuntime } from '../../apps/api/src/piConversationRuntime.js';
import { createResponsesTriage } from '../../apps/api/src/conversationRouting.js';
import { unknownMemoryMarks } from '../../apps/api/src/personalMemory.js';
import { loadCompanyMemory } from '../../apps/api/src/companyMemory.js';
import { fileURLToPath } from 'node:url';
const testEnv = { companyMemorySeedDir: fileURLToPath(new URL('../../apps/api/test/fixtures/company-memory', import.meta.url)), companyPeopleSeed: fileURLToPath(new URL('../../apps/api/test/fixtures/company-people.json', import.meta.url)) };
// @ts-ignore 实验脚本（.mjs）
import { gateway } from './env.mjs';
// @ts-ignore
import { QUERIES, ACTIVE, CORE, BY_ID } from './dataset.mjs';
// @ts-ignore
import { lexicalCurrent, llmIndexSelect } from './methods.mjs';
// @ts-ignore
import { pool as runPool } from './llm.mjs';

export const E2E_QUERIES = ['q01', 'q04', 'q13', 'q17', 'q25', 'q29', 'q31', 'q35', 'q44', 'q47', 'q54', 'q57', 'q66', 'q74', 'q75'];
const [method = 'a', runsArg = '1', concurrencyArg = '3'] = process.argv.slice(2);
const MAIN_MODEL = gateway.heavy;
const uuidOf = (id: string) => { const hex = createHash('sha256').update(`pmem:${id}`).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const idOf = new Map<string, string>((ACTIVE as { id: string }[]).map((item) => [uuidOf(item.id), item.id]));
type Item = { id: string; title: string; text: string; createdAt: string; kind: string };
const entry = (item: Item) => ({ id: uuidOf(item.id), title: item.title, text: item.text, createdAt: item.createdAt });
const pool = ACTIVE as Item[];
const core = pool.filter((item) => CORE.has(item.id));

async function select(text: string): Promise<string[]> {
  const query = { id: 'e2e', text };
  if (method === 'a') return lexicalCurrent(query, pool).ids;
  if (method === 'full') return pool.map((item) => item.id);
  const model = method === 'b-flash' ? 'deepseek-v4.1-flash' : 'gpt-5.6-terra';
  const picked = (await llmIndexSelect(query, pool, { model, mode: 'snippet' })).ids;
  return [...core.map((item) => item.id), ...picked];
}

const runtime = await createPiConversationRuntime({
  companyMemory: loadCompanyMemory(testEnv), baseUrl: gateway.responsesUrl, apiKey: gateway.apiKey, modelId: MAIN_MODEL,
  triage: createResponsesTriage({ baseUrl: gateway.responsesUrl, apiKey: gateway.apiKey, modelId: gateway.light }),
});
const outDir = new URL('./results-e2e/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const out = new URL(`./${method}.jsonl`, outDir);
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((line) => { const row = JSON.parse(line); return `${row.run}:${row.qid}`; }) : []);
for (let run = 1; run <= Number(runsArg); run++) {
  const todo = (QUERIES as { id: string; text: string }[]).filter((query) => E2E_QUERIES.includes(query.id) && !done.has(`${run}:${query.id}`));
  await runPool(todo, Number(concurrencyArg), async (query: { id: string; text: string }) => {
    const started = performance.now();
    const selected = await select(query.text);
    const selectMs = performance.now() - started;
    const memoryUsed = new Set(selected.map(uuidOf));
    const searches: { query: string; ids: string[] }[] = [];
    const tools = {
      search: async (text: string) => {
        const ids = (await select(text)).filter((id) => !CORE.has(id));
        searches.push({ query: text, ids });
        for (const id of ids) memoryUsed.add(uuidOf(id));
        return ids.map((id) => { const item = BY_ID.get(id) as Item; return { id: uuidOf(id), title: item.title, text: item.text }; });
      },
      remember: async (input: { title: string; text: string }) => ({ id: randomUUID(), title: input.title, text: input.text }),
      forget: async (input: { id: string }) => ({ id: input.id }),
    };
    const events: string[] = [];
    try {
      const result = await runtime.run({
        viewer: { personId: 'linzhou', displayName: '林舟', role: 'ceo' }, scope: 'global', message: query.text, currentObject: null, referencesSnapshot: [],
        personalMemory: selected.map((id) => entry(BY_ID.get(id) as Item)), personalMemoryTools: tools,
        runtimeEntries: [], piSessionId: randomUUID(), signal: AbortSignal.timeout(240_000),
        emit: (event) => { if (event.type === 'tool' && event.phase === 'started') events.push(event.name); },
      });
      const answer = result.assistantMessage;
      const marks = [...answer.matchAll(/\(cite:pmem:([^)\s]+)\)/g)].map((match) => match[1]);
      appendFileSync(out, `${JSON.stringify({ method, run, qid: query.id, selected, selectMs, searches, tools: events, answer,
        marks: marks.map((uuid) => idOf.get(uuid) ?? uuid), unknownMarks: unknownMemoryMarks(answer, memoryUsed).length, ms: performance.now() - started })}\n`);
      console.log(method, run, query.id, Math.round((performance.now() - started) / 1000), 's', marks.length, 'marks');
    } catch (error) {
      console.error(method, run, query.id, (error as Error).message.slice(0, 200));
    }
  });
}
await runtime.close?.();
