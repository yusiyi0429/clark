import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Budget, BudgetMode } from "./budget.js";
import { NullableInteger, NullableNumber } from "./nullable.js";

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
/** 云端「验收交代」（相对天枢 api 的根）：GET ?handbackKey=<交回条目的 key>，鉴权同上。本机在交回同步上去以后取它，起验收会话。 */
export const LOCAL_RUNNER_VERIFY_BRIEF_PATH = "/api/local-runner/verify-brief";
/**
 * 云端子会话附件（相对天枢 api 的根，新首页 14.5）：GET /api/local-runner/attachments/:id 回文件原样（Content-Type 是它的类型，x-sha256 是摘要），鉴权同上，
 * 只给附件主人配对的电脑。本机收到带 attachments 的一句话时按 id 取回，存进这件 Task 的工作区，把路径交给 Claude Code。
 */
export const LOCAL_RUNNER_ATTACHMENT_PATH = "/api/local-runner/attachments/:id";

const Instant = Type.String({ format: "date-time" });
const Id = Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" });
const Uuid = Type.String({ format: "uuid" });
const strict = { additionalProperties: false } as const;
/** 钥匙和令牌只收可见 ASCII（不含空格、换行等控制字符），免得经 stdin 交给系统凭据工具时被当成另一条命令。 */
const SECRET_CHARS = "^[\x21-\x7E]*$";
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
/** 同步条目的幂等键，交回时用它点名产出和证据（云端存成 local_outputs.client_id）。 */
const SyncKey = Type.String({ minLength: 10, maxLength: 200 });
/** git 提交号（完整的 40 位，SHA-256 仓库是 64 位）。 */
const Sha = Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" });

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
/**
 * 本机会话的四种（V2 设计第 21 节）：都是能对话的本机会话，都占本机的位置。
 * - card：执行 worker，看板上的一张卡（执行事项）；topic：调研专题。
 * - plan：规划员，把一个 Task 拆成计划和派活单草稿（propose_plan），只读不改文件。交了计划、这一轮做完就收工（done）；
 *   本人「改一改」就对它说一句（POST /v1/sessions/:id/messages），本机续上原来的对话，改完再交一次（revision +1），又收工。
 * - verify：验收员，执行方交回以后本机自己起，逐条判这次交回（submit_verdict），只读不改文件，交完结论就收工（done）。网页不能开这种会话。
 * 排队先后：verify → plan → card、topic；同一种先来先跑。
 */
export const LocalSessionKind = Type.Union([Type.Literal("card"), Type.Literal("topic"), Type.Literal("plan"), Type.Literal("verify")]);
/** 模型档位，和云端岗位的 modelTier 一致：strong 强、normal 普通、light 轻。 */
export const LocalModelTier = Type.Union([Type.Literal("strong"), Type.Literal("normal"), Type.Literal("light")]);

// ───────────────────────── 健康与配对 ─────────────────────────

/**
 * 本机同时跑的位置（V2 设计 20.6，界面上的「资源 · 本机 ▮▮▯」）：max 是上限（本机设置 maxConcurrent，默认 3）；
 * running 是占着位置的会话（开工中、进行中、等你批准；一轮做完在等你回复的不占）；queued 是等空位的。
 */
export const LocalSlots = Type.Object({
  max: Type.Integer({ minimum: 1 }),
  running: Type.Integer({ minimum: 0 }),
  queued: Type.Integer({ minimum: 0 }),
}, strict);

/** GET /v1/health：不需要口令，只要来源在白名单里。网页据此判断「装了没、配对没」，资源栏也读这里的 slots。 */
export const LocalHealthResponse = Type.Object({
  app: Type.Literal("tianshu-local"),
  version: Type.String(),
  protocol: Type.Integer({ minimum: 1 }),
  platform: Type.Union([Type.Literal("win32"), Type.Literal("darwin"), Type.Literal("linux")]),
  /** 请求里带的口令是否有效；没带就是 false。 */
  tokenValid: Type.Boolean(),
  slots: LocalSlots,
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
  /**
   * 关联的是谁（关联时网页传来的天枢人员 id）：网页拿它和登录的人比，对不上就把这台电脑当未配对，不显示别人的本机会话。
   * 没关联、或者是老的关联（当时没传 personId）时为 null。
   */
  personId: Nullable(Type.String()),
  outbox: LocalOutboxStatus,
}, strict);

export const LocalSettings = Type.Object({
  /** 新开的会话是否默认带上本人全局配置（hooks、插件、个人 MCP）。默认 false：会话干净。 */
  includePersonalConfigByDefault: Type.Boolean(),
  /** 只读：允许直连的网页来源。改它要在本机配置文件里改，网页不能改。 */
  allowedOrigins: Type.Array(Type.String()),
  /** 「暂停全部」后为 true：进行中的会话停下，不接新会话、不续接旧会话；只能在托盘里恢复。 */
  paused: Type.Boolean(),
  /** 同时最多跑几个（默认 3，插件页可改，不设上限；超过 10 个时网页提醒电脑和额度可能吃紧）。超出的排队，先来先跑；调大时立刻从队里接上。 */
  maxConcurrent: Type.Integer({ minimum: 1 }),
  /**
   * 「验收过就合回」（默认 true，插件页可改）：卡的验收过了，主文件夹停在原分支上、没有没提交的改动、合并没有冲突时，本机自动合回（只合不推），
   * 等它的卡接着自己开始。不满足或关了时不合，卡的 workspace.needsMerge 写明原因，等本人合。
   */
  autoMerge: Type.Boolean(),
}, strict);
export const LocalSettingsPatch = Type.Object({
  includePersonalConfigByDefault: Type.Optional(Type.Boolean()),
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
  autoMerge: Type.Optional(Type.Boolean()),
  /** 网页只能暂停（true）；传 false 会被拒（409），恢复只能在本机托盘里点。 */
  paused: Type.Optional(Type.Boolean()),
}, strict);

/** 一笔钱：金额、币种（如 USD、CNY）、是不是估的。 */
export const LocalMoney = Type.Object({ amount: Type.Number({ minimum: 0 }), currency: Type.String({ minLength: 1, maxLength: 10 }), estimated: Type.Boolean() }, strict);

/**
 * 订阅的一个额度窗口（11/07 用 Claude Code 2.1.318 的 get_usage 和 rate_limit_event 实测）：
 * session 是 5 小时窗口（计划里有才有）；weekly_all 本周（所有模型）；weekly_scoped 本周某个模型的（model 是它的名字，如 Fable）。
 * usedPercent 用了多少（0–100）；state：ok、warning（到了警戒线）、blocked（用完了，到 resetsAt 恢复）；resetsAt 下次重置（读不到为 null）。
 */
export const LocalQuotaWindow = Type.Object({
  kind: Type.Union([Type.Literal("session"), Type.Literal("weekly_all"), Type.Literal("weekly_scoped")]),
  model: Nullable(Type.String({ minLength: 1, maxLength: 60 })),
  usedPercent: Type.Integer({ minimum: 0, maximum: 100 }),
  state: Type.Union([Type.Literal("ok"), Type.Literal("warning"), Type.Literal("blocked")]),
  resetsAt: Nullable(Instant),
}, strict);
/**
 * 用量来源的种类（新首页设计 14.4）：subscription 订阅额度（剩多少百分比，按窗口重置）；api_balance API 余额（剩多少钱）；
 * daily_spend 当天花了多少（TokenHub 这种按量付费的）。
 */
export const LocalUsageKind = Type.Union([Type.Literal("subscription"), Type.Literal("api_balance"), Type.Literal("daily_spend")]);
/**
 * 一个用量来源（右栏「用量」的一格，新首页设计 14.4）。来源不限几家，按这个形状往下排：
 * - Claude 订阅（id claude）：本机向 Claude Code 读（get_usage，不发提示、不花 token），跑着的卡实时报的 rate_limit_event 也算进来；
 * - Codex 订阅（id codex，装了 Codex 才有）：codex app-server 的 account/rateLimits/read（11/07 实测 0.159.2 约 5 秒，不花 token），按窗口长度认 5 小时和本周，
 *   Codex 不报警戒线，只看到没到 100%；只显示，不挡卡；
 * - TokenHub（id tokenhub:<网关主机>，kind daily_spend）：TokenHub 自己的统计（GET <网关主机>/api/tokavi/v1/log/usage，用本机存的那把钥匙，只能查这把钥匙所在的账户，
 *   每人一个计费账户，就是本人的），amounts 是今天（本机 0 点起）、monthAmounts 是本月（1 日 0 点起）花了多少，按币种各一笔，estimated false，不换算；半小时一格；
 * - 别的 API（MiniMax、DeepSeek 等，id api:<名字>，kind api_balance）：amounts 是余额。形状先留着，本机还没读。
 * kind subscription 时：remainingPercent 是 100 减去用得最多的那个窗口（按模型分的周额度不算，除非只有它）；windows 只列计划里有的窗口；
 * resetsAt 是剩得最少的那个窗口几点重置；blockedUntil 用完时几点恢复（没用完为 null）；plan 计划名（如 max、plus）；extraUsage 额外额度开没开（读不到为 null）。
 * 别的 kind 这几项为 null、windows 为空。name 是显示名（Claude、Codex、TokenHub…）。updatedAt 最近一次读到的时间（还没读到为 null）；error 最近一次没读到的原因。
 * 账号邮箱、组织、账户名不在这里，也不出本机。本机每 5 分钟（网页问状态时）读一次。
 */
export const LocalQuotaSource = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  kind: LocalUsageKind,
  remainingPercent: NullableInteger({ minimum: 0, maximum: 100 }),
  amounts: Type.Array(LocalMoney, { maxItems: 4 }),
  monthAmounts: Type.Optional(Type.Array(LocalMoney, { maxItems: 4 })),
  windows: Type.Array(LocalQuotaWindow, { maxItems: 12 }),
  resetsAt: Nullable(Instant),
  blockedUntil: Nullable(Instant),
  plan: Nullable(Type.String({ maxLength: 40 })),
  extraUsage: Nullable(Type.Boolean()),
  updatedAt: Nullable(Instant),
  error: Nullable(Type.String({ maxLength: 300 })),
}, strict);
/** 同步给云端的用量：读到过的才带，不带计划名、额外额度、出错原因。 */
export const LocalQuotaSync = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  kind: LocalUsageKind,
  remainingPercent: NullableInteger({ minimum: 0, maximum: 100 }),
  amounts: Type.Array(LocalMoney, { maxItems: 4 }),
  monthAmounts: Type.Optional(Type.Array(LocalMoney, { maxItems: 4 })),
  windows: Type.Array(LocalQuotaWindow, { maxItems: 12 }),
  resetsAt: Nullable(Instant),
  blockedUntil: Nullable(Instant),
  updatedAt: Instant,
}, strict);

/**
 * 这台电脑上的执行方和 worker 能用的命令行工具（右栏「这台电脑」逐项检查、连接页，新首页设计 14.4）：claude-code 是 Claude Code（照它自己报的登录，每次问状态现查），
 * codex 是 Codex（codex login status），gh 是 GitHub，lark-cli 是飞书命令行。有一项不是 ready，网页就提醒。
 * state：ready 已登录；not_installed 没装；not_logged_in 没登录；expired 登录过期；unknown 还没查完。
 * account 登的是谁（GitHub 用户名、飞书里的名字；Claude Code、Codex 为 null），只在本机，不同步。checkedAt 上次查的时间（Codex、gh、lark-cli 本机启动时和每 10 分钟查一次）。
 */
export const LocalToolStatus = Type.Object({
  kind: Type.Union([Type.Literal("claude-code"), Type.Literal("codex"), Type.Literal("gh"), Type.Literal("lark-cli")]),
  state: Type.Union([Type.Literal("ready"), Type.Literal("not_installed"), Type.Literal("not_logged_in"), Type.Literal("expired"), Type.Literal("unknown")]),
  version: Nullable(Type.String({ maxLength: 40 })),
  account: Nullable(Type.String({ maxLength: 100 })),
  checkedAt: Nullable(Instant),
}, strict);

/** GET /v1/status */
export const LocalStatusResponse = Type.Object({
  deviceId: Uuid,
  version: Type.String(),
  agents: Type.Array(LocalAgentStatus),
  /** 等于 slots.running（留着兼容）。 */
  activeSessions: Type.Integer({ minimum: 0 }),
  slots: LocalSlots,
  cloud: LocalCloudLinkView,
  settings: LocalSettings,
  /** 用量（见 LocalQuotaSource）：Claude 订阅、装了 Codex 时的 Codex 订阅、配了 TokenHub 时的 TokenHub 当天花费，以后还有别的 API。 */
  quota: Type.Array(LocalQuotaSource, { maxItems: 16 }),
  /** 这台电脑上的执行方和命令行工具登没登录（右栏「这台电脑」逐项检查）：Claude Code、Codex、gh、lark-cli。 */
  tools: Type.Array(LocalToolStatus, { maxItems: 8 }),
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
  /** 关联的是谁：云端 me 里的人员 id，本机存下来，GET /v1/status 和 /v1/cloud 原样给回（见 LocalCloudLinkView）。 */
  personId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, strict);

// ───────────────────────── 模型与文件夹 ─────────────────────────

/**
 * subscription：用本人在 Claude Code 里的登录，不设任何模型环境变量（内置一条，id 固定为 "subscription"）。
 * gateway：Anthropic 格式的自定义地址，接进 Claude Code：TokenHub、厂商的 Anthropic 兼容地址（DeepSeek、Kimi、GLM、Qwen、火山方舟等），
 * 或本机的 magpie（127.0.0.1:3425，把 Codex、Copilot、Gemini 等订阅和别家 API 转成 Anthropic 格式）。钥匙只存本机（系统凭据库），任何接口都不回传。
 */
export const LocalModelSource = Type.Union([Type.Literal("subscription"), Type.Literal("gateway")]);
/**
 * 真正的来源（本机按地址和模型名认出来，网页照写，不用自己猜）：
 * - provider：认出的来源 id。claude-subscription 本人的 Claude 订阅；tokenhub；厂商 API 是 deepseek、kimi、glm、qwen、volcengine、minimax、anthropic 等；
 *   经 magpie 时按模型名的前缀（codex/…、deepseek/…）认，如 codex、copilot、gemini；都认不出就是地址的主机名（经 magpie 又没有前缀时是 magpie）。
 * - label：给人看的，如「我的 Claude 订阅」「TokenHub」「DeepSeek API」「Codex 订阅 · 经 magpie」「api.example.com」。
 * - via：经本机 magpie 转的为 magpie，直连为 null。
 * 子会话选模型时写「执行方 · 来源 · 模型」，如「Claude Code · Codex 订阅 · 经 magpie · gpt-6.1」。用量照旧按来源（LocalQuotaSource）汇总。
 */
export const LocalModelOrigin = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 100 }),
  label: Type.String({ minLength: 1, maxLength: 120 }),
  via: Nullable(Type.Literal("magpie")),
}, strict);
export const LocalModelProfile = Type.Object({
  id: Id,
  label: Type.String({ minLength: 1, maxLength: 40 }),
  source: LocalModelSource,
  /** 认出的真正来源（见 LocalModelOrigin），按 baseUrl 和 model 现算。老版本本机不带。 */
  origin: Type.Optional(LocalModelOrigin),
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
 *   地址要 https；本机地址（127.0.0.1、localhost）可以是 http。magpie（127.0.0.1:3425）不用填钥匙，本机照它的约定传 magpie；model 写「来源/模型」，如 codex/gpt-6.1。
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

// ───────────────────────── 本人加的工具 ─────────────────────────

/**
 * 本人在连接页给子会话加的工具（设计 9.5 · 11/08 改定、17.2 第 6 条）：一个 MCP 服务器，本机程序开执行会话时写进那个会话的 mcp.json。
 * - 存在这台电脑上；钥匙只存本机凭据库（Windows DPAPI、Mac 钥匙串），任何接口都不回传，写进 mcp.json 的也只是 ${变量名}。云端这个月不知道。
 * - 只收 HTTP 地址（https；本机的 127.0.0.1、localhost 可以是 http），不收命令：网页一旦被注入，收命令就等于能在本机起任意程序。
 * - preset：kingdee 金蝶（哪款产品还没定，先是占位预设，地址由本人填）；custom 其他工具。GitHub 不在这里，它就是「这台电脑」里 gh 那一行。
 * - 挂给所有执行会话（卡、专题），不受岗位工具名单管；规划员、验收员不挂。Codex 下个月接。
 * - 放行：预设带一份读工具名单，读的照权限模式放行（「自动」「全部放行」不问，和天枢 MCP 的读工具一样）；写的、认不出的，哪一档都问本人。
 */
export const LocalToolPreset = Type.Union([Type.Literal("kingdee"), Type.Literal("custom")]);
/**
 * 连没连上（本机发一次 MCP 的 initialize 和 tools/list）：ready 连上了；unauthorized 钥匙不对或过期（401、403）；
 * unreachable 连不上或回的不是 MCP；unknown 还没查。加、改、点「检查」时查，结果只留本机。
 */
export const LocalToolState = Type.Union([Type.Literal("ready"), Type.Literal("unauthorized"), Type.Literal("unreachable"), Type.Literal("unknown")]);
export const LocalTool = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 40 }),
  preset: LocalToolPreset,
  url: Type.String({ maxLength: 300 }),
  /** 钥匙放在哪个请求头：null 是 Authorization: Bearer <钥匙>，否则原样放进这个头（如 X-Api-Key）。 */
  keyHeader: Nullable(Type.String({ maxLength: 60 })),
  hasKey: Type.Boolean(),
  state: LocalToolState,
  /** 连上时它有几个工具。 */
  toolCount: NullableInteger({ minimum: 0 }),
  /** 没连上的一句原因（给人看）。 */
  error: Nullable(Type.String({ maxLength: 200 })),
  checkedAt: Nullable(Instant),
  addedAt: Instant,
}, strict);
/** GET /v1/tools */
export const LocalToolListResponse = Type.Object({ tools: Type.Array(LocalTool, { maxItems: 20 }) }, strict);
/**
 * PUT /v1/tools/:id：加或改一个工具（id 由网页起，字母数字、- 和 _），最多 20 个。不收 command、args 这类字段。
 * apiKey 只写不读：不传是保留原钥匙，传空串是删掉；地址改了又没给新钥匙时旧钥匙作废（免得改个地址就把钥匙发到别处）。
 * keyHeader 不传是用 Authorization: Bearer。存完马上查一次连没连上，回的是查完的 LocalTool。
 */
export const LocalToolUpsert = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 40 }),
  preset: LocalToolPreset,
  url: Type.String({ minLength: 8, maxLength: 300, pattern: "^https?://" }),
  keyHeader: Type.Optional(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9-]{0,59}$" })),
  apiKey: Type.Optional(Type.String({ maxLength: 2000, pattern: SECRET_CHARS })),
}, strict);

/** 文件夹挂在哪个项目上（项目 id 是天枢给的，name 是绑定时网页带来的名字，只用来显示）。 */
export const LocalFolderProject = Type.Object({ projectId: Uuid, name: Nullable(Type.String({ maxLength: 120 })) }, strict);
/**
 * 本人允许本机程序读写的文件夹。只能经本机弹出的系统选择框添加（POST /v1/folders/pick），网页不能直接写路径。
 * projects：这个文件夹在这台电脑上挂着哪几个项目（新首页设计 16.6，连接页的文件夹列表用）；GET /v1/folders 总会带，选文件夹的回执不带。
 */
export const LocalFolder = Type.Object({
  id: Id,
  path: Type.String(),
  label: Type.String(),
  addedAt: Instant,
  projects: Type.Optional(Type.Array(LocalFolderProject, { maxItems: 50 })),
}, strict);
/**
 * 一个项目在这台电脑上对应的文件夹（新首页设计 16.1、16.6：按设备分别绑，存在本机，不报给云端）。folder 为 null 是还没绑或解绑了。
 * 项目的卡、专题、规划员不指定工作目录时就在这个文件夹里做（卡在 git 仓库里照样开自己的工作树）；没绑时卡在本机程序给这个项目建的专用目录里做，
 * 专题、规划员照旧用各自的专用目录。
 */
export const LocalProjectFolder = Type.Object({
  projectId: Uuid,
  name: Nullable(Type.String({ maxLength: 120 })),
  folder: Nullable(Type.Object({ id: Id, path: Type.String(), label: Type.String() }, strict)),
  updatedAt: Instant,
}, strict);
/** GET /v1/projects：这台电脑上记着的项目和文件夹。 */
export const LocalProjectListResponse = Type.Object({ projects: Type.Array(LocalProjectFolder) }, strict);
/**
 * PUT /v1/projects/:projectId/folder：把项目绑到一个已允许的文件夹（folderId，先经 POST /v1/folders/pick 选好），null 是解绑；name 是项目名（只用来显示，可不带）。
 * 项目交出去以后（16.7），原负责人那边的网页传 null 解绑：只解绑，不动文件夹里的文件，文件夹也还在允许的列表里。
 * 文件夹不在允许的列表里回 404。删掉一个允许的文件夹（DELETE /v1/folders/:id）时，绑着它的项目一起解绑。
 */
export const LocalProjectFolderRequest = Type.Object({
  folderId: Nullable(Id),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, strict);

/**
 * POST /v1/projects/:projectId/handover-check（新首页设计 16.7「准备交接」）：项目绑的文件夹现在什么样，只看 git，不调模型。网页把结果交给天枢写交接说明。
 * - folder：绑的文件夹（没绑为 null，这时 git、recentFiles 都是 null）。
 * - git（是 git 仓库时）：branch 当前分支（不在分支上为 null）；remotes 远端（url 去掉了口令：https 的账号口令整个去掉，ssh 只留用户名）；uncommitted 没提交的文件（含没加进 git 的，相对仓库根，最多 200 个，
 *   uncommittedCount 是总数）；unpushed 没推完的本地分支：没有上游的 ahead 为 null，有上游的是比上游多几个提交（卡的 tianshu/… 分支也在这里）。
 * - recentFiles（不是 git 仓库时）：最近改过的文件（相对文件夹，跳过 node_modules、.git 这类目录，最多 30 个，新的在前）。
 * 账号口令、文件内容都不在结果里。
 */
export const LocalHandoverCheck = Type.Object({
  projectId: Uuid,
  checkedAt: Instant,
  folder: Nullable(Type.Object({ path: Type.String(), label: Type.String() }, strict)),
  git: Nullable(Type.Object({
    branch: Nullable(Type.String({ maxLength: 250 })),
    remotes: Type.Array(Type.Object({ name: Type.String({ maxLength: 100 }), url: Type.String({ maxLength: 500 }) }, strict), { maxItems: 10 }),
    uncommitted: Type.Array(Type.String(), { maxItems: 200 }),
    uncommittedCount: Type.Integer({ minimum: 0 }),
    unpushed: Type.Array(Type.Object({ branch: Type.String({ maxLength: 250 }), upstream: Nullable(Type.String({ maxLength: 250 })), ahead: NullableInteger({ minimum: 1 }) }, strict), { maxItems: 50 }),
  }, strict)),
  recentFiles: Nullable(Type.Array(Type.Object({ path: Type.String(), modifiedAt: Instant }, strict), { maxItems: 30 })),
}, strict);
/**
 * POST /v1/projects/:projectId/clone（16.7「接手」以后文件夹 chip 的「拉到这台电脑」）：本机先弹系统选择框让本人选放在哪（父文件夹），
 * 在里面 git clone 仓库（文件夹名是 name，不给就用仓库名），切到 branch（交接分支；远端没有就留在默认分支，fellBack 为 true），加进允许的文件夹并绑到项目上。
 * repoUrl 只收 https://、ssh://、git@ 开头的。用本人电脑上的 git 和它已有的登录，不弹输入口令（拿不到权限直接失败）。
 * 本人在选择框点了取消：project 为 null。选的地方不许用（主目录本身等）、那里已经有同名文件夹：400 validation；clone 失败（没有仓库权限、地址不对、断网）：409 conflict，
 * message 是「没拉下来：」加 git 的报错，网页写在 chip 上。可能要几分钟，网页显示用时。
 */
/**
 * 能拉的仓库地址（本机 clone 只收这几种；云端 ProjectTransfer.clone 也用它）：https://、ssh://、git@ 开头，不带空白。
 * 交接检查给的远端已去掉口令（https 的账号口令整个去掉，ssh 只留用户名）；远端是本地路径、file:// 等别的样子时不算能拉。
 */
export const LocalRepoUrl = Type.String({ minLength: 8, maxLength: 500, pattern: "^(https://|ssh://|git@)[^\\s]+$" });
/** 能切的分支名：不以 - 开头，不带空白。 */
export const LocalBranchName = Type.String({ minLength: 1, maxLength: 250, pattern: "^[^-\\s][^\\s]*$" });
export const LocalProjectCloneRequest = Type.Object({
  repoUrl: LocalRepoUrl,
  branch: Type.Optional(LocalBranchName),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, strict);
export const LocalProjectCloneResponse = Type.Object({ project: Nullable(LocalProjectFolder), branch: Nullable(Type.String()), fellBack: Type.Boolean() }, strict);
export const LocalFolderListResponse = Type.Object({ folders: Type.Array(LocalFolder) }, strict);
/**
 * POST /v1/folders/pick：本人在本机选择框里点了取消时 folder 为 null。
 * 选了主目录或它的上级、Claude 配置目录、本机程序数据目录（或它们的上级）时回 400 validation，message 可直接给人看。
 */
export const LocalFolderPickResponse = Type.Object({ folder: Nullable(LocalFolder) }, strict);

// ───────────────────────── 会话 ─────────────────────────

export const LocalSessionStatus = Type.Union([
  /** 等空位：本机同时跑的已满，先来先跑，有空位自动开始；本机程序重启后照样排着。界面上叫「等空位」。 */
  Type.Literal("queued"),
  Type.Literal("starting"),
  Type.Literal("running"),
  /** 有权限请求挂起，等网页批准或拒绝。 */
  Type.Literal("waiting_permission"),
  /** 一轮结束，进程还在，等下一句话；或者执行方在问本人（摘要带 pendingQuestion）。界面「等你回复」，不占位置。 */
  Type.Literal("idle"),
  /** 进程已退出（停下、强停、本机程序重启）；再发消息会用 --resume 续上。 */
  Type.Literal("exited"),
  /** 交完了、进程已退出：规划员交了计划、验收员交了结论，这一轮做完就自己收工。和 exited 一样不占位置，再说一句会续上（running）。 */
  Type.Literal("done"),
  Type.Literal("failed"),
]);

export const LocalSessionSubject = Type.Object({
  kind: LocalSessionKind,
  /** 天枢里卡（执行事项）的 id：kind=card 时必填；kind=verify 时是被验的那张卡。 */
  cardId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /** 天枢里调研专题的 id，kind=topic 时必填。 */
  topicId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /** 天枢里 Task 的 id：kind=plan 时拆的是这个 Task。kind=plan 时 taskId 和 projectId 至少有一个，只带 projectId 是拆没挂 Task 的项目（16.3）。 */
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /** 只有 kind=verify（本机填）：验的是哪一次交回，就是那条 handback 同步条目的 key。 */
  handbackKey: Type.Optional(SyncKey),
  /**
   * 所属项目（新首页设计 16，天枢的项目 id）：网页把认领回执里的 SessionStartView.projectId（不为 null 时）原样放进来；验收员由本机随被验的卡带上。
   * subject 在每条同步条目里都有，状态上报就带着它（云端从 item.subject.projectId 取）。
   * 带了而不指定 cwd 时，本机在这个项目在这台电脑上绑的文件夹里做（见 LocalProjectFolder）。
   */
  projectId: Type.Optional(Uuid),
}, strict);

export const LocalUsage = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0 }),
  /**
   * Claude Code 按 Anthropic 标价算的等价金额，只算官方模型（costBasis 为 list）；网关模型（costBasis 为 unknown，它按 Opus 价瞎算）为 null。
   * 订阅登录时这不是真花的钱；真钱看 cost 条目的 money。
   */
  costUsd: NullableNumber({ minimum: 0 }),
}, strict);

/** 岗位能用的工具（插件），和云端 roles.ts 的 RoleTool 一致。 */
export const LocalRoleTool = Type.Union([Type.Literal("tianshu"), Type.Literal("web_search"), Type.Literal("feishu"), Type.Literal("github"), Type.Literal("browser")]);
const RoleText = Type.String({ maxLength: 8000 });
/**
 * 岗位（V2 设计第 19 节）：和云端交代里的 RoleBrief 同形，网页可原样转给本机。
 * 本机把职责、做法、验收口径写进会话追加的系统提示词（不往本人的仓库写文件，ADR 0037）；tools 决定挂哪些插件、给哪些工具。
 * modelTier 由网页按档位挑好模型（modelProfileId），本机不看；id、kind、version 只用来显示和留痕。
 */
export const LocalRole = Type.Object({
  id: Type.Optional(Uuid),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  kind: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("reviewer"), Type.Literal("critic")])),
  dutiesMd: RoleText,
  practiceMd: RoleText,
  acceptanceMd: RoleText,
  tools: Type.Array(LocalRoleTool, { maxItems: 5 }),
  modelTier: Type.Optional(LocalModelTier),
  version: Type.Optional(Type.Integer({ minimum: 1 })),
}, strict);

/**
 * 子会话的权限模式（新首页：子会话输入框下面的模式选择；项目主管线下面那个是这个项目新开子会话的默认，由网页记、开工时带来）。照 Claude Code 的 Mode 菜单：
 * - auto「自动（推荐）」，新子会话默认：安全的步骤本机自己放行，有风险的问本人。安全的是：在允许的文件夹里读写文件（卡在工作树里时是工作树里），
 *   不装东西、不联网、不推拉代码、不改系统设置、不删不挪文件（工作树里可以删、挪：有 git 兜底）的命令，飞书命令行只读的，天枢 MCP 里读的工具（get_、list_）。
 *   别的（联网搜索、抓网页、开子 agent 等）问。
 * - default「每次都问」：除了 Claude Code 自己就不问的（读文件、看目录这种），每一步都问本人。
 * - acceptEdits「自动接受改文件」：允许的文件夹里新建、改文件自己放行；命令和别的照样问。
 * - plan「先出计划」：执行方只读、只出计划（Claude Code 的 plan 模式），出完计划问本人「按这个做」（权限请求，toolName ExitPlanMode）；
 *   本人批了就转成 auto 接着做（事件 permission_mode，by plan_approved），拒了留在 plan、按本人说的改计划。
 * - bypassPermissions「全部放行」：除了下面的硬规矩，都自己放行。
 * 天枢的硬规矩不受模式影响，哪一档都照问本人（设计 9.5）：对外的动作（git 推送和拉取、gh（开 PR 等）、飞书命令行写的（发消息、改文档等））、
 * 危险命令表里的（装东西、联网下载、ssh、sudo、改注册表和系统设置、跑没装好的 npx 包）、碰 .git 和 .claude 的、碰允许的文件夹以外的路径、
 * 天枢 MCP 里写的工具。卡和规划员、验收员本来不给的工具（只读的会话不给写文件）照旧不给，跟模式无关。
 * 实现上 Claude Code 一律以「每次都问」起（只有 plan 用它自己的 plan 模式），每个请求都先到本机、本机按档位放行或转给网页：
 * Claude Code 自己的 auto、bypassPermissions 放行的步骤不经本机，硬规矩管不住。
 */
export const LocalPermissionMode = Type.Union([
  Type.Literal("auto"), Type.Literal("default"), Type.Literal("acceptEdits"), Type.Literal("plan"), Type.Literal("bypassPermissions"),
]);
/**
 * 每种执行方能选哪几档（没有的不出现在选择里）。Codex（12 月接）走 app-server 的审批（每一步都先问本机），能像 Claude Code 一样由本机按档位放行，
 * 只是没有「先出计划」；接上时按实测再定。
 */
export const LOCAL_AGENT_PERMISSION_MODES = {
  "claude-code": ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
  codex: ["auto", "default", "acceptEdits", "bypassPermissions"],
} as const satisfies Record<Static<typeof LocalAgentKind>, readonly Static<typeof LocalPermissionMode>[]>;

/**
 * POST /v1/sessions。kind=plan（规划员）：带 taskId，或只带 projectId（没挂 Task 的项目，网页按 plan-brief 回的 project 填），firstMessage 是云端的拆卡交代，role 是规划员岗位；不给目录时用项目绑的文件夹，再没有本机给它建一个专用目录。
 * kind=verify 不能从网页开（400）：执行方交回以后本机自己起。
 */
export const LocalCreateSessionRequest = Type.Object({
  subject: LocalSessionSubject,
  title: Type.String({ minLength: 1, maxLength: 120 }),
  /**
   * 工作目录：必须在允许的文件夹内。不填时：subject 带 projectId 且项目在这台电脑上绑了文件夹，就用那个文件夹；没绑时卡用本机给项目建的专用目录，
   * topic、plan 用各自的专用目录；不带项目的卡必须填。卡的文件夹在 git 仓库里时，卡在自己的工作树里做（见 LocalWorkspace）。
   */
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  agent: Type.Optional(LocalAgentKind),
  /** 不填用默认模型。 */
  modelProfileId: Type.Optional(Id),
  /**
   * 这件的档位（派活单上的 modelTier）。模型配置没写模型名（本人的 Claude 订阅）时，本机按档位选模型和思考强度：
   * strong 是 Opus、high；normal 是 Opus、medium；light 是 Sonnet、low。不填按岗位的档位，再没有按 normal。
   */
  modelTier: Type.Optional(LocalModelTier),
  firstMessage: Type.String({ minLength: 1, maxLength: 20000 }),
  /** 覆盖「默认干净」：true 时带上本人全局配置（hooks、插件、个人 MCP）。 */
  includePersonalConfig: Type.Optional(Type.Boolean()),
  /** 专题：云端已有的最新一版号（交代里的 latestVersion，没有版本时不填）。本机存新一版时从下一号往下编。 */
  versionBase: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 做这张卡或这个专题的岗位（交代里的 role）。不带就按通用的规矩做。 */
  role: Type.Optional(LocalRole),
  /** 只有专题：评审会用的挑刺岗位（交代里的 critics，最多 3 个）。开工时定下，评审会时并行起它们。 */
  critics: Type.Optional(Type.Array(LocalRole, { maxItems: 3 })),
  /**
   * 只有卡：要等的卡（天枢里的 cardId，派活单里 after 指的那几张）。本机先排着（摘要的 waitingFor），等这几张都在这台本机上合回以后，
   * 从基线分支最新的提交开出这张卡的工作树，自己开始。等着的时候还没有工作树（摘要不带 workspace）。
   */
  after: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 8 })),
  /**
   * 这件归哪件 Task、那件 Task 此刻的预算（新首页设计 11.3、11.4）：网页把认领回执（POST /api/me/session-starts/claim）里的 taskId 和 budget 原样转来。
   * 本机按 Task 记账：同一件 Task 的卡、规划员、验收员（随被验的卡）算在一起；taskId 为 null（不挂 Task 的专题）时只管这一个会话。
   * 每次开工带的预算覆盖本机记着的那份（以最新的为准）。不带就是「自动」、不记账。
   */
  taskBudget: Type.Optional(Type.Object({ taskId: Nullable(Type.String({ minLength: 1, maxLength: 80 })), budget: Budget }, strict)),
  /** 权限模式（见 LocalPermissionMode）：网页带项目主管线上设的默认；不带为 auto。执行方没有这一档时 400。验收员随被验的卡。 */
  permissionMode: Type.Optional(LocalPermissionMode),
}, strict);

/**
 * 卡的会话在哪做（ADR 0038）。本人选的文件夹在 git 仓库里（在某个分支上、至少有一个提交）时，每张卡在本机程序数据目录里的
 * worktrees/<cardId> 开一个自己的工作树，新建分支 tianshu/<卡 id 前 8 位>-<标题里的英文和数字>，从开工那一刻主文件夹所在分支的最新提交开始；
 * 几张卡同时做互不覆盖，交回时本机把没提交的改动提交到这个分支，验收员看开工以来这个分支上的改动。
 * 验收过了本机自动合回（LocalSettings.autoMerge，条件不满足时等本人点 POST /v1/sessions/:id/merge）。
 * 不是 git 仓库（或不在分支上、还没有提交）时就在这个文件夹里做，同一个文件夹同时只做一张卡，别的排队。
 */
/**
 * 验收过了却没自动合回的原因（卡的 workspace.needsMerge、同步条目 merge）：
 * base_not_checked_out 主文件夹现在不在 baseBranch 上；dirty 主文件夹有没提交的改动（含没加进 git 的文件）；conflict 有冲突（已放弃这次合并）；
 * auto_merge_off 本人把「验收过就合回」关了；not_ready 卡还在跑或有后台任务在跑、交回以后卡又改过、工作树不在了、主文件夹已不在允许的文件夹里（message 写明是哪种）。
 */
export const LocalMergeHoldReason = Type.Union([
  Type.Literal("base_not_checked_out"), Type.Literal("dirty"), Type.Literal("conflict"), Type.Literal("auto_merge_off"), Type.Literal("not_ready"),
]);
export const LocalWorkspace = Type.Union([
  Type.Object({
    kind: Type.Literal("worktree"),
    /** 本人选的文件夹（主文件夹）：合回在这里合。 */
    folder: Type.String(),
    /** 工作树的根目录。会话的 cwd 是它（本人选的是仓库里的子文件夹时，是工作树里对应的子文件夹）。 */
    path: Type.String(),
    branch: Type.String(),
    /** 开工时主文件夹所在的分支，合回到它。 */
    baseBranch: Type.String(),
    /** 开工时 baseBranch 的最新提交：卡的改动从这里算起。主文件夹里没提交的改动不带进工作树。 */
    baseCommit: Sha,
    /** 合回以后主文件夹里的提交（合回后工作树已清理，分支保留）；没合回为 null。 */
    mergedCommit: Nullable(Sha),
    /** 验收过了但没合回、要本人合：原因和一句给人看的话。合回了、还没验收过、又交回了在重新验收时不带。 */
    needsMerge: Type.Optional(Type.Object({ reason: LocalMergeHoldReason, message: Type.String({ minLength: 1, maxLength: 500 }) }, strict)),
  }, strict),
  Type.Object({ kind: Type.Literal("folder"), folder: Type.String() }, strict),
]);

/** Claude Code 的「问用户」（AskUserQuestion）里的一个问题，按它给的原样转给网页：标题、问题、选项（label + 说明），能不能多选。 */
export const LocalQuestion = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 2000 }),
  header: Type.String({ maxLength: 100 }),
  options: Type.Array(Type.Object({ label: Type.String({ minLength: 1, maxLength: 200 }), description: Type.String({ maxLength: 1000 }) }, strict), { maxItems: 10 }),
  multiSelect: Type.Boolean(),
}, strict);
/**
 * 一次提问（一次可以问几个问题）。问着的时候会话状态是 idle（界面「等你回复」，不占位置），摘要带 pendingQuestion；
 * 本人用 POST /v1/sessions/:id/questions/:requestId 回答。不再当成权限请求（以前网页只看到「要 AskUserQuestion · 批准 / 拒绝」）。
 */
export const LocalQuestionRequestView = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 120 }),
  questions: Type.Array(LocalQuestion, { minItems: 1, maxItems: 10 }),
  askedAt: Instant,
}, strict);

/**
 * 会话里 Claude Code 自己开的后台任务（首页右栏「后台任务」、云端 /api/me/background?scope=session:<id>）：
 * subagent 是子 agent（Agent / Task 工具），command 是后台命令（Bash 的 run_in_background）和别的后台任务。前台跑完的普通命令不算。
 * id 是 Claude Code 的 task_id，同一个会话里唯一。title 是 Claude Code 给的说明，截到 200 字；没有说明时是「子 agent」或「后台命令」（不另取命令原文和子 agent 的提示词）。
 * state：running 在跑；done 跑完了；failed 失败；stopped 被停了（本人点停止、执行方自己停、进程退出）。
 * stoppable：现在能不能点停止（在跑、进程还在才能停）。
 */
export const LocalBackgroundItemKind = Type.Union([Type.Literal("subagent"), Type.Literal("command")]);
export const LocalBackgroundItemState = Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("stopped")]);
export const LocalBackgroundItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 120 }),
  title: Type.String({ maxLength: 200 }),
  kind: LocalBackgroundItemKind,
  state: LocalBackgroundItemState,
  startedAt: Instant,
  finishedAt: Nullable(Instant),
  stoppable: Type.Boolean(),
}, strict);

/**
 * 卡为什么停着等（不是等你回复）。停着不占位置；没开始的也停在排队里、带这个原因。
 * - usage_limit：订阅额度用完了（界面「等额度恢复 · HH:MM」），until 是恢复的时间（读不到为 null）。到点后 1 分钟本机先读一次额度，没用完就自己接着做：
 *   一轮做到一半的，进程还开着就往里说一句接着做，没开着就续上（--resume）；还没开始的照常排队开始。
 * - budget：这件 Task 的预算用完了（界面「等你加预算」），until 为 null。预算加了（PUT /v1/budgets 或下一次开工带来的）本机自己接着做，同上。
 * - balance：TokenHub 余额不足（网关回 402），until 为 null。不重试、不自己接着做；本人说一句（比如充值以后）才接着做，停下就不再等。
 * 本人说一句、停下、强停都不再等。
 */
export const LocalHold = Type.Object({
  reason: Type.Union([Type.Literal("usage_limit"), Type.Literal("budget"), Type.Literal("balance")]),
  until: Nullable(Instant),
}, strict);

/** Claude Code 的思考强度（--effort）。 */
export const LocalEffort = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
/**
 * 这次拉起实际怎么跑（卡行写模型和思考强度，新首页设计 11.3、11.5）：mode 是所属 Task 的预算模式（没带预算为 auto）；
 * model 是传给 Claude Code 的模型（订阅按档位选的 opus、sonnet，网关是配置里的模型名）；effort 是思考强度（网关不传为 null）；
 * multiAgent 是多 agent（ultracode）开没开，只有「无上限」的订阅会话开，额度到 95% 时对新的轮次关掉。每次拉起、续上时定，跑着时只有 multiAgent 会变。
 */
/**
 * 执行方自己报的实际模型：Claude Code 每轮开头 system/init 里的 model（Codex 接上以后是 app-server 开线程时回的 model）。
 * 和 LocalRun.model 不一样时（订阅传的是 opus 这种别名、网关把模型换了）以它为准显示；对不上的那一下本机记一条事件 notice（code model_mismatch，
 * text 写请求的和实际的），同步给云端的 status 条目随之带新的 actual。modelName 的写法同 LocalRun.modelName；at 是报出这个模型的时间（换了模型才更新，
 * 每轮报的一样就不重报 status）。续上同一个模型时，上次报的先留着，等这次报了再换。
 */
export const LocalActualModel = Type.Object({
  model: Type.String({ minLength: 1, maxLength: 120 }),
  modelName: Type.String({ minLength: 1, maxLength: 60 }),
  at: Instant,
}, strict);
export const LocalRun = Type.Object({
  mode: BudgetMode,
  model: Nullable(Type.String({ maxLength: 120 })),
  effort: Nullable(LocalEffort),
  multiAgent: Type.Boolean(),
  /**
   * 每个子会话都显示「哪个来源的哪个模型」（选了「自动」也显示落到哪个）：界面写 `${sourceLabel} · ${actual?.modelName ?? modelName}`，
   * 如「我的 Claude 订阅 · Opus 5.5」「TokenHub · qwen3.8-flash」。下面四项本机总会填；Optional 只为兼容老版本本机报的和已存的会话。
   * source：本人的订阅还是网关（同模型配置的 source）。
   */
  source: Type.Optional(LocalModelSource),
  /** 来源的名字：模型配置的名字（内置的「我的 Claude 订阅」，或本人给 TokenHub 配置起的名字）。 */
  sourceLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  /** 哪个执行方（harness）跑：Claude Code 或 Codex（同会话的 agent）。老版本本机不带。 */
  harness: Type.Optional(LocalAgentKind),
  /**
   * 认出的真正来源（见 LocalModelOrigin）：开工前按模型配置算；经 magpie 时执行方报了实际模型（actual）就按实际模型名的前缀重认。
   * 老版本本机不带，网页退回写 sourceLabel。
   */
  origin: Type.Optional(LocalModelOrigin),
  /**
   * 给人看的模型名：认得出的 Claude 模型写成「Opus 5.5」「Sonnet 5.5」「Haiku 5.5」；订阅传的是 opus、sonnet 这种别名时，
   * 用这台电脑上一次实际跑出来的版本（见 actual），一次都没跑过就写「Opus」「Sonnet」；别的（网关模型）去掉「厂商/」前缀原样写，如 qwen3.8-flash。
   */
  modelName: Type.Optional(Nullable(Type.String({ maxLength: 60 }))),
  /** 实际跑的（见 LocalActualModel），以它为准；这次拉起后执行方还没报过为 null。 */
  actual: Type.Optional(Nullable(LocalActualModel)),
}, strict);
/**
 * POST /v1/runs/preview：开工前看这次会怎么跑（开工选项框写「我的 Claude 订阅 · Opus 5.5 · 思考 medium」，「自动」也写落到哪个）。
 * 体是开工请求（LocalCreateSessionRequest）里定跑法的那几项，原样带；回的 LocalRun 和真开工时一样算（当下的额度、这件 Task 的预算），actual 为 null。
 * 只是预览：开工时额度或预算变了，以开工那一刻算的为准（会话摘要和 status 条目里的 run）。
 */
export const LocalRunPreviewRequest = Type.Object({
  agent: Type.Optional(LocalAgentKind),
  modelProfileId: Type.Optional(Id),
  modelTier: Type.Optional(LocalModelTier),
  taskBudget: Type.Optional(Type.Object({ taskId: Nullable(Type.String({ minLength: 1, maxLength: 80 })), budget: Budget }, strict)),
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
  /** 排队时是第几个（1 起），没在排队为 null。 */
  queuePosition: NullableInteger({ minimum: 1 }),
  usage: LocalUsage,
  /** 只有卡：在工作树还是文件夹里做（本机总会填；等前面的卡时还没有工作树，不带）。 */
  workspace: Type.Optional(LocalWorkspace),
  /** 在等本人回答的提问（状态是 idle，界面「等你回复」）；没有就不带。 */
  pendingQuestion: Type.Optional(LocalQuestionRequestView),
  /** 只有卡：排着队、还在等的前面的卡（cardId，还没在这台本机上合回的），界面「已排队 · 等前面的卡」；不在等就不带。 */
  waitingFor: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8 })),
  /** 这个会话里开过的后台任务（按开始的先后，最多留最近 50 个）；没有就不带。 */
  background: Type.Optional(Type.Array(LocalBackgroundItem, { maxItems: 50 })),
  /** 停着等（见 LocalHold）；没在等就不带。 */
  hold: Type.Optional(LocalHold),
  /** 最近一次拉起时定的跑法（见 LocalRun）；还没拉起过（排着）不带。 */
  run: Type.Optional(LocalRun),
  /** 现在的权限模式（见 LocalPermissionMode）。本人在子会话底下改（PUT /v1/sessions/:id/permission-mode），计划批了从 plan 转 auto。 */
  permissionMode: LocalPermissionMode,
}, strict);
export const LocalSessionListResponse = Type.Object({ sessions: Type.Array(LocalSessionSummary) }, strict);

export const LocalPermissionRequestView = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 120 }),
  toolName: Type.String(),
  /** 给人看的一行，例如「改文件 src/app.ts」「运行 pnpm test」。 */
  title: Type.String(),
  input: Type.Record(Type.String(), Type.Unknown()),
  /**
   * 这一步要碰的、不在允许的文件夹里的路径（越界）。非空时网页要标红写明越界的路径，且只能「允许这一次」。
   * 文件类工具按字段取路径；Bash、PowerShell 是从命令里尽力认，可能认不全。本机不自动拒绝，由本人决定（ADR 0031）。
   */
  outsidePaths: Type.Array(Type.String(), { maxItems: 20 }),
  /**
   * 可以「这张卡都允许」：Claude Code 给了放行建议，这一步没越界，且建议要放开的范围（加进来的目录、放行规则里的路径）也都在允许的文件夹里。
   * 放行只在本会话内有效，不写进仓库或本人的设置。
   */
  canAllowForSession: Type.Boolean(),
  requestedAt: Instant,
}, strict);
export const LocalSessionDetailResponse = Type.Object({
  session: LocalSessionSummary,
  pendingPermissions: Type.Array(LocalPermissionRequestView),
}, strict);

/**
 * POST /v1/sessions/batch：一次开工多件（派活单点一次「开工」）。每件和单开一件一样；按给的顺序排，有空位的马上开，满了的进队列（status = queued）。
 * 开工只能由本人在这台电脑的网页上点，云端不发指令。
 */
export const LocalCreateSessionBatchRequest = Type.Object({ items: Type.Array(LocalCreateSessionRequest, { minItems: 1, maxItems: 20 }) }, strict);
/** 每件一个结果，顺序和请求一样：成了给会话（可能是 queued），没成给错误（这一件不留记录，别的照常）。 */
export const LocalCreateSessionBatchResponse = Type.Object({
  results: Type.Array(Type.Union([
    Type.Object({ ok: Type.Literal(true), session: LocalSessionSummary }, strict),
    Type.Object({ ok: Type.Literal(false), error: Type.Object({ code: LocalRunnerErrorCode, message: Type.String() }, strict) }, strict),
  ])),
}, strict);

/**
 * POST /v1/sessions/:id/messages：说一句。进行中时在下一个工具步骤生效；空闲时开下一轮；已退出时先 --resume 再发。
 * kind = review：专题开评审会（开工时带了 critics 才行），本机让会话并行起挑刺子 agent，合成「分歧和建议」存成 kind = review 的一版；
 * 这时 text 可不填，填了是本人对这次评审的补充要求。不带 kind 就是普通的一句话，text 必填。
 */
/**
 * 一句话带的附件（新首页 14.5）：云端存着的子会话附件，本机按 id 从 LOCAL_RUNNER_ATTACHMENT_PATH 取回，核对 sha256。
 * 本机存进这件的工作区：会话的工作目录（卡的工作树、专题和规划员的专用目录）里的 .tianshu-attachments/<这句话的编号>/<文件名>
 * （目录里放一个只写 * 的 .gitignore，不会被提交），再把路径写进给执行方的那句话（图片和 PDF 执行方能直接看）。
 * 格式：图片 PNG、JPEG、GIF、WebP；文档 PDF、DOCX、XLSX、PPTX、CSV、TXT、MD、JSON、HTML、XML、YAML；代码和日志。每个不超过 30 MB，一句最多 20 个。
 * 格式不支持、太大：400 validation；没连天枢、取不到、sha256 对不上：409 conflict。都是整句不发，会话里记一条 notice（attachment_failed），
 * message 写「文件名：原因」，网页照 14.5 写在附件那一行下面。
 */
export const LocalAttachmentRef = Type.Object({
  id: Type.String({ format: "uuid" }),
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  size: Type.Integer({ minimum: 1 }),
  sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
}, strict);
/** 存好了的附件：文件名、在本机的路径、大小（字节）。user_message 事件带上，网页画在本人气泡里。 */
export const LocalSavedAttachment = Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), path: Type.String(), size: Type.Integer({ minimum: 0 }) }, strict);
export const LocalSendMessageRequest = Type.Object({
  kind: Type.Optional(Type.Union([Type.Literal("say"), Type.Literal("review")])),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 20000 })),
  /** 附件（最多 20 个）：本机取回存进工作区，路径和这句话一起交给执行方；只带附件不说话时 text 可以不填。 */
  attachments: Type.Optional(Type.Array(LocalAttachmentRef, { minItems: 1, maxItems: 20 })),
}, strict);
export const LocalSendMessageResponse = Type.Object({
  /** next_step：进行中，下一步前送达；new_turn：开了新一轮；resumed：进程已退出，续接后送达。 */
  delivery: Type.Union([Type.Literal("next_step"), Type.Literal("new_turn"), Type.Literal("resumed")]),
  /** 这句话的编号（本机给的），事件流里 user_message 和 receipt 按它对上。 */
  messageId: Uuid,
}, strict);

/** POST /v1/sessions/:id/permissions/:requestId */
export const LocalPermissionDecisionRequest = Type.Object({
  decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  /** 拒绝时附一句理由，Claude 会看到。 */
  message: Type.Optional(Type.String({ maxLength: 500 })),
  /** allow 时可选：按 Claude Code 给的建议，这张卡（本会话）同类操作都允许。 */
  allowForSession: Type.Optional(Type.Boolean()),
}, strict);

/**
 * POST /v1/sessions/:id/merge（体 {}）：本人点合并，把卡的分支合回主文件夹的 baseBranch（验收过了本机会先自动试一次，见 LocalSettings.autoMerge）。只合不推。合成了清理工作树、保留分支。
 * 合不了时 merged = false，主文件夹原样不动：base_not_checked_out 主文件夹现在不在 baseBranch 上；dirty 主文件夹有没提交的改动（含没加进 git 的文件）；
 * conflict 有冲突（已放弃这次合并）。files 是有改动或冲突的文件。卡不在工作树里、卡或它的验收员还在跑、卡的工作树里还有没提交的改动、已经合回过，回 409。
 */
export const LocalMergeBlockReason = Type.Union([Type.Literal("base_not_checked_out"), Type.Literal("dirty"), Type.Literal("conflict")]);
export const LocalMergeResponse = Type.Union([
  Type.Object({ merged: Type.Literal(true), commit: Sha, session: LocalSessionSummary }, strict),
  Type.Object({ merged: Type.Literal(false), reason: LocalMergeBlockReason, message: Type.String(), files: Type.Array(Type.String(), { maxItems: 200 }) }, strict),
]);

/**
 * POST /v1/sessions/:id/questions/:requestId：回答一次提问，回执是 LocalSessionActionResponse。choices[i] 是第 i 个问题选中的选项 label
 * （单选最多一个，多选可以几个，可以一个不选），条数和 questions 一样；text 是本人另外写的话（不在选项里的回答）。
 * 这次提问已经答过或已失效（这一轮停了、进程退出了）回 409。
 */
export const LocalQuestionAnswerRequest = Type.Object({
  choices: Type.Array(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 10 }), { minItems: 1, maxItems: 10 }),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
}, strict);

/**
 * POST /v1/sessions/:id/background/:itemId/stop（体 {}）：停一个后台任务（让 Claude Code 停掉它，会话本身不停），回执是 LocalSessionActionResponse。
 * 停下以后这一项的 state 变成 stopped（事件 background 和同步条目 background 都会报）。不在跑、进程已退出、没有这一项回 409。
 */

/** POST /v1/sessions/:id/interrupt（停下，会话保留）与 /kill（强停，杀本会话进程树）的回执。 */
export const LocalSessionActionResponse = Type.Object({ session: LocalSessionSummary }, strict);
/**
 * PUT /v1/sessions/:id/permission-mode：本人在子会话底下换模式，跑着的时候也能换，下一步就按新的来；回改完的会话。
 * 换成更宽的档时，正在等批准的请求按新的档重判一遍，新档放行的就自己放行（网页上那条随之消失）。执行方没有这一档时 400；会话已结束 409。
 */
export const LocalPermissionModeRequest = Type.Object({ mode: LocalPermissionMode }, strict);

// ───────────────────────── 预算（新首页设计 11.3、11.4） ─────────────────────────

/**
 * 本机记着的一份预算和用了多少：一件 Task 一份（taskId），不挂 Task 的专题一个会话一份（sessionId）。
 * spent 从这件 Task 第一个会话开工起算：
 * - hours：真在跑的时长（status 是 starting、running 的时间；排队、等额度、等你批准、等你回复都不算），含规划员、验收员；
 * - weeklyPercent：订阅本周额度（weekly_all）从开工起涨了几个百分点，整个账号的（含本人自己同时在用的），按整数涨；中途重置过就接着累加；读不到额度为 null；
 * - money：网关这件 Task 花了多少，本机按 TokenHub 价目表一轮一轮估的（estimated true），币种照预算的币种（预算没设金额时照第一笔的），别的币种的不算；没花过为 null。
 * ratio：设预算时各项「用了 ÷ 上限」里最大的那个；别的模式为 null。state：ok；warning 到了 80%（后面开的卡思考强度降一档、验收员用轻档，不打断）；
 * exhausted 到了 100%（排着的不开始，跑着的收到一句「做完这一步就停，列出没做完的」，这一轮做完或 3 分钟后停下，会话都留着，hold.reason = budget）。
 */
export const LocalTaskBudgetView = Type.Object({
  taskId: Nullable(Type.String({ minLength: 1, maxLength: 80 })),
  sessionId: Nullable(Uuid),
  budget: Budget,
  spent: Type.Object({
    hours: Type.Number({ minimum: 0 }),
    weeklyPercent: NullableInteger({ minimum: 0 }),
    money: Nullable(LocalMoney),
  }, strict),
  ratio: NullableNumber({ minimum: 0 }),
  state: Type.Union([Type.Literal("ok"), Type.Literal("warning"), Type.Literal("exhausted")]),
  /** 第一个会话开工的时间（还没开工为 null）。 */
  since: Nullable(Instant),
  updatedAt: Instant,
}, strict);
/** GET /v1/budgets：本机记着的全部预算。 */
export const LocalBudgetListResponse = Type.Object({ budgets: Type.Array(LocalTaskBudgetView) }, strict);
/**
 * PUT /v1/budgets：改一件 Task（taskId）或一个不挂 Task 的会话（sessionId）的预算，二选一，回改完的那份。
 * 网页先把预算存到天枢（PUT /api/me/tasks/:taskId/budget），再交给本机：「加 50%」「加 50% 继续」就是带着加过的预算来一次。
 * 马上生效：用完停着等的（hold.reason = budget）不再用完就自己接着做（进程开着的往里说一句，退出了的续上，排着的回到队里）；
 * 收到「做完这一步就停」还没停下的，往里说一句不用停了。正跑着的进程不换模型和思考强度（下次拉起才按新的定），多 agent 在下一轮按新的模式开关。
 * 本机还没见过这件 Task 也收下（之后开工就按它）。
 */
export const LocalBudgetUpdateRequest = Type.Object({
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  sessionId: Type.Optional(Uuid),
  budget: Budget,
}, strict);

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
 * 规划员出的派活单里的一件（对得上云端的草稿卡）：brief 是交代；doneDefinition 是完成标准，每行一条；criterionIndex 对约定第几条（从 1 起，对不上为 null）；
 * role 是交代里岗位清单的 id 或名字（云端按本人的岗位对上，对不上当没配）；modelTier 是模型档位；why 一句话说为什么这么拆。
 */
export const LocalPlanCard = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120 }),
  brief: Type.String({ maxLength: 4000 }),
  doneDefinition: Type.String({ minLength: 1, maxLength: 500 }),
  criterionIndex: NullableInteger({ minimum: 1 }),
  role: Nullable(Type.String({ minLength: 1, maxLength: 80 })),
  modelTier: LocalModelTier,
  why: Nullable(Type.String({ maxLength: 200 })),
  /** 要等派活单里哪几件做完（位置，从 1 起，只能是排在它前面的）；不填就是不用等，可以和别的并行。 */
  after: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 7 })),
  /**
   * 本人原话里和这件有关的片段（16.8）：只能从交代「本人原话」那一段里原样摘，不能改写。云端核对，有一段不是原文就改用整条原话；不填也用整条原话。
   */
  sourceWords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 10 })),
}, strict);
/**
 * 规划员出的计划和派活单草稿（propose_plan）。revision 是本会话第几次出（本人说一句让它改，改完再出是新的一次，云端以最新一次为准）；
 * summary 一句话；steps 是计划的几步（数组顺序就是先后）；risks 是风险；cards 是派活单。
 * modelLabel、roleId、roleVersion 记是谁出的（本机用的模型、规划员岗位和版本，没配岗位为 null）。
 */
export const LocalCardPlan = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
  steps: Type.Array(Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), detail: Nullable(Type.String({ maxLength: 1000 })) }, strict), { maxItems: 20 }),
  risks: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 10 }),
  cards: Type.Array(LocalPlanCard, { minItems: 1, maxItems: 8 }),
  modelLabel: Type.String(),
  roleId: Nullable(Uuid),
  roleVersion: NullableInteger({ minimum: 1 }),
}, strict);

/** 验收员对一条完成标准的判定（对得上云端的 CardAcceptanceCriterion，少了 text：云端有交回时的标准快照）。fix 是没达到时怎么补。 */
export const LocalVerdictCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  verdict: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")]),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  evidence: Nullable(Type.String({ maxLength: 2000 })),
  fix: Nullable(Type.String({ maxLength: 2000 })),
}, strict);
/**
 * 产出和本人原话对不上的一处（16.8）：quote 是原话里的哪一句（原样，是某段原话或其中一截），kind：missing 漏了原话里明说的，extra 做了原话里没要的；reason 为什么。
 */
export const LocalSourceWordIssue = Type.Object({
  quote: Type.String({ minLength: 1, maxLength: 4000 }),
  kind: Type.Union([Type.Literal("missing"), Type.Literal("extra")]),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
}, strict);
/**
 * 验收员的结论（submit_verdict）：每条完成标准判一次，条数和验收交代的 criteria 一样；passed 是每条都 met、并且没有 sourceWordIssues；beyondScope 是标准以外的建议，不算没达到。
 * sourceWordIssues：验收交代带了本人原话（LocalVerifyBriefResponse.sourceWords）时，产出和原话明显对不上的地方（见 LocalSourceWordIssue）；有一条就是没过，标准全达到也一样。没有时不带。
 * modelLabel、roleId、roleVersion 记是谁验的（本机用的模型、验收员岗位和版本，用内置规矩时为 null）。
 */
export const LocalVerdict = Type.Object({
  passed: Type.Boolean(),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  criteria: Type.Array(LocalVerdictCriterion, { minItems: 1, maxItems: 50 }),
  beyondScope: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }),
  sourceWordIssues: Type.Optional(Type.Array(LocalSourceWordIssue, { minItems: 1, maxItems: 10 })),
  modelLabel: Type.String(),
  roleId: Nullable(Uuid),
  roleVersion: NullableInteger({ minimum: 1 }),
  /** 验的是哪个提交（卡在工作树里做时就是交回的那个提交，验收员看的是 baseCommit 到它的改动）；卡在文件夹里做时不带。 */
  commit: Type.Optional(Sha),
}, strict);

/**
 * GET <apiBaseUrl>/api/local-runner/verify-brief?handbackKey=<key>（云端实现）：本机起验收会话用的交代。
 * - markdown 原样作为验收会话的第一句话（≤ 20000 字）：约定、卡的完成标准、卡所属岗位的验收口径、这次交回的逐条自评和总结、交回点名的产出和证据（标题、文件名、链接、证据正文）。
 * - criteria 是交回那一刻卡的完成标准（按行拆好），验收员逐条判，条数以它为准。
 * - role 是验收员岗位（kind=reviewer，带模型档位，本机按档位挑模型）；没配为 null，本机用内置的验收规矩、普通档。
 * - failStreak 是这张卡在这次交回之前连续没过几次（推翻以后从 0 算）。这次再没过、累计到 2 就是「受阻」。
 * 404：云端没有这次交回（还没收到或拒收了）；409：这次交回已经有结论（已验过或已推翻），不用再验。
 * sourceWords（16.8）：卡上的本人原话；不为空时 markdown 里有一段「本人原话」，验收员逐条对完标准再对一遍原话，明显对不上（做了原话里没要的、漏了原话里明说的）算没过。
 *   本机核对验收员写的 sourceWordIssues：quote 必须是其中某段或某段里的一截。
 */
export const LocalVerifyBriefResponse = Type.Object({
  markdown: Type.String({ minLength: 1, maxLength: 20000 }),
  criteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
  role: Nullable(LocalRole),
  failStreak: Type.Integer({ minimum: 0 }),
  sourceWords: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
}, strict);

/** 专题一版的种类：outline 提纲、draft 正文、review 评审会合成的「分歧和建议」。 */
export const LocalTopicVersionKind = Type.Union([Type.Literal("outline"), Type.Literal("draft"), Type.Literal("review")]);

/**
 * 计划进度（派活单上的「第 3/6 步」）：done 做完几条，total 共几条，step 是第几步（正在做的那条是第几条；没有正在做的就是做完的条数），
 * current 是正在做的那条的标题（没有为 null）。
 */
export const LocalPlanProgress = Type.Object({
  done: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  step: Type.Integer({ minimum: 0 }),
  current: Nullable(Type.String()),
}, strict);

/**
 * GET /v1/sessions/:id/events（text/event-stream）。每条 `id: <seq>` + `data: <JSON>`。
 * 断线后带 Last-Event-ID 重连，本机从会话事件日志补发其后的全部事件；也可用 ?after=<seq>。
 * 事件已归一化，不随执行方变：Claude Code 和以后的 Codex 都映射到这几种。
 */
export const LocalSessionEvent = Type.Union([
  /** hold：停着等额度恢复时带（见 LocalHold）。 */
  ev("status", { status: LocalSessionStatus, exitCode: Type.Optional(NullableInteger()), reason: Type.Optional(Type.String()), hold: Type.Optional(LocalHold) }),
  ev("agent_info", { agent: LocalAgentKind, version: Type.String(), model: Nullable(Type.String()), permissionMode: Nullable(Type.String()) }),
  /** 权限模式换了（见 LocalPermissionMode）：by web 是本人在网页上换的，plan_approved 是本人批了计划、从 plan 转成 auto。开工时的模式不报这一条。 */
  ev("permission_mode", { mode: LocalPermissionMode, by: Type.Union([Type.Literal("web"), Type.Literal("plan_approved")]) }),
  /**
   * attachments：这句话带的附件（存好的，见 LocalAttachmentRef）；没有就不带。text 是本人说的原话，不含本机拼给执行方的附件路径。
   * messageId：这句话的编号（本机给的，11/08 起每条都带；之前的事件日志里没有），回执（receipt）按它对上。
   */
  ev("user_message", { text: Type.String(), source: Type.Union([Type.Literal("initial"), Type.Literal("web")]), attachments: Type.Optional(Type.Array(LocalSavedAttachment, { maxItems: 20 })),
    messageId: Type.Optional(Uuid) }),
  /**
   * 这句话的回执（新首页 17.4，形状同伙伴对话的 receipt 帧 { state, messageId }，网页用同一个组件画）：
   * - delivered：执行方收下了（第一个勾）。Claude Code 回 command_lifecycle queued 的那一刻，比写进它的输入更实。
   * - read：执行方读到了（第二个勾）。Claude Code 回 command_lifecycle started：这句话放进了对话、下一次模型请求就带着它。
   *   在跑工具时说的，工具做完马上读到、同一轮里生效；模型只在出字（中间没有工具）时说的，要等这一轮结束、自己成为新的一轮才读到。
   *   在等本人回答时说的就是回答，收下即读到（delivered、read 同时到）。
   * - failed：没读到就没了（进程退出、强停、本机程序重启时还没读到的），网页给「重发」。
   * 一条消息依次是 delivered → read，或 delivered → failed；老版本 Claude Code 没有 command_lifecycle 时没有回执。
   */
  ev("receipt", { messageId: Uuid, state: Type.Union([Type.Literal("delivered"), Type.Literal("read"), Type.Literal("failed")]) }),
  ev("assistant_text", { text: Type.String() }),
  ev("tool_call", { toolUseId: Type.String(), name: Type.String(), title: Type.String(), input: Type.Record(Type.String(), Type.Unknown()) }),
  ev("tool_result", { toolUseId: Type.String(), isError: Type.Boolean(), preview: Type.String() }),
  ev("plan", { entries: Type.Array(LocalPlanEntry), progress: LocalPlanProgress }),
  ev("permission_request", { request: LocalPermissionRequestView }),
  ev("permission_resolved", { requestId: Type.String(), decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]), message: Type.Optional(Type.String()), allowForSession: Type.Boolean() }),
  /** 后台任务开始或变了（开始、跑完、失败、被停）：每次带这一项的全部字段，按 item.id 覆盖。 */
  ev("background", { item: LocalBackgroundItem }),
  /** 执行方问本人（Claude Code 的 AskUserQuestion）：会话转成 idle（等你回复）。 */
  ev("question", { request: LocalQuestionRequestView }),
  /** 提问了结：答了带 choices 和 text；这一轮停了、进程退出了就作废，choices 为 null。 */
  ev("question_resolved", { requestId: Type.String(), choices: Nullable(Type.Array(Type.Array(Type.String()))), text: Nullable(Type.String()) }),
  ev("turn_end", {
    isError: Type.Boolean(),
    text: Nullable(Type.String()),
    durationMs: Type.Integer({ minimum: 0 }),
    usage: LocalUsage,
    /**
     * usage_limit：订阅额度用完了（rate_limit_event rejected、usage_limit_reached、429），本机转成停着等恢复，不当成等你回复。
     * balance：网关余额不足（TokenHub 回 402），本机停着等本人（hold.reason = balance），不重试。
     */
    errorKind: Type.Optional(Type.Union([Type.Literal("auth"), Type.Literal("api"), Type.Literal("usage_limit"), Type.Literal("balance"), Type.Literal("interrupted"), Type.Literal("other")])),
  }),
  ev("artifact", { artifactId: Id, title: Type.String(), fileName: Type.String(), size: Type.Integer({ minimum: 0 }), sha256: Type.String() }),
  /** commit：卡在工作树里做时，交回那一刻分支上的提交（本机先把没提交的改动提交了）。 */
  ev("handback", { summary: Type.String(), criteria: Type.Array(LocalHandbackCriterion), outputKeys: Type.Array(SyncKey), commit: Type.Optional(Sha) }),
  /** 专题存了新的一版（已排进上报队列）。 */
  ev("version", { number: Type.Integer({ minimum: 1 }), kind: LocalTopicVersionKind, label: Nullable(Type.String()), note: Nullable(Type.String()) }),
  /**
   * 验收员交了结论。验收会话和被验的那张卡的会话里各有一条（同一份），只给网页显示：failStreak 是算上这次连续没过几次，blocked（累计到 2）是「受阻」，
   * returnText 是改法（过了时为 null）。网页**不要**据这条事件送回改法：送回只走云端那条路——verdict 同步上去，云端把改法写进那次交回，
   * 网页原有的自动送回按交回送一次（多个标签页也只送一次）。
   */
  ev("verdict", {
    handbackKey: SyncKey, passed: Type.Boolean(), summary: Type.String(), criteria: Type.Array(LocalVerdictCriterion), beyondScope: Type.Array(Type.String()),
    failStreak: Type.Integer({ minimum: 0 }), blocked: Type.Boolean(), returnText: Nullable(Type.String()),
  }),
  /**
   * interjection_next_step：插话已送出，下一步生效；auth_required：执行方登录失效；agent_stderr：执行方报错输出；verify_waiting：验收在等交代（连不上天枢等）；
   * workspace：卡开工时在哪做（工作树的分支、从哪个提交开始、主文件夹里没提交的改动没带进来）；merged：卡的分支已合回主文件夹。
   */
  ev("notice", { level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]), code: Type.String(), text: Type.String() }),
]);

// ───────────────────────── 云端同步载荷（本机 → 天枢 api，单向） ─────────────────────────

/** 卡的分支和提交：branch 从 baseBranch 的 baseCommit 开出来，commit 是交回那一刻分支上的提交。 */
export const LocalGitRef = Type.Object({ branch: Type.String(), baseBranch: Type.String(), baseCommit: Sha, commit: Sha }, strict);

/**
 * 卡合回的结果（同步条目 merge，按卡的会话报；首页「已合并 / 要你合」、Task 管线的验收行用它）。什么时候报：
 * - 验收过了本机自动合回成了：merged true、auto true；
 * - 验收过了没自动合（条件不满足或本人关了自动合回）：merged false、auto true、reason；
 * - 本人在卡上点了合并：auto false，合成了 merged true，没合成 merged false、reason 是 base_not_checked_out、dirty、conflict 之一。
 * handbackKey 是验的那次交回（没交回过就合的不报）。同一个 handbackKey 有多条时，以 key 末尾本机序号最大的为准。
 * commit 是合回后主文件夹里的提交，没合成为 null；baseBranch 是合到哪个分支；message 给人看，合成了为 null。
 */
export const LocalMergeSync = Type.Object({
  handbackKey: SyncKey,
  merged: Type.Boolean(),
  commit: Nullable(Sha),
  baseBranch: Type.String({ minLength: 1, maxLength: 200 }),
  reason: Nullable(LocalMergeHoldReason),
  message: Nullable(Type.String({ minLength: 1, maxLength: 500 })),
  auto: Type.Boolean(),
}, strict);

const syncItem = <T extends string, D extends TSchema>(type: T, data: D) => Type.Object({
  /** 幂等键：<deviceId>:<sessionId>:<本机序号>。云端按它去重，重复提交返回 accepted。 */
  key: SyncKey,
  sessionId: Uuid,
  subject: LocalSessionSubject,
  occurredAt: Instant,
  type: Type.Literal(type),
  data,
}, strict);

/**
 * 同步给云端的「在等批准的那一步」（status = waiting_permission 时带）：给人看的一行、越界路径，不传工具的完整输入（输入只在本机）。
 * 云端「等你」那一行的标题就是 title（原话）；项目对话里的批准卡（新首页设计 18.10）也照它画：
 * 批准、拒绝都走网页的 POST /v1/sessions/:id/permissions/:requestId（已处理过或已失效回 409）。
 */
export const LocalPermissionBrief = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 120 }),
  toolName: Type.String({ maxLength: 200 }),
  title: Type.String({ maxLength: 500 }),
  outsidePaths: Type.Array(Type.String(), { maxItems: 20 }),
  /** 能不能「这张卡都允许」（同 LocalPermissionRequestView.canAllowForSession）：为 false 时批准卡只给「允许这一次」。老版本本机报的不带，按 false。 */
  canAllowForSession: Type.Optional(Type.Boolean()),
}, strict);

/**
 * 子会话停了（新首页设计 18.10「报给主管线」）：why 是怎么停的——
 * turn_done 做完一轮（等本人下一句；卡交回了、规划员交了计划、验收员交了结论也是这个）；interrupted 本人点了停下（含托盘「暂停全部」）；
 * held 停着等（订阅额度用完、网关余额不足、预算用完，blocker 写等什么）；error 出错停住（执行方报错、没开起来、进程意外退出，blocker 写原因）；killed 强停。
 * 要人介入（在问本人、在等批准）不报这一条：照旧是 status 条目带 question / permission，云端据此在项目对话里直接出决定卡。
 */
export const LocalStopReason = Type.Union([
  Type.Literal("turn_done"), Type.Literal("interrupted"), Type.Literal("held"), Type.Literal("error"), Type.Literal("killed"),
]);
/**
 * 停了的报告（同步条目 stopped）。都取会话里现成的内容，本机不另调模型：
 * - summary：做成了什么，取这一轮执行方最后那段话的头一两句（去掉 Markdown 记号，200 字以内）；这一轮一句话也没说为 null。
 * - blocker：卡在哪，出错、停着等时的原因（一句话，给人看）；做完一轮、本人停下、强停为 null。
 * - outputs：这一轮交的产出物，key 是它那条 artifact 同步条目的 key（云端据此出「看结果」），title、fileName 同那一条。
 * - handbackKey：这一轮交回了时，那条 handback 同步条目的 key。
 * 云端照它在项目对话里出「B · 标题」的报告，再让项目主管线回一小轮。subject 里有 cardId、topicId、taskId 和 projectId。
 */
export const LocalStopReport = Type.Object({
  why: LocalStopReason,
  summary: Nullable(Type.String({ minLength: 1, maxLength: 400 })),
  blocker: Nullable(Type.String({ minLength: 1, maxLength: 400 })),
  outputs: Type.Array(Type.Object({ key: SyncKey, title: Type.String({ maxLength: 200 }), fileName: Type.String({ maxLength: 200 }) }, strict), { maxItems: 20 }),
  handbackKey: Type.Optional(SyncKey),
}, strict);

export const LocalSyncItem = Type.Union([
  syncItem("status", Type.Object({
    status: LocalSessionStatus, title: Type.String(), agent: LocalAgentKind, modelLabel: Type.String(),
    /** 只在 status = queued 时带：排第几（1 起）。前面的开始或取消后，本机会给还在排的每件重发一条带新位置的 queued。 */
    queuePosition: Type.Optional(Type.Integer({ minimum: 1 })),
    /** 只在 status = queued、卡在等前面的卡时带：还没合回的那几张的 cardId（派活单上「已排队 · 等前面的卡」）。少了一张就重发一条。 */
    waitingFor: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8 })),
    /** 停着等（见 LocalHold）：等的时候报一条带它的，接着做时报的那条不带。 */
    hold: Type.Optional(LocalHold),
    /** 最近一次拉起时定的跑法（见 LocalRun，卡行写模型和思考强度）；还没拉起过不带。 */
    run: Type.Optional(LocalRun),
    /**
     * status = idle 且执行方在问本人（AskUserQuestion）时带：原样的提问（同本机摘要的 pendingQuestion）。云端据此出「等你」，标题用原话，单选的就地答。
     * 不带的 idle 是这一轮做完停下了：云端不当成等你（新首页 9.6），卡照常交回进验收，单独开的子会话显示「已停下」。答完以后报的那条不带。
     */
    question: Type.Optional(LocalQuestionRequestView),
    /** status = waiting_permission 时带：在等批准的那一步（LocalPermissionBrief）。 */
    permission: Type.Optional(LocalPermissionBrief),
    /** 现在的权限模式（同本机摘要的 permissionMode，手机上看）；换了模式本机重报一条 status。老版本本机报的不带。 */
    permissionMode: Type.Optional(LocalPermissionMode),
  }, strict)),
  syncItem("plan", Type.Object({ entries: Type.Array(LocalPlanEntry, { maxItems: 100 }), progress: LocalPlanProgress }, strict)),
  /**
   * 本人在网页上对这个会话说的一句（17.4，手机端看子会话的对话和回执用）。只报本人说的（user_message 的 source = web），开工那句（云端的交代）不报。
   * text 是原话（不含本机拼给执行方的附件路径）；attachments 只报文件名。之后的状态见 receipt 条目，按 messageId 对上。
   */
  syncItem("user_message", Type.Object({
    messageId: Uuid,
    text: Type.String({ maxLength: 20000 }),
    attachments: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 255 }), { minItems: 1, maxItems: 20 })),
  }, strict)),
  /** 上面那句话的回执（同事件 receipt）：delivered、read、failed 各报一条，云端以最新的为准。 */
  syncItem("receipt", Type.Object({
    messageId: Uuid,
    state: Type.Union([Type.Literal("delivered"), Type.Literal("read"), Type.Literal("failed")]),
  }, strict)),
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
  /**
   * 交回（只有卡）。outputKeys 是这次交回点名用的产出和证据（它们的 artifact、evidence 条目的 key）：
   * 执行方点了名就是那几份，没点名就是本会话交过的全部（同一个产出物交过几次只算最新一版）；可以为空。
   */
  syncItem("handback", Type.Object({
    summary: Type.String({ maxLength: 4000 }),
    criteria: Type.Array(LocalHandbackCriterion, { maxItems: 50 }),
    outputKeys: Type.Array(SyncKey, { maxItems: 100 }),
    /** 卡在工作树里做时：分支、开工时的基线和交回的提交（云端和手机显示用）；在文件夹里做时不带。 */
    git: Type.Optional(LocalGitRef),
  }, strict)),
  /**
   * 专题新的一版（只有专题）：number 由本机从开工时的 versionBase 和本机同一个专题已存到的号里取大的往下编；label 为 null 时云端按自己的规矩起名（「提纲」「第 N 版」）；
   * note 是这一版改了什么；body 是 Markdown 正文。
   */
  syncItem("topic_version", Type.Object({
    number: Type.Integer({ minimum: 1 }),
    kind: LocalTopicVersionKind,
    label: Nullable(Type.String({ minLength: 1, maxLength: 20 })),
    note: Nullable(Type.String({ maxLength: 200 })),
    body: Type.String({ minLength: 1, maxLength: 200000 }),
  }, strict)),
  /** 专题的第 number 版已由本机会话用本人的飞书登录存进飞书，feishuUrl 是飞书里的地址。 */
  syncItem("topic_version_feishu", Type.Object({
    number: Type.Integer({ minimum: 1 }),
    feishuUrl: Type.String({ pattern: "^https://", maxLength: 2000 }),
  }, strict)),
  /** 规划员出的计划和派活单草稿（subject.kind = plan，带 taskId 或只带 projectId）。 */
  syncItem("card_plan", LocalCardPlan),
  /** 验收员的结论（subject.kind = verify，带 cardId 和 handbackKey）：云端按 handbackKey 找到那次交回，照原来的规则落结果（过了进准备中，没过拼改法，第二次没过受阻）。 */
  syncItem("verdict", LocalVerdict),
  /**
   * 花费：每轮结束报一次本轮的增量。source：subscription 是本人的订阅（usage.costUsd 按标价算，不是真钱），gateway 是 TokenHub 等网关（花的是真钱）；
   * model 是这一轮用得最多的模型名；money 是网关的真钱，本机按 TokenHub 的价目表算（按价目表的币种，不换算，estimated 为 true），订阅或读不到价目表时为 null。
   */
  syncItem("cost", Type.Object({
    modelLabel: Type.String(), usage: LocalUsage,
    source: Type.Optional(Type.Union([Type.Literal("subscription"), Type.Literal("gateway")])),
    model: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    money: Type.Optional(Nullable(LocalMoney)),
  }, strict)),
  /**
   * 会话里的后台任务开始或变了：每次带全部字段，云端按 sessionId + data.id 覆盖（/api/me/background?scope=session:<sessionId>）。
   * 发件箱重试时同一项的几条可能乱序到达：云端留 key 末尾本机序号最大的那条（occurredAt 可能落在同一毫秒）。
   * 不要另定「已结束的不再变回 running」：子 agent 跑完后被续上（SendMessage）时，Claude Code 沿用同一个 task_id，这一项会从 done 回到 running。
   */
  syncItem("background", LocalBackgroundItem),
  /** 卡合回的结果，见 LocalMergeSync。 */
  syncItem("merge", LocalMergeSync),
  /** 子会话停了：一两句摘要、卡在哪、这一轮的产出物，见 LocalStopReport。每停一次报一条。 */
  syncItem("stopped", LocalStopReport),
  /**
   * 预算变了（见 LocalTaskBudgetView）：state 变了（到 80%、到 100%、加了预算回落）和预算被改了时报一条，按报这一条的会话（这件 Task 里刚做完一轮的、或随便一个）。
   * 云端照它画 Task 行的「预算 80%」、Task 管线里的「加 50%」和 100% 时的选项框、「等你」里那一行。同一件 Task 以 updatedAt 最新的一条为准。
   */
  syncItem("budget", LocalTaskBudgetView),
]);

export const LocalSyncBatchRequest = Type.Object({
  deviceId: Uuid,
  runnerVersion: Type.String(),
  /** 发这一批时本机的位置数（云端的 worker 列表和「资源」用）。 */
  slots: LocalSlots,
  /** 本机读到的用量（读到过的才带，见 LocalQuotaSync）：订阅的百分比和窗口、TokenHub 的今天和本月，云端给手机看。 */
  quota: Type.Optional(Type.Array(LocalQuotaSync, { maxItems: 16 })),
  /** 可以为空：本机开着、5 分钟里没别的要报时发一批空的当心跳，云端照样刷新本机的在线时间和位置数，回 accepted、rejected 都为空。 */
  items: Type.Array(LocalSyncItem, { maxItems: 50 }),
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
export type TLocalModelOrigin = Static<typeof LocalModelOrigin>;
export type TLocalToolPreset = Static<typeof LocalToolPreset>;
export type TLocalToolState = Static<typeof LocalToolState>;
export type TLocalTool = Static<typeof LocalTool>;
export type TLocalToolListResponse = Static<typeof LocalToolListResponse>;
export type TLocalToolUpsert = Static<typeof LocalToolUpsert>;
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
export type TLocalWorkspace = Static<typeof LocalWorkspace>;
export type TLocalGitRef = Static<typeof LocalGitRef>;
export type TLocalMergeBlockReason = Static<typeof LocalMergeBlockReason>;
export type TLocalMergeResponse = Static<typeof LocalMergeResponse>;
export type TLocalMergeHoldReason = Static<typeof LocalMergeHoldReason>;
export type TLocalQuotaWindow = Static<typeof LocalQuotaWindow>;
export type TLocalQuotaSource = Static<typeof LocalQuotaSource>;
export type TLocalQuotaSync = Static<typeof LocalQuotaSync>;
export type TLocalToolStatus = Static<typeof LocalToolStatus>;
export type TLocalHold = Static<typeof LocalHold>;
export type TLocalFolderProject = Static<typeof LocalFolderProject>;
export type TLocalProjectFolder = Static<typeof LocalProjectFolder>;
export type TLocalProjectListResponse = Static<typeof LocalProjectListResponse>;
export type TLocalProjectFolderRequest = Static<typeof LocalProjectFolderRequest>;
export type TLocalHandoverCheck = Static<typeof LocalHandoverCheck>;
export type TLocalProjectCloneRequest = Static<typeof LocalProjectCloneRequest>;
export type TLocalRepoUrl = Static<typeof LocalRepoUrl>;
export type TLocalProjectCloneResponse = Static<typeof LocalProjectCloneResponse>;
export type TLocalAttachmentRef = Static<typeof LocalAttachmentRef>;
export type TLocalSavedAttachment = Static<typeof LocalSavedAttachment>;
export type TLocalEffort = Static<typeof LocalEffort>;
export type TLocalRun = Static<typeof LocalRun>;
export type TLocalActualModel = Static<typeof LocalActualModel>;
export type TLocalRunPreviewRequest = Static<typeof LocalRunPreviewRequest>;
export type TLocalPermissionMode = Static<typeof LocalPermissionMode>;
export type TLocalPermissionModeRequest = Static<typeof LocalPermissionModeRequest>;
export type TLocalTaskBudgetView = Static<typeof LocalTaskBudgetView>;
export type TLocalBudgetListResponse = Static<typeof LocalBudgetListResponse>;
export type TLocalBudgetUpdateRequest = Static<typeof LocalBudgetUpdateRequest>;
export type TLocalUsageKind = Static<typeof LocalUsageKind>;
export type TLocalMoney = Static<typeof LocalMoney>;
export type TLocalMergeSync = Static<typeof LocalMergeSync>;
export type TLocalQuestion = Static<typeof LocalQuestion>;
export type TLocalQuestionRequestView = Static<typeof LocalQuestionRequestView>;
export type TLocalPermissionBrief = Static<typeof LocalPermissionBrief>;
export type TLocalStopReason = Static<typeof LocalStopReason>;
export type TLocalStopReport = Static<typeof LocalStopReport>;
export type TLocalQuestionAnswerRequest = Static<typeof LocalQuestionAnswerRequest>;
export type TLocalBackgroundItem = Static<typeof LocalBackgroundItem>;
export type TLocalBackgroundItemKind = Static<typeof LocalBackgroundItemKind>;
export type TLocalBackgroundItemState = Static<typeof LocalBackgroundItemState>;
export type TLocalPlanEntry = Static<typeof LocalPlanEntry>;
export type TLocalHandbackCriterion = Static<typeof LocalHandbackCriterion>;
export type TLocalTopicVersionKind = Static<typeof LocalTopicVersionKind>;
export type TLocalRole = Static<typeof LocalRole>;
export type TLocalModelTier = Static<typeof LocalModelTier>;
export type TLocalPlanCard = Static<typeof LocalPlanCard>;
export type TLocalCardPlan = Static<typeof LocalCardPlan>;
export type TLocalSourceWordIssue = Static<typeof LocalSourceWordIssue>;
export type TLocalVerdictCriterion = Static<typeof LocalVerdictCriterion>;
export type TLocalVerdict = Static<typeof LocalVerdict>;
export type TLocalVerifyBriefResponse = Static<typeof LocalVerifyBriefResponse>;
export type TLocalSlots = Static<typeof LocalSlots>;
export type TLocalPlanProgress = Static<typeof LocalPlanProgress>;
export type TLocalCreateSessionBatchRequest = Static<typeof LocalCreateSessionBatchRequest>;
export type TLocalCreateSessionBatchResponse = Static<typeof LocalCreateSessionBatchResponse>;
export type TLocalRoleTool = Static<typeof LocalRoleTool>;
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
  listTools: { method: "GET", path: "/v1/tools", auth: true },
  putTool: { method: "PUT", path: "/v1/tools/:id", auth: true },
  deleteTool: { method: "DELETE", path: "/v1/tools/:id", auth: true },
  checkTool: { method: "POST", path: "/v1/tools/:id/check", auth: true },
  listFolders: { method: "GET", path: "/v1/folders", auth: true },
  pickFolder: { method: "POST", path: "/v1/folders/pick", auth: true },
  deleteFolder: { method: "DELETE", path: "/v1/folders/:id", auth: true },
  listSessions: { method: "GET", path: "/v1/sessions", auth: true },
  createSession: { method: "POST", path: "/v1/sessions", auth: true },
  createSessionBatch: { method: "POST", path: "/v1/sessions/batch", auth: true },
  getSession: { method: "GET", path: "/v1/sessions/:id", auth: true },
  sessionEvents: { method: "GET", path: "/v1/sessions/:id/events", auth: true },
  sendMessage: { method: "POST", path: "/v1/sessions/:id/messages", auth: true },
  interrupt: { method: "POST", path: "/v1/sessions/:id/interrupt", auth: true },
  decidePermission: { method: "POST", path: "/v1/sessions/:id/permissions/:requestId", auth: true },
  kill: { method: "POST", path: "/v1/sessions/:id/kill", auth: true },
  mergeSession: { method: "POST", path: "/v1/sessions/:id/merge", auth: true },
  answerQuestion: { method: "POST", path: "/v1/sessions/:id/questions/:requestId", auth: true },
  stopBackground: { method: "POST", path: "/v1/sessions/:id/background/:itemId/stop", auth: true },
  listBudgets: { method: "GET", path: "/v1/budgets", auth: true },
  putBudget: { method: "PUT", path: "/v1/budgets", auth: true },
  previewRun: { method: "POST", path: "/v1/runs/preview", auth: true },
  setPermissionMode: { method: "PUT", path: "/v1/sessions/:id/permission-mode", auth: true },
  listProjects: { method: "GET", path: "/v1/projects", auth: true },
  putProjectFolder: { method: "PUT", path: "/v1/projects/:projectId/folder", auth: true },
  handoverCheck: { method: "POST", path: "/v1/projects/:projectId/handover-check", auth: true },
  cloneProject: { method: "POST", path: "/v1/projects/:projectId/clone", auth: true },
} as const;
