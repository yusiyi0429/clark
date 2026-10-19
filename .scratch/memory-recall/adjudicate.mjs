// 补标注（pooling）：把各方案选出、但不在 gold / related 里的条目交给强模型逐条判断是否相关，结果写 data/adjudication.json 供人工复核。
// 也顺带让它复核 gold 条目（判 0 的 gold 要人工看）。
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { QUERIES, CORE, BY_ID } from './dataset.mjs';
import { complete, parseJson, pool } from './llm.mjs';

const model = process.argv[2] ?? 'claude-opus-5-5';
const dir = new URL('./results/', import.meta.url);
const extra = new Map(QUERIES.map((query) => [query.id, new Set()]));
for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
  for (const line of readFileSync(new URL(file, dir), 'utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    for (const id of row.ids) if (!CORE.has(id)) extra.get(row.qid).add(id);
  }
}
const OUT = new URL('./data/adjudication.json', import.meta.url);
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const PROMPT = `你是检索评测的标注员。给你一位 CEO 这一轮问的问题，和他个人记忆里的若干条目（都是他自己以前说过的想法、立场、未决问题、理由或做法）。
逐条判断：如果助手回答这个问题时把这条记忆考虑进去，会让回答更贴合他的想法吗？
2 = 必须用到（不知道这条就答不好）；1 = 相关、有参考价值（用上会更好，不用也不算错）；0 = 无关或几乎没帮助。
问题是常识、翻译、计算、闲聊等与他个人想法无关时，一律 0。只输出 JSON：{"ratings":{"条目id":分数}}`;
const tasks = QUERIES.map((query) => {
  const ok = new Set([...(query.related ?? []), ...Object.keys(query.stale ?? {}), ...Object.values(query.stale ?? {})]);
  const ids = [...new Set([...query.gold, ...[...extra.get(query.id)].filter((id) => !ok.has(id))])].filter((id) => previous[query.id]?.[id] === undefined);
  return { query, ids };
}).flatMap((task) => Array.from({ length: Math.ceil(task.ids.length / 40) }, (_, index) => ({ query: task.query, ids: task.ids.slice(index * 40, index * 40 + 40) })));
await pool(tasks, 6, async ({ query, ids }) => {
  const list = ids.map((id) => { const item = BY_ID.get(id); return `${id}｜${item.createdAt.slice(0, 10)}｜${item.title}：${item.text}`; }).join('\n');
  const result = await complete({ model, instructions: PROMPT, input: `今天是 2026-10-16。问题：${query.text}\n\n条目：\n${list}`, maxOutputTokens: 4000 });
  const ratings = parseJson(result.text)?.ratings ?? {};
  previous[query.id] = { ...(previous[query.id] ?? {}), ...Object.fromEntries(Object.entries(ratings).filter(([id]) => ids.includes(id))) };
  writeFileSync(OUT, JSON.stringify(previous, null, 1));
  console.log(query.id, Object.entries(ratings).map(([id, score]) => `${id}:${score}`).join(' '));
});
writeFileSync(OUT, JSON.stringify(previous, null, 1));
