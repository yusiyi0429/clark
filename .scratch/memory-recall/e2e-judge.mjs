// 端到端打分：强模型逐条判断回答有没有用对记忆、有没有把旧说法当现行、有没有硬扯无关记忆；标记数由程序统计。
// node e2e-judge.mjs   结果写 results-e2e/judged.json，并打印汇总表。
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { QUERIES, BY_ID, CORE } from './dataset.mjs';
import { complete, parseJson, pool } from './llm.mjs';

const dir = new URL('./results-e2e/', import.meta.url);
const OUT = new URL('./judged.json', dir);
const judged = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const QUERY = new Map(QUERIES.map((query) => [query.id, query]));
const rows = readdirSync(dir).filter((file) => file.endsWith('.jsonl')).flatMap((file) => readFileSync(new URL(file, dir), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
const show = (id) => { const item = BY_ID.get(id); return `【${item.createdAt.slice(0, 10)}】${item.title}：${item.text}`; };

const PROMPT = `你在评估一个 AI 助手的回答。提问的是一位 CEO，助手这一轮手里有他以前说过的一些个人记忆。给你：问题、助手手里的记忆、回答这个问题应当用到的记忆（按编号）、已被他后来的说法改掉的旧说法（如有）、助手的回答。
逐项判断，只输出 JSON：
{"gold":{"编号":true|false},"stale":true|false,"intrusion":true|false,"fabricated":true|false,"note":"一句话理由"}
- gold：每条「应当用到」的记忆，回答里有没有体现它的意思（换了说法也算；没提或说反了算 false）。没有应当用到的记忆时填 {}。
- stale：回答是否把旧说法当成他现在的立场（没提后来改了）。没有旧说法时填 false。
- intrusion：回答是否把和问题无关的个人记忆硬扯进来（比如问常识却谈起他的业务想法）。
- fabricated：回答是否声称他说过、定过、想过某件事，而这件事在助手手里的记忆和问题里都找不到（一般性的建议、分析不算）。`;

const keyOf = (row) => `${row.method}:${row.run}:${row.qid}`;
const todo = rows.filter((row) => !judged[keyOf(row)]);
await pool(todo, 6, async (row) => {
  const query = QUERY.get(row.qid);
  const inHand = [...new Set([...row.selected, ...row.searches.flatMap((search) => search.ids)])].map((id) => `${id}｜${show(id)}`).join('\n') || '（无）';
  const gold = query.gold.map((id) => `${id}｜${show(id)}`).join('\n') || '（无，这是与他个人想法无关的问题）';
  const stale = Object.entries(query.stale ?? {}).map(([old, current]) => `${show(old)}（后来改成：${BY_ID.get(current).title}）`).join('\n') || '（无）';
  const input = `问题：${query.text}\n\n助手手里的记忆：\n${inHand}\n\n应当用到的记忆：\n${gold}\n\n旧说法：\n${stale}\n\n回答：\n${row.answer.replace(/\[记忆\]\(cite:pmem:[^)]+\)/g, '')}`;
  const result = await complete({ model: 'claude-opus-5-5', instructions: PROMPT, input, maxOutputTokens: 3000 });
  const value = parseJson(result.text);
  if (value?.gold) judged[keyOf(row)] = value;
  writeFileSync(OUT, JSON.stringify(judged, null, 1));
});

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const methods = [...new Set(rows.map((row) => row.method))];
const coverage = (entry) => { const values = Object.values(entry.verdict.gold ?? {}); return values.length ? values.filter(Boolean).length / values.length : 1; };
console.log(['方案', '回答数', '应用记忆覆盖', '全部用上', '旧当新', '硬扯无关', '编造', '有标记的回答', '标记数/答', '标记 id 都有效', '标记指向应用记忆', '干扰题出现标记', '选取耗时P50', '总耗时P50'].join('\t'));
for (const method of methods) {
  const mine = rows.filter((row) => row.method === method);
  const verdicts = mine.map((row) => ({ row, verdict: judged[keyOf(row)], query: QUERY.get(row.qid) })).filter((entry) => entry.verdict);
  const relevant = verdicts.filter((entry) => entry.query.type !== 5);
  const distractor = verdicts.filter((entry) => entry.query.type === 5);
  const marksOnGold = relevant.filter((entry) => entry.row.marks.some((id) => entry.query.gold.includes(id))).length;
  const p50 = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
  console.log([method, verdicts.length,
    mean(relevant.map(coverage)).toFixed(2),
    mean(relevant.map((entry) => (coverage(entry) === 1 ? 1 : 0))).toFixed(2),
    verdicts.filter((entry) => entry.verdict.stale).length,
    verdicts.filter((entry) => entry.verdict.intrusion).length,
    verdicts.filter((entry) => entry.verdict.fabricated).length,
    `${relevant.filter((entry) => entry.row.marks.length).length}/${relevant.length}`,
    mean(relevant.map((entry) => entry.row.marks.length)).toFixed(1),
    `${verdicts.filter((entry) => entry.row.unknownMarks === 0).length}/${verdicts.length}`,
    `${marksOnGold}/${relevant.length}`,
    `${distractor.filter((entry) => entry.row.marks.length).length}/${distractor.length}`,
    Math.round(p50(mine.map((row) => row.selectMs))), Math.round(p50(mine.map((row) => row.ms)))].join('\t'));
}
const breakdown = {};
for (const row of rows) {
  const verdict = judged[keyOf(row)];
  if (!verdict) continue;
  breakdown[row.qid] ??= {};
  const values = Object.values(verdict.gold ?? {});
  const covered = values.length ? `${values.filter(Boolean).length}/${values.length}` : '-';
  breakdown[row.qid][row.method] = `${breakdown[row.qid][row.method] ? `${breakdown[row.qid][row.method]} ` : ''}${covered}${verdict.stale ? 's' : ''}${verdict.intrusion ? 'i' : ''}${verdict.fabricated ? 'f' : ''}`;
}
console.log('\n逐题（数字 = used，s = 旧当新，i = 硬扯无关；每次运行一个字符组）');
for (const [qid, value] of Object.entries(breakdown)) console.log(qid, `T${QUERY.get(qid).type}`, JSON.stringify(value));
void CORE;
