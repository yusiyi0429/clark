import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { candidateModelDefinition, runCandidateAgent } from "../src/candidateAgentRuntime.js";
import { agentModel, agentModelEnvFrom } from "../src/agentModels.js";
import { responsesBaseUrl } from "../src/conversationModel.js";
import { researchTimeoutMs, RESEARCH_THINKING_TIMEOUT_MS } from "../src/researchAgent.js";
import { RESEARCH_TIMEOUT_MS } from "../src/research.js";
import { configureTracing, resetTracing, type TraceClientLike } from "../src/tracing.js";
import { migrate } from "../src/migrate.js";
import { createTestDb } from "./helpers.js";

const Candidate = Type.Object({ summary: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const GATEWAY = "https://gw.invalid/v2/llm/responses";

/** Anthropic SSE：先一段思考摘要，再调用 submit_candidate。 */
function anthropicSubmit(model: string): Response {
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 10 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weighing the options." } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "submit_candidate", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"summary\":\"选择合作\"}" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function captureFetch(reply: (url: string) => Response) {
  const requests: { url: string; headers: Headers; body: Record<string, any> }[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const target = String(url?.url ?? url);
    requests.push({ url: target, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    return reply(target);
  }) as typeof fetch;
  return requests;
}

const stopHere = () => new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400, headers: { "content-type": "application/json" } });

describe("候选 Agent 的模型配置（agentModels.ts）", () => {
  it("每个 Agent 一对变量，不配时用各自原来的模型、不开思考；个人雷达不配时跟公司雷达", () => {
    const env = agentModelEnvFrom({ RESEARCH_MODEL: "claude-opus-5-5", RESEARCH_THINKING: "xhigh", RADAR_MODEL: " deepseek-v4.1-flash ", OUTCOME_THINKING: "medium", PERSONAL_RADAR_MODEL: "" });
    expect(env).toEqual({ research: { model: "claude-opus-5-5", thinking: "xhigh" }, radar: { model: "deepseek-v4.1-flash" }, outcome: { thinking: "medium" } });
    expect(agentModel(env, "research", { modelId: "gpt-5.6-sol" })).toEqual({ modelId: "claude-opus-5-5", thinkingLevel: "xhigh" });
    expect(agentModel(env, "outcome", { modelId: "gpt-5.6-sol" })).toEqual({ modelId: "gpt-5.6-sol", thinkingLevel: "medium" });
    expect(agentModel(env, "personalRadar", { modelId: "gpt-5.6-terra" })).toEqual({ modelId: "deepseek-v4.1-flash", thinkingLevel: "off" });
    expect(agentModel(undefined, "radar", { modelId: "gpt-5.6-terra" })).toEqual({ modelId: "gpt-5.6-terra", thinkingLevel: "off" });
    expect(agentModel(agentModelEnvFrom({ PERSONAL_RADAR_MODEL: "gpt-6-luna", RADAR_MODEL: "x" }), "personalRadar", { modelId: "t" }).modelId).toBe("gpt-6-luna");
  });

  it("思考强度写错直接报错并写明是哪个变量", () => {
    expect(() => agentModel(agentModelEnvFrom({ RESEARCH_THINKING: "max" }), "research", { modelId: "m" })).toThrow(/RESEARCH_THINKING/);
    expect(() => agentModel(agentModelEnvFrom({ RADAR_THINKING: "hgih" }), "personalRadar", { modelId: "m" })).toThrow(/RADAR_THINKING/);
  });

  it("预研开思考或用 Claude 时时限放到 8 分钟，否则仍是原来的 3 分钟", () => {
    expect(researchTimeoutMs({ modelId: "gpt-5.6-sol" })).toBe(RESEARCH_TIMEOUT_MS);
    expect(researchTimeoutMs({ modelId: "gpt-5.6-sol", thinkingLevel: "off" })).toBe(RESEARCH_TIMEOUT_MS);
    expect(researchTimeoutMs({ modelId: "gpt-6.1-sol", thinkingLevel: "high" })).toBe(RESEARCH_THINKING_TIMEOUT_MS);
    expect(researchTimeoutMs({ modelId: "claude-sonnet-5-5", thinkingLevel: "off" })).toBe(RESEARCH_THINKING_TIMEOUT_MS);
  });
});

describe("候选 Agent 的协议与地址（与对话同一套推断）", () => {
  it("gpt-6.1-* 接根地址 + /openai；其他 Responses 模型仍是 PI_BASE_URL", () => {
    expect(responsesBaseUrl("gpt-6.1-sol", GATEWAY)).toBe("https://gw.invalid/v2/llm/openai");
    expect(responsesBaseUrl("gpt-6.1-sol", "https://gw.invalid/v2/llm/openai/responses")).toBe("https://gw.invalid/v2/llm/openai");
    expect(responsesBaseUrl("gpt-5.6-sol", GATEWAY)).toBe("https://gw.invalid/v2/llm");
    expect(responsesBaseUrl("gpt-6-luna", GATEWAY)).toBe("https://gw.invalid/v2/llm");
  });

  it("不开思考的 GPT 注册与 10/13 之前一致：reasoning:false、12.8 万上下文、16k 输出", () => {
    expect(candidateModelDefinition({ modelId: "gpt-5.6-terra", baseUrl: GATEWAY })).toMatchObject({
      id: "gpt-5.6-terra", api: "openai-responses", baseUrl: "https://gw.invalid/v2/llm", reasoning: false, contextWindow: 128_000, maxTokens: 16_384 });
    expect(candidateModelDefinition({ modelId: "gpt-5.6-sol", baseUrl: GATEWAY, thinkingLevel: "high", maxTokens: 32_768 })).toMatchObject({ reasoning: true, maxTokens: 32_768 });
    expect(candidateModelDefinition({ modelId: "claude-opus-5-5", baseUrl: GATEWAY })).toMatchObject({
      api: "anthropic-messages", baseUrl: "https://gw.invalid/v2/llm/anthropic", reasoning: true, maxTokens: 32_000, compat: { forceAdaptiveThinking: true } });
  });
});

describe("候选 Agent 切到 Claude / gpt-6.1-sol 时的真实请求", { timeout: 30_000 }, () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; resetTracing(); });

  const run = (db: { query: any }, modelId: string, extra: Record<string, unknown> = {}) => runCandidateAgent({
    query: db.query.bind(db), kind: "issue-research", objectRef: { type: "issue", id: "0d9e1f2a-1111-4222-8333-444455556666" },
    input: { question: "比较供应链" }, prompt: "只提交候选。", schema: Candidate,
    baseUrl: GATEWAY, apiKey: "test-key", modelId, ...extra,
  });

  it("Claude 走 /anthropic/v1/messages、x-api-key，自适应思考 + effort；不开思考时按 effort low 发，不发关思考和 temperature", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const requests = captureFetch(() => anthropicSubmit("claude-sonnet-5-5"));
      const events: string[] = [];
      const result = await run(db, "claude-sonnet-5-5", { onEvent: (event: { type: string }) => events.push(event.type) });
      expect(result.candidate).toEqual({ summary: "选择合作" });
      expect(requests).toHaveLength(1);
      expect(requests[0].url.split("?")[0]).toBe("https://gw.invalid/v2/llm/anthropic/v1/messages");
      expect(requests[0].headers.get("x-api-key")).toBe("test-key");
      expect(requests[0].body).toMatchObject({ model: "claude-sonnet-5-5", stream: true, thinking: { type: "adaptive" }, output_config: { effort: "low" }, max_tokens: 32_000 });
      expect(requests[0].body).not.toHaveProperty("temperature");
      // 思考摘要照常转成运行事件（会前预审的过程显示用）
      expect(events).toEqual(expect.arrayContaining(["thinking_start", "thinking_delta", "tool_args"]));

      const high = captureFetch(() => anthropicSubmit("claude-opus-5-5"));
      await run(db, "claude-opus-5-5", { thinkingLevel: "xhigh", maxTokens: 32_768 });
      expect(high[0].body).toMatchObject({ model: "claude-opus-5-5", thinking: { type: "adaptive" }, output_config: { effort: "xhigh" }, max_tokens: 32_768 });
    });
  });

  it("gpt-6.1-sol 走 /openai/responses；gpt-5.6 不开思考时不发 reasoning，与原来一致", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const sol61 = captureFetch(stopHere);
      await expect(run(db, "gpt-6.1-sol", { thinkingLevel: "high" })).rejects.toThrow();
      expect(sol61[0].url).toBe("https://gw.invalid/v2/llm/openai/responses");
      expect(sol61[0].body.reasoning).toMatchObject({ effort: "high" });
      const terra = captureFetch(stopHere);
      await expect(run(db, "gpt-5.6-terra")).rejects.toThrow();
      expect(terra[0].url).toBe("https://gw.invalid/v2/llm/responses");
      expect(terra[0].body).not.toHaveProperty("reasoning");
      expect(terra[0].headers.get("authorization")).toBe("Bearer test-key");
    });
  });

  it("注入的 streamSimple 对 Claude 也生效（走 provider 的包装，不落到 pi 内建实现）", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      captureFetch(() => { throw new Error("不应直接请求网关"); });
      const seen: Model<any>[] = [];
      const result = await run(db, "claude-opus-5-5", { streamSimple: (model: Model<any>) => {
        seen.push(model);
        const final: AssistantMessage = { role: "assistant", api: "anthropic-messages", provider: "warmap-anthropic", model: "claude-opus-5-5",
          content: [{ type: "toolCall", id: "s1", name: "submit_candidate", arguments: { summary: "ok" } }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: Date.now() };
        const events = createAssistantMessageEventStream();
        queueMicrotask(() => { events.push({ type: "start", partial: { ...final, content: [] } }); events.push({ type: "done", reason: "toolUse", message: final }); });
        return events;
      } });
      expect(result.candidate).toEqual({ summary: "ok" });
      expect(seen[0]).toMatchObject({ id: "claude-opus-5-5", api: "anthropic-messages", baseUrl: "https://gw.invalid/v2/llm/anthropic" });
    });
  });

  it("追踪打开时 Claude 的每次真实请求都有 llm 节点（model:pi/claude-*），usage 来自网关返回", async () => {
    const creates: Record<string, any>[] = [];
    const updates: Record<string, any>[] = [];
    const client: TraceClientLike = {
      async createRun(value) { creates.push(structuredClone(value)); },
      async updateRun(id, value) { updates.push({ id, ...structuredClone(value) }); },
    };
    configureTracing({ enabled: true, client, salt: "s" });
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const requests = captureFetch(() => anthropicSubmit("claude-sonnet-5-5"));
      await run(db, "claude-sonnet-5-5", { kind: "meeting_preflight", objectRef: { type: "meeting", id: "0d9e1f2a-1111-4222-8333-444455556666" } });
      expect(requests).toHaveLength(1);
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      const byId = new Map<string, Record<string, any>>();
      for (const value of creates) byId.set(value.id, { ...value });
      for (const value of updates) byId.set(value.id, { ...byId.get(value.id), ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) });
      const runs = [...byId.values()];
      const llm = runs.filter((value) => value.run_type === "llm");
      expect(llm.map((value) => value.name)).toEqual(["model:pi/claude-sonnet-5-5"]);
      expect(llm[0].extra.metadata).toMatchObject({ ls_provider: "pi", ls_model_name: "claude-sonnet-5-5", agent_role: "preflight-agent" });
      expect(llm[0].outputs.usage_metadata).toMatchObject({ output_tokens: 12, input_token_details: { cache_read: 10 } });
      expect(runs.some((value) => value.name === "tool:submit_candidate")).toBe(true);
      expect(JSON.stringify([...creates, ...updates])).not.toContain("test-key");
    });
  });
});
