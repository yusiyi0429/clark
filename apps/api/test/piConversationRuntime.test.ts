import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { createFakeWebSearchAdapter, testEnv } from "./helpers.js";

const usage = {
  input: 4,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  messageUsage = usage,
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "warmap",
    model: "fake-light",
    content,
    usage: messageUsage,
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
  it("does not call the model when the public abort signal is already aborted", async () => {
    let modelCalls = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple: () => {
        modelCalls += 1;
        return stream(message([{ type: "text", text: "must not run" }], "stop"));
      },
    });
    const abort = new AbortController();
    abort.abort(new Error("stopped before start"));
    try {
      await expect(runtime.run({
        scope: "global",
        message: "不要开始",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: abort.signal,
        emit: () => undefined,
      })).rejects.toThrow("Conversation aborted");
      expect(modelCalls).toBe(0);
    } finally {
      await runtime.close?.();
    }
  });

  it("makes Search available but does not call it when internal context is sufficient", async () => {
    const contexts: Context[] = [];
    const search = createFakeWebSearchAdapter({});
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (_model, context) => {
        contexts.push(context);
        return stream(message([{ type: "text", text: "[内部证据] 当前对象已经足够。" }], "stop"));
      },
    });
    try {
      const result = await runtime.run({
        scope: "issue:fixture-001",
        message: "总结当前对象",
        currentObject: null,
        referencesSnapshot: [],
        recentMessages: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
        checkpoint: async () => undefined,
      });
      expect(result.assistantMessage).toContain("内部证据");
      expect(contexts[0].tools?.map((tool) => tool.name)).toContain("web_search");
      expect(search.calls).toEqual([]);
    } finally {
      await runtime.close?.();
    }
  });

  it("searches once for missing current facts and stops when evidence is sufficient", async () => {
    const search = createFakeWebSearchAdapter({
      "月球供应链最新公告": [{
        title: "供应链公告",
        url: "https://example.com/latest",
        publishedAt: "2025-09-15T00:00:00.000Z",
        excerpt: "合作方今天公布新窗口。",
        provider: "fake-search",
      }],
    });
    let turn = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (_model, context) => {
        turn += 1;
        if (turn === 1) return stream(message([{
          type: "toolCall", id: "search-1", name: "web_search", arguments: { query: "月球供应链最新公告" },
        }], "toolUse"));
        const evidence = JSON.stringify(context.messages.findLast((item) => item.role === "toolResult"));
        return stream(message([{ type: "text", text: evidence.includes("合作方今天公布新窗口")
          ? "[外部证据] 公告显示新窗口。\n[推断] 需要重新比较时点。"
          : "missing evidence" }], "stop"));
      },
    });
    try {
      const result = await runtime.run({
        scope: "global",
        message: "最新窗口是什么？",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(result.assistantMessage).toContain("[外部证据]");
      expect(result.assistantMessage).toContain("[推断]");
      expect(search.calls).toEqual([{ query: "月球供应链最新公告" }]);
    } finally {
      await runtime.close?.();
    }
  });

  it("terminates an abnormal loop on the eighth Search without retrying or switching models", async () => {
    const search = createFakeWebSearchAdapter({ loop: [] });
    let modelCalls = 0;
    const seenModels: string[] = [];
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (model) => {
        seenModels.push(model.id);
        modelCalls += 1;
        if (modelCalls > 9) throw new Error("unbounded search loop");
        return stream(message([{
          type: "toolCall", id: `search-${modelCalls}`, name: "web_search", arguments: { query: "loop" },
        }], "toolUse"));
      },
    });
    try {
      await expect(runtime.run({
        scope: "global",
        message: "loop",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      })).rejects.toMatchObject({
        message: "Search limit reached (8)",
        code: "SEARCH_BUDGET_EXHAUSTED",
      });
      expect(search.calls).toHaveLength(8);
      expect(seenModels).toEqual(Array(seenModels.length).fill("fake-light"));
    } finally {
      await runtime.close?.();
    }
  });

  it("keeps Pi automatic compaction enabled and checkpoints an in-turn compaction", async () => {
    const search = createFakeWebSearchAdapter({ latest: [] });
    const highUsage = { ...usage, input: 120_000, totalTokens: 120_002 };
    const events: unknown[] = [];
    const checkpoints: unknown[][] = [];
    let regularCalls = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (_model, context) => {
        if (context.systemPrompt.includes("context summarization assistant")) {
          return stream(message([{ type: "text", text: "自动压缩摘要" }], "stop"));
        }
        regularCalls += 1;
        if (regularCalls === 3) return stream(message([{
          type: "toolCall", id: "search-auto", name: "web_search", arguments: { query: "latest" },
        }], "toolUse", highUsage));
        return stream(message(
          [{ type: "text", text: `regular-${regularCalls}` }],
          "stop",
          regularCalls >= 3 ? highUsage : usage,
        ));
      },
    });
    try {
      const history = await runtime.run({
        scope: "global",
        message: "历史上下文".repeat(30_000),
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      const middle = await runtime.run({
        scope: "global",
        message: "近期上下文".repeat(30_000),
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: JSON.parse(JSON.stringify(history.runtimeEntries)),
        piSessionId: history.piSessionId ?? "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      await runtime.run({
        scope: "global",
        message: "查询当前事实",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: JSON.parse(JSON.stringify(middle.runtimeEntries)),
        piSessionId: middle.piSessionId ?? "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        checkpoint: async (entries) => { checkpoints.push(entries); },
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "compaction", phase: "started" }),
        expect.objectContaining({ type: "compaction", phase: "completed" }),
      ]));
      expect(JSON.stringify(checkpoints)).toContain("自动压缩摘要");
    } finally {
      await runtime.close?.();
    }
  });

  it("JSON round-trips entries, compacts long context with the compaction slot, and checkpoints only runtime state", async () => {
    const emitted: unknown[] = [];
    const checkpoints: unknown[][] = [];
    let lightTurns = 0;
    const highUsage = { ...usage, input: 120_000, totalTokens: 120_002 };
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      compactionModelId: "fake-compaction",
      streamSimple: (model) => {
        if (model.id === "fake-compaction") {
          return stream(message([{ type: "text", text: "旧讨论的压缩摘要" }], "stop"));
        }
        lightTurns += 1;
        return stream(message([{ type: "text", text: `light-${lightTurns}` }], "stop"));
      },
    });
    try {
      const first = await runtime.run({
        scope: "global",
        message: "旧上下文".repeat(30_000),
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      const middle = await runtime.run({
        scope: "global",
        message: "仍需保留的近期上下文".repeat(10_000),
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: JSON.parse(JSON.stringify(first.runtimeEntries)),
        piSessionId: first.piSessionId ?? "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      const roundTripped = JSON.parse(JSON.stringify(middle.runtimeEntries));
      const latestAssistant = roundTripped.findLast((entry: { type?: string; message?: { role?: string; usage?: unknown } }) =>
        entry.type === "message" && entry.message?.role === "assistant");
      latestAssistant.message.usage = highUsage;
      const second = await runtime.run({
        scope: "global",
        message: "继续",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: roundTripped,
        piSessionId: middle.piSessionId ?? "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: (event) => emitted.push(event),
        checkpoint: async (entries) => { checkpoints.push(entries); },
      });
      expect(emitted).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "compaction", phase: "started" }),
        expect.objectContaining({ type: "compaction", phase: "completed" }),
      ]));
      expect(JSON.stringify(second.runtimeEntries)).toContain("旧讨论的压缩摘要");
      expect(JSON.stringify(checkpoints.at(-1))).toContain("旧讨论的压缩摘要");
      expect(checkpoints.at(-1)!.length).toBeLessThan(second.runtimeEntries.length);
    } finally {
      await runtime.close?.();
    }
  });

  it("rebuilds corrupted entries from recent raw messages and reports the public recovery result", async () => {
    const contexts: Context[] = [];
    const emitted: unknown[] = [];
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple: (_model, context) => {
        contexts.push(context);
        return stream(message([{ type: "text", text: "recovered" }], "stop"));
      },
    });
    try {
      const result = await runtime.run({
        scope: "issue:fixture-001",
        message: "继续",
        currentObject: null,
        referencesSnapshot: [],
        recentMessages: [
          { role: "user", content: "原始问题", createdAt: "2025-09-15T00:00:00.000Z" },
          { role: "assistant", content: "原始回答", createdAt: "2025-09-15T00:00:01.000Z" },
        ],
        runtimeEntries: [{ broken: true }],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: (event) => emitted.push(event),
      });
      expect(result.recovery).toMatchObject({ recreated: true, warning: expect.stringContaining("corrupted") });
      expect(result.piSessionId).not.toBe("11111111-1111-4111-8111-111111111111");
      expect(emitted).toContainEqual(expect.objectContaining({ type: "warning", code: "RUNTIME_RECREATED" }));
      expect(JSON.stringify(contexts[0].messages)).toContain("原始问题");
      expect(JSON.parse(JSON.stringify(result.runtimeEntries))).toEqual(result.runtimeEntries);
    } finally {
      await runtime.close?.();
    }
  });

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

    const runtimeOptions = {
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple,
    };
    const runtime = await createPiConversationRuntime(runtimeOptions);
    let runtimeClosed = false;
    let restoredRuntime: ConversationRuntime | undefined;
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
        "get_passages", "list_sections", "search_people", "search_sections", "web_search",
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

      await runtime.close?.();
      runtimeClosed = true;
      restoredRuntime = await createPiConversationRuntime(runtimeOptions);
      const restored = await restoredRuntime.run({
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
      if (!runtimeClosed) await runtime.close?.();
      await restoredRuntime?.close?.();
    }
  });
});
