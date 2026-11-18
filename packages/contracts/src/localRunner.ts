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

/**
 * 本机程序的协议号（GET /v1/health 的 protocol）。网页按它判断能不能带新字段：老本机程序 strict，带了它不认识的字段整个请求回 400。
 * 2：发话可带 messageId（LocalSendMessageRequest）。
 * 3：发话可带 agreementRevision（主循环第 60 条，LocalSendMessageRequest）。
 * 4：开工可带 free（第 68 条自由子会话，LocalCreateSessionRequest）。
 */
export const LOCAL_RUNNER_PROTOCOL = 4;
export const LOCAL_RUNNER_DEFAULT_PORT = 47610;
export const LOCAL_RUNNER_TOKEN_HEADER = "x-tianshu-local-token";
/** 云端接收端路径（相对天枢 api 的根），鉴权用 Authorization: Bearer <个人令牌>。 */
export const LOCAL_RUNNER_SYNC_PATH = "/api/local-runner/sync";
/** 云端「验收交代」（相对天枢 api 的根）：GET ?handbackKey=<交回条目的 key>，鉴权同上。本机在交回同步上去以后取它，起验收会话。 */
export const LOCAL_RUNNER_VERIFY_BRIEF_PATH = "/api/local-runner/verify-brief";
/** 云端「卡的约定」（相对天枢 api 的根，主循环第 60 条）：GET ?cardId=<卡 id>，鉴权同上，回 LocalCardAgreementResponse。 */
export const LOCAL_RUNNER_CARD_AGREEMENT_PATH = "/api/local-runner/card-agreement";
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
  /** 连 TokenHub（POST /v1/tokenhub）：TokenHub 不认这把 Key（422）；连不上 TokenHub、它回的认不出（502）；这把 Key 的账户没有能用的模型（422）。 */
  Type.Literal("tokenhub_key_rejected"), Type.Literal("tokenhub_unreachable"), Type.Literal("tokenhub_no_models"),
  /** 添加来源（/v1/sources，设计 17.2 第 52 条）：厂商不认这把 Key（422）；连不上厂商、它回的认不出（502）；这把 Key 列不出能用的模型（422）。 */
  Type.Literal("source_key_rejected"), Type.Literal("source_unreachable"), Type.Literal("source_no_models"),
  /** 恢复其中几处（POST /v1/sessions/:id/files/changes/restore，第 72 条）：文件在网页读了以后又变了（409），网页重读再来。 */
  Type.Literal("file_changed"),
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
  /** 只有 Claude Code：`claude auth status --json` 的 planTier（如 max_5x、max_20x），能分出同一种订阅的档位；它没报就不带。 */
  planTier: Type.Optional(Type.String()),
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
   * 「验收后自动合并」（默认 true，插件页可改）：卡的验收过了，主文件夹停在原分支上、没有没提交的改动、合并没有冲突时，本机自动合回（只合不推），
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
 *   Codex 不报警戒线，只看到没到 100%。Codex 子会话跑着时每次模型回复后它报的 account/rateLimits/updated 也算进来；
 *   用完了（它报 usageLimitExceeded，或读到 100%）Codex 的卡停下等额度（LocalHold usage_limit），Claude Code 的卡不受影响；
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

/**
 * POST /v1/agents/claude-code/login 的贴码兜底：浏览器显示一串代码而没有跳回时，本人贴进网页。
 * Codex 也走 POST /v1/agents/codex/login（设计 17.2 第 38 条）：本机经 codex app-server 的 account/login/start 拿到 ChatGPT 的登录地址，
 * 替本人打开浏览器（setup.loginUrl 同 Claude），本人点完 Codex 自己收回调（本机 1455 端口），本机收到 account/login/completed 后 phase 转 succeeded。
 * Codex 没有贴码，login/code 对 Codex 回 400；DELETE /v1/agents/codex/setup 取消登录。Codex 没装时 install 回 501（请本人装 Codex，本机不代装）。
 */
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
 * 思考程度（设计 17.2 第 36 条）。各执行方、各模型支持哪几档（11/09 实测，都没调模型）：
 * - Claude Code 2.1.318：握手（initialize）回的模型列表里，Opus 5.5、Fable 5.1、Sonnet 5.5、Haiku 5.5 都是 low、medium、high、xhigh、max 五档。
 *   开工用 --effort 传；开着时用控制请求 apply_flag_settings { effortLevel } 当场换（它不校验取值，本机先校验）。网关模型本机不传思考程度。
 * - Codex 0.159.2：app-server 的 model/list（同 `codex debug models` 的模型目录，登录后按账号给）里每个模型自己列 supportedReasoningEfforts 和
 *   defaultReasoningEffort，如 gpt-6.1-sol 是 low…max 加 ultra、默认 low，gpt-5.5 是 low…xhigh、默认 medium（11/10 实测）。ultra 只有 Codex 有。
 *   开一轮（turn/start）时带 effort，从这一轮起生效；Codex 报的这里没有的档（如 none、minimal）不列。
 */
export const LocalEffort = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"), Type.Literal("ultra")]);
/**
 * 真正的来源（本机按地址和模型名认出来，网页照写，不用自己猜）：
 * - provider：认出的来源 id。claude-subscription 本人的 Claude 订阅；tokenhub；厂商 API 是 deepseek、kimi、glm、qwen、volcengine、minimax、anthropic 等；
 *   经 magpie 时按模型名的前缀（codex/…、deepseek/…）认，如 codex、copilot、gemini；都认不出就是地址的主机名（经 magpie 又没有前缀时是 magpie）。
 * - label：给人看的来源名，从简：「Claude 订阅」「Codex 订阅」「TokenHub」「DeepSeek API」「Codex 订阅 · 经 magpie」「api.example.com」（11/10 起不带「我的」）。
 *   选模型的「来源」那一行写它；同一个 provider 的几条模型配置是同一个来源，「模型」那一行在它们里面选（见 LocalModelProfile.modelName）。
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
  /**
   * 这个模型能选的思考程度（见 LocalEffort），网页选完模型只列这几档；空的是不能选（网关模型本机不传思考程度）。
   * Claude Code 的订阅是 Claude 模型的五档；Codex 的按它模型目录里这个模型的几档。老版本本机不带。
   */
  efforts: Type.Optional(Type.Array(LocalEffort, { maxItems: 8 })),
  /**
   * 不选时用哪档：null 是本机按档位和预算模式定（强 high、标准 medium、轻 low），模型自己的默认档时写那一档（Codex 写它模型目录里的默认档）。
   * 老版本本机不带。
   */
  defaultEffort: Type.Optional(Nullable(LocalEffort)),
  /**
   * 从执行方自己的模型目录现列的，不能改、不能删（PUT、DELETE 回 400），也不能设成默认；5 分钟读一次，读不到时用上次读到的。本人配的为 false；老版本本机不带。
   * - Codex 订阅（设计 17.2 第 38 条）：能用的每个模型一条，按 codex app-server 的 model/list（不列 hidden 的），本人的 Codex 登录着才有。
   *   id 是 codex- 加模型名（不是字母、数字、_、- 的字换成 _），如 codex-gpt-6_1-sol；label 是 Codex 给的显示名，如 GPT-6.1-Sol；
   *   source subscription、agent codex、model 是模型名、origin「Codex 订阅」。
   * - Claude 订阅（设计 17.2 第 40 条）：从 Claude Code 握手（initialize）回的模型列表里来（11/10 实测 2.1.318 回 14 个：default、opus、sonnet、haiku、fable
   *   这几个别名，加 claude-fable-5-2、claude-opus-4-6 这样指定版本的；不发提示、不调模型就读得到）。本机筛过再给，网页拿到的就是要列的：
   *   每个系列只留最新的一个（按它实际是哪一版认，现在是 Opus 5.5、Fable 5.2、Sonnet 5.5、Haiku 5.5 四个，同 Claude Code 自己菜单的主列表），旧版本不列；
   *   系列和版本认不出来的照列；「default」那一项不列（内置的 subscription 那条就是不指定模型，排在最前面）。
   *   id 是 cc- 加 Claude Code 给的名字（同样换字），如 cc-opus、cc-claude-fable-5-2；label 和 modelName 是它给的显示名，如「Opus 5.5」「Fable 5.2」；
   *   source subscription、agent claude-code、model 是那个名字（拉起时原样传 --model）、origin「Claude 订阅」；efforts 是它报的这个模型支持的几档
   *   （不支持选思考程度的为空，如 Haiku 4.5），defaultEffort 为 null。Claude Code 没装、读不到时没有这几条，内置的 subscription 那条照旧在。
   */
  catalog: Type.Optional(Type.Boolean()),
  /**
   * 给人看的模型名（设计 17.2 第 40 条，选模型「模型」那一行写它，来源那一行写 origin.label，同一个东西不写两遍）：
   * - 内置的 subscription（不指定模型，本机按档位和预算模式挑 Opus、Sonnet、Haiku）是「自动」，它是「Claude 订阅」这个来源的默认；
   * - 模型目录里的是执行方给的显示名（「Opus 5.5」「GPT-6.1-Sol」）；
   * - 本人配的按 model 写（同 LocalRun.modelName 的写法：认得出的 Claude 模型写成「Haiku 5.5」，网关模型去掉「厂商/」前缀，如 qwen3.8-flash）。
   * 老版本本机不带，网页退回写 label。
   */
  modelName: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
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
  /** 经「添加来源」建的（见 LocalSource）：是哪个来源的。本人在模型配置里自己配的、模型目录里的、TokenHub 的没有。老版本本机不带。 */
  sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
}, strict);
export const LocalModelListResponse = Type.Object({ profiles: Type.Array(LocalModelProfile) }, strict);

/** 连接页连 TokenHub 时建的模型配置的 id 前缀（设计 17.2 第 51 条）。 */
export const LOCAL_TOKENHUB_PROFILE_PREFIX = "th-";
/**
 * POST /v1/tokenhub：连接页连 TokenHub（设计 17.2 第 51 条）。网页把 Key 直接交给本机，不经过云端；Key 只写不读，不进日志。
 * 本机先拿这把 Key 调 TokenHub 列这把 Key 能用的模型（`GET <TokenHub>/api/openai/v1/models`，Bearer）：
 * - 不认（401、403）回 422 tokenhub_key_rejected；连不上、超时、别的错、回的认不出回 502 tokenhub_unreachable。都不改本机的东西。
 * - 只建实测能给 Claude Code 用的（现在是 wangsu/claude-opus-5-5、wangsu/claude-sonnet-5-5、wangsu/deepseek-v4.1-flash）里这把 Key 的账户列得出来的，
 *   选模型时不出现点了就失败的；一个都没有回 422 tokenhub_no_models，也不改本机的东西。所以本机存着这把 Key，就一定有 th- 的模型配置，反过来也一样。
 * - 认了：Key 存进本机钥匙（一份，这些模型配置共用），每个模型建一条网关模型配置：id 是 th- 加模型名（不是字母、数字、_、- 的换成 _），
 *   label 是给人看的模型名，baseUrl 是本机认的 TokenHub 的 Anthropic 入口（默认 https://tokenhub.corp.tokenkingos.com/api/anthropic），
 *   model 是 TokenHub 的模型名。上一次连接建的、这次没有的删掉。默认模型不改，只有一个例外：这台电脑的 Claude 订阅用不了（Claude Code 没装或没登录）、
 *   默认还是内置那条时，把 Opus 5.5 那条（没有就第一条）设成默认，免得默认档一跑就失败。回现在全部的模型配置（同 GET /v1/models）。
 * 这些模型配置的 baseUrl 和钥匙只能经这里换（PUT /v1/models/:id 改它们的地址或钥匙回 400），名字、默认、联网搜索照常能改；单条能删。
 * 以后天枢给每人开 TokenHub 户头时，可以照样把 Key 交到这里自动连上。
 */
export const LocalTokenHubConnectRequest = Type.Object({
  apiKey: Type.String({ minLength: 1, maxLength: 400, pattern: SECRET_CHARS }),
}, strict);
/** DELETE /v1/tokenhub：断开，删本机存的 Key 和 th- 开头的模型配置（本人在模型配置里自己配的 TokenHub 不动）；用着它们的会话同删了模型配置一样：再说话时回「这个会话用的模型配置已被删除」，换个模型接着做。回 { ok: true }。 */
/**
 * PUT /v1/models/:id。
 * - gateway：baseUrl、model 必填；apiKey 只写不读，不传表示保留原钥匙，传空串表示删除钥匙。
 *   地址要 https；本机地址（127.0.0.1、localhost）可以是 http。magpie（127.0.0.1:3425）不用填钥匙，本机照它的约定传 magpie；model 写「来源/模型」，如 codex/gpt-6.1。
 * - subscription：用本人登录，只选模型（如 opus、sonnet、haiku），不收 baseUrl 和 apiKey。
 * 只收 Claude Code 的（agent 不填或 claude-code）：Codex 的模型从它自己的模型目录来（见 LocalModelProfile.catalog），这次不接 Codex 走网关；
 * id 以 codex-、cc- 开头的留给模型目录，回 400。
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

// ───────────────────────── 添加来源（设计 17.2 第 52 条） ─────────────────────────

/** 来源说的「话」（接口格式）：anthropic 是 Anthropic Messages，openai_responses 是 OpenAI Responses，openai_chat 是 OpenAI Chat Completions。 */
export const LocalSourceFormat = Type.Union([Type.Literal("anthropic"), Type.Literal("openai_responses"), Type.Literal("openai_chat")]);
/** api：按量付费的 API；coding_plan：厂商的编程套餐（也是一把 Key，配专门的地址，额度按窗口算）。 */
export const LocalSourcePlan = Type.Union([Type.Literal("api"), Type.Literal("coding_plan")]);
/** 有国内、国际两个地址的厂商要选地区（默认 cn）。 */
export const LocalSourceRegion = Type.Union([Type.Literal("cn"), Type.Literal("intl")]);
/** 来源里的一个模型：id 是厂商的模型名（原样交给执行方），name 是给人看的（认得出的写成「Opus 5.5」，别的去掉「厂商/」前缀）。 */
export const LocalSourceModel = Type.Object({ id: Type.String({ minLength: 1, maxLength: 120 }), name: Type.String({ minLength: 1, maxLength: 60 }) }, strict);

/**
 * 预设厂商（本机程序内置、核过才放，不在线读）。id 现在有：anthropic（Anthropic 官方 API）、tokenhub、kimi、glm、deepseek、qwen（通义千问 · 阿里百炼）、
 * minimax、volcengine（火山方舟）、openrouter。另有「自定义」，不在这张表里（添加时 presetId 为 null）。
 * - plans：这家有哪几种（只有按量的是 ["api"]）；regions：要选地区的才有，空数组是不用选。
 * - agents：现在这台电脑上能接哪几个执行方（按格式配对：Claude Code 只说 anthropic，Codex 只说 openai_responses），配不上的执行方网页灰掉。
 *   本机这一版只接 Claude Code，所以现在只会有 claude-code；以后接上 Codex 的 Key 类来源，这里跟着多。
 */
export const LocalSourcePreset = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  plans: Type.Array(LocalSourcePlan, { minItems: 1, maxItems: 2 }),
  regions: Type.Array(LocalSourceRegion, { maxItems: 2 }),
  agents: Type.Array(LocalAgentKind, { maxItems: 4 }),
}, strict);

/**
 * 加好的来源。Key 只在本机（系统凭据库），任何接口都不回传。选了的每个模型建一条网关模型配置（LocalModelProfile，sourceId 指回这里），共用这把 Key；
 * 模型配置的名字、默认、联网搜索照常在模型配置里改，地址、钥匙只能经来源换（PUT /v1/models/:id 改它们回 400）。
 * - id：本机给的。预设的是「厂商-种类-地区」，如 kimi-coding_plan-cn、anthropic-api；自定义的是 custom- 加名字。同一个预设、种类、地区只有一个，再加一次就是换 Key、换模型。
 *   TokenHub 并进来了：id 固定 tokenhub，加、换、删都同 POST/DELETE /v1/tokenhub（第 51 条，模型配置还是 th- 开头的那几条，不带 sourceId）。
 * - name：给人看的来源名，如「Kimi 编程套餐」「Anthropic 官方 API」「DeepSeek API」，自定义的是本人起的名字。选模型「来源」那一行写它。
 * - verified：加的时候用这把 Key 验过（按量 API 读过一次模型列表）。编程套餐不验（厂商条款不许命令行以外的请求），第一次真跑才知道 Key 对不对。
 */
export const LocalSource = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  presetId: Nullable(Type.String({ minLength: 1, maxLength: 40 })),
  name: Type.String({ minLength: 1, maxLength: 60 }),
  plan: LocalSourcePlan,
  region: Nullable(LocalSourceRegion),
  /** 给执行方用的地址（Anthropic 格式的那个；自定义的是本人填的）。 */
  baseUrl: Type.String({ minLength: 8, maxLength: 300 }),
  formats: Type.Array(LocalSourceFormat, { minItems: 1, maxItems: 3 }),
  agents: Type.Array(LocalAgentKind, { maxItems: 4 }),
  models: Type.Array(LocalSourceModel, { maxItems: 100 }),
  verified: Type.Boolean(),
  addedAt: Instant,
}, strict);
/** GET /v1/sources：预设厂商和加好的来源。 */
export const LocalSourceListResponse = Type.Object({ presets: Type.Array(LocalSourcePreset), sources: Type.Array(LocalSource) }, strict);

/**
 * POST /v1/sources/check：贴上 Key 先认、先验，不存任何东西（Key 只交给本机，不经过云端）。
 * - presetId 不给：按 Key 的开头认厂商（如 sk-ant- 是 Anthropic 官方，sk-or- 是 OpenRouter，sk-sp- 是阿里百炼编程套餐）。认得出回 recognized；
 *   认不出（多家都是 sk- 开头的）recognized 为 null，candidates 是可能的几家，网页让本人选，选了带 presetId 再调一次。
 * - presetId 给了（或认出来了）：plan、region 不给用这家的第一种、cn。按量 API 用这把 Key 读一次模型列表（不花 token），回能用的模型；
 *   厂商不认回 422 source_key_rejected，连不上回 502 source_unreachable，列不出能用的回 422 source_no_models。
 *   编程套餐不发请求，回预设的模型表，verified 为 false；没有不花钱验法的按量 API（现在是 GLM、通义千问）也一样。
 * - 自定义（presetId 为 null 且给了 baseUrl）：本人填地址和格式（这一版只收 anthropic），模型名本人填，不验。
 */
export const LocalSourceCheckRequest = Type.Object({
  apiKey: Type.String({ minLength: 1, maxLength: 400, pattern: SECRET_CHARS }),
  presetId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 40 }))),
  plan: Type.Optional(LocalSourcePlan),
  region: Type.Optional(LocalSourceRegion),
  baseUrl: Type.Optional(Type.String({ minLength: 8, maxLength: 300, pattern: "^https?://" })),
}, strict);
export const LocalSourceCheckResponse = Type.Object({
  recognized: Nullable(Type.Object({ presetId: Type.String(), plan: LocalSourcePlan, region: Nullable(LocalSourceRegion) }, strict)),
  /** recognized 为 null 时可能的几家（预设 id），按常见程度排；都不像时是空的，网页列全部预设加自定义。 */
  candidates: Type.Array(Type.String(), { maxItems: 20 }),
  /** 认出了（或给了 presetId）才有：这把 Key 能用的模型（按量 API 是厂商列的，编程套餐是预设表）；本机建议先勾的排在前面。 */
  models: Type.Array(LocalSourceModel, { maxItems: 300 }),
  verified: Type.Boolean(),
}, strict);

/**
 * POST /v1/sources：加来源（或同一个预设、种类、地区再加一次 = 换 Key、换模型）。和 check 一样先验（按量 API 再读一次模型列表，不认、连不上照 check 回错，不改本机的东西）；
 * 通过了 Key 存进本机钥匙，models 里每个建一条模型配置（id 是 src- 加来源 id 加模型名），上一次有、这次没有的删掉，默认模型不改。回加好的来源和现在全部的模型配置。
 * models 至少一个；按量 API 的必须是这把 Key 列得出来的，编程套餐的必须在预设表里，自定义的随本人填。presetId 为 null 时要 name、baseUrl、format。
 */
export const LocalSourceAddRequest = Type.Object({
  apiKey: Type.String({ minLength: 1, maxLength: 400, pattern: SECRET_CHARS }),
  presetId: Nullable(Type.String({ minLength: 1, maxLength: 40 })),
  plan: Type.Optional(LocalSourcePlan),
  region: Type.Optional(LocalSourceRegion),
  models: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 100 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  baseUrl: Type.Optional(Type.String({ minLength: 8, maxLength: 300, pattern: "^https?://" })),
  format: Type.Optional(LocalSourceFormat),
}, strict);
export const LocalSourceAddResponse = Type.Object({ source: LocalSource, profiles: Type.Array(LocalModelProfile) }, strict);
/** DELETE /v1/sources/:id：删这个来源的 Key 和它的模型配置；用着它们的会话同删了模型配置一样（再说话时回「这个会话用的模型配置已被删除」）。回 { ok: true }。 */

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
 *
 * 一个项目可以绑多个文件夹（设计 17.2 第 46 条，11/10 起）：
 * - folders：有顺序的列表，最多 LOCAL_PROJECT_FOLDER_LIMIT 个。第一个是工作目录（会话从这里开始，卡的工作树也开在这里）；其余的是这个项目的会话另外能读写的目录
 *   （不开工作树，直接读写本人的那个文件夹；卡在里面改的东西不在卡的分支上，合回时不带）。没绑是空列表。
 * - folder：就是 folders 的第一个（没绑为 null），留给只认一个文件夹的老网页。
 * - 回的东西里没有 folders 的，是老的本机程序：只能绑一个，网页照一个的上限来，也不要发 folderIds（老的本机程序不认，回 400）。
 *   项目在这台电脑上还没有记录（GET /v1/projects 里没有它）时看不出来：先用 folderId 绑第一个，回执里有 folders 再用 folderIds 交整份。
 */
export const LOCAL_PROJECT_FOLDER_LIMIT = 5;
export const LocalProjectFolderRef = Type.Object({ id: Id, path: Type.String(), label: Type.String() }, strict);
export const LocalProjectFolder = Type.Object({
  projectId: Uuid,
  name: Nullable(Type.String({ maxLength: 120 })),
  folder: Nullable(LocalProjectFolderRef),
  folders: Type.Optional(Type.Array(LocalProjectFolderRef, { maxItems: LOCAL_PROJECT_FOLDER_LIMIT })),
  updatedAt: Instant,
}, strict);
/** GET /v1/projects：这台电脑上记着的项目和文件夹。 */
export const LocalProjectListResponse = Type.Object({ projects: Type.Array(LocalProjectFolder) }, strict);
/**
 * PUT /v1/projects/:projectId/folder：定这个项目在这台电脑上绑哪些文件夹（都要是已允许的，先经 POST /v1/folders/pick 选好）；name 是项目名（只用来显示，可不带）。
 * folderId、folderIds 给一个，都给或都不给回 400 validation：
 * - folderIds（11/10 起）：整份有顺序的列表，一次换掉——加一个、减一个、换工作目录（把它挪到第一个）都是交整份。空列表是全部解绑。不能有重复的。
 * - folderId（老网页只会这个，照旧能用）：换掉第一个（工作目录），其余的不动；它本来就在其余的里面时挪到第一个。null 是全部解绑。
 * 项目交出去以后（16.7），原负责人那边的网页传 folderId: null 解绑：只解绑，不动文件夹里的文件，文件夹也还在允许的列表里。
 * 有一个文件夹不在允许的列表里就回 404，一个都不改。删掉一个允许的文件夹（DELETE /v1/folders/:id）时，它从绑着它的项目里一起拿掉；
 * 拿掉的是第一个时，剩下的第一个成了工作目录，一个都不剩就是没绑。
 * 改了以后：本机放行的范围马上跟着变；开着的会话里执行方自己知道的目录，到它下一次起进程才变。
 */
export const LocalProjectFolderRequest = Type.Object({
  folderId: Type.Optional(Nullable(Id)),
  folderIds: Type.Optional(Type.Array(Id, { maxItems: LOCAL_PROJECT_FOLDER_LIMIT, uniqueItems: true })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, strict);

/**
 * POST /v1/projects/:projectId/handover-check（新首页设计 16.7「准备交接」）：项目绑的文件夹现在什么样，只看 git，不调模型。网页把结果交给天枢写交接说明。
 * 绑了多个文件夹的只看第一个（工作目录），其余的不查。
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
 * 在里面 git clone 仓库（文件夹名是 name，不给就用仓库名），切到 branch（交接分支；远端没有就留在默认分支，fellBack 为 true），加进允许的文件夹并绑到项目上
 * （放在第一个，项目原有的其余文件夹不动）。
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
 * POST /v1/folders/pick 的体（「选择其他文件夹…」，设计 17.2 第 32 条）：可以空着（{}）；带 projectId 时选中后一步绑到这个项目（同 PUT /v1/projects/:projectId/folder
 * 的 folderId：换掉第一个，其余的不动），projectName 是项目名（只用来显示）。给项目再加一个文件夹时不带 projectId：选好以后用 folderIds 交整份列表。
 */
export const LocalFolderPickRequest = Type.Object({
  projectId: Type.Optional(Uuid),
  projectName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, strict);
/**
 * POST /v1/folders/pick：本机弹系统的选文件夹窗口，本人选中后加进允许的文件夹；本人点了取消时 folder 为 null。
 * 选了主目录或它的上级、Claude 配置目录、本机程序数据目录（或它们的上级）时回 400 validation，message 可直接给人看。
 * 请求带了 projectId 且选中了：project 是绑好以后的样子；没带或取消了不带。
 */
export const LocalFolderPickResponse = Type.Object({ folder: Nullable(LocalFolder), project: Type.Optional(LocalProjectFolder) }, strict);
/**
 * POST /v1/folders/create（「新建文件夹…」，设计 17.2 第 32 条）：在 parent 下新建一个空文件夹 name，加进允许的文件夹；带 projectId 时一步绑到这个项目（同选文件夹：换掉第一个）。
 * - name：一层的名字，不能带 / \ : * ? " < > | 和控制字符，不能是 . 或 ..，不能以点或空格结尾，不能是 Windows 的保留名（CON、PRN、AUX、NUL、COM1–9、LPT1–9，带扩展名的也算）；
 *   parent 下已经有同名的（不分大小写）回 409 conflict。
 * - parent：绝对路径，可不传，默认是本人的桌面（没有桌面时是主目录）。只能在本人主目录下、或在已允许的文件夹下；
 *   新建出来的不能落进 Claude 配置目录、本机程序数据目录（同选文件夹的规矩），不满足回 400 validation，message 可直接给人看。
 * 不经系统窗口：新建的是空文件夹，不会因此放开本人已有的文件。
 */
export const LocalFolderCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  parent: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  projectId: Type.Optional(Uuid),
  projectName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, strict);
/** 新建好的文件夹（已在允许的列表里）；带了 projectId 时 project 是绑好以后的样子。 */
export const LocalFolderCreateResponse = Type.Object({ folder: LocalFolder, project: Type.Optional(LocalProjectFolder) }, strict);
/** 「随手」项目在这台电脑上的文件夹：主目录下的这两层。 */
export const LOCAL_SCRATCH_FOLDER = ["天枢", "随手"] as const;
/**
 * POST /v1/folders/scratch：保证「主目录/天枢/随手」在（没有就建，已经有了不报错），加进允许的文件夹，绑到 projectId。
 * 这个项目在这台电脑上已经绑了文件夹：什么都不改，回现在绑着的。
 * 路径只由本机程序自己算，网页不传。老版本本机程序没有这条路由（404），网页当作没做成，照旧问在哪个文件夹开工。
 */
export const LocalScratchFolderRequest = Type.Object({ projectId: Uuid, projectName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })) }, strict);
export const LocalScratchFolderResponse = Type.Object({ folder: LocalFolder, project: LocalProjectFolder }, strict);
/**
 * POST /v1/folders/:id/open（「在资源管理器中显示」，11/16）：本机按 id 查出允许的文件夹的路径，用系统的文件管理器打开。体可以不带或是 {}，不收路径。
 * 没有这个 id、或文件夹在磁盘上已经没了回 404 not_found；打开了回 { ok: true }。
 */
export const LocalFolderOpenRequest = Type.Object({}, strict);

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
 * - bypassPermissions「全部放行」（11/09 用户定，设计 17.2 第 33 条：选了全部放行就是不看，不该来问）：只有三类还问本人——
 *   推代码或开 PR（git push；gh 的写操作，如 pr create、pr merge、release create、issue create、api 发 POST 等）、
 *   给别人发消息（飞书命令行发消息、回复、转发、发邮件）、在天枢里替本人写入（天枢 MCP 里写的工具）。
 *   还有第四类（11/11 过渡规矩）：没有兜底的地方（不在本机自己的目录、卡的工作树、整份留了一份的工作目录里），已有文件要被删、挪、覆盖——
 *   改文件工具改已有文件、Write 覆盖已有文件，命令里有删、挪、写、重定向、sed -i、冲文件的 git 子命令（扔掉输出的 > $null 不算）。见 LocalUndo。
 *   别的都自己放行：联网下载、装东西、改系统设置、碰 .git 和 .claude、动允许的文件夹以外的文件、跑没装好的 npx 包、本人加的工具里写的操作等。
 * 其他几档还有天枢的硬规矩，照问本人（设计 9.5）：对外的动作（git 推送和拉取、gh（开 PR 等）、飞书命令行写的（发消息、改文档等））、
 * 危险命令表里的（装东西、联网下载、ssh、sudo、改注册表和系统设置、跑没装好的 npx 包）、碰 .git 和 .claude 的、碰允许的文件夹以外的路径、
 * 天枢 MCP 里写的工具、本人加的工具里不是读的。卡和规划员、验收员本来不给的工具（只读的会话不给写文件）照旧不给，跟模式无关。
 * 实现上 Claude Code 一律以「每次都问」起（只有 plan 用它自己的 plan 模式），每个请求都先到本机、本机按档位放行或转给网页：
 * Claude Code 自己的 auto、bypassPermissions 放行的步骤不经本机，硬规矩管不住。Codex 同理，见 LOCAL_AGENT_PERMISSION_MODES。
 */
export const LocalPermissionMode = Type.Union([
  Type.Literal("auto"), Type.Literal("default"), Type.Literal("acceptEdits"), Type.Literal("plan"), Type.Literal("bypassPermissions"),
]);
/**
 * 每种执行方能选哪几档（没有的不出现在选择里）。Codex 没有「先出计划」。
 * Codex（设计 17.2 第 38 条）一律以 approvalPolicy untrusted、sandbox read-only 起，每一步都先到本机，本机按档位放行或转给网页，规则和 Claude Code 同一套。
 * 11/10 用 codex-cli 0.159.2 加本机假网关实测（没调模型）：
 * - 命令：Windows 上每条都包进 PowerShell，连目录里的读（Get-Content）都来问（item/commandExecution/requestApproval），本人允许后照常执行；
 * - 改文件（apply_patch）：每次都来问（item/fileChange/requestApproval）；
 * - MCP 工具：声明只读（readOnlyHint）的直接跑、不问，别的来问（mcpServer/elicitation/request，_meta.codex_approval_kind 为 mcp_tool_call）。
 *   所以天枢 MCP 里读的工具、本人加的工具里自己声明只读的，Codex 不经本机；写的照问。
 * 批准不能附理由：本人拒绝时带的话，本机先作为插话送进去再拒。
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
  /**
   * 执行方，不填按模型配置的（再没有是 Claude Code）。和模型配置的执行方不一样回 400。
   * 规划员（kind=plan）只能用 Claude Code（400）：开工前要用选项框问本人（18.11），Codex 0.159.2 的提问工具只在它自己的计划模式里给。
   * Codex 会话里没有选项框，模型要问就直接写在回复里，会话转成等你回复。
   */
  agent: Type.Optional(LocalAgentKind),
  /** 不填用默认模型。 */
  modelProfileId: Type.Optional(Id),
  /**
   * 这件的档位（派活单上的 modelTier）。模型配置没写模型名（本人的 Claude 订阅）时，本机按档位选模型和思考强度：
   * strong 是 Opus、high；normal 是 Opus、medium；light 是 Sonnet、low。不填按岗位的档位，再没有按 normal。
   */
  modelTier: Type.Optional(LocalModelTier),
  /** 本人选的思考程度（设计 17.2 第 36 条）：要在这个模型配置的 efforts 里，不然 400；不填按档位和预算模式定。 */
  effort: Type.Optional(LocalEffort),
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
  /**
   * 自由子会话（第 68 条，项目下的「+」）：只给 kind=topic（别的 400），云端专题带 free 时网页原样带上；本机 protocol ≥ 4 才收。
   * 本机换一套规矩：没有提纲、版本、交回、验收，本人要的文件就写在文件夹里；工具只有交产出物和翻更早的轮次。
   * 在项目的文件夹里做，不管里面有没有 .git 都按普通文件夹算：摘要的 workspace 是 folder，和普通文件夹里的卡、别的自由子会话同一时间只许一个在改，被占着时排队（见 LocalFolderHolder）。
   */
  free: Type.Optional(Type.Literal(true)),
}, strict);

/**
 * 排队是因为普通文件夹被占着（第 68 条）：占着它的那个会话是谁。kind 是卡还是专题（自由子会话是带 free 的专题），id 是天枢里卡或专题的 id，title 是它的标题。
 * 普通文件夹同一时间只许一个会话改：卡和自由子会话都算，正在跑、在等批准时占着，一轮做完在等本人时不占。占着的换了人，本机重报一条。
 */
export const LocalFolderHolder = Type.Object({
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]),
  id: Type.String({ minLength: 1, maxLength: 80 }),
  title: Type.String({ maxLength: 120 }),
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
 * auto_merge_off 本人把「验收后自动合并」关了；not_ready 卡还在跑或有后台任务在跑、交回以后卡又改过、工作树不在了、主文件夹已不在允许的文件夹里（message 写明是哪种）。
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

/**
 * 改、删前留一份（11/11 本人定，ADR 0039）：不在 git 工作树里做的会话（普通文件夹、「此电脑」、专题、规划员），执行方改、删已有文件之前本机留一份，
 * 本人能在「改动的文件」里一个个恢复，或全部恢复到开工前（POST /v1/sessions/:id/files/restore）。会话摘要的 undo：
 * - preparing：在留开工前那一份（后台做，开工不等）。这时用改文件工具改的先拷一份再放行；命令最多等 10 秒，等不到就按 touched_only 的规矩办。
 * - ready：整个工作目录都留了（每一轮开始前、结束后各留一份），用命令、脚本、子 agent 改的、删的也能恢复。
 *   带 reason sync_folder 时（11/11）：文件夹在 OneDrive 等同步盘里，只给本地已有的文档类文件（Word、Excel、PPT、Markdown、文本、CSV 等，单个不超过 32MB）留了，只在云端的不碰、不下载。
 *   带 reason too_large 时：文件夹太大（超过 3 万个文件或 3GB），只给里面的文档类文件留了。
 * - touched_only：只给执行方用改文件工具（Claude Code 的 Write、Edit、MultiEdit、NotebookEdit，Codex 的改文件）改的已有文件留一份；
 *   命令要删、挪、覆盖已有文件时，哪一档都照样问本人（包括「全部放行」）。reason 是为什么：too_large 文件夹太大（超过 3 万个文件或 3GB，
 *   不算 32MB 以上的大文件和 node_modules 这类目录）、sync_folder 在 OneDrive 等同步盘里、连文档都留不成、disk_full 本机数据目录所在的盘不够、
 *   failed 没留成（message 写原因）。本机自己的专用目录（专题、规划员、没绑文件夹的项目）不用整份留，也是 touched_only，不带 reason。
 * 不管哪种：32MB 以上的大文件、工作目录以外的文件（项目另外绑的、允许范围以外的），只在用改文件工具改它时拷一份。
 * 留的东西只在本机：会话最后一次活动后留 14 天；总量超过 20GB 或盘剩余空间的 10%（取小的）时，从最旧的已结束会话清起。
 */
export const LocalUndo = Type.Object({
  state: Type.Union([Type.Literal("preparing"), Type.Literal("ready"), Type.Literal("touched_only")]),
  reason: Type.Optional(Type.Union([Type.Literal("too_large"), Type.Literal("sync_folder"), Type.Literal("disk_full"), Type.Literal("failed")])),
  message: Type.Optional(Type.String({ maxLength: 500 })),
}, strict);

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
/**
 * 上下文用了多少（设计 17.2 第 42 条，输入框下面的小圆环）：usedTokens 现在上下文里的 token 数，maxTokens 这个模型的上限（读不到为 null，圆环不画）。
 * 网页写「16.6 万 / 20 万」，百分比自己算（usedTokens ÷ maxTokens），到 80% 变色。分布（消息、工具、记忆各占多少）不给。
 * - Claude Code：每轮做完用控制请求 get_context_usage 读一次（11/10 实测 2.1.318：回 totalTokens、maxTokens，约 1 秒、不调模型；Opus 5.5、Fable 5.2 的上限是 100 万）；
 *   这一轮中间按每次模型回复的用量估（输入加缓存加输出），上限用上一次读到的。
 * - Codex：每次模型回复后它报的 thread/tokenUsage/updated 里最近一次请求的 totalTokens 和 modelContextWindow。
 * at 是算出这个数的时间。会话还没跑过一轮、执行方没报过时没有这一项。换了执行方、换了模型以后，等新的那家报了才更新。
 */
export const LocalContextUsage = Type.Object({
  usedTokens: Type.Integer({ minimum: 0 }),
  maxTokens: NullableInteger({ minimum: 1 }),
  at: Instant,
}, strict);
export const LocalRun = Type.Object({
  mode: BudgetMode,
  model: Nullable(Type.String({ maxLength: 120 })),
  effort: Nullable(LocalEffort),
  multiAgent: Type.Boolean(),
  /**
   * 每个子会话都显示「哪个来源的哪个模型」（选了「自动」也显示落到哪个）：界面写 `${sourceLabel} · ${actual?.modelName ?? modelName}`，
   * 如「Claude 订阅 · Opus 5.5」「TokenHub · qwen3.8-flash」。下面四项本机总会填；Optional 只为兼容老版本本机报的和已存的会话。
   * source：本人的订阅还是网关（同模型配置的 source）。
   */
  source: Type.Optional(LocalModelSource),
  /**
   * 来源的名字：本人配的写模型配置的名字（如本人给 TokenHub 配置起的名字）；内置的那条是「Claude 订阅」；
   * 模型目录里的（cc-、codex- 开头的，配置的名字就是模型名）写认出的来源，「Claude 订阅」「Codex 订阅」（11/10 起，免得写成「Opus 5.5 · Opus 5.5」）。
   */
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
 * POST /v1/runs/preview：开工前看这次会怎么跑（开工选项框写「Claude 订阅 · Opus 5.5 · 思考 medium」，「自动」也写落到哪个）。
 * 体是开工请求（LocalCreateSessionRequest）里定跑法的那几项，原样带；回的 LocalRun 和真开工时一样算（当下的额度、这件 Task 的预算），actual 为 null。
 * 只是预览：开工时额度或预算变了，以开工那一刻算的为准（会话摘要和 status 条目里的 run）。
 */
export const LocalRunPreviewRequest = Type.Object({
  agent: Type.Optional(LocalAgentKind),
  modelProfileId: Type.Optional(Id),
  modelTier: Type.Optional(LocalModelTier),
  effort: Type.Optional(LocalEffort),
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
  /**
   * 卡：在工作树还是文件夹里做（本机总会填；等前面的卡时还没有工作树，不带）。
   * 自由子会话（第 68 条）：总带 kind=folder，git 仓库的主文件夹也是（它直接改主文件夹，没有自己的工作树；第 71 条「改之前留一份」照卡一样认它）。
   */
  workspace: Type.Optional(LocalWorkspace),
  /** 改、删前留一份的情况（见 LocalUndo）；卡在工作树里做的不带（有 git）。 */
  undo: Type.Optional(LocalUndo),
  /** 排着队、在等普通文件夹空出来时：占着它的是谁（LocalFolderHolder，第 68 条）；不在等就不带。 */
  heldBy: Type.Optional(LocalFolderHolder),
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
  /** 本人换了模型、要等这一轮做完才换的（见 LocalSessionModelResponse 的 after_turn）：换成哪个；换好了或没有就不带。 */
  pendingModel: Type.Optional(Type.Object({ modelProfileId: Id, modelLabel: Type.String(), effort: Type.Optional(Nullable(LocalEffort)) }, strict)),
  /** 本人选的思考程度（开工时带的或后来换的）；不带是按档位和预算模式定。实际跑的看 run.effort。 */
  effort: Type.Optional(LocalEffort),
  /** 上下文用了多少（见 LocalContextUsage）：最近一次算出来的；还没有就不带。事件流里随 context_usage 更新。 */
  context: Type.Optional(LocalContextUsage),
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
  /**
   * 批准说人话（主循环第 64 条）：执行方自己写的一句「要做什么」。Claude Code 取 Bash（PowerShell）入参里的 description；Codex 取它给的理由；都没有就不带。
   * 网页批准框第一行写它，命令原文收进「命令」里点了才看（会话在代码仓库的工作树里时默认展开）；没有就照原来的样子（第一行是 title）。
   */
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  /**
   * 这一步会动的文件（主循环第 64 条）：本机认得出的（pathGuard 在认的：文件类工具的路径、从命令里尽力认出来的），会话根里的写相对路径，外面的写绝对路径。
   * 网页第二行「会动：文件名…」；认不出、只读的不带。越界的照旧另在 outsidePaths 里。
   */
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 })),
}, strict);
export const LocalSessionDetailResponse = Type.Object({
  session: LocalSessionSummary,
  pendingPermissions: Type.Array(LocalPermissionRequestView),
}, strict);

/**
 * 在右边预览文件（设计 17.2 第 41 条）。两条都只看本会话自己的地方（下称「会话根」）：卡在工作树里做时是工作树的根，别的会话是工作目录；
 * 交出的产出本来就在里面。本机按解析掉链接以后的真实路径判，在会话根外面的（.. 穿越、指到外面的链接、别的盘）一律 403 folder_not_allowed。
 * 会话结束了（退出、交完、合回前）也能读；工作树合回后清掉了，文件就不在了（404，列表里 exists 为 false）。只读，不改任何东西。
 *
 * POST /v1/sessions/:id/files/read：读一个文件。path 是绝对路径，或相对路径（正反斜杠都行）：相对路径先按执行方的工作目录找（它在回答里写的相对路径是相对工作目录的），
 * 没有再按会话根找——两者只在卡的工作树里、本人选的又是仓库的子文件夹时不一样。回答里的路径、列表里的 path / absolutePath、产出事件（artifact）的 path 都可以直接拿来问。
 * - kind：markdown（.md、.markdown）；text 纯文本和代码（按扩展名认，认不出的看内容里有没有 NUL 字节；HTML、SVG 也算 text，网页当文本看、不执行）；
 *   image（png、jpg、jpeg、gif、webp、bmp、ico）；other 别的（PDF、Word、压缩包、二进制），只给名字和大小，网页给「打开」。
 * - content：markdown、text 是 UTF-8 文字，最多 1 MB，超了只给前 1 MB、truncated 为 true；image 是 base64（encoding 写明），最多 5 MB，超了不给内容（content 为 null、truncated true）；
 *   other 的 content 为 null。mimeType 给 image 拼 data: 地址用，别的类型按扩展名给一个尽量准的。
 * - path 是相对会话根的路径（正斜杠），absolutePath 是这台电脑上的绝对路径，size 是文件的字节数，modifiedAt 是最后改的时间。
 * 项目另外绑的文件夹（LocalProjectFolder.folders 里第一个以后的，17.2 第 46 条）里的文件也能读：要给绝对路径（相对路径只按工作目录、会话根找，不去那些文件夹里猜同名的）；
 * 这些文件的 path 就是绝对路径（正斜杠），拿它原样再问也行。认的是问的这一刻项目绑着、本人也还允许着的文件夹。
 * 错误：404 not_found（没有这个会话、文件不存在、是个文件夹）；403 folder_not_allowed（在会话根和项目另外绑的文件夹外面）；400 validation。
 */
export const LocalFileKind = Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("image"), Type.Literal("other")]);
export const LocalSessionFileReadRequest = Type.Object({ path: Type.String({ minLength: 1, maxLength: 2000 }) }, strict);
export const LocalSessionFileReadResponse = Type.Object({
  path: Type.String(),
  absolutePath: Type.String(),
  name: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  modifiedAt: Instant,
  kind: LocalFileKind,
  mimeType: Type.String({ minLength: 1, maxLength: 120 }),
  encoding: Type.Union([Type.Literal("utf8"), Type.Literal("base64")]),
  content: Nullable(Type.String()),
  truncated: Type.Boolean(),
}, strict);
/**
 * GET /v1/sessions/:id/files：本会话写过、改过的文件（右栏「改动的文件 N」；回答里提到的路径对得上这里的才能点）。sources 写明是哪一路知道的。
 * 卡在工作树里做的两路取并集；在本人文件夹里直接做的只有 tool 这一路——宁可漏掉用命令改的，也不把本人自己没提交的改动算成这个会话改的：
 * - tool：事件记录里执行方用写文件、改文件的工具动过的（Claude Code 的 Write、Edit、MultiEdit、NotebookEdit，Codex 的改文件）。不是 git 仓库也有；
 *   用命令改的（脚本生成、sed、格式化工具）看不到，子 agent 里写的也看不到（它内部的步骤不进事件记录）；被拒绝、没改成的不算。
 * - git：只有卡在工作树里做的有这一路（工作树是这张卡自己的）——开工以来分支上已经提交的，加上没提交的（含新文件，.gitignore 里的不算）。
 * path 是相对会话根的路径（正斜杠），absolutePath 是绝对路径（回答里两种写法都可能出现，网页拿它们去对）；exists 是现在还在不在（删掉的、挪走的为 false，不能点）；
 * size 是现在的字节数（不在了为 null）。按路径排，最多 500 个，多了 truncated 为 true。root 是会话根。删掉的文件只有 git 那一路知道。
 * 项目另外绑的文件夹里的也列（17.2 第 46 条）：只有 tool 这一路（那里是本人的文件夹，不开工作树），path 是绝对路径（正斜杠）。
 * 不在工作树里做的会话有留一份时（见 LocalUndo，11/11）：
 * - snapshot：整个工作目录留了的（undo.state ready）——每一轮开始前和结束后各留一份，两份之间变了的；用命令、脚本、子 agent 改的、删的、新建的都在。
 *   本人在两轮之间自己改的不算。删掉的文件这一路也知道（exists 为 false）。
 * - change：这个会话把它怎么了（added 新建、modified 改了、deleted 删了；挪走算原来的删了、新地方新建）。只有 snapshot 一路、或有留一份的才带。
 * - restorable：能不能点「恢复」（有留一份，或是会话新建的）。restoredAt：最近一次恢复的时间；恢复以后又被会话改了就不带。
 * 恢复了的文件还留在列表里（内容回到会话第一次动它之前；新建的恢复后不在了，exists false）。
 */
export const LocalChangedFile = Type.Object({
  path: Type.String(),
  absolutePath: Type.String(),
  sources: Type.Array(Type.Union([Type.Literal("tool"), Type.Literal("git"), Type.Literal("snapshot")]), { minItems: 1, maxItems: 3 }),
  exists: Type.Boolean(),
  size: NullableInteger({ minimum: 0 }),
  change: Type.Optional(Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")])),
  restorable: Type.Optional(Type.Boolean()),
  restoredAt: Type.Optional(Instant),
}, strict);
export const LocalSessionFilesResponse = Type.Object({
  root: Type.String(),
  files: Type.Array(LocalChangedFile, { maxItems: 500 }),
  truncated: Type.Boolean(),
}, strict);

/**
 * POST /v1/sessions/:id/files/restore：把这个会话动过的文件恢复到它第一次动之前（11/11，见 LocalUndo）。paths 用 LocalChangedFile 的 path 或 absolutePath；
 * 不给 paths 就是全部恢复到开工前。改了的、删了的写回原来的内容；会话新建的删掉。恢复前先给现在的样子也留一份（以后可以撤回这次恢复）。
 * 一个个来，有的成了有的没成时照样回 200：restored 是恢复了的 path，failed 是没成的：in_use 文件正被别的程序打开（比如 Excel，关掉再点）、
 * no_copy 没有留一份（不是这个会话动的、留的已过期清掉了）、error 别的（message 写原因）。
 * 会话正在做一轮（starting、running、waiting_permission）时回 409（先停下）；没有这个会话 404；卡在工作树里做的回 409（用 git，合回前不需要）。
 * 恢复完记一条事件 files_restored。
 */
export const LocalSessionRestoreRequest = Type.Object({
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 500 })),
}, strict);
export const LocalRestoreFailure = Type.Object({
  path: Type.String(),
  reason: Type.Union([Type.Literal("in_use"), Type.Literal("no_copy"), Type.Literal("error")]),
  message: Type.String({ maxLength: 500 }),
}, strict);
export const LocalSessionRestoreResponse = Type.Object({
  restored: Type.Array(Type.String(), { maxItems: 500 }),
  failed: Type.Array(LocalRestoreFailure, { maxItems: 500 }),
}, strict);

/**
 * 看得见改了什么、只动让动的那一块（设计第 72 条第一步，11/11 本人定进 11/18；数据形状主会话定）。
 * 数据来自「改、删前留一份」（LocalUndo）：每一轮开始前、结束后各留的一份，和改前拷的那份。
 *
 * 「一处」由本机算，网页照给的区间画，显示的和能恢复的才对得上：先按行比，再在改过的行里按字比（中文按字），
 * 挨得近的（中间只隔不超过 3 个没变的字、且不跨行）并成一处；同一行里隔得远的两处是两处，能分开恢复。新建、删掉的文件算一处（整份）。
 *
 * range：turn 这一轮（turn 给轮号，不给是最近做完的那一轮）；session 开工到现在（会话第一次动它之前 → 磁盘上现在）。
 * 卡在 git 工作树里做的只有 session（从开工的提交比到现在的工作树），问 turn 回 400。
 */
export const LocalChangeRange = Type.Union([Type.Literal("turn"), Type.Literal("session")]);
/**
 * full：有明细（Markdown、纯文本、代码、CSV 这类文本，不超过 1MB）；
 * converted：Word（.docx）、Excel（.xlsx）转成文字再比，before、after 是转出来的文字（Excel 大表只给改过的行和上下各两行，带表头，中间用一行省略隔开，区间按裁过的文字算），
 *   changes 照常给，但不能按处恢复（只能整个文件恢复，POST /v1/sessions/:id/files/restore）；
 * none：只知道改过（超过 1MB、二进制、转不了的老格式或带密码的、降级后拿不到改前那份、用命令改的工作目录以外的文件），不给 before、after、changes。
 */
export const LocalChangeDetail = Type.Union([Type.Literal("full"), Type.Literal("converted"), Type.Literal("none")]);
/** 一段字符区间：JS 字符串下标（UTF-16），[start, end)；空区间 start = end。 */
export const LocalTextSpan = Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }, strict);
/**
 * 一处改动：before 是它在改前那份全文里的区间，after 是在改后那份里的区间（就按给出去的那两个字符串算，换行符原样不动、不做归一）。
 * 纯新增 before 是空区间，纯删除 after 是空区间。id 在同一对 before / after 文字下不变（文件没再变，重读拿到的 id 一样）。
 */
export const LocalTextChange = Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }), before: LocalTextSpan, after: LocalTextSpan }, strict);

/**
 * POST /v1/sessions/:id/files/changes：读一个文件的改动。path 用改动的文件列表（LocalChangedFile）里的 path 或 absolutePath。
 * 错误：404 not_found（没有这个会话、这个会话没动过这个文件、那一轮不存在）；400 validation（工作树里的会话问 turn）。一轮在跑时也能读（读的是已经留下的那几份）。
 */
export const LocalFileChangesRequest = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 2000 }),
  range: Type.Optional(LocalChangeRange),
  /** 第几轮（1 起，同 files_changed 事件的 turn）；range 是 turn 时用，不给是最近做完的那一轮。 */
  turn: Type.Optional(Type.Integer({ minimum: 1 })),
}, strict);
/**
 * - change：这一段时间里这个文件是新建、改了还是删了。新建的 before 为 null、删掉的 after 为 null（各算一处，整份）。
 * - revision：读的这一刻磁盘上这个文件内容的指纹（不在了为 null）。恢复其中几处时带回来核对。
 * - restorable：能不能按处恢复（detail 是 full、不是整份新建或删掉、而且磁盘上现在就是 after 那份——看更早的一轮、之后又改过的，不能按处恢复）。
 * - turn：range 是 turn 时是第几轮，session 时为 null。
 * detail 是 none 时不带 before、after、changes。
 */
export const LocalFileChangesResponse = Type.Object({
  path: Type.String(),
  absolutePath: Type.String(),
  range: LocalChangeRange,
  turn: NullableInteger({ minimum: 1 }),
  change: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
  detail: LocalChangeDetail,
  before: Type.Optional(Nullable(Type.String())),
  after: Type.Optional(Nullable(Type.String())),
  changes: Type.Optional(Type.Array(LocalTextChange, { maxItems: 2000 })),
  revision: Nullable(Type.String({ maxLength: 80 })),
  restorable: Type.Boolean(),
}, strict);

/**
 * POST /v1/sessions/:id/files/changes/restore：把其中几处按改前那份写回，别的不动（网页不送文件内容）。path、range、turn 同读的时候，ids 是要恢复的那几处，
 * revision 是读的时候拿到的。写回前照「留一份」的规矩先给现在的样子留一份；写回以后回新的读结果（同一个 range、turn），网页照它重画。
 * 错误：409 file_changed（磁盘上的文件和 revision 对不上：读了以后又被改过，网页重读）；409 conflict（会话正在做一轮）；
 * 400 validation（不能按处恢复：detail 不是 full、整份新建或删掉的、restorable 为 false；ids 里有不认识的）；404 同读。恢复完记一条 files_restored（all false）。
 */
export const LocalFileChangesRestoreRequest = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 2000 }),
  range: Type.Optional(LocalChangeRange),
  turn: Type.Optional(Type.Integer({ minimum: 1 })),
  ids: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 2000 }),
  revision: Nullable(Type.String({ maxLength: 80 })),
}, strict);
export const LocalFileChangesRestoreResponse = Type.Object({
  restored: Type.Array(Type.String(), { maxItems: 2000 }),
  file: LocalFileChangesResponse,
}, strict);
/** 一轮结束的事件 files_changed 里的一个文件：count 是几处（detail 为 none 时为 null；Word、Excel 照转出来的文字算）。 */
export const LocalTurnFileChange = Type.Object({
  path: Type.String(),
  absolutePath: Type.String(),
  change: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
  detail: LocalChangeDetail,
  count: NullableInteger({ minimum: 1 }),
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
  /**
   * 这句话的编号（网页生成；本机程序 protocol ≥ 2 才收，见 LOCAL_RUNNER_PROTOCOL）。本机就用它当编号，网页发出去就能先画这句。
   * 幂等：同一会话里这个编号已经记过（事件流里有这条 user_message），当成重发，不再送一遍，回原来的结果（原来回的错误照样回）。
   * 没记下就被拒的（排队中、空话、附件取不回）不算记过，同一个编号可以再发。不带就由本机给。
   */
  messageId: Type.Optional(Uuid),
  /**
   * 这句话是在告诉执行方「卡的约定改了」（主循环第 60 条，本机程序 protocol ≥ 3 才收）：改完以后约定的版本号（同 LocalCardAgreementResponse.revision）。
   * 网页转的是云端登记的那条转话（SessionCommand message 带了 agreementRevision）时原样带上；本机记下「执行方已经知道第 N 版」，交回时核对就不再为这一版退回。
   * 老本机程序不带它（只发 text），交回时最多多退回一次。
   */
  agreementRevision: Type.Optional(Type.Integer({ minimum: 1 })),
}, strict);
export const LocalSendMessageResponse = Type.Object({
  /**
   * next_step：进行中，下一步前送达；new_turn：开了新一轮；resumed：进程已退出，续接后送达。
   * compact：这句是手打的 /compact，照 POST /v1/sessions/:id/compact 压缩上下文（开始压了就回，不等压完），不记成一句话、没有 user_message；
   * 在跑一轮、正在压缩时照那边回 409。
   */
  delivery: Type.Union([Type.Literal("next_step"), Type.Literal("new_turn"), Type.Literal("resumed"), Type.Literal("compact")]),
  /** 这句话的编号（请求带了就是它，没带是本机给的），事件流里 user_message 和 receipt 按它对上。 */
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

/**
 * POST /v1/sessions/:id/compact（体 {}）：压缩上下文（本人 11/18，子会话输入框下的上下文圆环点开「压缩」；手打 /compact 也走这里），回执是 LocalSessionActionResponse。
 * Claude Code 往会话里发 /compact，Codex 调 thread/compact/start；进程不在就先续接上。压完才回，摘要的 context 已是压完读到的用量（事件流里随 context_usage、
 * notice context_compacted 更新）。压缩不算一轮：不记成本人说的一句话，没有 agent_info、turn_end，不报 stopped，状态不变；花的用量照记（cost 同步条目）。
 * 一轮在跑（含在等批准、在问本人、启动中、排队中）、正在压缩时回 409；执行方没压成也回 409（message 带它的原话）。压缩途中说话回 409。
 */
/** POST /v1/sessions/:id/interrupt（停下，会话保留）与 /kill（强停，杀本会话进程树）的回执。 */
export const LocalSessionActionResponse = Type.Object({ session: LocalSessionSummary }, strict);
/**
 * PUT /v1/sessions/:id/permission-mode：本人在子会话底下换模式，跑着的时候也能换，下一步就按新的来；回改完的会话。
 * 换成更宽的档时，正在等批准的请求按新的档重判一遍，新档放行的就自己放行（网页上那条随之消失）。执行方没有这一档时 400；会话已结束 409。
 */
export const LocalPermissionModeRequest = Type.Object({ mode: LocalPermissionMode }, strict);

/**
 * PUT /v1/sessions/:id/model：子会话换模型、换思考程度（天枢伙伴不走这里；设计 17.2 第 32、36 条）。modelProfileId 是本机的模型配置（GET /v1/models），
 * effort 是思考程度（要在新模型配置的 efforts 里；null 是回到按档位和预算模式定）。两项至少带一项；只带 effort 是同一个模型换思考程度：
 * Claude Code 在跑时用 apply_flag_settings 当场换（now）。只换模型不带 effort 时，原来选的思考程度新模型也支持就留着，不支持就回到自动。
 * Codex 的会话（设计 17.2 第 38 条）：模型和思考程度都是开一轮（turn/start）时带，不用重开进程——没在跑时 now；正在跑一轮时 after_turn，
 * 这一轮做完、下一轮开始时换上（摘要的 pendingModel 到那时去掉）。下面两条讲的是 Claude Code。
 * 两种生效方式，回执的 applied 写明，网页分别显示：
 * - now（已生效）：下一次回答起就用新模型。同一个执行方、同一个来源里换（订阅里 Opus 换 Haiku；同一个网关地址、同一把钥匙下换模型名）时，
 *   本机当场让 Claude Code 换（它的 set_model，11/09 实测 2.1.318 认）；会话没在跑（停了、排着、交完了）时也是 now，下次开起来就用新的。
 * - after_turn（这一轮做完后生效）：跨来源（订阅换 TokenHub、换别的网关、换钥匙）要换环境变量，只能重开执行方。
 *   正在跑的先记下（摘要的 pendingModel），这一轮做完、没有在跑的后台任务时，本机用 --resume 接着原来的对话、换上新模型重开，对话和进度不丢；
 *   会话空着（等你回复）时当场就重开，回 now。
 * 换好以后摘要和 status 同步条目里的 run（modelName、origin 等）随之更新，事件流记一条 notice（code model_changed）。
 * 没有这个模型配置回 400。
 *
 * 换执行方（设计 17.2 第 38 条下面，11/10 用户：Claude Code ↔ Codex 双向换，接着原来的事做）：modelProfileId 是另一家的模型配置就是换执行方。
 * - 生效时机同跨来源：空着、停了、排着时 now；正在跑一轮、有批准或提问在等、有后台任务在跑时 after_turn，这一轮做完再换。
 * - 会话还是同一个（id、事件流、产出、工作目录都不变）：摘要的 agent 和 run.harness 换成新的，事件流记一条 notice（code harness_changed，
 *   text 如「换成 Codex · GPT-6.1-Sol」），同步给云端的 status 条目随之带新的 run。
 * - 接上下文：两家各留着自己的对话（Claude Code 的会话、Codex 的线程），换回来时续上自己的；换过去的那家只补它没看到的那几轮——
 *   最近 8 轮原样带上（本人说的、它回的、工具调用写成一行字，如「运行 git status → ok」），更早的不压缩，给它本会话 MCP 的
 *   read_earlier_turns 工具自己翻（本机从事件记录里读，分页）；再附上工作目录里 git 看得到的改动文件。不再调一次模型去写摘要（额度用完时也能换）。
 * - 两边规矩一致：工作规矩、技能、天枢 MCP、本人加的工具两边都挂；仓库里只有 CLAUDE.md 时它的内容一并给 Codex，只有 AGENTS.md 时给 Claude Code
 *   （本机不往仓库里写文件）；技能要飞书时两边都有本人的飞书技能。
 * - 新执行方没有现在这一档权限模式时（「先出计划」换到 Codex）改成「每次都问」，事件流记 permission_mode（by harness_changed）。
 * - 规划员、验收员只能用 Claude Code，换到 Codex 回 400。
 */
export const LocalSessionModelRequest = Type.Object({ modelProfileId: Type.Optional(Id), effort: Type.Optional(Nullable(LocalEffort)) }, strict);
export const LocalSessionModelResponse = Type.Object({
  applied: Type.Union([Type.Literal("now"), Type.Literal("after_turn")]),
  session: LocalSessionSummary,
}, strict);

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

/**
 * 交回时执行方对一条完成标准的自评。result 多一种 needs_person 要本人补（主循环第 61 条）：要登录、验证码、人工查询、网站拦自动访问、
 * 要本人的权限或判断，执行方做不了的，不绕，标这个；need 是一句人话：要本人做什么、给回什么（needs_person 时必带，本机检查；别的不带）。
 */
export const LocalHandbackCriterion = Type.Object({
  /** 第几条完成标准，从 1 开始。 */
  index: Type.Integer({ minimum: 1 }),
  result: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet"), Type.Literal("needs_person")]),
  evidence: Type.String({ maxLength: 2000 }),
  need: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, strict);

/**
 * 规划员出的派活单里的一件（对得上云端的草稿卡）：brief 是交代；doneDefinition 是完成标准，每行一条；criterionIndex 对约定第几条（从 1 起，对不上为 null）；
 * role 是交代里岗位清单的 id 或名字（云端按本人的岗位对上，对不上当没配）；modelTier 是模型档位；why 一句话说为什么这么拆。
 */
export const LocalPlanCard = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120 }),
  brief: Type.String({ maxLength: 4000 }),
  doneDefinition: Type.String({ minLength: 1, maxLength: 2000 }),
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

/**
 * 验收员对一条完成标准的判定（对得上云端的 CardAcceptanceCriterion，少了 text：云端有交回时的标准快照）。fix 是没达到时怎么补。
 * 主循环第 61 条：verdict 多一种 needs_person（执行方标了「要本人补」、而且确实只有本人能做；执行方其实能做的照旧 unmet）；
 * fixBy 是没达到时谁来补：worker 执行方、person 本人（needs_person 的是 person）。新验收员没达到的每条都带，met 不带；老验收员不带，云端按 worker 算。
 * fixBy = person 时 fix 写要本人做什么、给回什么，一句人话。
 */
export const LocalVerdictCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  verdict: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet"), Type.Literal("needs_person")]),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  evidence: Nullable(Type.String({ maxLength: 2000 })),
  fix: Nullable(Type.String({ maxLength: 2000 })),
  fixBy: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("person")])),
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
 * 「等本人补」（主循环第 61 条）不另报：有一条 needs_person 或 fixBy = person 时 passed 照样是 false，云端按逐条判定算成 needs_person（规则见 CardHandbackOutcome）。
 * summary（主循环第 61 条的新规矩）：一句人话，说卡在哪、要谁做什么；不写行号，不复述标准原文。云端存成 headline，等你补和受阻的框第一行就是它。
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
 * - failStreak 是这张卡在这次交回之前连续没过几次（推翻以后从 0 算；等本人补的那几次跳过，不算也不打断）。这次再没过、累计到 2 就是「受阻」；这次是等本人补的不算受阻。
 * - markdown 里执行方的逐条自评带上「要本人补」的那几条和它写的 need（主循环第 61 条），验收员据此判 needs_person 还是 unmet。
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

/**
 * GET <apiBaseUrl>/api/local-runner/card-agreement?cardId=<卡 id>（云端实现，主循环第 60 条）：卡此刻的约定。卡的约定的依据只有云端卡上这一份。
 * revision 是约定的版本号（卡建出来是 1，交代或完成标准每改一次加 1）；brief 是交代（没写为 null）；standards 是完成标准，按条。
 * 本机这样用：
 * - 卡开工时取一次，记下执行方知道的是第几版；网页转来带 agreementRevision 的那句话时（LocalSendMessageRequest），记成那一版。
 * - 执行方 hand_back 时再取一次：比记下的新，就退回这次交回（不报 handback 同步条目），把新的完成标准原样告诉执行方，让它逐条重新自评再交；记成新的这一版。
 *   取不到（离线、云端出错）不挡交回，照常报上去。
 * 不是本人的卡、没有这张卡 404。
 */
export const LocalCardAgreementResponse = Type.Object({
  cardId: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  brief: Nullable(Type.String()),
  standards: Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 }),
}, strict);

/**
 * 执行方提议改卡的约定（主循环第 60 条，天枢 MCP 的工具 propose_agreement_change 的入参，只有卡的会话有这个工具）：
 * standards 是新的完成标准全文（按条，整份；每条一行、不超过 300 字，合起来不超过 2000 字）；brief 是新的交代（不改交代就不带）；reason 是原因，一句话。
 * 它不直接生效：本机记一条事件 agreement_proposal、报一条同步条目 agreement_proposal，云端在这个子会话里钉一个框，本人选「改成这样（推荐）」「不改」，
 * 结果由云端登记的转话告诉执行方。工具立刻回「已经提给本人，等本人定」，执行方接着做别的、或停下等。
 */
export const LocalAgreementProposal = Type.Object({
  standards: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 20 }),
  brief: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
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
 * 子会话停了（新首页设计 18.10「报给主管线」）：why 是怎么停的——
 * turn_done 做完一轮（等本人下一句；卡交回了、规划员交了计划、验收员交了结论也是这个）；interrupted 本人点了停下（含托盘「暂停全部」）；
 * held 停着等（订阅额度用完、网关余额不足、预算用完，blocker 写等什么）；error 出错停住（执行方报错、没开起来、进程意外退出，blocker 写原因）；killed 强停；
 * runner_restart 本机程序被直接停掉（重启、升级、强杀）后重新起来，那时还在跑、在等的会话补一条（主循环第 65 条；老版本本机不报）。
 * 要人介入（在问本人、在等批准）不报这一条：照旧是 status 条目带 question / permission，云端据此在项目对话里直接出决定卡。
 */
export const LocalStopReason = Type.Union([
  Type.Literal("turn_done"), Type.Literal("interrupted"), Type.Literal("held"), Type.Literal("error"), Type.Literal("killed"), Type.Literal("runner_restart"),
]);

/**
 * GET /v1/sessions/:id/events（text/event-stream）。每条 `id: <seq>` + `data: <JSON>`。
 * 断线后带 Last-Event-ID 重连，本机从会话事件日志补发其后的全部事件；也可用 ?after=<seq>。
 * 事件已归一化，不随执行方变：Claude Code 和以后的 Codex 都映射到这几种。
 * 带 ?drafts=1 时还夹着推「正在写」的草稿（LocalSessionDraft）。
 */
export const LocalSessionEvent = Type.Union([
  /**
   * hold：停着等额度恢复时带（见 LocalHold）。
   * why（主循环第 65 条）：这一条是「停了」时（转成 idle 且没在问、exited、failed、done）为什么停，同 LocalStopReason；和同时报的 stopped 同步条目是同一个原因。
   * 网页在对话末尾画一行：turn_done 不画；其余写原因（你停的 / 本机程序重启 / 出错：reason / 额度用完，hold 里的恢复时间），行尾一个「接着做」。不是停了的那几条不带。
   */
  ev("status", { status: LocalSessionStatus, exitCode: Type.Optional(NullableInteger()), reason: Type.Optional(Type.String()), hold: Type.Optional(LocalHold),
    why: Type.Optional(LocalStopReason) }),
  ev("agent_info", { agent: LocalAgentKind, version: Type.String(), model: Nullable(Type.String()), permissionMode: Nullable(Type.String()) }),
  /**
   * 权限模式换了（见 LocalPermissionMode）：by web 是本人在网页上换的，plan_approved 是本人批了计划、从 plan 转成 auto，
   * harness_changed 是换了执行方、新的那家没有原来那一档（「先出计划」换到 Codex 改成「每次都问」）。开工时的模式不报这一条。
   */
  ev("permission_mode", { mode: LocalPermissionMode, by: Type.Union([Type.Literal("web"), Type.Literal("plan_approved"), Type.Literal("harness_changed")]) }),
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
  /**
   * 权限请求了结。voided：不是本人批的或拒的，是本机程序被直接停掉（重启、升级、强杀）后重新起来时作废的（decision 记 deny），
   * 网页写「已作废」，不写「换个做法」。老版本本机不带；老网页忽略它（协议号不升）。
   */
  ev("permission_resolved", { requestId: Type.String(), decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]), message: Type.Optional(Type.String()), allowForSession: Type.Boolean(), voided: Type.Optional(Type.Boolean()) }),
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
  /** path：这份产出在会话根里的相对路径（正斜杠，11/10 起带；fileName 只是文件名），在右边预览时拿它去读（POST /v1/sessions/:id/files/read）。 */
  ev("artifact", { artifactId: Id, title: Type.String(), fileName: Type.String(), size: Type.Integer({ minimum: 0 }), sha256: Type.String(), path: Type.Optional(Type.String()) }),
  /** commit：卡在工作树里做时，交回那一刻分支上的提交（本机先把没提交的改动提交了）。 */
  ev("handback", { summary: Type.String(), criteria: Type.Array(LocalHandbackCriterion), outputKeys: Type.Array(SyncKey), commit: Type.Optional(Sha) }),
  /** 专题存了新的一版（已排进上报队列）。 */
  ev("version", { number: Type.Integer({ minimum: 1 }), kind: LocalTopicVersionKind, label: Nullable(Type.String()), note: Nullable(Type.String()) }),
  /**
   * 验收员交了结论。验收会话和被验的那张卡的会话里各有一条（同一份），只给网页显示：failStreak 是算上这次连续没过几次，blocked（累计到 2）是「受阻」，
   * returnText 是改法（过了时为 null）。网页**不要**据这条事件送回改法：送回只走云端那条路——verdict 同步上去，云端把改法写进那次交回，
   * 网页原有的自动送回按交回送一次（多个标签页也只送一次）。
   */
  /**
   * needsPerson（主循环第 61 条）：这次是「等本人补」（规则同 CardHandbackOutcome），网页写「等你补」，不写没过、不算受阻（blocked 为 false）。老本机不带，按 false。
   */
  ev("verdict", {
    handbackKey: SyncKey, passed: Type.Boolean(), summary: Type.String(), criteria: Type.Array(LocalVerdictCriterion), beyondScope: Type.Array(Type.String()),
    failStreak: Type.Integer({ minimum: 0 }), blocked: Type.Boolean(), returnText: Nullable(Type.String()), needsPerson: Type.Optional(Type.Boolean()),
  }),
  /**
   * 执行方提议改约定（主循环第 60 条，见 LocalAgreementProposal）：proposalKey 是同时报给云端的 agreement_proposal 同步条目的 key。
   * 网页在对话里记这一行；钉住的框和「改成这样 / 不改」照云端的 CardDetailResponse.agreement.proposal 画（手机上也一样），看到这条事件就重读一次卡的详情。
   */
  ev("agreement_proposal", { proposalKey: SyncKey, ...LocalAgreementProposal.properties }),
  /**
   * 上下文用了多少变了（见 LocalContextUsage，摘要的 context 同步更新）：每轮做完报一次；这一轮中间每次模型回复后算一次，
   * 百分比（取整）变了才报，免得事件太密；上限读不到时只在每轮做完报。压缩以后跟着报一条新的。
   */
  ev("context_usage", { usedTokens: Type.Integer({ minimum: 0 }), maxTokens: NullableInteger({ minimum: 1 }) }),
  /**
   * interjection_next_step：插话已送出，下一步生效；auth_required：执行方登录失效；agent_stderr：执行方报错输出；verify_waiting：验收在等交代（连不上天枢等）；
   * workspace：卡开工时在哪做（工作树的分支、从哪个提交开始、主文件夹里没提交的改动没带进来）；merged：卡的分支已合回主文件夹；
   * context_compacted：执行方压缩了上下文（Claude Code 的 compact_boundary、Codex 的 contextCompaction；自动压的和本人让它压的都报），
   * text 是「压缩了上下文」，网页在对话里记这一行（设计 17.2 第 42 条）。
   * undo：改、删前留一份变了（见 LocalUndo；留好了 info、只能给改文件工具改的留一份 warn、留的已清掉 warn），摘要的 undo 同时更新。
   */
  ev("notice", { level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]), code: Type.String(), text: Type.String() }),
  /** 本人恢复了文件（POST /v1/sessions/:id/files/restore）：all 是不是「全部恢复」，restored、failed 同回执。只在本机，不同步给云端。 */
  /**
   * 一轮结束、这一轮改过文件时记一条（设计第 72 条）：turn 第几轮（1 起），files 是这一轮新建、改了、删了的文件（按路径排，最多 100 个，多了 more 写还有几个）。
   * 有整份快照的（undo.state ready）命令、子 agent 改的也在；只改前拷一份的只有改文件工具改的。卡在工作树里的会话不记。只在本机，不同步给云端。
   */
  ev("files_changed", { turn: Type.Integer({ minimum: 1 }), files: Type.Array(LocalTurnFileChange, { minItems: 1, maxItems: 100 }), more: Type.Integer({ minimum: 0 }) }),
  ev("files_restored", { all: Type.Boolean(), restored: Type.Array(Type.String(), { maxItems: 500 }), failed: Type.Array(LocalRestoreFailure, { maxItems: 500 }) }),
]);

/**
 * 「正在写」的草稿：GET /v1/sessions/:id/events?drafts=1 时夹在事件之间推，帧是 `event: draft` + `data: <JSON>`，没有 id 行。
 * 不是会话事件：不占编号、不写盘、不进云端同步和交接摘要，断线重连不补（一会儿完整的 assistant_text 就到）。
 * text 是执行方正在写的这一段话到目前为止的全文（不是增量），本机合并成每 80 毫秒至多一条。
 * 这一段写完照常来一条 assistant_text，以它为准：网页收到 assistant_text 就拿它替换草稿。
 * text 为空串：这一段没写完就不写了（停下、出错、进程没了），网页清掉草稿。
 * 只发正文：思考内容、工具参数、子 agent 的字不发。老本机程序不认 drafts=1，照旧只推事件，网页照旧能用。
 */
export const LocalSessionDraft = Type.Object({
  type: Type.Literal("draft"),
  sessionId: Uuid,
  text: Type.String(),
}, strict);

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
 * description、paths（主循环第 64 条）同 LocalPermissionRequestView：有 description 时「等你」那一行的摘要用它。老版本本机不带。
 */
export const LocalPermissionBrief = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 120 }),
  toolName: Type.String({ maxLength: 200 }),
  title: Type.String({ maxLength: 500 }),
  outsidePaths: Type.Array(Type.String(), { maxItems: 20 }),
  /** 能不能「这张卡都允许」（同 LocalPermissionRequestView.canAllowForSession）：为 false 时批准卡只给「允许这一次」。老版本本机报的不带，按 false。 */
  canAllowForSession: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 })),
}, strict);

/**
 * 停了的报告（同步条目 stopped）。都取会话里现成的内容，本机不另调模型：
 * - summary：做成了什么，取这一轮执行方最后那段话的头一两句（去掉 Markdown 记号，200 字以内）；这一轮一句话也没说为 null。
 * - blocker：卡在哪，出错、停着等时的原因（一句话，给人看）；做完一轮、本人停下、强停为 null。
 * - outputs：这一轮交的产出物，key 是它那条 artifact 同步条目的 key（云端据此出「看结果」），title、fileName 同那一条。
 * - handbackKey：这一轮交回了时，那条 handback 同步条目的 key。
 * 云端照它在项目对话里出「B · 标题」的报告，不再让项目主管线回一小轮（主循环第 63 条：报告不触发模型）。subject 里有 cardId、topicId、taskId 和 projectId。
 * 本机程序重启时，那时还在跑、在等的会话各补一条 why = runner_restart（主循环第 65 条）。
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
    /** 只在 status = queued、在等普通文件夹空出来时带：占着它的是谁（LocalFolderHolder，第 68 条）。云端据此算 queueReason = folder_busy。 */
    heldBy: Type.Optional(LocalFolderHolder),
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
   * 执行方提议改卡的约定（主循环第 60 条，只有卡，subject 带 cardId），见 LocalAgreementProposal。云端按 key 去重，记成这张卡在等本人定的那一个（旧的作废）。
   * 卡不是本人的、卡已完成的永久拒收。
   */
  syncItem("agreement_proposal", LocalAgreementProposal),
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
export type TLocalSourceFormat = Static<typeof LocalSourceFormat>;
export type TLocalSourcePlan = Static<typeof LocalSourcePlan>;
export type TLocalSourceRegion = Static<typeof LocalSourceRegion>;
export type TLocalSourceModel = Static<typeof LocalSourceModel>;
export type TLocalSourcePreset = Static<typeof LocalSourcePreset>;
export type TLocalSource = Static<typeof LocalSource>;
export type TLocalSourceListResponse = Static<typeof LocalSourceListResponse>;
export type TLocalSourceCheckRequest = Static<typeof LocalSourceCheckRequest>;
export type TLocalSourceCheckResponse = Static<typeof LocalSourceCheckResponse>;
export type TLocalSourceAddRequest = Static<typeof LocalSourceAddRequest>;
export type TLocalSourceAddResponse = Static<typeof LocalSourceAddResponse>;
export type TLocalTokenHubConnectRequest = Static<typeof LocalTokenHubConnectRequest>;
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
export type TLocalFolderPickRequest = Static<typeof LocalFolderPickRequest>;
export type TLocalFolderCreateRequest = Static<typeof LocalFolderCreateRequest>;
export type TLocalFolderCreateResponse = Static<typeof LocalFolderCreateResponse>;
export type TLocalScratchFolderRequest = Static<typeof LocalScratchFolderRequest>;
export type TLocalScratchFolderResponse = Static<typeof LocalScratchFolderResponse>;
export type TLocalFolderOpenRequest = Static<typeof LocalFolderOpenRequest>;
export type TLocalSessionModelRequest = Static<typeof LocalSessionModelRequest>;
export type TLocalContextUsage = Static<typeof LocalContextUsage>;
export type TLocalFileKind = Static<typeof LocalFileKind>;
export type TLocalSessionFileReadRequest = Static<typeof LocalSessionFileReadRequest>;
export type TLocalSessionFileReadResponse = Static<typeof LocalSessionFileReadResponse>;
export type TLocalChangedFile = Static<typeof LocalChangedFile>;
export type TLocalSessionFilesResponse = Static<typeof LocalSessionFilesResponse>;
export type TLocalUndo = Static<typeof LocalUndo>;
export type TLocalSessionRestoreRequest = Static<typeof LocalSessionRestoreRequest>;
export type TLocalSessionRestoreResponse = Static<typeof LocalSessionRestoreResponse>;
export type TLocalRestoreFailure = Static<typeof LocalRestoreFailure>;
export type TLocalChangeRange = Static<typeof LocalChangeRange>;
export type TLocalChangeDetail = Static<typeof LocalChangeDetail>;
export type TLocalTextChange = Static<typeof LocalTextChange>;
export type TLocalFileChangesRequest = Static<typeof LocalFileChangesRequest>;
export type TLocalFileChangesResponse = Static<typeof LocalFileChangesResponse>;
export type TLocalFileChangesRestoreRequest = Static<typeof LocalFileChangesRestoreRequest>;
export type TLocalFileChangesRestoreResponse = Static<typeof LocalFileChangesRestoreResponse>;
export type TLocalTurnFileChange = Static<typeof LocalTurnFileChange>;
export type TLocalSessionModelResponse = Static<typeof LocalSessionModelResponse>;
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
export type TLocalCardAgreementResponse = Static<typeof LocalCardAgreementResponse>;
export type TLocalAgreementProposal = Static<typeof LocalAgreementProposal>;
export type TLocalFolderHolder = Static<typeof LocalFolderHolder>;
export type TLocalSlots = Static<typeof LocalSlots>;
export type TLocalPlanProgress = Static<typeof LocalPlanProgress>;
export type TLocalCreateSessionBatchRequest = Static<typeof LocalCreateSessionBatchRequest>;
export type TLocalCreateSessionBatchResponse = Static<typeof LocalCreateSessionBatchResponse>;
export type TLocalRoleTool = Static<typeof LocalRoleTool>;
export type TLocalSessionEvent = Static<typeof LocalSessionEvent>;
export type TLocalSessionDraft = Static<typeof LocalSessionDraft>;
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
  connectTokenHub: { method: "POST", path: "/v1/tokenhub", auth: true },
  disconnectTokenHub: { method: "DELETE", path: "/v1/tokenhub", auth: true },
  listSources: { method: "GET", path: "/v1/sources", auth: true },
  checkSource: { method: "POST", path: "/v1/sources/check", auth: true },
  addSource: { method: "POST", path: "/v1/sources", auth: true },
  deleteSource: { method: "DELETE", path: "/v1/sources/:id", auth: true },
  listTools: { method: "GET", path: "/v1/tools", auth: true },
  putTool: { method: "PUT", path: "/v1/tools/:id", auth: true },
  deleteTool: { method: "DELETE", path: "/v1/tools/:id", auth: true },
  checkTool: { method: "POST", path: "/v1/tools/:id/check", auth: true },
  listFolders: { method: "GET", path: "/v1/folders", auth: true },
  pickFolder: { method: "POST", path: "/v1/folders/pick", auth: true },
  createFolder: { method: "POST", path: "/v1/folders/create", auth: true },
  scratchFolder: { method: "POST", path: "/v1/folders/scratch", auth: true },
  deleteFolder: { method: "DELETE", path: "/v1/folders/:id", auth: true },
  openFolder: { method: "POST", path: "/v1/folders/:id/open", auth: true },
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
  compactSession: { method: "POST", path: "/v1/sessions/:id/compact", auth: true },
  listBudgets: { method: "GET", path: "/v1/budgets", auth: true },
  putBudget: { method: "PUT", path: "/v1/budgets", auth: true },
  previewRun: { method: "POST", path: "/v1/runs/preview", auth: true },
  setPermissionMode: { method: "PUT", path: "/v1/sessions/:id/permission-mode", auth: true },
  setSessionModel: { method: "PUT", path: "/v1/sessions/:id/model", auth: true },
  listSessionFiles: { method: "GET", path: "/v1/sessions/:id/files", auth: true },
  readSessionFile: { method: "POST", path: "/v1/sessions/:id/files/read", auth: true },
  restoreSessionFiles: { method: "POST", path: "/v1/sessions/:id/files/restore", auth: true },
  readFileChanges: { method: "POST", path: "/v1/sessions/:id/files/changes", auth: true },
  restoreFileChanges: { method: "POST", path: "/v1/sessions/:id/files/changes/restore", auth: true },
  listProjects: { method: "GET", path: "/v1/projects", auth: true },
  putProjectFolder: { method: "PUT", path: "/v1/projects/:projectId/folder", auth: true },
  handoverCheck: { method: "POST", path: "/v1/projects/:projectId/handover-check", auth: true },
  cloneProject: { method: "POST", path: "/v1/projects/:projectId/clone", auth: true },
} as const;
