import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createMemoryRecall, memoryRecallModels, recallDirectory, parseRecall, type RecallCandidate } from '../src/personalMemoryRecall.js';

const items: RecallCandidate[] = [
    { id: 'id-new', kind: 'open_question', title: '扩编方向还没想好', text: '还没想好销售扩编往哪个方向扩：是补县城地推，还是在总部加电销覆盖长尾客户。电销便宜，但签下来的客户流失高，要等 1 月看完样板县的数据再定。', createdAt: '2026-09-15T02:00:00.000Z' },
    { id: 'id-old', kind: 'stance', title: '先提人效再扩人', text: '人均月签约从 6 家提到 9 家之前，不扩编。', createdAt: '2026-08-04T02:00:00.000Z' },
    { id: 'id-mid', kind: 'practice', title: '周会先数后事', text: '周会先过 15 分钟数据看板。', createdAt: '2026-08-20T02:00:00.000Z' },
];

/** 网关 Responses 的流式返回：把 text 拆成几段 delta。 */
function sse(text: string, status = 200): Response {
    if (status !== 200) return new Response('upstream error', { status });
    const chunks = [text.slice(0, 5), text.slice(5)].map((delta) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
    return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { status });
}

test('the directory lists items oldest first with date, kind, title and the start of the text, and handles map back to real ids', () => {
    const ordered = [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const lines = recallDirectory(ordered).split('\n');
    expect(lines[0]).toBe('M1｜2026-08-04｜立场｜先提人效再扩人：人均月签约从 6 家提到 9 家之前，不扩编。');
    expect(lines[2]).toMatch(/^M3｜2026-09-15｜未决问题｜扩编方向还没想好：还没想好销售扩编往哪个方向扩/);
    expect(lines[2].endsWith('…')).toBe(true);
    // 编号换回真实 id；编出来的编号丢掉，重复的只留一个；空数组是「没有相关记忆」，解析不出来是 null。
    expect(parseRecall('{"ids":["M3","M9","M3","m1"]}', ordered)).toEqual(['id-new', 'id-old']);
    expect(parseRecall('{"ids":[]}', ordered)).toEqual([]);
    expect(parseRecall('没有 JSON', ordered)).toBeNull();
});

test('recall asks the fast model with the directory as a stable prefix and returns the picked ids', async () => {
    const requests: { url: string; body: { model: string; instructions: string; input: { content: string }[]; reasoning: unknown } }[] = [];
    const recall = createMemoryRecall({ baseUrl: 'https://gateway.test/v2/llm/responses', apiKey: 'test-key', modelId: 'fast-model', now: () => new Date('2026-10-16T04:00:00.000Z'),
        fetch: async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return sse('{"ids":["M3","M1"]}'); } });
    expect(await recall({ message: '关于卖货团队招人的方向，我还有什么拿不定主意的？', items })).toEqual(['id-new', 'id-old']);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://gateway.test/v2/llm/responses');
    expect(requests[0].body.model).toBe('fast-model');
    expect(requests[0].body.reasoning).toEqual({ effort: 'none' });
    expect(requests[0].body.instructions).toContain('M1｜2026-08-04｜立场｜先提人效再扩人');
    expect(requests[0].body.input[0].content).toBe('今天是 2026-10-16。本轮问题：关于卖货团队招人的方向，我还有什么拿不定主意的？');
    // 没有候选时不调模型。
    expect(await recall({ message: '你好', items: [] })).toEqual([]);
    expect(requests).toHaveLength(1);
});

test('recall retries once on the fallback model, and throws when both fail so the caller can fall back to word overlap', async () => {
    const models: string[] = [];
    const recall = createMemoryRecall({ baseUrl: 'https://gateway.test/v2/llm/responses', apiKey: 'test-key', modelId: 'fast-model', fallbackModelId: 'light-model',
        fetch: async (_url, init) => { const { model } = JSON.parse(String(init?.body)); models.push(model); return model === 'fast-model' ? sse('', 500) : sse('{"ids":["M2"]}'); } });
    expect(await recall({ message: '周会怎么开', items })).toEqual(['id-mid']);
    expect(models).toEqual(['fast-model', 'light-model']);

    const broken = createMemoryRecall({ baseUrl: 'https://gateway.test/v2/llm/responses', apiKey: 'test-key', modelId: 'fast-model', fallbackModelId: 'light-model',
        fetch: async () => sse('不是 JSON') });
    await expect(broken({ message: '周会怎么开', items })).rejects.toMatchObject({ code: 'PERSONAL_MEMORY_RECALL_FAILED' });

    const slow = createMemoryRecall({ baseUrl: 'https://gateway.test/v2/llm/responses', apiKey: 'test-key', modelId: 'fast-model', timeoutMs: 50,
        fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) });
    await expect(slow({ message: '周会怎么开', items })).rejects.toMatchObject({ code: 'PERSONAL_MEMORY_RECALL_TIMEOUT' });
});

test('the recall model is configured apart from triage: MEMORY_RECALL_MODEL, else TRIAGE_MODEL, else LIGHT_MODEL; LIGHT_MODEL is the retry', () => {
    expect(memoryRecallModels({ memoryRecallModel: 'deepseek-v4.1-flash', triageModel: 'triage-model', lightModel: 'gpt-5.6-terra' }))
        .toEqual({ modelId: 'deepseek-v4.1-flash', fallbackModelId: 'gpt-5.6-terra' });
    expect(memoryRecallModels({ triageModel: 'triage-model', lightModel: 'gpt-5.6-terra' })).toEqual({ modelId: 'triage-model', fallbackModelId: 'gpt-5.6-terra' });
    expect(memoryRecallModels({ memoryRecallModel: '', lightModel: 'gpt-5.6-terra' })).toEqual({ modelId: 'gpt-5.6-terra', fallbackModelId: 'gpt-5.6-terra' });
});

test('.env.example recommends deepseek-v4.1-flash for recall and the compose file passes it to the api', () => {
    const root = new URL('../../../', import.meta.url);
    expect(readFileSync(new URL('.env.example', root), 'utf8')).toMatch(/^MEMORY_RECALL_MODEL=deepseek-v4\.1-flash\r?$/m);
    expect(readFileSync(new URL('infra/docker-compose.yml', root), 'utf8')).toContain('MEMORY_RECALL_MODEL: ${MEMORY_RECALL_MODEL:-}');
});
