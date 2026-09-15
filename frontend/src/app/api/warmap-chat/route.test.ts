import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/warmap/chat-research', () => ({ answerWithMicroResearch: vi.fn() }));
vi.mock('@/lib/models/mock', () => ({ modelMockOn: () => false }));
vi.mock('@/lib/models/slots', () => ({ resolveModel: () => ({ alias: 'test' }) }));
import { answerWithMicroResearch } from '@/lib/warmap/chat-research';
import { POST } from './route';
const reference = { id: 'notice:confirmation', title: '会后确认', kind: '通知', content: '优先支持灯塔，尚未确认。', source: '演练材料', capturedAt: '2026-09-11T08:00:00Z' };
const request = (references: unknown) => new Request('http://localhost/api/warmap-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '分析引用的卡片', context: '全局材料', references }) });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(answerWithMicroResearch).mockResolvedValue({ text: '分析完成', ms: 10 }); });
describe('manual reference chat route', () => {
  it('passes selected content, provenance and pending status separately to the model', async () => {
    const response = await POST(request([reference]));
    expect(response.status).toBe(200);
    const messages = vi.mocked(answerWithMicroResearch).mock.calls[0][0];
    const manual = messages.find(message => typeof message.content === 'string' && message.content.includes('"type":"manualReferences"'))!;
    expect(JSON.parse(manual.content as string).references).toEqual([reference]);
    expect(messages[0].content).toContain('引用不是批准');
    expect(messages.at(-1)?.content).toBe('分析引用的卡片');
  });
  it('rejects invalid references before any model work', async () => {
    expect((await POST(request([reference, reference]))).status).toBe(400);
    expect(answerWithMicroResearch).not.toHaveBeenCalled();
  });
  it('keeps clients without references working', async () => {
    expect((await POST(request(undefined))).status).toBe(200);
  });
});
