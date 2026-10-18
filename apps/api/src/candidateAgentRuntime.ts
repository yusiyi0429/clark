import { createHash, randomUUID } from "node:crypto";
import type { QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { logEvent } from "./observability.js";
import { preview, traceTools, tracedCandidateAgent, tracedStreamSimple, tracingEnabled } from "./tracing.js";
import { conversationModelDefinition, type ConversationModelDefinition } from "./conversationModel.js";

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/responses$/, "");
}

/** Claude（Anthropic 协议）单独注册一个 provider：pi 只在模型协议与 provider 协议一致时才走 provider 的 streamSimple（追踪包装在那里）。 */
const ANTHROPIC_PROVIDER = "warmap-anthropic";

/**
 * 候选 Agent 的模型注册信息，协议与地址推断与对话主答同一套（conversationModel.ts）：
 * - claude-*：Anthropic 协议，根地址 + /anthropic，自适应思考 + effort；Sonnet / Opus 5.5 不能关思考，「off」按 effort low 发；
 * - gpt-6.1-*：Responses，根地址 + /openai；
 * - 其余（gpt-5.6、deepseek 等）：Responses，PI_BASE_URL，与 10/13 之前完全一样——不开思考时 reasoning:false（不发 reasoning 参数）。
 */
export function candidateModelDefinition(input: { modelId: string; baseUrl: string; thinkingLevel?: CandidateThinkingLevel; maxTokens?: number }): ConversationModelDefinition {
  const definition = conversationModelDefinition({ modelId: input.modelId, baseUrl: normalizedBaseUrl(input.baseUrl) });
  // Claude 一律不发关思考：Sonnet / Opus 5.5 关思考是 400；Haiku 5.5 虽然接受，10/13 雷达实测关掉后 4 批里有 3 批没交候选，保持 off → effort low。
  if (definition.api === "anthropic-messages") return { ...definition, maxTokens: input.maxTokens ?? definition.maxTokens };
  return { ...definition, reasoning: (input.thinkingLevel ?? "off") !== "off", contextWindow: 128_000, maxTokens: input.maxTokens ?? 16_384 };
}

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/** 候选 Agent 运行中的事件（给需要显示过程的场景用，如会前预审）：思考、工具调用、submit_candidate 的流式参数。 */
export type CandidateAgentEvent =
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; isError: boolean; result: unknown }
  /** 工具参数边写边解析出的部分对象；final=true 是整份参数写完。 */
  | { type: "tool_args"; name: string; args: unknown; final?: boolean };

export type CandidateThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type CandidateAgentOptions<T extends TSchema> = {
  query: Query;
  kind: string;
  objectRef?: { type: string; id: string; version?: number };
  /** 这次 run 属于谁：只以 anon_user_id 进入 LangSmith，系统/公司级 run 不传。 */
  personId?: string;
  /** 历史参数，不再发送到轨迹。 */
  personName?: string;
  /** 覆盖按 objectRef 推出的轨迹 scope（如 plan:2026-10）。 */
  traceScope?: string;
  input: unknown;
  prompt: string;
  schema: T;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelSlot?: "light" | "heavy";
  /** 只读辅助工具（如 CompanyMemory MCP）：与 submit_candidate 一同进入工具白名单。 */
  extraTools?: ReturnType<typeof defineTool<any>>[];
  signal?: AbortSignal;
  /** 本次运行最多调用模型几次；不给时不限。 */
  maxModelCalls?: number;
  /**
   * 打开思考（模型注册为 reasoning，thinkingLevel 映射到 reasoning.effort）。不给时关闭，与原来一致。
   * Claude 走 Anthropic 协议的 adaptive + output_config.effort；Sonnet / Opus 5.5 不能关思考，off 按 effort low 发。
   */
  thinkingLevel?: CandidateThinkingLevel;
  /** 单次输出 token 上限；不给时 16384。 */
  maxTokens?: number;
  /** 运行事件；回调里抛错不影响运行。 */
  onEvent?: (event: CandidateAgentEvent) => void;
  streamSimple?: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
};

export async function runCandidateAgent<T extends TSchema>(options: CandidateAgentOptions<T>): Promise<{ runId: string; candidate: Static<T> }> {
  if (!tracingEnabled()) return runCandidateAgentUntraced(options);
  return tracedCandidateAgent(
    { query: options.query, kind: options.kind, objectRef: options.objectRef, scope: options.traceScope, personId: options.personId,
      inputs: { kind: options.kind, input: preview(options.input) } },
    () => runCandidateAgentUntraced(options),
    (result) => ({ candidate: result.candidate }),
  );
}

async function runCandidateAgentUntraced<T extends TSchema>(options: CandidateAgentOptions<T>): Promise<{ runId: string; candidate: Static<T> }> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const promptHash = createHash("sha256").update(options.prompt).digest("hex");
  await options.query(
    `INSERT INTO agent_runs (id, kind, object_ref, status, model_slot, prompt_hash, input_snapshot)
     VALUES ($1, $2, $3::jsonb, 'running', $4, $5, $6::jsonb)`,
    [runId, options.kind, JSON.stringify(options.objectRef ?? null), options.modelSlot ?? "heavy", promptHash, JSON.stringify(options.input)],
  );

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };

  let candidate: Static<T> | undefined;
  let abortAfterSubmit: (() => Promise<void>) | undefined;
  let usage: unknown;
  let usageTokens = -1;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const thinking = options.thinkingLevel ?? "off";
  const emit = (event: CandidateAgentEvent) => { try { options.onEvent?.(event); } catch { /* 过程显示失败不影响候选 */ } };
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const definition = candidateModelDefinition({ modelId: options.modelId, baseUrl: options.baseUrl, thinkingLevel: thinking, maxTokens: options.maxTokens });
    const anthropic = definition.api === "anthropic-messages";
    const provider = anthropic ? ANTHROPIC_PROVIDER : "warmap";
    // 两种协议都经过追踪包装：追踪启用时每次真实模型请求一个 llm 节点（Claude 不能落到 pi 内建实现上绕过它）。
    modelRuntime.registerProvider(provider, {
      name: anthropic ? "WarMap Anthropic Messages" : "WarMap OpenAI-compatible Responses",
      baseUrl: definition.baseUrl,
      api: definition.api,
      streamSimple: tracedStreamSimple(options.streamSimple),
      models: [definition],
    });
    // 模型调用次数上限（PR #12）：结构化提交反复不合规时不无限重试。
    if (options.maxModelCalls !== undefined) {
      const stream = modelRuntime.streamSimple.bind(modelRuntime);
      let modelCalls = 0;
      modelRuntime.streamSimple = (providerModel, context, streamOptions) => {
        if (++modelCalls > options.maxModelCalls!) throw new Error("CANDIDATE_MODEL_BUDGET_EXHAUSTED");
        return stream(providerModel, context, streamOptions);
      };
    }
    await modelRuntime.setRuntimeApiKey(provider, options.apiKey);
    const model = modelRuntime.getModel(provider, options.modelId);
    if (!model) throw new Error(`Pi model not found: ${provider}/${options.modelId}`);

    const submitCandidate = defineTool({
      name: "submit_candidate",
      label: "Submit candidate",
      description: "提交唯一的结构化候选并结束本轮；散文输出不会被保存",
      parameters: options.schema,
      execute: async (_id, value) => {
        if (!Value.Check(options.schema, value)) throw new Error("submit_candidate schema validation failed");
        candidate = structuredClone(value) as Static<T>;
        queueMicrotask(() => { void abortAfterSubmit?.(); });
        return { content: [{ type: "text" as const, text: "candidate accepted" }], details: {} };
      },
    });
    ({ session } = await createAgentSession({
      model,
      modelRuntime,
      resourceLoader,
      customTools: traceTools([submitCandidate, ...(options.extraTools ?? [])]),
      tools: ["submit_candidate", ...(options.extraTools ?? []).map((tool) => tool.name)],
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      thinkingLevel: thinking,
    }));
    abortAfterSubmit = () => session!.abort();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage.totalTokens > usageTokens) {
        usage = event.message.usage;
        usageTokens = event.message.usage.totalTokens;
      }
      if (!options.onEvent) return;
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_start") emit({ type: "thinking_start" });
        else if (update.type === "thinking_delta") emit({ type: "thinking_delta", delta: update.delta });
        else if (update.type === "toolcall_delta" || update.type === "toolcall_end") {
          const block = update.type === "toolcall_end" ? update.toolCall : update.partial.content[update.contentIndex];
          if (block?.type === "toolCall") emit({ type: "tool_args", name: block.name, args: block.arguments, final: update.type === "toolcall_end" });
        }
      } else if (event.type === "tool_execution_start") {
        emit({ type: "tool_start", toolCallId: event.toolCallId, name: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        emit({ type: "tool_end", toolCallId: event.toolCallId, name: event.toolName, isError: event.isError, result: event.result });
      }
    });
    const onAbort = () => void session!.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(JSON.stringify({ input: options.input }), { expandPromptTemplates: false, source: "rpc" });
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }
    if (!candidate) throw new Error("Candidate agent did not call submit_candidate");
    await options.query(
      `UPDATE agent_runs
          SET status = 'succeeded', candidate_output = $2::jsonb, usage = $3::jsonb, completed_at = now()
        WHERE id = $1`,
      [runId, JSON.stringify(candidate), JSON.stringify(usage ?? null)],
    );
    logBatchRun({ runId, kind: options.kind, modelId: options.modelId, objectRef: options.objectRef, startedAt, status: "succeeded" });
    return { runId, candidate };
  } catch (cause) {
    const error = (cause as Error).message || String(cause);
    await options.query(
      `UPDATE agent_runs
          SET status = $2, error = $3, usage = $4::jsonb, completed_at = now()
        WHERE id = $1`,
      [runId, options.signal?.aborted ? "aborted" : "failed", error, JSON.stringify(usage ?? null)],
    );
    const status = options.signal?.aborted ? "aborted" : "failed";
    logBatchRun({ runId, kind: options.kind, modelId: options.modelId, objectRef: options.objectRef, startedAt, status, error });
    throw cause;
  } finally {
    session?.dispose();
  }
}

function logBatchRun(input: {
  runId: string;
  kind: string;
  modelId: string;
  objectRef?: { type: string; id: string; version?: number };
  startedAt: number;
  status: string;
  error?: string;
}): void {
  logEvent({
    event: "agent.run",
    runId: input.runId,
    agentKind: input.kind,
    objectRef: input.objectRef ? `${input.objectRef.type}:${input.objectRef.id}` : undefined,
    provider: "warmap",
    model: input.modelId,
    durationMs: Date.now() - input.startedAt,
    status: input.status,
    errorCode: input.error ? input.status.toUpperCase() : undefined,
    error: input.error,
  });
}
