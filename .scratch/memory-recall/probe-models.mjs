// 试几个候选的快模型：能不能调通、整次耗时和首字耗时。
import { complete } from './llm.mjs';

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['gpt-5.6-terra', 'gpt-5.6-luna', 'deepseek-v4.1-flash', 'claude-haiku-5-5', 'gpt-6-luna', 'kimi-k3'];
for (const model of models) {
  try {
    const result = await complete({ model, instructions: '只输出 JSON。', input: '从下面挑出和「销售扩编」相关的编号：A 先提人效再扩人；B 周会不念 PPT；C 扩编方向还没想好。输出 {"ids":[...]}', maxOutputTokens: 100 });
    console.log(model, Math.round(result.ms), 'ms ttft', Math.round(result.ttftMs), JSON.stringify(result.usage), result.text.slice(0, 80).replace(/\s+/g, ' '));
  } catch (error) { console.log(model, 'ERR', error.message.slice(0, 200)); }
}
