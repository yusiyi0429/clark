/**
 * LangSmith Span 级轨迹（docs/superpowers/specs/2026-10-13-langsmith-tracing.md）。
 *
 * 层级对应扣子罗盘「根节点—Agent 步骤—原子步骤」：
 *   root   turn:{logical_turn_id}#a{attempt}   run_type chain   业务 Turn 的一次执行段
 *   agent  agent:{agent_role}                  run_type chain   ls_agent_type root / subagent
 *   model  model:{provider}/{model_id}         run_type llm     每次真实模型请求一个
 *   tool   tool:{tool_name}                    run_type tool    每次真实工具执行一个
 *   检索   retrieve:{source}                   run_type retriever
 *
 * 约束：
 * - LANGSMITH_TRACING 不是 "true" 时完全不发送：不建 RunTree、不建 Client、不查库，包装函数直接透传。
 * - metadata 只有 METADATA_KEYS 里的键；用户只以 anon_user_id（带盐 HMAC）出现，接入方用 tags（client:*）。
 * - token 与首 token 只来自模型真实返回 / 真实 delta 事件；缺失就缺失。
 * - 根节点与 Agent 节点按需物化：第一个真实子步骤出现时才发送（开始时间仍是真实开始时间），
 *   没有任何真实步骤的 Turn（如雷达被占用、听写句子无需整理）不留空轨迹。
 * - 追踪本身的任何失败只 warning，绝不影响请求；发送走 SDK 异步批量队列，超时丢弃。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client, RunTree, uuid7 } from "langsmith";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { redactSecrets } from "./observability.js";

// ───────────────────────────── 命名常量 ─────────────────────────────

/** 全部 Agent 角色：run 名为 `agent:<role>`，metadata.agent_role 同值。新增 Agent 只在这里加。 */
export const AGENT_ROLES = {
  ceoAgent: "ceo-agent",
  driAgent: "dri-agent",
  preflight: "preflight-agent",
  research: "research-agent",
  meetingOutcome: "outcome-agent",
  radarAssess: "radar-assess",
  personalRadarAssess: "personal-radar-assess",
  dictationPolish: "dictation-polish",
  monthlyDraft: "monthly-draft-agent",
  monthlyReviewDraft: "monthly-review-draft",
  monthlyReviewAssess: "monthly-review-assess",
  monthlyReviewSummary: "monthly-review-summary",
  personalReviewDraft: "personal-review-draft",
  missionCardDraft: "mission-card-draft-agent",
  missionCardDraftCheck: "mission-card-draft-check",
  missionCardAnnotation: "mission-card-annotation",
  missionCardCombinationReview: "mission-card-combination-review",
  materialAnnotation: "material-annotation",
  battlefieldSync: "battlefield-sync",
  taskAcceptanceDraft: "task-acceptance-draft",
  threadIntro: "thread-intro",
  /** 对话历史的后台压缩（conversationCompaction.ts）：挂在这段对话同一个 Thread 下，自成一个 Turn。 */
  conversationCompaction: "conversation-compaction",
} as const;
export type AgentRole = (typeof AGENT_ROLES)[keyof typeof AGENT_ROLES] | string;

/** 真实检索来源：run 名为 `retrieve:<source>`。 */
export const RETRIEVE_SOURCES = {
  contextPack: "context-pack",
  companyMemory: "company-memory",
  peopleDirectory: "people-directory",
  webSearch: "web-search",
  outletFeed: "outlet-feed",
  wechatFeed: "wechat-feed",
} as const;
export type RetrieveSource = (typeof RETRIEVE_SOURCES)[keyof typeof RETRIEVE_SOURCES];

/** 模型供应方（run 名 `model:<provider>/<model_id>`、metadata.ls_provider）。 */
export const MODEL_PROVIDERS = {
  /** PI_BASE_URL 的 OpenAI 兼容 Responses 网关（LIGHT_MODEL / HEAVY_MODEL / COMPACTION_MODEL）。 */
  pi: "pi",
  /** 火山方舟（听写整理）。 */
  ark: "ark",
} as const;

/** 接入方：只用 LangSmith tags 表达（metadata 白名单里没有接入方键）。 */
export const CLIENT_TAGS = {
  web: "client:web",
  mcp: "client:mcp",
  feishu: "client:feishu",
  demo: "client:demo",
  /** 定时任务、启动补跑等没有外部请求来源的后台执行。 */
  system: "client:system",
} as const;
export type ClientTag = (typeof CLIENT_TAGS)[keyof typeof CLIENT_TAGS];

/** metadata 白名单：业务关联 + LangSmith 契约。任何 Run 只会带这些键。 */
export const METADATA_KEYS = [
  "thread_id", "logical_turn_id", "attempt", "scope", "anon_user_id", "agent_role",
  "ls_agent_type", "ls_provider", "ls_model_name", "ls_tool_name", "ls_message_format",
  // 这一轮走过恢复（conversationRecovery.ts）：原模型、实际完成的备用模型、触发原因、各类恢复、合计重试次数。只出现在 Turn 根节点上。
  "recovery_original_model", "recovery_fallback_model", "recovery_reasons", "recovery_actions", "recovery_retries",
] as const;
export type MetadataKey = (typeof METADATA_KEYS)[number];
type Metadata = Partial<Record<MetadataKey, string | number>>;
const METADATA_KEY_SET = new Set<string>(METADATA_KEYS);

/** 机器可解析的 run 名：全小写、冒号分段，不含中文与业务自由文本。 */
export const RUN_NAME_PATTERN = /^(turn:[a-z0-9][a-z0-9-]*#a[1-9][0-9]*|agent:[a-z0-9][a-z0-9-]*|model:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*|tool:[a-z0-9][a-z0-9_.-]*|retrieve:[a-z0-9][a-z0-9-]*)$/;

/** 名字里的一个段：小写，[a-z0-9._/-] 以外的字符（含中文、空格、下划线）换成「-」。 */
export function nameSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^[-./]+|[-./]+$/g, "") || "unknown";
}

/** 只含 [a-z0-9-] 的段（Turn id、Agent 角色）。 */
function dashSegment(value: string): string {
  return nameSegment(value).replace(/[._/]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export const runNames = {
  turn: (logicalTurnId: string, attempt: number) => `turn:${dashSegment(logicalTurnId)}#a${Math.max(1, Math.floor(attempt))}`,
  agent: (role: AgentRole) => `agent:${dashSegment(role)}`,
  model: (provider: string, modelId: string) => `model:${dashSegment(provider)}/${nameSegment(modelId)}`,
  // 工具注册名本身是 snake_case（web_search），保留下划线。
  tool: (toolName: string) => `tool:${toolName.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "") || "unknown"}`,
  retrieve: (source: RetrieveSource) => `retrieve:${source}`,
};

/** 业务对象 id 的短形式（logical_turn_id 用）：uuid 取前 8 位，其它（含中文名）取 sha256 前 8 位。 */
export function shortId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8).toLowerCase() : createHash("sha256").update(id).digest("hex").slice(0, 8);
}

/** scope 里的 id：本身是机器 id 就原样保留，否则（中文名、带空格）换成 h<sha8>。 */
export function scopeId(id: string): string {
  return /^[A-Za-z0-9._-]{1,80}$/.test(id) ? id : `h${shortId(id)}`;
}

/** 业务对象 → scope；人员相关对象只用 anon_user_id，不发送真实 personId。 */
export function scopeOf(objectRef?: { type: string; id: string }): string {
  if (!objectRef) return "global";
  const type = nameSegment(objectRef.type);
  if (type === "person" || type === "person-radar") return `person:${anonUserId(objectRef.id) ?? "unknown"}`;
  if (type === "global") return "global";
  return `${type}:${scopeId(objectRef.id)}`;
}

// ───────────────────────────── 配置 ─────────────────────────────

/** SDK Client 的最小子集：测试注入 fake，真实环境是 langsmith Client。 */
export type TraceClientLike = {
  createRun(run: Record<string, any>, options?: unknown): Promise<void>;
  updateRun(runId: string, run: Record<string, any>, options?: unknown): Promise<void>;
};

type TracingConfig = { enabled: false } | { enabled: true; client: TraceClientLike; project: string; salt: string };
let config: TracingConfig | undefined;

const DEFAULT_SALT_FILE = join(import.meta.dirname, "..", "..", "..", ".data", "trace-anon-salt");

/** 盐：TRACE_ANON_SALT → 本地 .data/trace-anon-salt（首次生成，git 忽略）→ 部署实例固定值。不打印。 */
function resolveSalt(env: Record<string, string | undefined>): string {
  const fromEnv = env.TRACE_ANON_SALT?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(DEFAULT_SALT_FILE, "utf8").trim() || "";
  } catch {
    try {
      const generated = randomBytes(32).toString("hex");
      mkdirSync(dirname(DEFAULT_SALT_FILE), { recursive: true });
      writeFileSync(DEFAULT_SALT_FILE, `${generated}\n`, { mode: 0o600, flag: "wx" });
      return generated;
    } catch {
      try { return readFileSync(DEFAULT_SALT_FILE, "utf8").trim(); } catch { /* fall through */ }
    }
  }
  return "tkos-inception-trace-anon-v1";
}

/**
 * 读取开关。默认从 process.env 读：LANGSMITH_TRACING=true 且有 LANGSMITH_API_KEY 才启用；
 * 测试传 { enabled: true, client: fake }。
 */
export function configureTracing(options: {
  enabled?: boolean;
  client?: TraceClientLike;
  project?: string;
  salt?: string;
  env?: Record<string, string | undefined>;
} = {}): void {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? env.LANGSMITH_TRACING?.trim().toLowerCase() === "true";
  if (!enabled) {
    config = { enabled: false };
    return;
  }
  try {
    let client = options.client;
    if (!client) {
      const apiKey = env.LANGSMITH_API_KEY?.trim();
      if (!apiKey) {
        console.warn("langsmith tracing disabled: LANGSMITH_API_KEY is missing");
        config = { enabled: false };
        return;
      }
      client = new Client({
        apiKey,
        apiUrl: env.LANGSMITH_ENDPOINT?.trim() || undefined,
        // 发送失败或超时只丢弃本批，不阻塞业务；不带运行环境信息，metadata 只有白名单键。
        timeout_ms: 10_000,
        autoBatchTracing: true,
        omitTracedRuntimeInfo: true,
        blockOnRootRunFinalization: false,
        callerOptions: { maxRetries: 1, maxConcurrency: 4 },
      }) as unknown as TraceClientLike;
    }
    config = { enabled: true, client, project: options.project ?? (env.LANGSMITH_PROJECT?.trim() || "default"), salt: options.salt ?? resolveSalt(env) };
  } catch (error) {
    console.warn(`langsmith tracing disabled: ${(error as Error).message}`);
    config = { enabled: false };
  }
}

function current(): TracingConfig {
  if (!config) configureTracing();
  return config!;
}

export function tracingEnabled(): boolean {
  return current().enabled;
}

/** 测试用：下次使用时重新从环境读取。 */
export function resetTracing(): void {
  config = undefined;
}

/** 等 SDK 队列发完（验证脚本用）；未启用或不支持时直接返回。 */
export async function flushTracing(): Promise<void> {
  const cfg = current();
  if (!cfg.enabled) return;
  const client = cfg.client as TraceClientLike & { awaitPendingTraceBatches?: () => Promise<void> };
  await client.awaitPendingTraceBatches?.().catch(() => undefined);
}

/** personId / principal → 带盐 HMAC；未启用时不计算。 */
export function anonUserId(personId: string | undefined): string | undefined {
  const cfg = current();
  if (!personId || !cfg.enabled) return undefined;
  return `u_${createHmac("sha256", cfg.salt).update(personId).digest("hex").slice(0, 16)}`;
}

// ───────────────────────────── 接入方（请求来源） ─────────────────────────────

const requestClient = new AsyncLocalStorage<ClientTag>();

/** 按请求路径与部署判定接入方。 */
export function clientTagFor(url: string, demo: boolean): ClientTag {
  const path = url.split("?", 1)[0];
  if (path === "/mcp" || path.startsWith("/mcp/")) return CLIENT_TAGS.mcp;
  if (/\/feishu(\/|$)/.test(path)) return CLIENT_TAGS.feishu;
  return demo ? CLIENT_TAGS.demo : CLIENT_TAGS.web;
}

/** Fastify onRequest（回调式）里调用：本请求及其派生的后台执行都带这个接入方。 */
export function enterRequestClient(tag: ClientTag): void {
  requestClient.enterWith(tag);
}

export function currentClientTag(): ClientTag {
  return requestClient.getStore() ?? CLIENT_TAGS.system;
}

// ───────────────────────────── Span ─────────────────────────────

type SpanKind = "turn" | "agent" | "llm" | "tool" | "retrieve";
const RUN_TYPES: Record<SpanKind, string> = { turn: "chain", agent: "chain", llm: "llm", tool: "tool", retrieve: "retriever" };

type TurnState = {
  base: Metadata;
  tags: string[];
  primaryRole: AgentRole;
  /** 允许在本 Turn 里作为 Agent 步骤运行的 candidate kind（其余 kind 各自开新 Trace）。 */
  accepts: Set<string>;
  /** 执行中补记、在根节点结束时带上的 metadata（annotateTurn，同样只收白名单键）。 */
  extra?: Metadata;
};

class Span {
  run?: RunTree;
  ended = false;
  private posted: Promise<void> = Promise.resolve();
  private readonly startTime = Date.now();
  private events: { name: string; time: string }[] = [];
  /** 同一父节点下子节点的先后（同一毫秒内的排序依据，写进 dotted_order）。 */
  private childOrder = 0;

  constructor(
    readonly turn: TurnState,
    readonly kind: SpanKind,
    readonly name: string,
    readonly parent: Span | undefined,
    readonly metadata: Metadata,
    readonly inputs: unknown,
    /** 根与 Agent 按需物化；model / tool / retrieve 在真实调用边界立即发送。 */
    lazy: boolean,
  ) {
    if (!lazy) this.materialize();
  }

  /** 发送 create（父节点先物化）。返回 false 表示无法发送。 */
  materialize(): boolean {
    if (this.run) return true;
    if (this.ended) return false;
    const cfg = current();
    if (!cfg.enabled) return false;
    if (this.parent && !this.parent.materialize()) return false;
    try {
      const order = this.parent ? Math.min(999, ++this.parent.childOrder) : 1;
      this.run = new RunTree({
        // id 由 SDK 按真实开始时间生成 uuid7，与 dotted_order 一致。
        name: this.name,
        run_type: RUN_TYPES[this.kind],
        start_time: this.startTime,
        inputs: toKV(this.inputs),
        metadata: cleanMetadata(this.metadata),
        tags: this.turn.tags,
        project_name: cfg.project,
        execution_order: order,
        child_execution_order: order,
        client: cfg.client as unknown as Client,
        ...(this.parent?.run ? { parent_run: this.parent.run } : {}),
      });
      const run = this.run;
      this.posted = Promise.resolve().then(() => run.postRun()).catch(warnTrace);
      return true;
    } catch (error) {
      warnTrace(error);
      this.run = undefined;
      return false;
    }
  }

  /** 真实首 token：只记一次，作为 LangSmith new_token 事件（服务端据此算 first_token_time）。 */
  firstToken(): void {
    if (this.events.length || this.ended) return;
    this.events.push({ name: "new_token", time: new Date().toISOString() });
  }

  hasFirstToken(): boolean {
    return this.events.length > 0;
  }

  end(result: { outputs?: unknown; error?: string; metadata?: Metadata } = {}): void {
    if (this.ended) return;
    this.ended = true;
    const run = this.run;
    if (!run) return;
    try {
      if (this.events.length) run.events = [...this.events];
      const metadata = result.metadata ? cleanMetadata(result.metadata) : undefined;
      void run.end(result.outputs === undefined ? undefined : toKV(result.outputs), result.error?.slice(0, 4000), undefined,
        metadata && Object.keys(metadata).length ? metadata : undefined);
      this.posted = this.posted.then(() => run.patchRun({ excludeInputs: true })).catch(warnTrace);
    } catch (error) {
      warnTrace(error);
    }
  }
}

function warnTrace(error: unknown): void {
  try { console.warn(`langsmith trace failed: ${(error as Error)?.message ?? String(error)}`); } catch { /* never throw */ }
}

function cleanMetadata(metadata: Metadata): Metadata {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (METADATA_KEY_SET.has(key) && value !== undefined && value !== null && value !== "") out[key as MetadataKey] = value;
  }
  return out;
}

function toKV(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

type Store = {
  turn: TurnState;
  root: Span;
  /** 当前父节点；undefined = 根。已结束的父节点不再接子节点（后台残留执行不挂到旧 Trace）。 */
  span?: Span;
  /** 当前 Agent（llm / tool / retrieve 继承其 agent_role）。 */
  agentRole?: AgentRole;
};
const storage = new AsyncLocalStorage<Store>();

function parentOf(store: Store): Span | undefined {
  const parent = store.span ?? store.root;
  return parent.ended ? undefined : parent;
}

function childSpan(store: Store, kind: SpanKind, name: string, extra: Metadata, inputs: unknown, lazy: boolean): Span | undefined {
  if (!current().enabled) return undefined;
  const parent = parentOf(store);
  if (!parent) return undefined;
  try {
    const metadata: Metadata = { ...store.turn.base, ...(store.agentRole ? { agent_role: store.agentRole } : {}), ...extra };
    const span = new Span(store.turn, kind, name, parent, metadata, inputs, lazy);
    if (!lazy && !span.run) return undefined;
    return span;
  } catch (error) {
    warnTrace(error);
    return undefined;
  }
}

function message(error: unknown): string {
  return (error as Error)?.message || String(error);
}

// ───────────────────────────── Turn ─────────────────────────────

export type TurnSpec = {
  /** 本 Turn 的主 Agent（其 Agent 步骤记为 ls_agent_type=root，其余为 subagent）。 */
  agentRole: AgentRole;
  logicalTurnId: string;
  attempt: number;
  /** uuid7，稳定关联业务会话。 */
  threadId: string;
  scope: string;
  /** 已脱敏的用户 id（anonUserId 的结果）。 */
  anonUserId?: string;
  client?: ClientTag;
  inputs?: unknown;
  /** 可在本 Turn 内作为 Agent 步骤运行的 candidate kind。 */
  accepts?: string[];
};

/**
 * 以一个业务 Turn 的执行段（attempt）为根运行 fn。
 * - 追踪未启用：不调用 resolve，直接 fn()。
 * - resolve 返回 undefined 或抛错：不追踪这次执行，业务照常。
 * - settle 在 fn 结束后告诉调用方本 attempt 的结果（用于 Turn 计数）。
 */
export async function tracedTurn<T>(
  options: {
    resolve: () => Promise<TurnSpec | undefined> | TurnSpec | undefined;
    outputs?: (result: T) => unknown;
    /** 正常返回但业务上未成功（如对话被中止）时给出错误说明。 */
    errorOf?: (result: T) => string | undefined;
    settle?: (status: "succeeded" | "failed") => Promise<void> | void;
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabled()) return fn();
  let spec: TurnSpec | undefined;
  try {
    spec = await options.resolve();
  } catch (error) {
    warnTrace(error);
  }
  if (!spec) return fn();
  let root: Span;
  try {
    const turn: TurnState = {
      base: cleanMetadata({ thread_id: spec.threadId, logical_turn_id: spec.logicalTurnId, attempt: spec.attempt, scope: spec.scope, anon_user_id: spec.anonUserId }),
      tags: [spec.client ?? currentClientTag()],
      primaryRole: spec.agentRole,
      accepts: new Set(spec.accepts ?? []),
    };
    root = new Span(turn, "turn", runNames.turn(spec.logicalTurnId, spec.attempt), undefined, turn.base, spec.inputs === undefined ? undefined : safeInputs(spec.inputs), true);
  } catch (error) {
    warnTrace(error);
    return fn();
  }
  const settle = async (status: "succeeded" | "failed") => {
    try { await options.settle?.(status); } catch (error) { warnTrace(error); }
  };
  return storage.run({ turn: root.turn, root }, async () => {
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      root.end({ error: message(error), metadata: root.turn.extra });
      await settle("failed");
      throw error;
    }
    let outputs: unknown;
    let failure: string | undefined;
    try {
      outputs = options.outputs ? safeOutputs(options.outputs(result)) : undefined;
      failure = options.errorOf?.(result);
    } catch (error) { warnTrace(error); }
    root.end({ outputs, error: failure, metadata: root.turn.extra });
    await settle(failure ? "failed" : "succeeded");
    return result;
  });
}

/**
 * 给当前 Turn 的根节点补记 metadata（在根节点结束时一起发出）：只收白名单键，没有当前 Turn（含追踪未启用）时什么都不做。
 */
export function annotateTurn(metadata: Partial<Record<MetadataKey, string | number | undefined>>): void {
  const store = storage.getStore();
  if (!store || store.root.ended) return;
  store.turn.extra = { ...store.turn.extra, ...cleanMetadata(metadata as Metadata) };
}

/** 对话 scope（如 issue:<id>、mission:<编号>）→ 轨迹 scope。 */
export function conversationScope(scope: string): string {
  if (scope === "global") return "global";
  const at = scope.indexOf(":");
  return at < 0 ? scopeOf({ type: scope, id: "unknown" }) : scopeOf({ type: scope.slice(0, at), id: scope.slice(at + 1) });
}

/** 当前是否处在一个接受该 candidate kind 的 Turn 里。 */
export function turnAccepts(kind: string): boolean {
  const store = storage.getStore();
  return !!store && !store.root.ended && store.turn.accepts.has(kind);
}

/** 只有当前 Turn 存在时才建 Agent 步骤；Agent 节点在第一个真实子步骤出现时才发送。 */
export async function withAgent<T>(role: AgentRole, fn: () => Promise<T>, options: { inputs?: unknown; outputs?: (result: T) => unknown } = {}): Promise<T> {
  const store = storage.getStore();
  if (!store || !current().enabled) return fn();
  const parent = parentOf(store);
  const agentType = parent === store.root && role === store.turn.primaryRole ? "root" : "subagent";
  const span = childSpan(store, "agent", runNames.agent(role), { agent_role: role, ls_agent_type: agentType },
    options.inputs === undefined ? undefined : safeInputs(options.inputs), true);
  if (!span) return fn();
  return storage.run({ ...store, span, agentRole: role }, async () => {
    try {
      const result = await fn();
      let outputs: unknown;
      try { outputs = options.outputs ? safeOutputs(options.outputs(result)) : undefined; } catch (error) { warnTrace(error); }
      span.end({ outputs });
      return result;
    } catch (error) {
      span.end({ error: message(error) });
      throw error;
    }
  });
}

/** 一次真实检索。没有当前 Turn（含追踪未启用）时直接执行，inputs 不求值。 */
export async function withRetrieve<T>(source: RetrieveSource, inputs: () => unknown, fn: () => Promise<T>, summarize?: (result: T) => unknown): Promise<T> {
  const store = storage.getStore();
  if (!store) return fn();
  const span = childSpan(store, "retrieve", runNames.retrieve(source), {}, safeInputs(inputs()), false);
  if (!span) return fn();
  return storage.run({ ...store, span }, async () => {
    try {
      const result = await fn();
      let outputs: unknown;
      try { outputs = summarize ? safeOutputs(summarize(result)) : undefined; } catch (error) { warnTrace(error); }
      span.end({ outputs });
      return result;
    } catch (error) {
      span.end({ error: message(error) });
      throw error;
    }
  });
}

/** 同步检索（本机企业知识）。 */
export function withRetrieveSync<T>(source: RetrieveSource, inputs: () => unknown, fn: () => T, summarize?: (result: T) => unknown): T {
  const store = storage.getStore();
  if (!store) return fn();
  const span = childSpan(store, "retrieve", runNames.retrieve(source), {}, safeInputs(inputs()), false);
  if (!span) return fn();
  try {
    const result = storage.run({ ...store, span }, fn);
    let outputs: unknown;
    try { outputs = summarize ? safeOutputs(summarize(result)) : undefined; } catch (error) { warnTrace(error); }
    span.end({ outputs });
    return result;
  } catch (error) {
    span.end({ error: message(error) });
    throw error;
  }
}

// ───────────────────────────── Tool ─────────────────────────────

type ExecutableTool = { name: string; execute: (...args: any[]) => Promise<any> };

/** 工具注册时包一层：每次真实执行一个 tool 节点（ls_tool_name = 注册名）。未启用时原样返回。 */
export function traceTools<T extends ExecutableTool>(tools: T[]): T[] {
  if (!tracingEnabled()) return tools;
  return tools.map((tool) => ({
    ...tool,
    execute: async (...args: any[]) => {
      const store = storage.getStore();
      if (!store) return tool.execute(...args);
      const span = childSpan(store, "tool", runNames.tool(tool.name), { ls_tool_name: tool.name }, safeInputs({ args: args[1] }), false);
      if (!span) return tool.execute(...args);
      return storage.run({ ...store, span }, async () => {
        try {
          const result = await tool.execute(...args);
          span.end({ outputs: toolOutputs(result) });
          return result;
        } catch (error) {
          span.end({ error: message(error) });
          throw error;
        }
      });
    },
  }));
}

function toolOutputs(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
  const text = Array.isArray(content) ? content.filter((item) => item?.type === "text").map((item) => item.text ?? "").join("\n") : "";
  const usage = usageMetadataFromPi((result as { usage?: Usage } | undefined)?.usage);
  return { output: clip(text, 4000), ...(usage ? { usage_metadata: usage } : {}) };
}

// ───────────────────────────── Model ─────────────────────────────

export type StreamFn = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

const defaultStream: StreamFn = (model, context, options) => {
  const api = getApiProvider(model.api);
  if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
  return api.streamSimple(model, context, options);
};

/**
 * Pi provider 的 streamSimple 包装：每次真实模型请求一个 llm 节点，流开始时建、done/error 时结束；
 * 首 token 只在收到第一个真实 delta 事件时记录；usage 来自 done/error 消息里供应方的真实返回。
 * 未启用时返回 inner（或 undefined，让 Pi 走内建实现），行为完全不变。
 */
export function tracedStreamSimple(inner: StreamFn | undefined, provider: string = MODEL_PROVIDERS.pi): StreamFn | undefined {
  if (!tracingEnabled()) return inner;
  const base = inner ?? defaultStream;
  return (model, context, options) => {
    const store = storage.getStore();
    const span = store ? childSpan(store, "llm", runNames.model(provider, model.id),
      { ls_provider: provider, ls_model_name: model.id }, safeLlmInputs(context), false) : undefined;
    if (!span) return base(model, context, options);
    let stream: AssistantMessageEventStream;
    try {
      stream = base(model, context, options);
    } catch (error) {
      span.end({ error: message(error) });
      throw error;
    }
    try {
      return tapStream(stream, span);
    } catch (error) {
      warnTrace(error);
      return stream;
    }
  };
}

function tapStream(source: AssistantMessageEventStream, span: Span): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        try { observe(span, event); } catch (error) { warnTrace(error); }
        out.push(event);
      }
    } finally {
      if (!span.ended) span.end({ error: "model stream closed without a final event" });
      out.end();
      source.result().then((result) => out.end(result), () => undefined);
    }
  })();
  return out;
}

function observe(span: Span, event: AssistantMessageEvent): void {
  if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
    if (event.delta) span.firstToken();
  } else if (event.type === "done") {
    span.end({ outputs: llmOutputs(event.message, event.reason) });
  } else if (event.type === "error") {
    span.end({ outputs: llmOutputs(event.error, event.reason), error: event.error.errorMessage || event.reason });
  }
}

/** Pi Usage → LangSmith usage_metadata。全零（供应方没给）视为缺失。 */
export function usageMetadataFromPi(usage: Usage | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const input = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const output = usage.output ?? 0;
  const total = usage.totalTokens ?? 0;
  if (!input && !output && !total) return undefined;
  const inputDetails: Record<string, number> = {};
  if (usage.cacheRead) inputDetails.cache_read = usage.cacheRead;
  if (usage.cacheWrite) inputDetails.cache_creation = usage.cacheWrite;
  const outputDetails: Record<string, number> = {};
  if (typeof usage.reasoning === "number") outputDetails.reasoning = usage.reasoning;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total || input + output,
    ...(Object.keys(inputDetails).length ? { input_token_details: inputDetails } : {}),
    ...(Object.keys(outputDetails).length ? { output_token_details: outputDetails } : {}),
  };
}

/** OpenAI 兼容 chat/completions 的 usage → usage_metadata（听写整理）。 */
export function usageMetadataFromOpenAI(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
  const input = Number(value.prompt_tokens ?? 0);
  const output = Number(value.completion_tokens ?? 0);
  const total = Number(value.total_tokens ?? 0);
  if (!input && !output && !total) return undefined;
  const cached = value.prompt_tokens_details?.cached_tokens;
  const reasoning = value.completion_tokens_details?.reasoning_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total || input + output,
    ...(typeof cached === "number" ? { input_token_details: { cache_read: cached } } : {}),
    ...(typeof reasoning === "number" ? { output_token_details: { reasoning } } : {}),
  };
}

/**
 * 非流式的一次真实模型请求（听写整理走方舟 chat/completions）。fn 拿到 report 回调，
 * 用供应方真实返回的 usage 与文字结束本节点。
 */
export async function withModelCall<T>(
  call: { provider: string; modelId: string; messages: { role: string; content: string }[] },
  fn: (report: (result: { text?: string; usage?: unknown; finishReason?: string }) => void) => Promise<T>,
): Promise<T> {
  const store = storage.getStore();
  const span = store ? childSpan(store, "llm", runNames.model(call.provider, call.modelId),
    { ls_provider: call.provider, ls_model_name: call.modelId },
    { messages: call.messages.map((item) => ({ role: item.role, content: item.role === "system" ? systemPromptRef(item.content) : clip(item.content, MESSAGE_CHARS) })) }, false) : undefined;
  if (!span) return fn(() => undefined);
  let reported: { text?: string; usage?: unknown; finishReason?: string } | undefined;
  try {
    const result = await fn((value) => { reported = value; });
    const usage = usageMetadataFromOpenAI(reported?.usage);
    span.end({ outputs: {
      choices: [{ message: { role: "assistant", content: clip(reported?.text ?? "", MESSAGE_CHARS) }, ...(reported?.finishReason ? { finish_reason: reported.finishReason } : {}) }],
      ...(usage ? { usage_metadata: usage } : {}),
    } });
    return result;
  } catch (error) {
    span.end({ error: message(error) });
    throw error;
  }
}

const MESSAGE_CHARS = 32000;
/** 系统提示可达数万字，单独放宽上限，保证轨迹里能看全。 */
const SYSTEM_PROMPT_CHARS = 120000;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit} chars]` : text;
}

/** 系统提示按明文上报，便于在轨迹里复盘 Agent 实际看到了什么。 */
function systemPromptRef(prompt: string): string {
  return clip(prompt, SYSTEM_PROMPT_CHARS);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: { type?: string; text?: string }) => (block?.type === "text" ? block.text ?? "" : block?.type === "image" ? "[image]" : "")).join("");
}

function safeLlmInputs(context: Context): Record<string, unknown> {
  try {
    const messages: Record<string, unknown>[] = [];
    if (context.systemPrompt) messages.push({ role: "system", content: systemPromptRef(context.systemPrompt) });
    for (const item of context.messages ?? []) {
      if (item.role === "user") messages.push({ role: "user", content: clip(contentText(item.content), MESSAGE_CHARS) });
      else if (item.role === "assistant") messages.push(assistantMessage(item));
      else if (item.role === "toolResult") messages.push({ role: "tool", tool_call_id: item.toolCallId, name: item.toolName, content: clip(contentText(item.content), MESSAGE_CHARS) });
    }
    return { messages, ...(context.tools?.length ? { tools: context.tools.map((tool) => tool.name) } : {}) };
  } catch {
    return {};
  }
}

function assistantMessage(item: AssistantMessage): Record<string, unknown> {
  const text = (item.content ?? []).filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
  const calls = (item.content ?? []).filter((block) => block.type === "toolCall") as { id: string; name: string; arguments: unknown }[];
  return {
    role: "assistant",
    content: clip(text, MESSAGE_CHARS),
    ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: clip(JSON.stringify(redactSecrets(call.arguments) ?? {}), MESSAGE_CHARS) } })) } : {}),
  };
}

function llmOutputs(item: AssistantMessage, reason: string): Record<string, unknown> {
  const usage = usageMetadataFromPi(item.usage);
  return {
    choices: [{ message: assistantMessage(item), finish_reason: reason }],
    // usage_metadata 在脱敏之后放入：键名含 token，但它是计数不是凭据。
    ...(usage ? { usage_metadata: usage } : {}),
  };
}

function safeInputs(value: unknown): unknown {
  try { return redactSecrets(JSON.parse(JSON.stringify(value ?? null))); } catch { return undefined; }
}

function safeOutputs(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const { usage_metadata: usage, ...rest } = (value && typeof value === "object" ? value : { value }) as Record<string, unknown>;
    const redacted = redactSecrets(JSON.parse(JSON.stringify(rest))) as Record<string, unknown>;
    return usage ? { ...redacted, usage_metadata: usage } : redacted;
  } catch {
    return undefined;
  }
}

// ───────────────────────────── 会话 Thread 与 Turn 计数 ─────────────────────────────

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** 新的 thread_id（uuid7）。 */
export function newThreadId(): string {
  return uuid7();
}

/** 对话：conversations.thread_id 首次使用时写入，之后稳定。 */
export async function conversationThreadId(query: Query, conversationId: string): Promise<string> {
  const result = await query(
    "UPDATE conversations SET thread_id = COALESCE(thread_id, $2::uuid) WHERE id = $1 RETURNING thread_id",
    [conversationId, uuid7()],
  );
  const threadId = result.rows[0]?.thread_id as string | undefined;
  if (!threadId) throw new Error("conversation not found for trace thread");
  return threadId;
}

/** 对话 Turn：conv-<会话短 id>-t<用户消息序号>。 */
export function conversationTurnId(conversationId: string, userSequence: number): string {
  return `conv-${shortId(conversationId)}-t${userSequence}`;
}

/**
 * 非对话业务会话的 Thread 与 Turn 计数（trace_threads）。
 * 上一个 attempt 成功（或从未运行）→ 新 Turn（turn_no+1, attempt=1）；否则同一 Turn 的 attempt+1（恢复/重试）。
 * advance=always 时每次都是新 Turn（如雷达每次扫描）。
 */
export async function allocateTurn(query: Query, threadKey: string, options: { advance?: "after-success" | "always" } = {}) {
  const always = options.advance === "always";
  const result = await query(
    `INSERT INTO trace_threads (thread_key, thread_id, turn_no, attempt, turn_status)
     VALUES ($1, $2::uuid, 1, 1, 'running')
     ON CONFLICT (thread_key) DO UPDATE SET
       turn_no = CASE WHEN $3::boolean OR trace_threads.turn_status = 'succeeded' THEN trace_threads.turn_no + 1 ELSE trace_threads.turn_no END,
       attempt = CASE WHEN $3::boolean OR trace_threads.turn_status = 'succeeded' THEN 1 ELSE trace_threads.attempt + 1 END,
       turn_status = 'running',
       updated_at = now()
     RETURNING thread_id, turn_no, attempt`,
    [threadKey, uuid7(), always],
  );
  const row = result.rows[0] as { thread_id: string; turn_no: number; attempt: number };
  return {
    threadId: row.thread_id,
    turnNo: Number(row.turn_no),
    attempt: Number(row.attempt),
    settle: async (status: "succeeded" | "failed") => {
      await query(
        "UPDATE trace_threads SET turn_status = $2, updated_at = now() WHERE thread_key = $1 AND turn_no = $3 AND attempt = $4",
        [threadKey, status, row.turn_no, row.attempt],
      );
    },
  };
}

/** 只要稳定 thread_id、不计 Turn 的会话（如听写：一人一个整理会话）。 */
export async function stableThreadId(query: Query, threadKey: string): Promise<string> {
  const result = await query(
    `INSERT INTO trace_threads (thread_key, thread_id) VALUES ($1, $2::uuid)
     ON CONFLICT (thread_key) DO UPDATE SET updated_at = trace_threads.updated_at
     RETURNING thread_id`,
    [threadKey, uuid7()],
  );
  return result.rows[0].thread_id as string;
}

/** 一次性 Turn 的随机短 id（听写、雷达扫描）。 */
export function randomTurnSuffix(): string {
  return randomBytes(4).toString("hex");
}

// ───────────────────────────── Candidate Agent ─────────────────────────────

/**
 * runCandidateAgent 的 kind → Agent 角色与 logical_turn_id 前缀。
 * logical_turn_id = <prefix>-<对象短 id>-r<n>，n 为该业务会话里的第几个 Turn（成功后前进，失败重跑是同一 Turn 的下一个 attempt）。
 */
export const CANDIDATE_AGENTS: Record<string, { role: AgentRole; prefix: string }> = {
  meeting_preflight: { role: AGENT_ROLES.preflight, prefix: "mtg" },
  "issue-research": { role: AGENT_ROLES.research, prefix: "iss" },
  meeting_outcome: { role: AGENT_ROLES.meetingOutcome, prefix: "mto" },
  "radar-assess": { role: AGENT_ROLES.radarAssess, prefix: "rdr" },
  "personal-radar-assess": { role: AGENT_ROLES.personalRadarAssess, prefix: "prd" },
  "monthly-draft": { role: AGENT_ROLES.monthlyDraft, prefix: "plan" },
  "monthly-review-draft": { role: AGENT_ROLES.monthlyReviewDraft, prefix: "mrd" },
  "monthly-review-assess": { role: AGENT_ROLES.monthlyReviewAssess, prefix: "mra" },
  "monthly-review-summary": { role: AGENT_ROLES.monthlyReviewSummary, prefix: "mrs" },
  "personal-review-draft": { role: AGENT_ROLES.personalReviewDraft, prefix: "prv" },
  "mission-card-draft": { role: AGENT_ROLES.missionCardDraft, prefix: "mcd" },
  "mission-card-draft-check": { role: AGENT_ROLES.missionCardDraftCheck, prefix: "mcd" },
  "mission-card-annotation": { role: AGENT_ROLES.missionCardAnnotation, prefix: "mca" },
  "mission-card-combination-review": { role: AGENT_ROLES.missionCardCombinationReview, prefix: "mcr" },
  "material-annotation": { role: AGENT_ROLES.materialAnnotation, prefix: "mat" },
  "battlefield-judgment": { role: AGENT_ROLES.battlefieldSync, prefix: "bf" },
  "task-acceptance-draft": { role: AGENT_ROLES.taskAcceptanceDraft, prefix: "tsk" },
  "thread-intro": { role: AGENT_ROLES.threadIntro, prefix: "thr" },
};

export function candidateAgent(kind: string): { role: AgentRole; prefix: string } {
  return CANDIDATE_AGENTS[kind] ?? { role: dashSegment(kind), prefix: "run" };
}

/** 截断后的 JSON 预览（Agent 节点的输入；完整上下文已在 llm 节点里）。 */
export function preview(value: unknown, limit = MESSAGE_CHARS): string {
  if (typeof value === "string") return clip(value, limit);
  try { return clip(JSON.stringify(redactSecrets(value)) ?? "", limit); } catch { return ""; }
}

export type CandidateTurnOptions = {
  query: Query;
  /** 决定 Agent 角色、Turn 前缀与业务会话（thread_key = kind|scope）。 */
  kind: string;
  objectRef?: { type: string; id: string };
  /** 覆盖按 objectRef 推出的 scope（如 plan:2026-10）。 */
  scope?: string;
  personId?: string;
  /** 本 Turn 内允许作为 Agent 步骤运行的其它 kind。 */
  accepts?: string[];
  inputs?: unknown;
};

/** 没有 objectRef 但有发起人时，按人分业务会话（个人复盘起草等）。 */
function effectiveRef(options: CandidateTurnOptions): { type: string; id: string } | undefined {
  return options.objectRef ?? (options.personId ? { type: "person", id: options.personId } : undefined);
}

function turnObjectPart(options: CandidateTurnOptions, scope: string): string {
  const ref = effectiveRef(options);
  if (!options.scope && ref && (ref.type === "person" || ref.type === "person-radar")) return (anonUserId(ref.id) ?? "u_unknown").slice(2, 10);
  if (!options.scope && ref && ref.type !== "global") return shortId(ref.id);
  if (scope === "global") return "global";
  const at = scope.indexOf(":");
  const type = scope.slice(0, at), id = scope.slice(at + 1);
  if (type === "plan" || type === "review") return dashSegment(id);
  if (type === "person") return id.replace(/^u_/, "").slice(0, 8);
  return shortId(id);
}

/** 以 trace_threads 计数开一个 candidate 业务 Turn（不建 Agent 步骤）。 */
export async function tracedCandidateTurn<T>(options: CandidateTurnOptions, fn: () => Promise<T>, outputs?: (result: T) => unknown): Promise<T> {
  if (!tracingEnabled()) return fn();
  const agent = candidateAgent(options.kind);
  let settle: ((status: "succeeded" | "failed") => Promise<void>) | undefined;
  return tracedTurn({
    resolve: async () => {
      const scope = options.scope ? conversationScope(options.scope) : scopeOf(effectiveRef(options));
      const allocated = await allocateTurn(options.query, `${options.kind}|${scope}`);
      settle = allocated.settle;
      return {
        agentRole: agent.role,
        logicalTurnId: `${agent.prefix}-${turnObjectPart(options, scope)}-r${allocated.turnNo}`,
        attempt: allocated.attempt,
        threadId: allocated.threadId,
        scope,
        anonUserId: anonUserId(options.personId),
        accepts: [options.kind, ...(options.accepts ?? [])],
        inputs: options.inputs,
      };
    },
    outputs,
    settle: (status) => settle?.(status),
  }, fn);
}

/** candidate Agent 一次运行：在接受它的 Turn 里是一个 Agent 步骤，否则自开一个 Turn。 */
export async function tracedCandidateAgent<T>(options: CandidateTurnOptions, fn: () => Promise<T>, outputs?: (result: T) => unknown): Promise<T> {
  if (!tracingEnabled()) return fn();
  const role = candidateAgent(options.kind).role;
  const agentOptions = { inputs: options.inputs, outputs };
  if (turnAccepts(options.kind)) return withAgent(role, fn, agentOptions);
  return tracedCandidateTurn({ ...options, inputs: undefined }, () => withAgent(role, fn, agentOptions));
}
