// 大规模测试用的追加条目（约 700 条，时间铺到 3 月到 10 月）：同一人物，同样的话题，但不能重复已有条目讲过的点。
// 用法：node gen-padding.mjs [模型]   输出 data/padding.json
import { readFileSync, writeFileSync } from 'node:fs';
import { complete, parseJson, pool } from './llm.mjs';
import { ITEMS } from './dataset.mjs';

const model = process.argv[2] ?? 'claude-opus-5-5';
const PERSONA = readFileSync(new URL('./gen-fillers.mjs', import.meta.url), 'utf8').match(/const PERSONA = `([\s\S]*?)`;/)[1];
const CLUSTERS = [...readFileSync(new URL('./gen-fillers.mjs', import.meta.url), 'utf8').matchAll(/\['([^']+)', '(topic:[^']+)', \d+\]/g)].map((match) => [match[1], match[2]]);
const existing = ITEMS.map((item) => `${item.title}：${item.text}`).join('\n');
const PROMPT = `你在为一个记忆检索评测造数据。模仿「后台从本人聊天里提炼出的个人记忆条目」的写法：每条是本人自己的一个想法（idea）、立场（stance）、未决问题（open_question）、理由（reason）或做法（practice）。
要求：
- 每条只讲一个具体的点，有具体细节（数字、对象、条件、理由）。
- 绝不能和「已有条目」讲同一个点，也不能是它们的换个说法、细化或反面；要讲这个话题下更细、更偏的其他方面（具体的人、具体的门店或县、具体的流程环节、具体的工具、某次会上的某个想法等）。
- 各条之间也不要重复。kind 混合。
- title 不超过 16 个字；text 20 到 90 个字，第一人称省略主语。
- date 在 2026-03-01 到 2026-10-15 之间，分布开。anchor 从给定的 topic 里选一个照抄。
- 只输出 JSON 数组：[{"kind":"…","title":"…","text":"…","date":"YYYY-MM-DD","anchor":"topic:…"}]`;

const tasks = CLUSTERS.flatMap(([theme, topics]) => [0, 1].map((part) => ({ theme, topics, part })));
const results = await pool(tasks, 6, async ({ theme, topics, part }) => {
  const input = `${PERSONA}\n\n已有条目（不要重复这些点）：\n${existing}\n\n这次的话题：${theme}（第 ${part + 1} 批，${part ? '偏执行细节与具体人和事' : '偏判断、原则与取舍'}）\n可用 anchor：${topics}\n请生成 13 条。`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await complete({ model, instructions: PROMPT, input, maxOutputTokens: 12000 });
      const items = parseJson(result.text);
      if (Array.isArray(items) && items.length >= 10) { console.log(theme, part, items.length); return items.slice(0, 13); }
    } catch (error) { console.log(theme, part, 'error', error.message.slice(0, 100)); }
  }
  return [];
});
const padding = results.flat().map((item, index) => ({ id: `x${String(index + 1).padStart(3, '0')}`, ...item }));
writeFileSync(new URL('./data/padding.json', import.meta.url), JSON.stringify(padding, null, 1));
console.log('padding', padding.length);
