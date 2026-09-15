import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/models/complete', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/models/complete')>(), callModel: vi.fn() }));
vi.mock('@/lib/agent/talk/micro', () => ({ runMicroResearch: vi.fn() }));
vi.mock('@/lib/research/search', () => ({ providers: vi.fn() }));
import { callModel } from '@/lib/models/complete';
import { runMicroResearch } from '@/lib/agent/talk/micro';
import { providers } from '@/lib/research/search';
import { answerWithMicroResearch } from './chat-research';

const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Question' }];
const modelResult = (text: string) => ({ text } as Awaited<ReturnType<typeof callModel>>);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(providers).mockReturnValue({ list: [{ name: 'test', label: 'Test', windowed: false, reason: '', search: vi.fn() }], skipped: [] });
});
describe('read-only conversation micro research', () => {
  it('answers directly without a search when the model finds existing context sufficient', async () => {
    vi.mocked(callModel).mockResolvedValue(modelResult('{"action":"answer","text":"已有材料能回答。"}'));
    const result = await answerWithMicroResearch(messages, new AbortController().signal, () => {});
    expect(result.text).toBe('已有材料能回答。');
    expect(result.research).toBeUndefined();
    expect(runMicroResearch).not.toHaveBeenCalled();
    expect(callModel).toHaveBeenCalledTimes(1);
  });
  it('uses the existing micro pipeline once, preserves absence of evidence and emits real stages', async () => {
    vi.mocked(callModel).mockResolvedValueOnce(modelResult('{"action":"micro_research","question":"公开的采购验证证据"}')).mockResolvedValueOnce(modelResult('本次没有查到可核对的证据。'));
    vi.mocked(runMicroResearch).mockResolvedValue({ kind: 'not_found', tried: ['test'], why: 'none' });
    const stages: string[] = [];
    const result = await answerWithMicroResearch(messages, new AbortController().signal, stage => stages.push(stage));
    expect(runMicroResearch).toHaveBeenCalledTimes(1);
    expect(result.research?.status).toBe('not_found');
    expect(result.research?.sources).toEqual([]);
    expect(stages).toEqual(['thinking', 'researching', 'answering']);
    expect(callModel).toHaveBeenCalledTimes(2);
  });
  it('labels missing provider as unavailable, never as no evidence exists', async () => {
    vi.mocked(providers).mockReturnValue({ list: [], skipped: [] });
    vi.mocked(callModel).mockResolvedValueOnce(modelResult('{"action":"micro_research","question":"公共行业信息"}')).mockResolvedValueOnce(modelResult('当前查证未完成。'));
    const result = await answerWithMicroResearch(messages, new AbortController().signal, () => {});
    expect(result.research?.status).toBe('unavailable');
    expect(runMicroResearch).not.toHaveBeenCalled();
  });
  it('keeps verifiable sources and quote/measurement context from the shared ledger', async () => {
    vi.mocked(callModel).mockResolvedValueOnce(modelResult('{"action":"micro_research","question":"公共标准"}')).mockResolvedValueOnce(modelResult('见原文来源。'));
    vi.mocked(runMicroResearch).mockResolvedValue({ kind: 'found', independentGroups: 1, entries: [{
      id: 'E1', claim: '标准要求', exactQuote: 'Original words', url: 'https://www.w3.org/TR/WCAG22/',
      sourceDomain: 'www.w3.org', sourceTier: 'A', period: '2023', independenceGroup: 'one',
    }] } as Awaited<ReturnType<typeof runMicroResearch>>);
    const result = await answerWithMicroResearch(messages, new AbortController().signal, () => {});
    expect(result.research?.sources[0].url).toBe('https://www.w3.org/TR/WCAG22/');
    expect(result.research?.independentGroups).toBe(1);
    const finalPrompt = JSON.stringify(vi.mocked(callModel).mock.calls[1][0].messages);
    expect(finalPrompt).toContain('Original words');
    expect(finalPrompt).toContain('2023');
    expect(vi.mocked(runMicroResearch).mock.calls[0][3]).toEqual({ maxPages: 3 });
  });
  it('does not start research or publish a late answer after cancellation during routing', async () => {
    const abort = new AbortController();
    vi.mocked(callModel).mockImplementation(async () => { abort.abort(); return modelResult('{"action":"micro_research","question":"test"}'); });
    await expect(answerWithMicroResearch(messages, abort.signal, () => {})).rejects.toThrow();
    expect(runMicroResearch).not.toHaveBeenCalled();
  });
});
