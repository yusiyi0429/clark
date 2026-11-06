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
/** 云端「验收交代」（相对天枢 api 的根）：GET ?handbackKey=<交回条目的 key>，鉴权同上。本机在交回同步上去以后取它，起验收会话。 */
export const LOCAL_RUNNER_VERIFY_BRIEF_PATH = "/api/local-runner/verify-brief";

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
  max: Type.Integer({ minimum: 1, maximum: 10 }),
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
  outbox: LocalOutboxStatus,
}, strict);

export const LocalSettings = Type.Object({
  /** 新开的会话是否默认带上本人全局配置（hooks、插件、个人 MCP）。默认 false：会话干净。 */
  includePersonalConfigByDefault: Type.Boolean(),
  /** 只读：允许直连的网页来源。改它要在本机配置文件里改，网页不能改。 */
  allowedOrigins: Type.Array(Type.String()),
  /** 「暂停全部」后为 true：进行中的会话停下，不接新会话、不续接旧会话；只能在托盘里恢复。 */
  paused: Type.Boolean(),
  /** 同时最多跑几个（默认 3，插件页可改）。超出的排队，先来先跑；调大时立刻从队里接上。 */
  maxConcurrent: Type.Integer({ minimum: 1, maximum: 10 }),
  /**
   * 「验收过就合回」（默认 true，插件页可改）：卡的验收过了，主文件夹停在原分支上、没有没提交的改动、合并没有冲突时，本机自动合回（只合不推），
   * 等它的卡接着自己开始。不满足或关了时不合，卡的 workspace.needsMerge 写明原因，等本人合。
   */
  autoMerge: Type.Boolean(),
}, strict);
export const LocalSettingsPatch = Type.Object({
  includePersonalConfigByDefault: Type.Optional(Type.Boolean()),
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  autoMerge: Type.Optional(Type.Boolean()),
  /** 网页只能暂停（true）；传 false 会被拒（409），恢复只能在本机托盘里点。 */
  paused: Type.Optional(Type.Boolean()),
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
  /** 天枢里 Task 的 id，kind=plan 时必填（拆的是这个 Task）。 */
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /** 只有 kind=verify（本机填）：验的是哪一次交回，就是那条 handback 同步条目的 key。 */
  handbackKey: Type.Optional(SyncKey),
}, strict);

export const LocalUsage = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0 }),
  /** 订阅登录时是 Claude Code 自己估的等价花费；网关模型可能为 null。 */
  costUsd: Nullable(Type.Number({ minimum: 0 })),
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
 * POST /v1/sessions。kind=plan（规划员）：带 taskId，firstMessage 是云端的拆卡交代，role 是规划员岗位；不给目录时本机给它建一个专用目录。
 * kind=verify 不能从网页开（400）：执行方交回以后本机自己起。
 */
export const LocalCreateSessionRequest = Type.Object({
  subject: LocalSessionSubject,
  title: Type.String({ minLength: 1, maxLength: 120 }),
  /** 工作目录：必须在允许的文件夹内。topic、plan 可不填，本机程序给它建一个专用目录。卡的文件夹在 git 仓库里时，卡在自己的工作树里做（见 LocalWorkspace）。 */
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  agent: Type.Optional(LocalAgentKind),
  /** 不填用默认模型。 */
  modelProfileId: Type.Optional(Id),
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
 * id 是 Claude Code 的 task_id，同一个会话里唯一。title 是它的说明（子 agent 的 description、命令的 description，没有就用命令本身），截到 200 字。
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
  queuePosition: Nullable(Type.Integer({ minimum: 1 })),
  usage: LocalUsage,
  /** 只有卡：在工作树还是文件夹里做（本机总会填；等前面的卡时还没有工作树，不带）。 */
  workspace: Type.Optional(LocalWorkspace),
  /** 在等本人回答的提问（状态是 idle，界面「等你回复」）；没有就不带。 */
  pendingQuestion: Type.Optional(LocalQuestionRequestView),
  /** 只有卡：排着队、还在等的前面的卡（cardId，还没在这台本机上合回的），界面「已排队 · 等前面的卡」；不在等就不带。 */
  waitingFor: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8 })),
  /** 这个会话里开过的后台任务（按开始的先后，最多留最近 50 个）；没有就不带。 */
  background: Type.Optional(Type.Array(LocalBackgroundItem, { maxItems: 50 })),
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
export const LocalSendMessageRequest = Type.Object({
  kind: Type.Optional(Type.Union([Type.Literal("say"), Type.Literal("review")])),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 20000 })),
}, strict);
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
  criterionIndex: Nullable(Type.Integer({ minimum: 1 })),
  role: Nullable(Type.String({ minLength: 1, maxLength: 80 })),
  modelTier: LocalModelTier,
  why: Nullable(Type.String({ maxLength: 200 })),
  /** 要等派活单里哪几件做完（位置，从 1 起，只能是排在它前面的）；不填就是不用等，可以和别的并行。 */
  after: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 7 })),
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
  roleVersion: Nullable(Type.Integer({ minimum: 1 })),
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
 * 验收员的结论（submit_verdict）：每条完成标准判一次，条数和验收交代的 criteria 一样；passed 是每条都 met；beyondScope 是标准以外的建议，不算没达到。
 * modelLabel、roleId、roleVersion 记是谁验的（本机用的模型、验收员岗位和版本，用内置规矩时为 null）。
 */
export const LocalVerdict = Type.Object({
  passed: Type.Boolean(),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  criteria: Type.Array(LocalVerdictCriterion, { minItems: 1, maxItems: 50 }),
  beyondScope: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }),
  modelLabel: Type.String(),
  roleId: Nullable(Uuid),
  roleVersion: Nullable(Type.Integer({ minimum: 1 })),
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
 */
export const LocalVerifyBriefResponse = Type.Object({
  markdown: Type.String({ minLength: 1, maxLength: 20000 }),
  criteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
  role: Nullable(LocalRole),
  failStreak: Type.Integer({ minimum: 0 }),
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
  ev("status", { status: LocalSessionStatus, exitCode: Type.Optional(Nullable(Type.Integer())), reason: Type.Optional(Type.String()) }),
  ev("agent_info", { agent: LocalAgentKind, version: Type.String(), model: Nullable(Type.String()), permissionMode: Nullable(Type.String()) }),
  ev("user_message", { text: Type.String(), source: Type.Union([Type.Literal("initial"), Type.Literal("web")]) }),
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
    errorKind: Type.Optional(Type.Union([Type.Literal("auth"), Type.Literal("api"), Type.Literal("interrupted"), Type.Literal("other")])),
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

export const LocalSyncItem = Type.Union([
  syncItem("status", Type.Object({
    status: LocalSessionStatus, title: Type.String(), agent: LocalAgentKind, modelLabel: Type.String(),
    /** 只在 status = queued 时带：排第几（1 起）。前面的开始或取消后，本机会给还在排的每件重发一条带新位置的 queued。 */
    queuePosition: Type.Optional(Type.Integer({ minimum: 1 })),
    /** 只在 status = queued、卡在等前面的卡时带：还没合回的那几张的 cardId（派活单上「已排队 · 等前面的卡」）。少了一张就重发一条。 */
    waitingFor: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8 })),
  }, strict)),
  syncItem("plan", Type.Object({ entries: Type.Array(LocalPlanEntry, { maxItems: 100 }), progress: LocalPlanProgress }, strict)),
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
  /** 规划员出的计划和派活单草稿（subject.kind = plan，带 taskId）。 */
  syncItem("card_plan", LocalCardPlan),
  /** 验收员的结论（subject.kind = verify，带 cardId 和 handbackKey）：云端按 handbackKey 找到那次交回，照原来的规则落结果（过了进准备中，没过拼改法，第二次没过受阻）。 */
  syncItem("verdict", LocalVerdict),
  /** 花费：每轮结束报一次本轮的增量。 */
  syncItem("cost", Type.Object({ modelLabel: Type.String(), usage: LocalUsage }, strict)),
  /** 会话里的后台任务开始或变了：每次带全部字段，云端按 sessionId + data.id 覆盖（/api/me/background?scope=session:<sessionId>）。 */
  syncItem("background", LocalBackgroundItem),
  /** 卡合回的结果，见 LocalMergeSync。 */
  syncItem("merge", LocalMergeSync),
]);

export const LocalSyncBatchRequest = Type.Object({
  deviceId: Uuid,
  runnerVersion: Type.String(),
  /** 发这一批时本机的位置数（云端的 worker 列表和「资源」用）。 */
  slots: LocalSlots,
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
export type TLocalMergeSync = Static<typeof LocalMergeSync>;
export type TLocalQuestion = Static<typeof LocalQuestion>;
export type TLocalQuestionRequestView = Static<typeof LocalQuestionRequestView>;
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
} as const;
