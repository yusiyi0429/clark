import { describe, expect, it } from "vitest";
import { parseSseBlock, splitSse } from "./sse";

describe("Conversation SSE parsing", () => {
  it("emits only complete blocks and keeps the tail buffered", () => {
    const chunk = 'data: {"type":"message","delta":"你"}\n\ndata: {"type":"mess';
    const { events, rest } = splitSse(chunk);
    expect(events).toHaveLength(1);
    expect(rest).toBe('data: {"type":"mess');
    expect(parseSseBlock(events[0])).toEqual({ type: "message", delta: "你" });
  });

  it("ignores blocks without a data line", () => {
    expect(parseSseBlock(": keep-alive")).toBeNull();
  });
});
