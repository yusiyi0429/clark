import { describe, expect, it } from 'vitest';
import { readChatReply } from './read-chat-reply';

describe('chat event reader', () => {
  it('handles fragmented UTF-8, real stages and a final response without a trailing newline', async () => {
    const encoded = new TextEncoder().encode('{"type":"stage","stage":"researching"}\n{"type":"reply","text":"已核对原文","ms":2400}');
    const stream = new ReadableStream({ start(controller) {
      for (let i = 0; i < encoded.length; i += 2) controller.enqueue(encoded.slice(i, i + 2));
      controller.close();
    } });
    const stages: string[] = [];
    const result = await readChatReply(new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }), stage => stages.push(stage));
    expect(result.text).toBe('已核对原文');
    expect(result.ms).toBe(2400);
    expect(stages).toEqual(['researching']);
  });
  it('does not treat a stage-only interrupted stream as a completed answer', async () => {
    await expect(readChatReply(new Response('{"type":"stage","stage":"thinking"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {})).rejects.toThrow('Interrupted');
  });
  it('supports existing JSON clients and rejects server failure', async () => {
    expect((await readChatReply(Response.json({ text: '你好' }), () => {})).text).toBe('你好');
    await expect(readChatReply(Response.json({ error: 'failed' }, { status: 503 }), () => {})).rejects.toThrow();
  });
});
