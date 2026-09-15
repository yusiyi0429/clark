import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { testEnv } from "./helpers.js";

const usage = {
  input: 4,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "warmap",
    model: "fake-light",
    content,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function stream(final: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    const block = final.content[0];
    if (block.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: 0, partial: final });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: final });
      events.push({ type: "done", reason: "toolUse", message: final });
    } else {
      events.push({ type: "text_start", contentIndex: 0, partial: final });
      events.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: final });
      events.push({ type: "text_end", contentIndex: 0, content: block.text, partial: final });
      events.push({ type: "done", reason: "stop", message: final });
    }
  });
  return events;
}

describe("controlled Pi conversation adapter public behavior", () => {
  it("loads no user/coding resources, exposes only read-only CompanyMemory tools, and restores entries", async () => {
    const contexts: Context[] = [];
    const streamSimple = (_model: Model<any>, context: Context) => {
      contexts.push(context);
      if (contexts.length === 1) {
        return stream(message([
          { type: "toolCall", id: "call-1", name: "search_people", arguments: { query: "测试甲" } },
        ], "toolUse"));
      }
      const toolResult = context.messages.findLast((item) => item.role === "toolResult");
      const text = JSON.stringify(toolResult).includes("person-fixture-001") ? "MCP OK" : "MCP missing";
      return stream(message([{ type: "text", text }], "stop"));
    };

    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple,
    });
    try {
      const emitted: unknown[] = [];
      const first = await runtime.run({
        scope: "issue:fixture-001",
        message: "负责人是谁？",
        currentObject: {
          cardId: "issue:fixture-001",
          version: 1,
          kind: "issue",
          title: "月球基地供应链选择",
          objectRef: { type: "issue", id: "fixture-001", version: 1 },
          payload: { summary: "供应链" },
        },
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: (event) => emitted.push(event),
      });

      expect(first.assistantMessage).toBe("MCP OK");
      expect(first.runtimeEntries.length).toBeGreaterThan(0);
      expect(contexts[0].tools?.map((tool) => tool.name).sort()).toEqual([
        "get_passages", "list_sections", "search_people", "search_sections",
      ]);
      expect(contexts[0].tools?.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
      expect(contexts[0].systemPrompt).toContain("不能执行任何业务写入");
      expect(JSON.stringify(contexts[0].messages)).toContain("月球基地供应链选择");
      expect(emitted).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool", phase: "started", name: "search_people" }),
        expect.objectContaining({ type: "tool", phase: "completed", name: "search_people", isError: false }),
        expect.objectContaining({ type: "message", delta: "MCP OK" }),
        expect.objectContaining({ type: "usage", totalTokens: 6 }),
      ]));

      const restored = await runtime.run({
        scope: "issue:fixture-001",
        message: "继续",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: first.runtimeEntries,
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(restored.runtimeEntries.length).toBeGreaterThan(first.runtimeEntries.length);
      expect(JSON.stringify(contexts.at(-1)?.messages)).toContain("MCP OK");
    } finally {
      await runtime.close?.();
    }
  });
});
