// 本地嵌入模型（网关没有 /embeddings）：transformers.js + ONNX，模型文件放在会话临时目录，不进仓库。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ENV_DIR = 'C:/Users/10021/AppData/Local/Temp/claude/C--Users-10021-Desktop-clark-Tianshu-MVP/bd19a587-6640-4d35-a0c5-ac191b2a4479/scratchpad/embed-env';
const require = createRequire(`${ENV_DIR}/package.json`);

export const EMBED_MODELS = {
  'bge-small-zh': { repo: 'Xenova/bge-small-zh-v1.5', dtype: 'fp32', queryPrefix: '为这个句子生成表示以用于检索相关文章：' },
  'bge-m3': { repo: 'Xenova/bge-m3', dtype: 'q8', queryPrefix: '' },
};
const loaded = new Map();

async function extractor(name) {
  if (!loaded.has(name)) {
    const { pipeline, env } = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href);
    env.cacheDir = `${ENV_DIR}/models`;
    loaded.set(name, pipeline('feature-extraction', EMBED_MODELS[name].repo, { dtype: EMBED_MODELS[name].dtype }));
  }
  return loaded.get(name);
}

export async function embed(name, texts, { query = false } = {}) {
  const run = await extractor(name);
  const prefix = query ? EMBED_MODELS[name].queryPrefix : '';
  const vectors = [];
  for (let index = 0; index < texts.length; index += 16) {
    const output = await run(texts.slice(index, index + 16).map((text) => prefix + text), { pooling: 'cls', normalize: true });
    vectors.push(...output.tolist());
  }
  return vectors;
}

export const itemText = (item) => `${item.title}：${item.text}`;

/** 条目向量缓存在 data/emb-<模型>.json。 */
export async function itemVectors(name, items) {
  const file = new URL(`./data/emb-${name}.json`, import.meta.url);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const missing = items.filter((item) => !cache[item.id] || cache[item.id].text !== itemText(item));
  if (missing.length) {
    const vectors = await embed(name, missing.map(itemText));
    missing.forEach((item, index) => { cache[item.id] = { text: itemText(item), v: vectors[index].map((x) => Math.round(x * 1e5) / 1e5) }; });
    writeFileSync(file, JSON.stringify(cache));
  }
  return new Map(items.map((item) => [item.id, cache[item.id].v]));
}

export const cosine = (left, right) => { let sum = 0; for (let index = 0; index < left.length; index++) sum += left[index] * right[index]; return sum; };
