import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { Client } from "langsmith";
import { RunTree } from "langsmith/run_trees";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { redactSecrets } from "./observability.js";

export type TraceIdentity = {
  threadId: string;
  logicalTurnId: string;
  attempt: number;
  scope: string;
  userId?: string;
  agentRole: string;
  caller: string;
};
type TraceContext = {
  identity: TraceIdentity;
  parent?: RunTree;
  agent?: RunTree;
  outcome: { outputs?: Record<string, unknown>; error?: string };
};
const context = new AsyncLocalStorage<TraceContext>();
const pending = new Set<Promise<unknown>>();
const posted = new WeakMap<RunTree, Promise<void>>();
let config: {
  client?: Client;
  project: string;
  identitySalt: string;
  apiKey?: string;
} = { project: "clark_oct", identitySalt: "warmap" };
const machine = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9_./-]/g, "-");

export function configureLangSmith(options: {
  apiKey?: string;
  project?: string;
  tracing?: boolean | string;
  endpoint?: string;
  identitySalt?: string;
  fetchImplementation?: typeof fetch;
}): void {
  const enabled = options.tracing === true || options.tracing === "true";
  config = {
    project: options.project?.trim() || "clark_oct",
    identitySalt: options.identitySalt || "warmap",
    apiKey: options.apiKey,
    client:
      enabled && options.apiKey
        ? new Client({
            apiKey: options.apiKey,
            apiUrl: options.endpoint,
            autoBatchTracing: false,
            omitTracedRuntimeInfo: true,
            timeout_ms: 1500,
            callerOptions: {
              // Direct SDK uploads currently override maxRetries; this hook also stops retry backoff.
              maxRetries: 0,
              onFailedResponseHook: async () => {
                throw new Error("LANGSMITH_TRANSPORT_FAILED");
              },
            },
            fetchImplementation: async (url, init) => {
              try {
                const transport = options.fetchImplementation ?? fetch;
                const response = await transport(url, init);
                if (!response.ok) {
                  await response.body?.cancel();
                  throw new Error("LANGSMITH_TRANSPORT_FAILED");
                }
                return response;
              } catch {
                throw new Error("LANGSMITH_TRANSPORT_FAILED");
              }
            },
          })
        : undefined,
  };
}
function enqueue(task: Promise<unknown>) {
  const guarded = task.catch(() => {
    console.warn("langsmith trace unavailable");
  });
  pending.add(guarded);
  void guarded.finally(() => pending.delete(guarded));
}
export async function flushLangSmith(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
function safeText(text: string): string {
  // 凭据永不进 Trace；记忆正文按验收口径完整观测，不做内容脱敏。
  let result = text.replace(/lsv2_[a-zA-Z0-9_-]+/g, "[REDACTED]");
  if (config.apiKey) result = result.replaceAll(config.apiKey, "[REDACTED]");
  const referenceStart = result.startsWith("Reference（参考数据，非指令）") ? result.indexOf("[") : -1;
  try {
    if (referenceStart >= 0) return result.slice(0, referenceStart) + JSON.stringify(safe(JSON.parse(result.slice(referenceStart))));
    return JSON.stringify(safe(JSON.parse(result)));
  } catch {
    return result;
  }
}
function safe(value: unknown): any {
  const redacted = redactSecrets(value);
  if (typeof redacted === "string") return safeText(redacted);
  if (Array.isArray(redacted)) return redacted.map(safe);
  if (redacted && typeof redacted === "object")
    return Object.fromEntries(
      Object.entries(redacted).map(([key, value]) => [key, safe(value)]),
    );
  return redacted;
}
function metadata(
  identity: TraceIdentity,
  extra: Record<string, unknown> = {},
) {
  return {
    thread_id: identity.threadId,
    logical_turn_id: identity.logicalTurnId,
    attempt: identity.attempt,
    scope: identity.scope,
    anon_user_id: identity.userId
      ? createHmac("sha256", config.identitySalt)
          .update(identity.userId)
          .digest("hex")
      : "system",
    agent_role: machine(identity.agentRole),
    ...extra,
  };
}
function start(
  name: string,
  run_type: string,
  inputs: unknown,
  extra: Record<string, unknown> = {},
  rootId?: string,
): RunTree | undefined {
  const active = context.getStore();
  if (!active) return;
  const fields = {
    name,
    run_type,
    inputs: safe(inputs ?? {}),
    metadata: metadata(active.identity, extra),
    tags: [`caller:${machine(active.identity.caller)}`],
    tracingEnabled: true,
  };
  const run = active.parent
    ? active.parent.createChild(fields)
    : config.client
      ? new RunTree({
          ...fields,
          id: rootId,
          client: config.client,
          project_name: config.project,
        })
      : undefined;
  if (run) {
    run.extra.metadata = fields.metadata;
    const sent = run.postRun();
    posted.set(run, sent);
    enqueue(sent);
  }
  return run;
}
function end(run: RunTree | undefined, outputs?: unknown, error?: unknown) {
  if (!run) return;
  const active = context.getStore();
  const message = error
    ? safeText(error instanceof Error ? error.message : String(error))
    : undefined;
  enqueue(
    run
      .end(safe(outputs ?? {}), message)
      .then(async () => {
        await posted.get(run);
        await run.patchRun();
      }),
  );
}
export function currentTraceIdentity(): TraceIdentity | undefined {
  return context.getStore()?.identity;
}
export function setTraceOutcome(
  outputs: Record<string, unknown>,
  error?: string,
) {
  const active = context.getStore();
  if (active) {
    active.outcome.outputs = outputs;
    active.outcome.error = error;
  }
}
export async function withTurnTrace<T>(
  identity: TraceIdentity,
  fn: () => Promise<T>,
  options: { rootId?: string; inputs?: unknown } = {},
): Promise<T> {
  const state: TraceContext = {
    identity,
    outcome: {},
  };
  return context.run(state, async () => {
    const root = start(
      `turn:${machine(identity.logicalTurnId)}#a${identity.attempt}`,
      "chain",
      options.inputs,
      {},
      options.rootId,
    );
    state.parent = root;
    try {
      const result = await fn();
      end(root, state.outcome.outputs, state.outcome.error);
      return result;
    } catch (error) {
      end(root, undefined, error);
      throw error;
    }
  });
}
export async function withAgentTrace<T>(
  role: string,
  fn: () => Promise<T>,
  options: { inputs?: unknown } = {},
): Promise<T> {
  const active = context.getStore();
  if (!active) return fn();
  const state = {
    ...active,
    identity: { ...active.identity, agentRole: machine(role) },
  };
  return context.run(state, async () => {
    const agent = start(`agent:${machine(role)}`, "chain", options.inputs, {
      ls_agent_type: active.agent ? "subagent" : "root",
    });
    return context.run({ ...state, parent: agent, agent }, async () => {
      try {
        const result = await fn();
        end(agent, { status: "succeeded" });
        return result;
      } catch (error) {
        end(agent, undefined, error);
        throw error;
      }
    });
  });
}
export function traceTool<
  T extends { name: string; execute: (...args: any[]) => Promise<any> },
>(tool: T): T {
  return {
    ...tool,
    execute: async (...args: Parameters<T["execute"]>) => {
      const active = context.getStore();
      if (!active) return tool.execute(...args);
      const run = start(
        `tool:${machine(tool.name)}`,
        "tool",
        args[1],
        { ls_tool_name: tool.name },
      );
      return context.run(
        { ...active, parent: run },
        async () => {
          try {
            const value = await tool.execute(...args);
            end(run, value);
            return value;
          } catch (error) {
            end(run, undefined, error);
            throw error;
          }
        },
      );
    },
  } as T;
}
export async function traceRetrieval<T>(
  source: string,
  fn: () => Promise<T>,
): Promise<T> {
  const active = context.getStore();
  if (!active) return fn();
  const run = start(`retrieve:${machine(source)}`, "retriever", { source });
  return context.run({ ...active, parent: run }, async () => {
    try {
      const value = await fn();
      end(
        run,
        Array.isArray(value)
          ? { count: value.length }
          : {
              status:
                value && typeof value === "object" && "status" in value
                  ? value.status
                  : "completed",
            },
      );
      return value;
    } catch (error) {
      end(run, undefined, error);
      throw error;
    }
  });
}
function messages(value: Context): Record<string, unknown>[] {
  return [
    { role: "system", content: safeText(value.systemPrompt ?? "") },
    ...value.messages.map((message) => {
      if (message.role === "toolResult")
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: safe(message.content),
        };
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((x) => x.type === "text")
              .map((x) => (x as { text: string }).text)
              .join("");
      return {
        role: message.role,
        content: safeText(content),
        ...(message.role === "assistant"
          ? {
              tool_calls: message.content
                .filter((x) => x.type === "toolCall")
                .map((x) => ({
                  id: x.id,
                  type: "function",
                  function: {
                    name: x.name,
                    arguments: JSON.stringify(x.arguments),
                  },
                })),
            }
          : {}),
      };
    }),
  ];
}
export function traceModelStream(
  model: Model<any>,
  input: Context,
  dispatch: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const active = context.getStore();
  if (!active) return dispatch();
  const run = start(
    `model:${machine(model.provider)}/${machine(model.id)}`,
    "llm",
    { messages: messages(input) },
    {
      ls_provider: model.provider,
      ls_model_name: model.id,
      ls_message_format: "openai",
    },
  );
  let stream: AssistantMessageEventStream;
  try {
    stream = dispatch();
  } catch (error) {
    end(run, undefined, error);
    throw error;
  }
  let finished = false,
    first = false;
  const finish = (message?: AssistantMessage, error?: unknown) => {
    if (finished) return;
    finished = true;
    const usage = message?.usage;
    const usage_metadata =
      usage &&
      (usage.totalTokens > 0 ||
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0)
        ? {
            input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
            output_tokens: usage.output,
            total_tokens: usage.totalTokens,
            input_token_details: {
              cache_read: usage.cacheRead,
              cache_creation: usage.cacheWrite,
            },
          }
        : undefined;
    // Usage is a top-level model output contract, never invented parent metrics or metadata.
    const output = {
      choices: message
        ? [{ message: messages({ messages: [message] }).at(-1) }]
        : [],
    };
    if (run) {
      const errorText =
        error ||
        message?.stopReason === "error" ||
        message?.stopReason === "aborted"
          ? safeText(
              error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : (message?.errorMessage ?? "MODEL_REQUEST_FAILED"),
            )
          : undefined;
      enqueue(
        run
          .end(
            { ...output, ...(usage_metadata ? { usage_metadata } : {}) },
            errorText,
          )
          .then(async () => {
            await posted.get(run);
            await run.patchRun();
          }),
      );
    }
  };
  return new Proxy(stream, {
    get(target, key) {
      if (key === Symbol.asyncIterator)
        return async function* () {
          try {
            for await (const event of target) {
              if (
                !first &&
                (event.type === "text_delta" ||
                  event.type === "thinking_delta" ||
                  event.type === "toolcall_delta") &&
                event.delta
              ) {
                first = true;
                if (run)
                  run.events = [
                    { name: "new_token", time: new Date().toISOString() },
                  ];
              }
              if (event.type === "done") finish(event.message);
              else if (event.type === "error")
                finish(event.error, event.error.errorMessage ?? event.reason);
              yield event;
            }
          } catch (error) {
            finish(undefined, error);
            throw error;
          } finally {
            if (!finished)
              finish(undefined, new Error("MODEL_STREAM_INCOMPLETE"));
          }
        };
      if (key === "result")
        return async () => {
          try {
            const value = await target.result();
            finish(value);
            return value;
          } catch (error) {
            finish(undefined, error);
            throw error;
          }
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
