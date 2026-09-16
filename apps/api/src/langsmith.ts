import { redactSecrets } from "./observability.js";

/**
 * 最小可选 LangSmith adapter（.tech/02 §13、.tech/07 §7）。
 * 未配置 API key 时完全 no-op；发送失败只 warning，绝不改变 AgentRun 或业务结果。
 */
export type AgentTrace = {
  runId: string;
  name: string;
  agentKind: string;
  promptHash?: string;
  objectRef?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  toolEvents?: unknown[];
  usage?: unknown;
  error?: string;
  status: string;
  startedAt: number;
  durationMs: number;
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

let config: { apiKey?: string; project: string; endpoint: string; fetchImpl?: FetchLike } = {
  project: "warmap",
  endpoint: "https://api.smith.langchain.com",
};

export function configureLangSmith(options: {
  apiKey?: string;
  project?: string;
  endpoint?: string;
  fetchImpl?: FetchLike;
}): void {
  config = {
    apiKey: options.apiKey?.trim() || undefined,
    project: options.project?.trim() || "warmap",
    endpoint: options.endpoint?.trim() || "https://api.smith.langchain.com",
    fetchImpl: options.fetchImpl ?? config.fetchImpl,
  };
}

export async function recordAgentTrace(trace: AgentTrace): Promise<void> {
  if (!config.apiKey) return;
  const send = config.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!send) return;
  try {
    const payload = redactSecrets({
      id: trace.runId,
      name: trace.name,
      run_type: "chain",
      session_name: config.project,
      start_time: new Date(trace.startedAt).toISOString(),
      end_time: new Date(trace.startedAt + trace.durationMs).toISOString(),
      inputs: { agentKind: trace.agentKind, promptHash: trace.promptHash, objectRef: trace.objectRef, input: trace.inputs },
      outputs: trace.outputs,
      error: trace.error,
      extra: { status: trace.status, durationMs: trace.durationMs, toolEvents: trace.toolEvents, usage: trace.usage },
    });
    const response = await send(`${config.endpoint}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.apiKey },
      body: JSON.stringify(payload),
    });
    if (!response.ok) console.warn(`langsmith trace failed: HTTP ${response.status}`);
  } catch (error) {
    console.warn(`langsmith trace failed: ${(error as Error).message}`);
  }
}
