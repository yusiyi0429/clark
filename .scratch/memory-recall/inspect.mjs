// 看某个结果文件里每条查询漏了什么、多选了什么：node inspect.mjs <文件名> [run]
import { readFileSync } from 'node:fs';
import { QUERIES, CORE, BY_ID } from './dataset.mjs';

const [file, runArg = '1'] = process.argv.slice(2);
const rows = readFileSync(new URL(`./results/${file}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.run === Number(runArg));
const byQuery = new Map(rows.map((row) => [row.qid, row]));
const label = (id) => `${id}「${BY_ID.get(id)?.title}」`;
for (const query of QUERIES) {
  const row = byQuery.get(query.id);
  if (!row) continue;
  const ids = row.ids.filter((id) => !CORE.has(id));
  const ok = new Set([...query.gold, ...(query.related ?? []), ...Object.keys(query.stale ?? {}), ...Object.values(query.stale ?? {})]);
  const missed = query.gold.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !ok.has(id));
  if (!missed.length && !extra.length) continue;
  console.log(`${query.id} T${query.type} ${query.text}`);
  if (missed.length) console.log('   漏：', missed.map(label).join(' '));
  if (extra.length) console.log('   多：', extra.map(label).join(' '));
}
