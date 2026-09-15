/**
 * 对齐自 tkos-lab/src/tkos_lab/models/registry.py（方舟那三个 + Bedrock 上那两个）
 *
 * 模型 ID 与出网路径是两件事。这张表上五个别名，出网口有三个，**地址、key、请求体方言
 * 三件事由 `provider` 一起决定**，调用方不许自己拼。
 *
 * ## 方舟：模型广场
 *
 * `ARK_API_KEY` + `/api/v3` —— model 填推理接入点 `ep-xxxxxxxx`，直接填模型名会
 * 404 `ModelNotOpen`。
 *
 * 方舟原来还有第二个出口（套餐：`ARK_AGENT_API_KEY` + `/api/plan/v3`，model 填模型名）。
 * 2026-08-25 起没有模型走它了，那把 key、那个地址、那道「别把两者交叉」的告警一起删掉 ——
 * **配着却没有任何代码去读的 key 是个陷阱**：控制台里看着开通了，产品上一个字都不经过它。
 * 哪天要再接一个套餐里的模型，是照 `provider` 加一支的事。
 *
 * ## Bedrock：同一个账号、同一把 key、两个口
 *
 * `WANGSU_API_KEY` 一把 key 撑深研的两条链路（`alt` 与 `synth`，见 `slots.ts`）——
 * 所以它缺了是**一次少两栏**，不是少一栏。两条链路的口不一样：
 *
 *   · GPT-5.6 走 OpenAI 兼容口（`bedrock-runtime.<region>.amazonaws.com/openai/v1`），
 *     `provider: "bedrock"`
 *   · Claude Opus 5 走 bedrock-runtime 自己的 InvokeModel（域名同上，**不带 `/openai/v1`**，
 *     路径由 `@anthropic-ai/bedrock-sdk` 自己拼），`provider: "anthropic"`
 *
 * 那两个口的请求体是两套东西（OpenAI 兼容 vs Anthropic Messages），差异全部落在
 * `complete.ts` 里由 `provider` 分支，实测下来的坑：
 *
 *   · GPT-5.6：`max_tokens` 会被拒（400 `Unsupported parameter`），要发
 *     `max_completion_tokens`；`temperature` 只认默认值 1；深度字段叫 `reasoning_effort`
 *   · Opus 5：`temperature` / `top_p` / `budget_tokens` 一律 400；深度字段是
 *     `output_config.effort`（这个口上实测收，两端 `low` 与 `max` 都通）；思考默认就开着
 *     （adaptive），不用也不能自己配额度
 *
 * 还有第二个能应答的域名（`bedrock-mantle.<region>.api.aws`），它对这个账号里 Claude 与
 * GPT 的**每一个 id 都回 404「does not exist」**—— 它答得出话这件事最容易让人以为是模型 id
 * 写错了。要的是 `bedrock-runtime`，两个口都是。
 *
 * 2026-08-26 这张表上还短暂有过第三家出口（OpenRouter 上的 Ox Alpha，深研第五条链路），
 * 当天又整条撤掉了 —— 撤的时候连 `provider`、地址函数、那三个环境变量一起撤，理由和上面
 * 套餐那一段是同一条：**配着却没有任何代码去读的 key 是个陷阱**。哪天要再接一个网关上的
 * 模型，是照 `provider` 加一支的事，那一支的方言是：上限字段标准 `max_tokens`、思考深度
 * 走统一字段 `reasoning: { effort }`、对模型不支持的参数是忽略而不是 400。
 *
 * 2026-08-27 撤掉 Doubao-Seed-Evolving（`seed` 槽位，屏幕上「豆包」那一栏）。撤的依据是
 * 一轮真运行的账：`RUN-A4-mt9pcc60-2` 里它 **8 次调用整整卡满 180 秒、输入输出都是 0**，
 * 一个字没产出却占了那一轮 32.3 分钟墙钟。它是最后一栏，所以已经落库的报告不会错位
 * （同 Ox Alpha 那次）。`ARK_MODEL_DOUBAO_SEED` 一起撤，理由同上一段。
 *
 * **注意「豆包」在这个库里是两件事**：这里撤的是方舟上那个**模型**。`research/search.ts`
 * 里的豆包搜索是**检索源**，和博查并列，没动也不该动 —— 它是 N3 找网页的两家之一。
 */
import type { Outlet } from "./gate";

export type ModelAlias =
  | "deepseek-pro"
  | "deepseek-flash"
  | "claude-opus-5"
  | "gpt-5.6";
export type KeyEnv = "ARK_API_KEY" | "WANGSU_API_KEY";

/**
 * 出网路径与请求体方言。**不是「哪家的模型」**，是「照哪一套协议发」——
 * 同一个厂的模型换一个出口就可能换一套方言，同一个账号的两个口也可能是两套，
 * 所以这个字段跟着出口走，不跟着厂走。
 *
 * `bedrock` 与 `anthropic` 是同一个账号、同一把 key、同一个域名下的两个口：前者是
 * OpenAI 兼容口，后者是 Anthropic Messages。分成两个值而不是在 `family` 上分支，
 * 是因为要分的是**方言**，而方言的判断依据只能是出口。
 *
 * `deepseek` 是 slots 里那条官方直连回落用的（它不在这张表上，见 `slots.ts`）；
 * 它和 `ark` 是同一套方言，分开写只是为了不让日志里出现「deepseek 直连走的是 ark」
 * 这种假话。
 */
export type Provider = "ark" | "wangsu" | "deepseek";

/**
 * 这一套方言背后是哪个**限流池**（`models/gate.ts`）。
 *
 * 今天它逐个同名，但这不是一件可以省掉的事：出口是「上游按哪一把 key 数请求数」，方言是
 * 「照哪一套协议拼请求体」，两者只是碰巧一一对应。**从前不是**：Bedrock 那阵子 `bedrock`
 * 与 `anthropic` 是两套方言、同一个账号同一把 key，也就是同一个池 —— 那时候按方言分池会让
 * 两个池各自都没超、合起来正好超一倍。写成一张全映射而不是 `provider as Outlet`，是为了让
 * 下一次加一支 `provider` 的人必须回答「它和谁共用配额」这个问题，而不是默认答「谁也不共用」。
 */
const OUTLET_BY_PROVIDER: Record<Provider, Outlet> = {
  ark: "ark",
  wangsu: "wangsu",
  deepseek: "deepseek",
};

export const outletOf = (provider: Provider): Outlet => OUTLET_BY_PROVIDER[provider];

export type ModelSpec = {
  /** 正式版里用的名字，也是 Run 记录里存的值。 */
  alias: ModelAlias;
  display: string;
  /**
   * 屏幕上指认这个模型的最短说法（「V4」「Opus 5」）。页签、按钮那种一行放不下第二个词
   * 的地方用它。
   *
   * 在这张表上而不是在视图里拼：几条链路各写一份报告时，报告页头上那几个字就是一号位
   * 分辨「这份是谁写的」唯一的凭据。视图自己维护一张 `claude-opus-5 → Opus 5` 的
   * 对照表意味着换模型时没人会想起去改它，屏幕上会留着一个已经不在跑的名字。
   *
   * flash 的是「V4 Flash」而不是「V4」：`V4` 这两个字在屏幕上归 pro。
   */
  short: string;
  /** 真正发给服务端的 model 字段。可由环境变量覆盖。 */
  providerModelId: string;
  /**
   * 覆盖 `providerModelId` 的环境变量名。
   *
   * 覆盖在**取用时**生效，不在模块加载时定死：定死的表现是 `.env` 改了、进程没重启
   * 的话仍然发旧 id，而日志里看不出来 —— 报错会是 404 ModelNotOpen，指向「模型没开通」。
   */
  idEnv: string;
  /** 哪个模型走哪把 key 是账号事实，只能写在这张表上。401 时要报出这个变量名。 */
  keyEnv: KeyEnv;
  /** 照哪一套方言发请求体。地址、key、方言三件事都跟着它走。 */
  provider: Provider;
  contextTokens: number;
  /**
   * 认不认思考深度这个字段。**字段名由 `provider` 决定**，几个口各一套：Anthropic 那边是
   * `output_config.effort`，Bedrock 的 OpenAI 兼容口上是 `reasoning_effort`（实测五档全收），
   * 方舟那几个哪个都不认，发过去只会报错。
   *
   * 所以这一档为 false 的模型，深度只驱动 harness 的研究规模，发不出去。
   */
  acceptsEffort: boolean;
  /** 能不能发 temperature / top_p。不是「要不要调」，是「能不能发」。 */
  sampling: boolean;
  /**
   * 一次调用最多能让它输出多少 token。**请求里的额度会被这个数压一次**
   * （`complete.ts` 那道 clamp）。
   *
   * 为什么要有这一栏：分节出稿那一支按「一节要写多少」报额度（`a4/run.ts` 的
   * `SECTION_MAX_TOKENS`），而那个数比几个口各自的上限都可能大 —— 超上限的表现不是被
   * 截短，是 400，那一条链路整条挂掉。压一次之后超出的部分由续写接上
   * （`agent/json.ts` 的 `jsonlContinue`）。
   *
   * **这几个数全是保守值，一个都不是官方规格**：这几个口都没有可查的公开数字，所以宁可
   * 报小 —— 报小了的代价是多一次续写调用，报大了的代价是那条链路 400。真正的上限量出来
   * 之后走 `TKOS_MAX_OUTPUT_TOKENS` 覆盖（**在取用时读**，改了不用重启），一个数管全部模型。
   */
  maxOutput: number;
  /**
   * 认不认 `verbosity`（GPT-5.x 那个）。
   *
   * 出稿那几次要发 `high`（补遗 §3）：同一份提示词下它决定的是模型愿意把话说到多细，而
   * 这一支要的正是「证据有多少就写多少」。
   *
   * **只在 Bedrock 兼容口上对 GPT-5.x 为 true，而且没有实测过。** 兼容口对不认的字段是
   * 400 而不是忽略，所以万一它不认，那一条链路会整条挂掉并在原话里带上
   * `Unsupported parameter` —— 出现那一句就把 `TKOS_MODEL_NO_VERBOSITY=1` 配上，
   * 全局关掉这个字段，别的都不用动。
   */
  acceptsVerbosity: boolean;
  /** 同家族的两次调用不算「独立」。交叉评审与双源反证用它做判定。 */
  family: string;
  note: string;
};

const ARK_PLAZA_BASE = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * Bedrock 那两个口。区域拼进域名，所以换区域是换地址，不是加一个参数 —— 两个口共用
 * 网宿那条只有**一个**地址：Claude 和 GPT 都走同一个 OpenAI 兼容口
 * （`POST {base}/chat/completions`）。这一点和从前的 Bedrock 不同 —— 那边要两个地址
 * 变量，共用一个会把 Claude 那条拼成 404，而 404 看起来像模型 id 写错了。
 */

/** 网宿 AI Gateway 的兼容口。整条地址可由 `WANGSU_BASE_URL` 覆盖。 */
const WANGSU_GATEWAY_BASE = "https://api.edgecloudapp.com/v2/llm";

const trimSlash = (s: string) => s.replace(/\/+$/, "");


/** 部署期才知道账号里开通的到底叫什么名字，所以留一道环境变量覆盖。 */
const idOverride = (env: string, fallback: string): string =>
  (process.env[env] ?? "").trim() || fallback;

const SPECS: Record<ModelAlias, ModelSpec> = {
  "deepseek-pro": {
    alias: "deepseek-pro",
    display: "DeepSeek V4 Pro",
    short: "V4",
    providerModelId: "deepseek-v4-pro",
    idEnv: "ARK_MODEL_DEEPSEEK_PRO",
    keyEnv: "ARK_API_KEY",
    provider: "ark",
    contextTokens: 128_000,
    // 方舟这个口没有公开的单次输出上限。16384 是保守值，理由见 `maxOutput`。
    maxOutput: 16_384,
    acceptsEffort: false,
    sampling: true,
    acceptsVerbosity: false,
    family: "deepseek",
    note: "国内直连，成本低，主力出文",
  },
  "deepseek-flash": {
    alias: "deepseek-flash",
    display: "DeepSeek V4 Flash",
    short: "V4 Flash",
    providerModelId: "deepseek-v4-flash",
    idEnv: "ARK_MODEL_DEEPSEEK_FLASH",
    keyEnv: "ARK_API_KEY",
    provider: "ark",
    contextTokens: 128_000,
    maxOutput: 16_384,
    acceptsEffort: false,
    sampling: true,
    acceptsVerbosity: false,
    family: "deepseek",
    note: "最快最便宜，短活与选路用",
  },
  "claude-opus-5": {
    alias: "claude-opus-5",
    display: "Claude Opus 5 (网宿)",
    /*
     * 页签上写的是「Claude」而不是这两个字：那一排页签（DeepSeek / Claude / ChatGPT）是给
     * 一号位认链路的，认的是家名，不是版本号。这里仍然记短名 —— 台账、运行记录、报告页头
     * 那行元数据要说得出这一份到底是哪个模型写的。
     */
    short: "Opus 5",
    /*
     * 必须是 `us.` 那个推理配置（inference profile）。基础模型 id（`anthropic.claude-opus-5`）
     * 在这个账号上是 INFERENCE_PROFILE-only，直接发回 400，原话点名了补救办法：
     * 「Retry your request with the ID or ARN of an inference profile that contains this model」。
     * `global.` 前缀那个也在账号里列着（没实测），要换就走 `WANGSU_MODEL_OPUS5`。
     */
    providerModelId: "claude-opus-5",
    idEnv: "WANGSU_MODEL_OPUS5",
    keyEnv: "WANGSU_API_KEY",
    provider: "wangsu",
    contextTokens: 1_000_000,
    // Anthropic 这一代实测能写到几万 token，但没有可查的硬上限。32768 是保守值。
    maxOutput: 32_768,
    /*
     * 网宿这条口只认 OpenAI 的标准字段（`model` / `messages` / `max_tokens` / `stream` /
     * `temperature`）。`reasoning_effort` 与 `verbosity` 是各家自己的扩展，它没说支持 ——
     * 而这个口对不认的字段是 400，**一发就是整条链路挂掉**。所以两个都关。
     *
     * 关掉的代价是这一条不能再按「这一轮还剩多少时间」调思考深度。等网宿那边确认支持
     * 之后再打开，届时要一并回答「字段名是哪一套方言」（见文件头 `acceptsEffort`）。
     */
    acceptsEffort: false,
    /* 网宿文档写着 temperature 支持，但 Claude 这一代原厂对它是 400。上游怎么归一化
       不确定，所以**不发** —— 少发一个字段不会让报告变差，发错一个会让整条链路挂掉。 */
    sampling: false,
    acceptsVerbosity: false,
    family: "claude",
    note: "深研第二条链路（走网宿）：自己编命题、自己联网取证、自己写报告；与另外两条互不同家族",
  },
  "gpt-5.6": {
    alias: "gpt-5.6",
    display: "GPT-5.6 (网宿)",
    /*
     * 页签上写的是「ChatGPT」而不是这两个字：那一排页签（DeepSeek / Claude / ChatGPT）是给
     * 一号位认链路的，认的是他自己也在用的那几个名字，不是版本号。这里仍然记短名 —— 台账、
     * 运行记录、报告页头那行元数据要说得出这一份到底是哪个模型写的。
     */
    short: "GPT-5.6",
    /*
     * 默认走 `us.` 那个推理配置（inference profile）。基础模型 id（不带前缀的
     * `openai.gpt-5.6-sol`）在这个账号上是 INFERENCE_PROFILE-only，直接发会 404；
     * `global.` 前缀那三个实测也通，要换就走 `WANGSU_MODEL_GPT56`。
     *
     * 三档（sol / terra / luna）实测都答得出中文推理题，没有公开的档位排序，所以
     * 默认取 sol，不在代码里替他选一档「最强的」。
     */
    providerModelId: "gpt-5.6-sol",
    idEnv: "WANGSU_MODEL_GPT56",
    keyEnv: "WANGSU_API_KEY",
    provider: "wangsu",
    contextTokens: 400_000,
    // 没有可查的公开数字。32768 是保守值，理由见 `maxOutput`。
    maxOutput: 32_768,
    /* 同 Claude 那一条：网宿只认 OpenAI 标准字段，扩展字段一律不发。 */
    acceptsEffort: false,
    sampling: false,
    /* `verbosity` 是 GPT-5.x 自己的字段，网宿没说它认。理由同上：不发。 */
    acceptsVerbosity: false,
    family: "gpt",
    note: "深研第三条链路（走网宿），也是判断板的主源：自己编命题、自己联网取证、自己写报告",
  },
};

/**
 * 每个别名的静态事实（家族、走哪把 key、哪套方言、吃不吃 effort）。
 *
 * `providerModelId` 在这张表上是**默认值**；要真正发出去的那个，走 `getModel()`
 * —— 只有它会读 `idEnv` 覆盖。
 */
export const MODELS: Record<ModelAlias, ModelSpec> = SPECS;

export function getModel(alias: string): ModelSpec {
  const spec = (SPECS as Record<string, ModelSpec>)[alias];
  // 报出可选项：返回 undefined 会让调用方炸在几层之外，现场看不出是别名写错了。
  if (!spec) throw new Error(`未知模型 ${alias}；可选：${Object.keys(SPECS).join(", ")}`);
  return { ...spec, providerModelId: idOverride(spec.idEnv, spec.providerModelId) };
}

export function modelCatalog(): ModelSpec[] {
  return Object.keys(SPECS).map(getModel);
}

/**
 * 这个模型这一次最多能输出多少 token。
 *
 * `TKOS_MAX_OUTPUT_TOKENS` 一个数管全部模型 —— **在取用时读**，改了不用重启。它是给
 * 「表上那个保守值卡住了出稿」这一种现场用的：量出真上限之后配上去，不必为此发一版。
 * 配了个不合法的值（非数、零、负数）当没配，不抛 —— 一个笔误让每条链路一起挂掉，代价
 * 比按表上的保守值跑一轮大得多。
 */
export function maxOutputFor(spec: { maxOutput: number }): number {
  const raw = Number((process.env.TKOS_MAX_OUTPUT_TOKENS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : spec.maxOutput;
}

export function arkKey(keyEnv: KeyEnv): string {
  // 只负责取，不做「取不到就换另一把」这种兜底：拿错 key 的表现是 401 或额度
  // 记到别的账上，静默替换只会把问题藏起来。
  return (process.env[keyEnv] ?? "").trim();
}

/**
 * 这个模型的出网地址。**方言、地址、key 三件事由 `provider` 一起决定**，调用方不许
 * 自己拼 —— 这一条正是文件头那句「地址跟着 key 走」的落点。
 */
export function baseUrlFor(spec: ModelSpec): string {
  if (spec.provider === "wangsu") return wangsuBase();
  return arkBase();
}

/**
 * 网宿 AI Gateway。**一条地址、一把 key 撑深研的两条链路**（`alt` 与 `synth`）。
 *
 * 它是 OpenAI 兼容协议：Claude 和 GPT 都走 `POST {base}/chat/completions`、`Bearer` 认证、
 * 标准 `max_tokens`。所以这里只有一个地址函数 —— 不像 Bedrock 那样要分两个（那边 Claude 走
 * Anthropic 原生口、GPT 走兼容口，共用一个覆盖变量会把 Claude 那条打歪成 404）。
 *
 * ## 为什么从 Bedrock 换过来
 *
 * 2026-09-01 实测：生产在火山引擎的境内 IP 上，Bedrock **网络是通的**（TLS 0.78 秒握完、
 * 证书校验过），但 Anthropic 与 OpenAI 在**模型层按来源国拒绝**：
 *
 *     400 Access to Anthropic models is not allowed from unsupported countries…
 *     400 Access to OpenAI models is not allowed from unsupported countries…
 *
 * 换 key、换区域、换地址都不解决 —— 那是模型服务商的策略，不是链路问题。网宿是境内可达的
 * 网关，同样供这两个家族，所以「四条链路互不同家族」这条设计前提保住了（理由见文件头）。
 */
export function wangsuBase(): string {
  return trimSlash((process.env.WANGSU_BASE_URL ?? "").trim() || WANGSU_GATEWAY_BASE);
}



/** 方舟模型广场。整条地址可由 `ARK_BASE_URL` 覆盖（部署期可能有代理路径）。 */
export function arkBase(): string {
  return trimSlash((process.env.ARK_BASE_URL ?? "").trim() || ARK_PLAZA_BASE);
}
