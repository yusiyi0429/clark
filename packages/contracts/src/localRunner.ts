import { Type, type Static, type TSchema } from "@sinclair/typebox";

/**
 * 天枢本机程序（apps/local）的两份契约：
 * 1. 本机 HTTP API：天枢网页在本人电脑上直连 http://127.0.0.1:47610/v1/…；
 * 2. 云端同步载荷：本机程序单向报给天枢 api（POST /api/local-runner/sync），云端从不指挥本机。
 *
 * 本机 API 的规矩（本机程序逐条检查，违反即拒）：
 * - Host 必须是 127.0.0.1:<端口> 或 localhost:<端口>，否则 421；
 * - 必须带 Origin，且在本机白名单里（默认 https://tk.tokenkingos.com），否则 403；跨域头只回这个来源，不用通配；
 * - 除 GET /v1/health、POST /v1/pairings、GET /v1/pairings/:id 外，都要带请求头 x-tianshu-local-token（配对口令），否则 401；
 * - POST、PUT、PATCH 只收 application/json，否则 415；没有内容的（如停下、强停、选文件夹）也发 {}。
 * 浏览器的 EventSource 不能带自定义头，网页要用 fetch + ReadableStream 读事件流，断线时把最后的 id 放进 Last-Event-ID 头重连。
 */

export const LOCAL_RUNNER_PROTOCOL = 1;
export const LOCAL_RUNNER_DEFAULT_PORT = 47610;
export const LOCAL_RUNNER_TOKEN_HEADER = "x-tianshu-local-token";
/** 云端接收端路径（相对天枢 api 的根），鉴权用 Authorization: Bearer <个人令牌>。 */
export const LOCAL_RUNNER_SYNC_PATH = "/api/local-runner/sync";

const Instant = Type.String({ format: "date-time" });
const Id = Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" });
const Uuid = Type.String({ format: "uuid" });
const strict = { additionalProperties: false } as const;
/** 钥匙和令牌只收可见 ASCII（不含空格、换行等控制字符），免得经 stdin 交给系统凭据工具时被当成另一条命令。 */
const SECRET_CHARS = "^[\x21-\x7E]*$";
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// ───────────────────────── 通用 ─────────────────────────

export const LocalRunnerErrorCode = Type.Union([
  Type.Literal("bad_host"), Type.Literal("bad_origin"), Type.Literal("unauthorized"), Type.Literal("unsupported_media_type"),
  Type.Literal("validation"), Type.Literal("not_found"), Type.Literal("conflict"), Type.Literal("folder_not_allowed"),
  Type.Literal("agent_not_installed"), Type.Literal("agent_not_logged_in"), Type.Literal("agent_incompatible"),
  Type.Literal("not_implemented"), Type.Literal("cloud_not_linked"), Type.Literal("internal"),
]);
export const LocalRunnerError = Type.Object({
  error: Type.Object({ code: LocalRunnerErrorCode, message: Type.String() }, strict),
}, strict);

/** 执行方。codex 12 月接，现在开会话会得到 not_implemented。 */
export const LocalAgentKind = Type.Union([Type.Literal("claude-code"), Type.Literal("codex")]);
/** card：看板上的一张卡（执行事项）；topic：调研专题。两者都是能对话的本机会话。 */
export const LocalSessionKind = Type.Union([Type.Literal("card"), Type.Literal("topic")]);

// ───────────────────────── 健康与配对 ─────────────────────────

/** GET /v1/health：不需要口令，只要来源在白名单里。网页据此判断「装了没、配对没」。 */
export const LocalHealthResponse = Type.Object({
  app: Type.Literal("tianshu-local"),
  version: Type.String(),
  protocol: Type.Integer({ minimum: 1 }),
  platform: Type.Union([Type.Literal("win32"), Type.Literal("darwin"), Type.Literal("linux")]),
  /** 请求里带的口令是否有效；没带就是 false。 */
  tokenValid: Type.Boolean(),
}, strict);

/** POST /v1/pairings：网页发起配对。本机弹出确认框，显示同一个四位确认码，本人点「允许」才发口令。 */
export const LocalPairingStartRequest = Type.Object({
  /** 显示在确认框里，例如「天枢网页 · Chrome」。 */
  clientLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
}, strict);
export const LocalPairingStartResponse = Type.Object({
  pairingId: Id,
  /** 四位数字，网页和本机确认框上同时显示，本人核对一致再点允许。 */
  code: Type.String({ pattern: "^[0-9]{4}$" }),
  expiresAt: Instant,
}, strict);
export const LocalPairingStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("approved"), Type.Literal("denied"), Type.Literal("expired"),
]);
/** GET /v1/pairings/:pairingId：网页轮询。口令只在批准后的第一次查询里返回一次，网页存进本来源的 localStorage。 */
export const LocalPairingStatusResponse = Type.Object({
  status: LocalPairingStatus,
  token: Type.Optional(Type.String({ minLength: 32 })),
}, strict);

// ───────────────────────── 本机状态、执行方安装与登录 ─────────────────────────

export const LocalAgentSetupPhase = Type.Union([
  Type.Literal("idle"), Type.Literal("installing"), Type.Literal("waiting_browser"), Type.Literal("succeeded"), Type.Literal("failed"),
]);
export const LocalAgentStatus = Type.Object({
  kind: LocalAgentKind,
  installed: Type.Boolean(),
  version: Nullable(Type.String()),
  path: Nullable(Type.String()),
  /** 已在本机登录（订阅或 Console）。只说明有凭据，不保证有效；跑任务时遇到认证失败会再报 auth_required。 */
  loggedIn: Type.Boolean(),
  authMethod: Nullable(Type.String()),
  subscriptionType: Nullable(Type.String()),
  loginExpiresAt: Nullable(Instant),
  /** 低于这个版本的 Claude Code 不保证兼容，网页提示升级。 */
  minimumVersion: Nullable(Type.String()),
  compatible: Type.Boolean(),
  setup: Type.Object({
    phase: LocalAgentSetupPhase,
    startedAt: Nullable(Instant),
    /** 登录时浏览器要打开的地址；本机已替本人打开，网页显示「没跳转就点这里」。 */
    loginUrl: Nullable(Type.String()),
    error: Nullable(Type.String()),
  }, strict),
}, strict);

export const LocalOutboxStatus = Type.Object({
  pending: Type.Integer({ minimum: 0 }),
  lastSyncedAt: Nullable(Instant),
  lastError: Nullable(Type.String()),
}, strict);

export const LocalCloudLinkView = Type.Object({
  linked: Type.Boolean(),
  apiBaseUrl: Nullable(Type.String()),
  personName: Nullable(Type.String()),
  outbox: LocalOutboxStatus,
}, strict);

export const LocalSettings = Type.Object({
  /** 新开的会话是否默认带上本人全局配置（hooks、插件、个人 MCP）。默认 false：会话干净。 */
  includePersonalConfigByDefault: Type.Boolean(),
  /** 只读：允许直连的网页来源。改它要在本机配置文件里改，网页不能改。 */
  allowedOrigins: Type.Array(Type.String()),
  /** 「暂停全部」后为 true：进行中的会话停下，不接新会话、不续接旧会话；只能在托盘里恢复。 */
  paused: Type.Boolean(),
}, strict);
export const LocalSettingsPatch = Type.Object({
  includePersonalConfigByDefault: Type.Optional(Type.Boolean()),
  /** 网页只能暂停（true）；传 false 会被拒（409），恢复只能在本机托盘里点。 */
  paused: Type.Optional(Type.Boolean()),
}, strict);

/** GET /v1/status */
export const LocalStatusResponse = Type.Object({
  deviceId: Uuid,
  version: Type.String(),
  agents: Type.Array(LocalAgentStatus),
  activeSessions: Type.Integer({ minimum: 0 }),
  cloud: LocalCloudLinkView,
  settings: LocalSettings,
}, strict);

/** POST /v1/agents/claude-code/login 的贴码兜底：浏览器显示一串代码而没有跳回时，本人贴进网页。 */
export const LocalAgentLoginCodeRequest = Type.Object({ code: Type.String({ minLength: 4, maxLength: 2000 }) }, strict);

// ───────────────────────── 云端关联 ─────────────────────────

/**
 * PUT /v1/cloud：网页把天枢 api 地址和一个本机专用的个人令牌交给本机程序。apiBaseUrl 的来源必须在白名单里。
 * 这个令牌两处用：单向同步（POST /api/local-runner/sync），以及每个会话挂的天枢 MCP（/mcp/me，联网搜索等）。
 * 令牌只存本机凭据库，挂 MCP 时经子进程环境变量传，不写进文件、不进命令行。
 */
export const LocalCloudLinkRequest = Type.Object({
  apiBaseUrl: Type.String({ minLength: 8, maxLength: 200 }),
  token: Type.String({ minLength: 16, maxLength: 400, pattern: SECRET_CHARS }),
  personName: Type.Optional(Type.String({ maxLength: 60 })),
}, strict);

// ───────────────────────── 模型与文件夹 ─────────────────────────

/**
 * subscription：用本人在 Claude Code 里的登录，不设任何模型环境变量（内置一条，id 固定为 "subscription"）。
 * gateway：Anthropic 格式的第三方地址（TokenHub 等），钥匙只存本机（系统凭据库），任何接口都不回传。
 */
export const LocalModelSource = Type.Union([Type.Literal("subscription"), Type.Literal("gateway")]);
export const LocalModelProfile = Type.Object({
  id: Id,
  label: Type.String({ minLength: 1, maxLength: 40 }),
  source: LocalModelSource,
  agent: LocalAgentKind,
  baseUrl: Nullable(Type.String()),
  model: Nullable(Type.String()),
  /** 网关时 Claude Code 后台小任务（WebFetch 摘要等）用的便宜模型，经 ANTHROPIC_DEFAULT_HAIKU_MODEL 传；不填则同 model。 */
  smallModel: Nullable(Type.String()),
  /**
   * 是否允许用 Claude Code 自带的联网搜索。它是 Anthropic 服务端工具，要网关背后的模型真的支持；
   * 不支持的模型（如 11/06 实测的 qwen3.8-flash）不报错还会编结果，所以网关模型默认关（实测能搜的 Opus、DeepSeek v4.1 flash 默认开），
   * 关着时拉起加 --disallowedTools WebSearch。联网搜索主要靠天枢 MCP 提供的搜索工具。
   */
  webSearch: Type.Boolean(),
  hasKey: Type.Boolean(),
  isDefault: Type.Boolean(),
}, strict);
export const LocalModelListResponse = Type.Object({ profiles: Type.Array(LocalModelProfile) }, strict);
/**
 * PUT /v1/models/:id。
 * - gateway：baseUrl、model 必填；apiKey 只写不读，不传表示保留原钥匙，传空串表示删除钥匙。
 * - subscription：用本人登录，只选模型（如 opus、sonnet、haiku），不收 baseUrl 和 apiKey。
 */
export const LocalModelProfileUpsert = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 40 }),
  source: LocalModelSource,
  agent: Type.Optional(LocalAgentKind),
  baseUrl: Type.Optional(Type.String({ minLength: 8, maxLength: 300, pattern: "^https?://" })),
  model: Type.String({ minLength: 1, maxLength: 120 }),
  smallModel: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  /** 不传：订阅为 true；网关模型按实测白名单。 */
  webSearch: Type.Optional(Type.Boolean()),
  apiKey: Type.Optional(Type.String({ maxLength: 400, pattern: SECRET_CHARS })),
  isDefault: Type.Optional(Type.Boolean()),
}, strict);

/** 本人允许本机程序读写的文件夹。只能经本机弹出的系统选择框添加（POST /v1/folders/pick），网页不能直接写路径。 */
export const LocalFolder = Type.Object({
  id: Id,
  path: Type.String(),
  label: Type.String(),
  addedAt: Instant,
}, strict);
export const LocalFolderListResponse = Type.Object({ folders: Type.Array(LocalFolder) }, strict);
/** POST /v1/folders/pick：本人在本机选择框里点了取消时 folder 为 null。 */
export const LocalFolderPickResponse = Type.Object({ folder: Nullable(LocalFolder) }, strict);

// ───────────────────────── 会话 ─────────────────────────

export const LocalSessionStatus = Type.Union([
  Type.Literal("starting"),
  Type.Literal("running"),
  /** 有权限请求挂起，等网页批准或拒绝。 */
  Type.Literal("waiting_permission"),
  /** 一轮结束，进程还在，等下一句话。 */
  Type.Literal("idle"),
  /** 进程已退出（停下、强停、本机程序重启）；再发消息会用 --resume 续上。 */
  Type.Literal("exited"),
  Type.Literal("failed"),
]);

export const LocalSessionSubject = Type.Object({
  kind: LocalSessionKind,
  /** 天枢里卡（执行事项）的 id，kind=card 时必填。 */
  cardId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /** 天枢里调研专题的 id，kind=topic 时必填。 */
  topicId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
}, strict);

export const LocalUsage = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0 }),
  /** 订阅登录时是 Claude Code 自己估的等价花费；网关模型可能为 null。 */
  costUsd: Nullable(Type.Number({ minimum: 0 })),
}, strict);

/** POST /v1/sessions */
export const LocalCreateSessionRequest = Type.Object({
  subject: LocalSessionSubject,
  title: Type.String({ minLength: 1, maxLength: 120 }),
  /** 工作目录：必须在允许的文件夹内。topic 可不填，本机程序给它建一个专用目录。 */
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  agent: Type.Optional(LocalAgentKind),
  /** 不填用默认模型。 */
  modelProfileId: Type.Optional(Id),
  firstMessage: Type.String({ minLength: 1, maxLength: 20000 }),
  /** 覆盖「默认干净」：true 时带上本人全局配置（hooks、插件、个人 MCP）。 */
  includePersonalConfig: Type.Optional(Type.Boolean()),
}, strict);

export const LocalSessionSummary = Type.Object({
  /** 同时就是 Claude Code 的 --session-id，续接用它。 */
  id: Uuid,
  subject: LocalSessionSubject,
  title: Type.String(),
  agent: LocalAgentKind,
  modelProfileId: Id,
  modelLabel: Type.String(),
  cwd: Type.String(),
  status: LocalSessionStatus,
  includePersonalConfig: Type.Boolean(),
  createdAt: Instant,
  updatedAt: Instant,
  lastSeq: Type.Integer({ minimum: 0 }),
  pendingPermissions: Type.Integer({ minimum: 0 }),
  usage: LocalUsage,
}, strict);
export const LocalSessionListResponse = Type.Object({ sessions: Type.Array(LocalSessionSummary) }, strict);

export const LocalPermissionRequestView = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 120 }),
  toolName: Type.String(),
  /** 给人看的一行，例如「改文件 src/app.ts」「运行 pnpm test」。 */
  title: Type.String(),
  input: Type.Record(Type.String(), Type.Unknown()),
  /** Claude Code 给了 permission_suggestions：可以「这张卡都允许」。 */
  canAllowForSession: Type.Boolean(),
  requestedAt: Instant,
}, strict);
export const LocalSessionDetailResponse = Type.Object({
  session: LocalSessionSummary,
  pendingPermissions: Type.Array(LocalPermissionRequestView),
}, strict);

/** POST /v1/sessions/:id/messages：插话。进行中时在下一个工具步骤生效；空闲时开下一轮；已退出时先 --resume 再发。 */
export const LocalSendMessageRequest = Type.Object({ text: Type.String({ minLength: 1, maxLength: 20000 }) }, strict);
export const LocalSendMessageResponse = Type.Object({
  /** next_step：进行中，下一步前送达；new_turn：开了新一轮；resumed：进程已退出，续接后送达。 */
  delivery: Type.Union([Type.Literal("next_step"), Type.Literal("new_turn"), Type.Literal("resumed")]),
}, strict);

/** POST /v1/sessions/:id/permissions/:requestId */
export const LocalPermissionDecisionRequest = Type.Object({
  decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  /** 拒绝时附一句理由，Claude 会看到。 */
  message: Type.Optional(Type.String({ maxLength: 500 })),
  /** allow 时可选：按 Claude Code 给的建议，这张卡（本会话）同类操作都允许。 */
  allowForSession: Type.Optional(Type.Boolean()),
}, strict);

/** POST /v1/sessions/:id/interrupt（停下，会话保留）与 /kill（强停，杀本会话进程树）的回执。 */
export const LocalSessionActionResponse = Type.Object({ session: LocalSessionSummary }, strict);

// ───────────────────────── 事件流 ─────────────────────────

const ev = <T extends string, P extends Record<string, TSchema>>(type: T, props: P) => Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  at: Instant,
  sessionId: Uuid,
  type: Type.Literal(type),
  ...props,
}, strict);

export const LocalPlanEntry = Type.Object({
  content: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
}, strict);

export const LocalHandbackCriterion = Type.Object({
  /** 第几条完成标准，从 1 开始。 */
  index: Type.Integer({ minimum: 1 }),
  result: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")]),
  evidence: Type.String({ maxLength: 2000 }),
}, strict);

/**
 * GET /v1/sessions/:id/events（text/event-stream）。每条 `id: <seq>` + `data: <JSON>`。
 * 断线后带 Last-Event-ID 重连，本机从会话事件日志补发其后的全部事件；也可用 ?after=<seq>。
 * 事件已归一化，不随执行方变：Claude Code 和以后的 Codex 都映射到这几种。
 */
export const LocalSessionEvent = Type.Union([
  ev("status", { status: LocalSessionStatus, exitCode: Type.Optional(Nullable(Type.Integer())), reason: Type.Optional(Type.String()) }),
  ev("agent_info", { agent: LocalAgentKind, version: Type.String(), model: Nullable(Type.String()), permissionMode: Nullable(Type.String()) }),
  ev("user_message", { text: Type.String(), source: Type.Union([Type.Literal("initial"), Type.Literal("web")]) }),
  ev("assistant_text", { text: Type.String() }),
  ev("tool_call", { toolUseId: Type.String(), name: Type.String(), title: Type.String(), input: Type.Record(Type.String(), Type.Unknown()) }),
  ev("tool_result", { toolUseId: Type.String(), isError: Type.Boolean(), preview: Type.String() }),
  ev("plan", { entries: Type.Array(LocalPlanEntry) }),
  ev("permission_request", { request: LocalPermissionRequestView }),
  ev("permission_resolved", { requestId: Type.String(), decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]), message: Type.Optional(Type.String()), allowForSession: Type.Boolean() }),
  ev("turn_end", {
    isError: Type.Boolean(),
    text: Nullable(Type.String()),
    durationMs: Type.Integer({ minimum: 0 }),
    usage: LocalUsage,
    errorKind: Type.Optional(Type.Union([Type.Literal("auth"), Type.Literal("api"), Type.Literal("interrupted"), Type.Literal("other")])),
  }),
  ev("artifact", { artifactId: Id, title: Type.String(), fileName: Type.String(), size: Type.Integer({ minimum: 0 }), sha256: Type.String() }),
  ev("handback", { summary: Type.String(), criteria: Type.Array(LocalHandbackCriterion) }),
  /** interjection_next_step：插话已送出，下一步生效；auth_required：执行方登录失效；agent_stderr：执行方报错输出。 */
  ev("notice", { level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]), code: Type.String(), text: Type.String() }),
]);

// ───────────────────────── 云端同步载荷（本机 → 天枢 api，单向） ─────────────────────────

const syncItem = <T extends string, D extends TSchema>(type: T, data: D) => Type.Object({
  /** 幂等键：<deviceId>:<sessionId>:<本机序号>。云端按它去重，重复提交返回 accepted。 */
  key: Type.String({ minLength: 10, maxLength: 200 }),
  sessionId: Uuid,
  subject: LocalSessionSubject,
  occurredAt: Instant,
  type: Type.Literal(type),
  data,
}, strict);

export const LocalSyncItem = Type.Union([
  syncItem("status", Type.Object({
    status: LocalSessionStatus, title: Type.String(), agent: LocalAgentKind, modelLabel: Type.String(),
  }, strict)),
  syncItem("plan", Type.Object({ entries: Type.Array(LocalPlanEntry, { maxItems: 100 }) }, strict)),
  /** 证据：一段说明、日志片段、链接（PR 等）、改动摘要。不传完整工具输出。 */
  syncItem("evidence", Type.Object({
    kind: Type.Union([Type.Literal("note"), Type.Literal("log"), Type.Literal("link"), Type.Literal("diff_summary")]),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    text: Type.Optional(Type.String({ maxLength: 8000 })),
    url: Type.Optional(Type.String({ pattern: "^https?://", maxLength: 2000 })),
  }, strict)),
  /** 产出物：执行方点名交出的文件（HTML、Markdown、PDF、Word），原文 base64，单个不超过 10 MB。同名再交记新一版。 */
  syncItem("artifact", Type.Object({
    artifactId: Id,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    fileName: Type.String({ minLength: 1, maxLength: 200 }),
    mimeType: Type.String({ maxLength: 100 }),
    size: Type.Integer({ minimum: 0, maximum: 10 * 1024 * 1024 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    contentBase64: Type.String({ maxLength: 14 * 1024 * 1024 }),
  }, strict)),
  syncItem("handback", Type.Object({ summary: Type.String({ maxLength: 4000 }), criteria: Type.Array(LocalHandbackCriterion, { maxItems: 50 }) }, strict)),
  /** 花费：每轮结束报一次本轮的增量。 */
  syncItem("cost", Type.Object({ modelLabel: Type.String(), usage: LocalUsage }, strict)),
]);

export const LocalSyncBatchRequest = Type.Object({
  deviceId: Uuid,
  runnerVersion: Type.String(),
  items: Type.Array(LocalSyncItem, { minItems: 1, maxItems: 50 }),
}, strict);
export const LocalSyncBatchResponse = Type.Object({
  /** 已存下或以前存过的幂等键；本机据此出队。 */
  accepted: Type.Array(Type.String()),
  /** 永久拒收（如卡不属于本人）：本机记日志后出队，不再重试。没出现在两边的视为暂时失败，稍后重试。 */
  rejected: Type.Array(Type.Object({ key: Type.String(), code: Type.String(), message: Type.String() }, strict)),
}, strict);

export type TLocalRunnerError = Static<typeof LocalRunnerError>;
export type TLocalRunnerErrorCode = Static<typeof LocalRunnerErrorCode>;
export type TLocalAgentKind = Static<typeof LocalAgentKind>;
export type TLocalSessionKind = Static<typeof LocalSessionKind>;
export type TLocalHealthResponse = Static<typeof LocalHealthResponse>;
export type TLocalPairingStartRequest = Static<typeof LocalPairingStartRequest>;
export type TLocalPairingStartResponse = Static<typeof LocalPairingStartResponse>;
export type TLocalPairingStatus = Static<typeof LocalPairingStatus>;
export type TLocalPairingStatusResponse = Static<typeof LocalPairingStatusResponse>;
export type TLocalAgentSetupPhase = Static<typeof LocalAgentSetupPhase>;
export type TLocalAgentStatus = Static<typeof LocalAgentStatus>;
export type TLocalOutboxStatus = Static<typeof LocalOutboxStatus>;
export type TLocalCloudLinkView = Static<typeof LocalCloudLinkView>;
export type TLocalSettings = Static<typeof LocalSettings>;
export type TLocalSettingsPatch = Static<typeof LocalSettingsPatch>;
export type TLocalStatusResponse = Static<typeof LocalStatusResponse>;
export type TLocalAgentLoginCodeRequest = Static<typeof LocalAgentLoginCodeRequest>;
export type TLocalCloudLinkRequest = Static<typeof LocalCloudLinkRequest>;
export type TLocalModelSource = Static<typeof LocalModelSource>;
export type TLocalModelProfile = Static<typeof LocalModelProfile>;
export type TLocalModelListResponse = Static<typeof LocalModelListResponse>;
export type TLocalModelProfileUpsert = Static<typeof LocalModelProfileUpsert>;
export type TLocalFolder = Static<typeof LocalFolder>;
export type TLocalFolderListResponse = Static<typeof LocalFolderListResponse>;
export type TLocalFolderPickResponse = Static<typeof LocalFolderPickResponse>;
export type TLocalSessionStatus = Static<typeof LocalSessionStatus>;
export type TLocalSessionSubject = Static<typeof LocalSessionSubject>;
export type TLocalUsage = Static<typeof LocalUsage>;
export type TLocalCreateSessionRequest = Static<typeof LocalCreateSessionRequest>;
export type TLocalSessionSummary = Static<typeof LocalSessionSummary>;
export type TLocalSessionListResponse = Static<typeof LocalSessionListResponse>;
export type TLocalPermissionRequestView = Static<typeof LocalPermissionRequestView>;
export type TLocalSessionDetailResponse = Static<typeof LocalSessionDetailResponse>;
export type TLocalSendMessageRequest = Static<typeof LocalSendMessageRequest>;
export type TLocalSendMessageResponse = Static<typeof LocalSendMessageResponse>;
export type TLocalPermissionDecisionRequest = Static<typeof LocalPermissionDecisionRequest>;
export type TLocalSessionActionResponse = Static<typeof LocalSessionActionResponse>;
export type TLocalPlanEntry = Static<typeof LocalPlanEntry>;
export type TLocalHandbackCriterion = Static<typeof LocalHandbackCriterion>;
export type TLocalSessionEvent = Static<typeof LocalSessionEvent>;
export type TLocalSyncItem = Static<typeof LocalSyncItem>;
export type TLocalSyncBatchRequest = Static<typeof LocalSyncBatchRequest>;
export type TLocalSyncBatchResponse = Static<typeof LocalSyncBatchResponse>;

/**
 * 本机 API 路由表（方法 + 路径），网页客户端和本机程序共用，免得两边各写一份字符串。
 * auth=false 的只要求来源白名单，不要求口令。
 */
export const LOCAL_RUNNER_ROUTES = {
  health: { method: "GET", path: "/v1/health", auth: false },
  startPairing: { method: "POST", path: "/v1/pairings", auth: false },
  pairingStatus: { method: "GET", path: "/v1/pairings/:pairingId", auth: false },
  unpair: { method: "DELETE", path: "/v1/pairing", auth: true },
  status: { method: "GET", path: "/v1/status", auth: true },
  installAgent: { method: "POST", path: "/v1/agents/:agent/install", auth: true },
  loginAgent: { method: "POST", path: "/v1/agents/:agent/login", auth: true },
  loginAgentCode: { method: "POST", path: "/v1/agents/:agent/login/code", auth: true },
  cancelAgentSetup: { method: "DELETE", path: "/v1/agents/:agent/setup", auth: true },
  getCloud: { method: "GET", path: "/v1/cloud", auth: true },
  linkCloud: { method: "PUT", path: "/v1/cloud", auth: true },
  unlinkCloud: { method: "DELETE", path: "/v1/cloud", auth: true },
  getSettings: { method: "GET", path: "/v1/settings", auth: true },
  patchSettings: { method: "PATCH", path: "/v1/settings", auth: true },
  listModels: { method: "GET", path: "/v1/models", auth: true },
  putModel: { method: "PUT", path: "/v1/models/:id", auth: true },
  deleteModel: { method: "DELETE", path: "/v1/models/:id", auth: true },
  listFolders: { method: "GET", path: "/v1/folders", auth: true },
  pickFolder: { method: "POST", path: "/v1/folders/pick", auth: true },
  deleteFolder: { method: "DELETE", path: "/v1/folders/:id", auth: true },
  listSessions: { method: "GET", path: "/v1/sessions", auth: true },
  createSession: { method: "POST", path: "/v1/sessions", auth: true },
  getSession: { method: "GET", path: "/v1/sessions/:id", auth: true },
  sessionEvents: { method: "GET", path: "/v1/sessions/:id/events", auth: true },
  sendMessage: { method: "POST", path: "/v1/sessions/:id/messages", auth: true },
  interrupt: { method: "POST", path: "/v1/sessions/:id/interrupt", auth: true },
  decidePermission: { method: "POST", path: "/v1/sessions/:id/permissions/:requestId", auth: true },
  kill: { method: "POST", path: "/v1/sessions/:id/kill", auth: true },
} as const;
