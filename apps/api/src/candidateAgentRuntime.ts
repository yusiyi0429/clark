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

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/responses$/, "");
}

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export async function runCandidateAgent<T extends TSchema>(options: {
  query: Query;
  kind: string;
  objectRef?: { type: string; id: string; version?: number };
  input: unknown;
  prompt: string;
  schema: T;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  signal?: AbortSignal;
  streamSimple?: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
}): Promise<{ runId: string; candidate: Static<T> }> {
  const runId = randomUUID();
  const promptHash = createHash("sha256").update(options.prompt).digest("hex");
  await options.query(
    `INSERT INTO agent_runs (id, kind, object_ref, status, model_slot, prompt_hash, input_snapshot)
     VALUES ($1, $2, $3::jsonb, 'running', 'heavy', $4, $5::jsonb)`,
    [runId, options.kind, JSON.stringify(options.objectRef ?? null), promptHash, JSON.stringify(options.input)],
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
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider("warmap", {
      name: "WarMap OpenAI-compatible Responses",
      baseUrl: normalizedBaseUrl(options.baseUrl),
      api: "openai-responses",
      streamSimple: options.streamSimple,
      models: [{
        id: options.modelId,
        name: options.modelId,
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      }],
    });
    await modelRuntime.setRuntimeApiKey("warmap", options.apiKey);
    const model = modelRuntime.getModel("warmap", options.modelId);
    if (!model) throw new Error(`Pi model not found: warmap/${options.modelId}`);

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
      customTools: [submitCandidate],
      tools: ["submit_candidate"],
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      thinkingLevel: "off",
    }));
    abortAfterSubmit = () => session!.abort();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage.totalTokens > usageTokens) {
        usage = event.message.usage;
        usageTokens = event.message.usage.totalTokens;
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
    return { runId, candidate };
  } catch (cause) {
    const error = (cause as Error).message || String(cause);
    await options.query(
      `UPDATE agent_runs
          SET status = $2, error = $3, usage = $4::jsonb, completed_at = now()
        WHERE id = $1`,
      [runId, options.signal?.aborted ? "aborted" : "failed", error, JSON.stringify(usage ?? null)],
    );
    throw cause;
  } finally {
    session?.dispose();
  }
}
