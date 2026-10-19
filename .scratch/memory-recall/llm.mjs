// 网关上的模型调用（实验用）：Responses（gpt / deepseek / kimi）与 Anthropic Messages（claude-*）。
// 流式读取，记下整次耗时、首字耗时与 usage。密钥只放请求头，不打印。
import { gateway } from './env.mjs';

const OPENAI_PATH = /^gpt-6\.1/i;

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
      const data = chunk.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      try { onEvent(JSON.parse(data)); } catch { /* 跳过解析不了的块 */ }
    }
  }
}

async function callResponses({ model, instructions, input, maxOutputTokens = 800, effort = 'none', signal }) {
  const base = OPENAI_PATH.test(model) ? `${gateway.root}/openai` : gateway.root;
  const started = performance.now();
  const response = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${gateway.apiKey}` },
    body: JSON.stringify({ model, instructions, input: [{ role: 'user', content: input }], stream: true, store: false, max_output_tokens: maxOutputTokens,
      ...(effort ? { reasoning: { effort } } : {}) }),
    signal,
  });
  if (!response.ok) throw new Error(`responses ${model} ${response.status} ${(await response.text()).slice(0, 300)}`);
  let text = '', usage = null, firstAt = null;
  await readSse(response, (event) => {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') { firstAt ??= performance.now(); text += event.delta; }
    if (event.type === 'response.completed' && event.response?.usage) usage = event.response.usage;
  });
  const ms = performance.now() - started;
  return { text, ms, ttftMs: firstAt ? firstAt - started : ms,
    usage: { input: usage?.input_tokens ?? 0, cached: usage?.input_tokens_details?.cached_tokens ?? 0, output: usage?.output_tokens ?? 0 } };
}

async function callAnthropic({ model, instructions, input, maxOutputTokens = 800, signal, thinking }) {
  const started = performance.now();
  const response = await fetch(`${gateway.root}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': gateway.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, system: instructions, max_tokens: maxOutputTokens, stream: true, messages: [{ role: 'user', content: input }],
      ...(thinking ? { output_config: { effort: thinking } } : {}) }),
    signal,
  });
  if (!response.ok) throw new Error(`anthropic ${model} ${response.status} ${(await response.text()).slice(0, 300)}`);
  let text = '', firstAt = null;
  const usage = { input: 0, cached: 0, output: 0 };
  await readSse(response, (event) => {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') { firstAt ??= performance.now(); text += event.delta.text; }
    if (event.type === 'message_start' && event.message?.usage) {
      usage.input = (event.message.usage.input_tokens ?? 0) + (event.message.usage.cache_read_input_tokens ?? 0) + (event.message.usage.cache_creation_input_tokens ?? 0);
      usage.cached = event.message.usage.cache_read_input_tokens ?? 0;
    }
    if (event.type === 'message_delta' && event.usage) usage.output = event.usage.output_tokens ?? usage.output;
  });
  const ms = performance.now() - started;
  return { text, ms, ttftMs: firstAt ? firstAt - started : ms, usage };
}

/** 一次模型调用；出错重试两次（网关偶发 5xx）。 */
export async function complete(options) {
  const call = /^claude-/i.test(options.model) ? callAnthropic : callResponses;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await call(options); } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** 从模型输出里取第一段 JSON（对象或数组）。 */
export function parseJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[\[{]/);
  if (start < 0) return null;
  for (let end = body.length; end > start; end--) {
    const ch = body[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try { return JSON.parse(body.slice(start, end)); } catch { /* 往前缩 */ }
  }
  return null;
}

/** 并发跑一组任务。 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); }
  }));
  return results;
}
