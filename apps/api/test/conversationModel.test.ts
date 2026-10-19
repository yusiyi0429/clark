import { afterEach, describe, expect, it } from "vitest";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { conversationModelApi, conversationModelDefinition, gatewayRoot, parseTierThinking } from "../src/conversationModel.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { testEnv } from "./helpers.js";

const CEO_VIEWER = { personId: "person-fixture-001", displayName: "测试甲", role: "ceo" as const };

describe("对话主答模型的协议与思考参数", () => {
  it("claude-* 默认走 Anthropic 协议，其余走 Responses；显式指定的协议优先，写错报错", () => {
    expect(conversationModelApi("claude-sonnet-5-5")).toBe("anthropic-messages");
    expect(conversationModelApi("gpt-6.1-sol")).toBe("openai-responses");
    expect(conversationModelApi("claude-sonnet-5-5", "openai-responses")).toBe("openai-responses");
    expect(() => conversationModelApi("x", "chat")).toThrow(/CONVERSATION_API/);
  });

  it("从任一协议地址推出网关根地址", () => {
    expect(gatewayRoot("https://gw.invalid/v2/llm/responses")).toBe("https://gw.invalid/v2/llm");
    expect(gatewayRoot("https://gw.invalid/v2/llm/openai/responses/")).toBe("https://gw.invalid/v2/llm");
    expect(gatewayRoot("https://gw.invalid/v2/llm/anthropic/v1/messages")).toBe("https://gw.invalid/v2/llm");
  });

  it("Claude 注册为自适应思考、不注册关思考；gpt-6.x 把关思考映射成 low；gpt-5.6 与原来一致", () => {
    const claude = conversationModelDefinition({ modelId: "claude-opus-5-5", baseUrl: "https://gw.invalid/v2/llm" });
    expect(claude).toMatchObject({ api: "anthropic-messages", baseUrl: "https://gw.invalid/v2/llm/anthropic", reasoning: true,
      thinkingLevelMap: { off: null, minimal: "low" }, compat: { forceAdaptiveThinking: true, supportsTemperature: false } });
    expect(conversationModelDefinition({ modelId: "claude-sonnet-5-5", baseUrl: "https://gw.invalid/v2/llm", overrideBaseUrl: "https://other.invalid/anthropic/v1/messages" }).baseUrl)
      .toBe("https://other.invalid/anthropic");
    const sol61 = conversationModelDefinition({ modelId: "gpt-6.1-sol", baseUrl: "https://gw.invalid/v2/llm", overrideBaseUrl: "https://gw.invalid/v2/llm/openai/responses" });
    expect(sol61).toMatchObject({ api: "openai-responses", baseUrl: "https://gw.invalid/v2/llm/openai", thinkingLevelMap: { off: "low" } });
    const sol56 = conversationModelDefinition({ modelId: "gpt-5.6-sol", baseUrl: "https://gw.invalid/v2/llm" });
    expect(sol56).toMatchObject({ api: "openai-responses", baseUrl: "https://gw.invalid/v2/llm", maxTokens: 16_384 });
    expect(sol56.thinkingLevelMap).toBeUndefined();
  });

  it("按档位覆盖思考强度的写法", () => {
    expect(parseTierThinking(undefined)).toEqual({});
    expect(parseTierThinking("quick=low, grounded=medium，deep=xhigh")).toEqual({ quick: "low", grounded: "medium", deep: "xhigh" });
    expect(() => parseTierThinking("deep=max")).toThrow(/CONVERSATION_THINKING/);
    expect(() => parseTierThinking("slow=high")).toThrow(/slow=high/);
  });
});

describe("对话 runtime 切到 Claude 时的真实请求", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function anthropicReply(text: string): Response {
    const events: [string, unknown][] = [
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  async function runOnce(options: { modelId: string; message: string; tierThinking?: Record<string, string>; modelBaseUrl?: string; reply?: () => Response }) {
    const requests: { url: string; headers: Headers; body: Record<string, any> }[] = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      requests.push({ url: String(url?.url ?? url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
      return options.reply ? options.reply() : anthropicReply("好的，已收到。");
    }) as typeof fetch;
    const runtime = await createPiConversationRuntime({
      peopleDirectory: loadPeopleDirectory(testEnv),
      baseUrl: "https://gw.invalid/v2/llm/responses",
      apiKey: "test-key",
      modelId: options.modelId,
      compactionModelId: "fake-compaction",
      ...(options.modelBaseUrl ? { modelBaseUrl: options.modelBaseUrl } : {}),
      ...(options.tierThinking ? { tierThinking: options.tierThinking as never } : {}),
    });
    let result: unknown;
    try {
      result = await runtime.run({
        scope: "global", viewer: CEO_VIEWER, message: options.message, currentObject: null, referencesSnapshot: [], runtimeEntries: [],
        piSessionId: "22222222-2222-4222-8222-222222222222", signal: new AbortController().signal, emit: () => undefined,
      }).catch((error: Error) => error);
    } finally { await runtime.close?.(); }
    return { requests, result };
  }

  it("快答档走 /anthropic/v1/messages，x-api-key 鉴权，自适应思考 + effort low，不发关思考和 temperature", async () => {
    const { requests, result } = await runOnce({ modelId: "claude-sonnet-5-5", message: "好的" });
    expect(result).toMatchObject({ assistantMessage: "好的，已收到。" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url.split("?")[0]).toBe("https://gw.invalid/v2/llm/anthropic/v1/messages");
    expect(requests[0].headers.get("x-api-key")).toBe("test-key");
    expect(requests[0].body).toMatchObject({ model: "claude-sonnet-5-5", stream: true, thinking: { type: "adaptive" }, output_config: { effort: "low" }, max_tokens: 32_000 });
    expect(requests[0].body.thinking.type).not.toBe("disabled");
    expect(requests[0].body).not.toHaveProperty("temperature");
  });

  it("深度档映射到 effort high；CONVERSATION_THINKING 可以把深度档改成 xhigh", async () => {
    const deep = await runOnce({ modelId: "claude-opus-5-5", message: "请对集团 Token 工厂的竞争格局做一次深度分析" });
    expect(deep.requests[0].body.output_config).toEqual({ effort: "high" });
    const xhigh = await runOnce({ modelId: "claude-sonnet-5-5", message: "请对集团 Token 工厂的竞争格局做一次深度分析", tierThinking: { deep: "xhigh" } });
    expect(xhigh.requests[0].body.output_config).toEqual({ effort: "xhigh" });
  });

  it("gpt-6.1-sol 走覆盖后的 Responses 地址，快答档发 effort low 而不是 none", async () => {
    const { requests } = await runOnce({ modelId: "gpt-6.1-sol", message: "好的", modelBaseUrl: "https://gw.invalid/v2/llm/openai",
      reply: () => new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400, headers: { "content-type": "application/json" } }) });
    expect(requests[0].url).toBe("https://gw.invalid/v2/llm/openai/responses");
    expect(requests[0].body.reasoning).toEqual({ effort: "low" });
  });
});
