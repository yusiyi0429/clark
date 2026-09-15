import type { ChatReply, ChatStage } from '@/lib/warmap/chat-research';

/** Stage events contain no generated thoughts; only actual pipeline activity. */
export async function readChatReply(response: Response, onStage: (stage: ChatStage) => void): Promise<ChatReply> {
  if (!response.ok) throw new Error('Chat request failed');
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const reply = await response.json();
    if (typeof reply.text !== 'string' || !reply.text.trim()) throw new Error('Empty chat reply');
    return reply;
  }
  if (!response.body) throw new Error('Missing response stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply: ChatReply | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error('Chat generation failed');
    if (event.type === 'stage' && ['thinking', 'researching', 'answering'].includes(event.stage)) onStage(event.stage);
    if (event.type === 'reply' && typeof event.text === 'string' && event.text.trim()) reply = event;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      lines.forEach(consume);
      if (done) { consume(buffer); break; }
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (!reply) throw new Error('Interrupted chat reply');
  return reply;
}
