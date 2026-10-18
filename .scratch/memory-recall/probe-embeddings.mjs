// 探测网关有没有 embedding 接口（只打印状态码和返回开头，不打印密钥）。
import { gateway } from './env.mjs';

const hide = (url) => url.replace(/https:\/\/[^/]+/, '');
const roots = [gateway.root, `${gateway.root}/openai`, `${gateway.root}/openai/v1`, `${gateway.root}/v1`, gateway.root.replace(/\/llm$/, '')];
const auth = { authorization: `Bearer ${gateway.apiKey}` };

for (const root of roots) {
  try {
    const response = await fetch(`${root}/models`, { headers: auth });
    console.log('GET', hide(root), '/models', response.status, (await response.text()).slice(0, 400).replace(/\s+/g, ' '));
  } catch (error) { console.log('GET', hide(root), 'ERR', error.message); }
}
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['text-embedding-3-small', 'text-embedding-v3', 'bge-m3'];
for (const root of roots) {
  for (const model of models) {
    try {
      const response = await fetch(`${root}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model, input: ['销售团队扩编'] }) });
      console.log('POST', hide(root), '/embeddings', model, response.status, (await response.text()).slice(0, 200).replace(/\s+/g, ' '));
    } catch (error) { console.log('POST', hide(root), model, 'ERR', error.message); }
  }
}
