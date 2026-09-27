export type ConversationEvent = {
  type: "message" | "tool" | "usage" | "compaction" | "warning" | "error" | "done";
  delta?: string;
  message?: string;
  code?: string;
  name?: string;
  phase?: string;
  isError?: boolean;
  status?: string;
};

/** 把 SSE 文本缓冲切成完整事件块，返回剩余未完成缓冲。纯函数，便于独立验证。 */
export function splitSse(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  return { events: blocks, rest };
}

export function parseSseBlock(block: string): ConversationEvent | null {
  const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (!line) return null;
  return JSON.parse(line.slice(6)) as ConversationEvent;
}
