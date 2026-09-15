/**
 * 对齐自 tkos-lab/src/tkos_lab/models/{base,volcengine}.py
 *
 * 所有模型调用的唯一出口。**两套协议**：方舟和 Bedrock 那个兼容口都是 OpenAI 兼容协议
 * （下面那段 fetch，两家的方言差异在那里分支），Bedrock 上的 Claude 是
 * Anthropic Messages（`callClaudeOnBedrock`）。
 * 分在两处而不是拼一个通用 body：那两套的请求体、应答体、字段名没有一处对得上，
 * 硬拼出来的「通用」只会让每一次加字段都要同时想两套语义。
 *
 * **每次调用都必须带回 token 计量。** 四个字段归一：新鲜输入、输出、命中提示
 * 缓存的输入、推理 token。少了 cached 那一项，账单对不上而看不出为什么；少了
 * reasoning 那一项，思考型模型的「为什么这么慢这么贵」就没有现场。
 *
 * `stopReason` 也是归一过的：上层只认 OpenAI 那套词（`json.ts` 拿 `"length"` 判截断），
 * 所以 Anthropic 那边的 `max_tokens` / `end_turn` 在这一层就翻过来。**不翻的代价是
 * 截断检测静默失效** —— 表现是一个看不懂的 SyntaxError，而不是「输出被截断」。
 */
import { acquire, coolDown, retryAfterMs } from "./gate";
import { mockText, modelMockOn } from "./mock";
import { getModel, outletOf, type ModelAlias } from "./registry";
import { SLOT_ALIAS, resolveModel, type ModelConfig, type Slot } from "./slots";

/** 官方 effort 词表，五档，英文原词照发。 */
import { costTapPath, tapModelCall } from "./cost-tap";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 一条消息的内容。**给成几块只为一件事：打缓存断点。**
 *
 * 标了 `cache` 的那一块，连同它前面的所有东西（system、更早的消息）会被服务端存下来；
 * 下一次前缀**逐字节相同**的调用只按「读缓存」计价。所以断点必须打在「这一轮里再也不会变
 * 的那一段」的末尾 —— 打在会变的那一段后面等于每次都写一份新缓存，比不缓存还贵。
 *
 * 只有 Anthropic 那个口认这件事（`cache_control`）。别的口把几块拼成一段发出去，
 * 行为和从前一模一样 —— 所以调用处可以无条件给块，不用问「这次落在哪个槽位」。
 */
export type ContentPart = { text: string; cache?: boolean };
export type MsgContent = string | ContentPart[];
export type WireMsg = { role: string; content: MsgContent };

/** 拼回一整段。发给不认缓存断点的那几个口，以及要按字数估算的地方。 */
export const flattenContent = (c: MsgContent): string =>
  typeof c === "string" ? c : c.map((x) => x.text).join("\n\n");

/**
 * 这个口认不认缓存断点。
 *
 * **网宿的兼容口是认的 —— 2026-09-01 实测三态确认**（同一段 9 千 token 的前缀）：
 *
 *   带断点、前缀第一次    `creation_tokens: 9092`、`ephemeral_5m_input_tokens: 9092`  ← 写进去了
 *   带断点、前缀第二次    `cached_tokens: 9092`                                       ← 读到了
 *   不带断点、同一前缀    `cached_tokens: 0`                                          ← 确认它是显式的
 *
 * 也就是说**这条口没有自动前缀缓存**：逐字节相同的重复调用和改过前缀的调用耗时一样
 * （5.5s / 6.7s vs 5.7s）。断点不发，那 8 万 token 的材料每次都按全价重算 —— 2026-08-31
 * 换网宿之后到今天，一直是这个状态，而屏幕上唯一的痕迹是账里 `cachedInputTokens` 恒为 0。
 *
 * **有效期只有五分钟。** `cache_control` 里递 `ttl: "1h"` 不报错，但实测被静默降级
 * （回来仍是 `ephemeral_5m_input_tokens`）。所以「先写后读」这两次之间隔了多久是要算的事，
 * 见 `stage-write.ts` 里暖缓存那一段。
 *
 * 只给 Anthropic 那一族发。`cache_control` 是 Anthropic 的内容块字段，OpenAI 那族
 * （`gpt-5.6-sol`）和方舟收到不认识的字段是 **400，不是忽略** —— 这条口上多发一个字段的
 * 代价是整次调用失败，所以宁可漏发不可错发。
 *
 * **家族那一半判的是 `"claude"`，不是 `"anthropic"`。** 后者是出口的名字（从前 Bedrock 上
 * 那条原生口的 `provider`），这里要的是模型自己的家族 —— `registry.ts` 上写的、`familyOf`
 * 猜的，两处都是 `"claude"`。写成 `"anthropic"` 时这个函数恒为 false，于是断点一个都发不
 * 出去，而**任何一处都不会红**：请求体照旧合法、调用照旧成功、报告照旧写完，唯一的痕迹是
 * 账里 `cachedInputTokens` 恒为 0。上一版就是这么静默地空转了一整天。
 */
const takesCacheBreakpoints = (cfg: ModelConfig): boolean =>
  cfg.provider === "wangsu" && cfg.family === "claude";

/**
 * Anthropic 一次最多认四个断点，多出来的是 400。真打到第五个说明该合并了（断点越多缓存
 * 越碎、命中率越低），所以这里静默截到前四个而不是抛 —— 断点是优化，不该因为多打了一个
 * 就让这一次调用失败。
 */
const MAX_BREAKPOINTS = 4;

/**
 * 拼成发给服务端的那一份。**认断点的口发内容块，不认的照旧拼成一整段。**
 *
 * 这条消息没打过断点时也走拼接那一支 —— 形状与从前逐字节相同。请求体不变既是缓存命中的
 * 前提，也是不给别的口带来任何风险的前提。
 */
const wireContent = (cfg: ModelConfig, c: MsgContent): unknown => {
  if (typeof c === "string" || !takesCacheBreakpoints(cfg)) return flattenContent(c);
  if (!c.some((x) => x.cache)) return flattenContent(c);
  let left = MAX_BREAKPOINTS;
  return c.map((x) => {
    const mark = Boolean(x.cache) && left > 0;
    if (mark) left -= 1;
    return {
      type: "text",
      text: x.text,
      ...(mark ? { cache_control: { type: "ephemeral" } } : {}),
    };
  });
};


export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

/** 未配置或调用失败。由上层记为该步失败，**不静默降级**。 */
export class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailable";
  }
}

export type CallResult = {
  text: string;
  usage: Usage;
  ms: number;
  slot: Slot | null;
  alias: string;
  providerModelId: string;
  /** 实际发出去的档位。**空 = 该模型不吃这个字段，不是「没选」。** */
  effortSent: Effort | null;
  stopReason: string;
  /**
   * 在出口限速器里排了多久（毫秒）。**和 `ms` 分开记，不许并进去。**
   *
   * 并进去的话，限速器一生效，trace 上每一条都会变慢，而读的人只能读成「这个模型今天慢」——
   * 于是去查出口、去调超时，查的是一件没发生的事。分开记之后，「这一轮为什么久」有两个数
   * 各答一半：`ms` 是模型真的想了多久，这个是它在门口等了多久。
   *
   * 429 退避后重发那一次的等待也算在这里（那也是等一个位子，不是模型在想）。
   */
  queuedMs: number;
};

/**
 * 一次调用最多等多久。思考型模型单次跑三分钟是常态，所以这个数不能小。
 *
 * 导出是给 `harness.ts` 用的：它按「这一轮还剩多少时间」压这个数（`timeoutMs`），
 * 而压之前得知道原本的上限是多少 —— 两处各写一个 180 秒，改一处就会漂。
 */
export const MODEL_TIMEOUT_MS = 180_000;

/**
 * 连不上的时候重发几次。**只补传输层，不补内容。**
 *
 * 2026-08-31 算账那一轮撞上的：Bedrock 上的 Claude 两次没连上（`Connection error.`
 * 1.1 秒就回来、`Request timed out.` 10.7 秒回来，而那一次的预算是 180 秒），于是 N1
 * 草稿整份没了。代价不是「少一次调用」—— 后面每一步都建立在草稿上：没有骨架就抽不出
 * 命题，抽不出命题 N3 取证整段跳过，而这一轮照旧出稿、照旧报 ok、照旧把后面那十几次
 * 调用的钱花完（那一轮 Opus 一家 $0.9）。**一次 1.1 秒的网络抖动废掉一轮几块钱的深研，
 * 而屏幕上看不出来。**
 *
 * 客户端那一层原来写着 `maxRetries: 0`，理由是「重试是 agent 的事，只有它知道这次为
 * 什么不合格」。那句话对**内容**成立，对**传输**不成立：连接压根没建起来时，agent 既
 * 不知道发生了什么（它只收到一个异常），也没有重发的路 —— `refineOnce` 重的是「交回来
 * 的东西不合格」，异常那一支直接记一条缺口走人。
 *
 * 所以这里补的正是那条缝，而且只补那条缝：
 *
 *   · **只认传输错**（连不上 / 建连超时）。4xx、模型拒答、内容不合格一律不重发 ——
 *     那些重发一次得到的是同一个答案，只是多付一次钱。
 *   · **只在它死得够早的时候重发**（用掉的预算不到 `EARLY_FAIL_RATIO`）。死在 170/180
 *     秒的那一次，服务端很可能已经在生成了，重发是双倍账单加双倍墙钟。
 *   · **墙上那道闸不重置**（`wall` 定时器在循环外面），所以重试再多也不会把这一次撑过
 *     它该占的时间。
 */
/** 最多重发几次。 */
const TRANSPORT_RETRIES = 2;
/** 每次重发前等多久。短，因为这一档失败通常是瞬时的。 */
const RETRY_BACKOFF_MS = [800, 2_400];
/** 「死得够早」的界：用掉的预算不到这个比例才重发。 */
const EARLY_FAIL_RATIO = 0.35;

/**
 * 这个异常是不是「请求根本没走通」。
 *
 * 按 message 认而不是按类名：这一支的错误来自 `@anthropic-ai/bedrock-sdk`，它把
 * `APIConnectionError` / `APIConnectionTimeoutError` 抛出来时 `name` 都是 `Error`
 * （实测两次都是），只有 message 分得开。
 */
export const isTransportFailure = (e: unknown): boolean => {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes("connection error") ||
    m.includes("request timed out") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("socket hang up") ||
    m.includes("fetch failed") ||
    m.includes("terminated")
  );
};

/**
 * 一次调用至少等这么久才算「等过了」。
 *
 * 上面那个数能被调用方压小（一轮深研有 20 分钟的总上限，见 `a4/deadline.ts`），而压小
 * 到两秒的话每一次调用都是超时 —— 那不是「按时收口」，是把一轮跑成一串超时异常。
 * 真要那么紧，该做的是这一步根本不发（`room()` 判的就是这个），不是发一个必死的请求。
 */
const MIN_TIMEOUT_MS = 5_000;

/**
 * **一次调用至少要有这么多余量才值得发。** 判它的是调用方（谁在管总时间谁判），住在这里
 * 是因为它和上面那两个数是同一件事的三档，分家会漂。
 *
 * 剩 8 秒时发一次 16k 的出稿调用，结果是等 8 秒、拿一个超时异常、把这一步记成「没跑成」——
 * 花掉的是真钱和真时间，换回来的是一条更难读的缺口（「调用超时」而不是「时间到了没开始」）。
 */
export const CALL_FLOOR_MS = 20_000;

/**
 * **首包慢的出口另有一道更高的下限。** 2026-09-04 加。
 *
 * 20 秒这个数对方舟和网宿 gpt-5.6 成立（首包 1–2 秒），对网宿 claude-opus-5 不成立：
 * 那条出口首包实测约 80 秒（`.workbuddy/memory/2026-09-01.md`）。ISS-223 那一轮收口时剩
 * 60 秒，按 20 秒的下限判「值得发」，发出去之后在 60 秒上超时 —— 花了一次等待，换回来的
 * 是一份没有标题和最终判断的报告。剩 60 秒时对这条出口正确的动作是不发。
 *
 * 只按槽位判，不探测出口：这个数的用途是「发不发」，探测本身就要花一次往返。
 */
export const SLOW_FIRST_TOKEN_FLOOR_MS = 120_000;

/** 这一次调用至少要剩多少余量才值得发。`alt`（claude-opus-5）走高的那一档。 */
export const callFloorMs = (slot: string | undefined): number =>
  slot === "alt" ? SLOW_FIRST_TOKEN_FLOOR_MS : CALL_FLOOR_MS;

/**
 * **流式那一支的墙上上限，和上面那个 180 秒是两个数。**
 *
 * 为什么要分开：`MODEL_TIMEOUT_MS` 在 2026-08-30 之前**从来没有真正约束过流式调用** ——
 * SDK 的 timeout 拿到响应头就被清掉了（见 `callClaudeOnBedrock` 里那段），
 * 所以流式那一支实际上是没有上限的。把它掐上之后，180 秒第一次生效，
 * 而这个数对**出稿那几步**明显偏小。
 *
 * 实测（另一条会话 2026-08-29/30 两轮真跑，14 次流式调用）：出稿步骤单次
 * 160–330 秒是常态（出 token 速度 38–50 tok/s，一次 `SECTION_MAX_TOKENS`
 * 规模的生成本来就要这么久）。其中一次 **292 秒是成功的** ——
 * 首字节 44.7 秒、交付 126KB、全程有数据在流。**按 180 秒掐，那次成功会变成失败，
 * 代价是报告丢掉收口那一节。**
 *
 * **这批数今天已经复现不了了**：产生它的那把临时 key 2026-08-30 当天过期，
 * 原始存档在另一条会话的临时目录里、不在仓库中。所以下面这两个数
 * （连同 `STREAM_IDLE_MS` / `STREAM_FIRST_BYTE_MS`）是**一次性样本上定出来的**，
 * 不是持续测出来的。
 *
 * 这不是要你不信它 —— 一次真跑的分布远好过零个样本，而且正是它拦下了「按 180 秒掐、
 * 把那次 292 秒的成功掐死」那一版。但下一个人要动这三个数时该知道：
 * **重新量一遍需要先拿到一把能跑通那条链路的 key**，光读代码推不出新值来。
 *
 * 所以这一档给到 420 秒：覆盖实测最长那次（292s）还留出一倍余量，
 * 同时仍然是个有限的数 —— 上层那套预算（`a4/deadline.ts`）照旧会按「这一轮还剩多少」
 * 把它压小，压小那条路一个字没改。
 *
 * **它不是用来兜住挂死的**：挂死交给下面那个空闲看门狗，那个精确得多。
 */
export const STREAM_TIMEOUT_MS = 420_000;

/**
 * 空闲看门狗：**多久没有新分片就判它挂了。**
 *
 * 墙上超时分不出两种东西 —— 流了 292 秒一直在吐字（该让它跑完）和流了 17 分钟
 * 一个字节没有（该立刻掐）。看门狗只认后者。
 *
 * 60 秒这个数有实测依据（同一批 14 次调用，两次分片之间的间隔）：
 *
 *   Anthropic 口   p95 0.9s   最大 1.07s
 *   兼容口         p95 0.5s   最大 9.47s   ← 中间真停过 9.5 秒
 *   那次挂死                  静默 1,018,957ms
 *
 * 正常与故障之间隔着三个数量级。取 60 秒是实测最大正常间隔的 6 倍多、
 * 离挂死那个数还差 17 倍 —— **要误杀一次正常调用，得让它比史上最慢的一次停顿再慢 6 倍。**
 *
 * 首字节单独放宽：实测最长的一次首字节是 44.7 秒（正是那次 292 秒的调用），
 * 拿 60 秒去卡首字节会误杀。
 */
/** 掐断原因的内部标记。只用来在 catch 里分辨是哪一道闸动的手，不上屏。 */


/**
 * 慢模型的墙上上限。
 *
 * 2026-09-01 实测网宿上的 `claude-opus-5`：**一个只回 300 token 的小问题要 67 秒**
 * （同一个前缀第二次 8.5 秒，上游像是在缓存，但它的 `cached_tokens` 一直报 0）。而深研
 * 真正写字那几步一次要生成几千 token —— 180 秒的上限会把它们成片掐掉，**而掐出来的失败
 * 长得像「模型没答上来」**，不像「等的时间不够」。
 *
 * 从前这条链路走 Anthropic 原生口的**流式**，墙是 420 秒（`STREAM_TIMEOUT_MS` 那一段
 * 写着理由）。换成网宿的 OpenAI 兼容口之后这一支是非流式的，所以那个数得在这里接住。
 *
 * **真正的修法是给兼容口也接上流式**（网宿支持 `stream: true`）：那样既有 420 秒的墙，
 * 又有空闲看门狗能分辨「它在吐字」和「它挂住了」。这一条是欠账，记在这儿。
 */
export const SLOW_CALL_TIMEOUT_MS = 420_000;

/**
 * 方舟那一档的墙上上限。**它存在只为一件事：把 `COST.plan` 那 200 秒真的兑现出去。**
 *
 * `a4/deadline.ts` 给 N2 检索计划留的位置是 200 秒（那张表上第二大的一项，理由写在它旁边：
 * 这一步一挂，N3 整段空转，交出来是一份没有任何外部证据的报告）。而 `timeoutFor` 只会往下
 * 压不会往上放 —— 天花板是 180 秒的时候，那 200 秒的预算**这一步永远用不满**，多出来的
 * 20 秒是一句上层说了、下层兑现不了的话。
 *
 * 2026-09-01 两轮真跑正好把这条缝的两面都撞了一遍：一轮 **180.0 秒整**超时（→ 零条命题 →
 * 取证整段跳过 → 零证据），另一轮 77.6 秒侥幸过。整秒那个数就是天花板留下的指纹 ——
 * 不是模型答不上来，是没让它答完。
 *
 * 300 秒：兑现那 200 秒还留一半余量，同时仍然是个有限的数。上层那套预算照旧按「这一轮还
 * 剩多少」把它压小，压小那条路一个字没改。
 *
 * **不动 `MODEL_TIMEOUT_MS`**：那个数还被流式那一档（`streamWallFor`）当基准读，抬它等于
 * 顺手把另一件没量过的事也改了。DeepSeek 官方直连那条回落不吃这一档 —— 它只在方舟那把 key
 * 缺了时才走，那时候该先补 key，不是先放宽超时。
 */
export const ARK_CALL_TIMEOUT_MS = 300_000;

/**
 * 长生成要自带 dispatcher，否则上面那个 420 秒是一句 Node 兑现不了的话。
 *
 * **undici 的 `headersTimeout` 默认 300 秒**（`lib/dispatcher/client.js`：
 * `headersTimeout != null ? headersTimeout : 300e3`），而**非流式**的补全，响应头是
 * 整段写完才发的 —— 也就是说这条口上任何一次超过 300 秒的生成，都会在 300 秒被
 * Node 自己掐掉，抛出来的是一个不带任何线索的 `TypeError: fetch failed`。
 *
 * 这不是推测：`RUN-A4-mtievtms-2`（ISS-225）的 `a4.layer.section(S1)` 死在 **308.0 秒**
 * —— 300 秒加上建连和排队。那一次把「分层成稿」打成 0/6 节，前面十几分钟取回来的证据
 * 一条都没写进正文，而这一轮照旧 `status=ok`。
 *
 * 最坏的地方是它**长得像网络故障**：`AbortSignal.timeout` 那道闸（420 秒）还没到，
 * 所以错误里不会说「超时」，只说「失败」，读的人第一反应是去查网宿。
 *
 * `bodyTimeout` 一起放开：换了流式之后它管的是「两块之间隔多久」，那时候该由看门狗
 * 来判，不该由一个和总时长同量级的数来判。墙上那道闸仍然是 `AbortSignal.timeout`，
 * 所以放开这两个数不会让任何一次调用超出它该占的时间。
 */
const slowDispatcher: Dispatcher = new Agent({
  headersTimeout: SLOW_CALL_TIMEOUT_MS,
  bodyTimeout: SLOW_CALL_TIMEOUT_MS,
});

/*
 * **必须连 `fetch` 一起换成 undici 的，不能只递 `dispatcher` 给全局 `fetch`。**
 *
 * Node 内置的 `fetch` 用的是它**自己捆进去的那一份** undici，和 `node_modules` 里
 * 这一份不是同一个实现。把这一份造的 `Agent` 递给它，第一次调用就是
 * `InvalidArgumentError · UND_ERR_INVALID_ARG · invalid onRequestStart method` ——
 * 两份 undici 的内部接口版本对不上。2026-09-01 实测：整轮 12 次调用全在 3.2 秒失败。
 *
 * 顺带的一个好处：这条路绕开了 Next 对全局 `fetch` 的那层缓存包装。模型调用本来就
 * 不该被那一层碰。
 */
const httpFetch = undiciFetch;

/** 把 `fetch` 藏在 `cause` 里的真实原因摊出来。见下面那处调用点的注释。 */
const causeLine = (e: unknown): string => {
  const c = (e as { cause?: unknown } | null)?.cause;
  if (!c) return "";
  const name = c instanceof Error ? c.name : "";
  const msg = c instanceof Error ? c.message : String(c);
  const code = (c as { code?: string })?.code;
  const said = [name, code, msg].filter(Boolean).join(" · ").slice(0, 200);
  return said ? ` — 底层：${said}` : "";
};

/** 这个口最长能等多久。慢的那两家各一档，理由见上面那两段。 */
const ceilingFor = (cfg: ModelConfig): number => {
  if (cfg.provider === "wangsu") return SLOW_CALL_TIMEOUT_MS;
  if (cfg.provider === "ark") return ARK_CALL_TIMEOUT_MS;
  return MODEL_TIMEOUT_MS;
};

/**
 * 调用方报的墙上时间上限压进 `[5s, ceiling]`。不给就是这个口的上限。
 *
 * **天花板是传进来的，不是写死的** —— 上层（`a4/deadline.ts`）按「这一轮还剩多少时间」
 * 压这个数，压的结果永远不该超过它自己给的余量；而余量之内该等多久，由这个口的实测
 * 速度说了算。
 */
const timeoutFor = (want: number | undefined, ceiling = MODEL_TIMEOUT_MS): number =>
  want === undefined || !Number.isFinite(want)
    ? ceiling
    : Math.min(ceiling, Math.max(MIN_TIMEOUT_MS, Math.round(want)));

/**
 * 流式那一支的墙上上限。形状和 `timeoutFor` 一样，只是天花板换成 `STREAM_TIMEOUT_MS`。
 *
 * **必须读没被压过的那个数。** 第一版是拿 `timeoutFor` 的结果去比 `MODEL_TIMEOUT_MS`
 * 的（`timeoutMs < MODEL_TIMEOUT_MS ? timeoutMs : STREAM_TIMEOUT_MS`），而那个结果
 * 早就被压进 ≤180s 了 —— 比较的另一半永远够不着，于是：
 *
 *   上层剩 120s → 120s   对
 *   上层剩 250s → **420s**   **错：整轮预算被超掉 170 秒**
 *   上层没给   → 420s   对
 *
 * 坏的是中间那一段（180s < 剩余 < 420s），而那正好是一轮跑到后半程、
 * `room()` 刚好还肯放行的那一段。`a4/deadline.ts` 那套编排的前提是
 * 「单次调用不会超过上层给的余量」，那一版在这段区间上把这个前提悄悄破了 ——
 * 破的方式是超时不是报错，屏幕上看着就是「这一轮又超了」。
 */
export const streamWallFor = (want: number | undefined): number =>
  want === undefined || !Number.isFinite(want)
    ? STREAM_TIMEOUT_MS
    : Math.min(STREAM_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(want)));

/**
 * 「等了多久」那半句话。**被压过的要说出来**：等了 40 秒就超时和等满这个口的天花板才超时，
 * 该去查的东西不一样（前者是这一轮时间快用完了，后者是这次调用真的卡住了）。
 * 不写的话结果页上两者长得一模一样，而运营台会按后者去查出口。
 *
 * **拿来比的必须是这个口自己那一档天花板**（`ceilingFor`），不能写死 180 秒。天花板分了
 * 三档之后（网宿 420、方舟 300、其余 180），写死的那一版会在方舟上说出「从 180s 压到了
 * 300s」这种自相矛盾的话，在网宿上则把「从 420 压到 300」的那一次说成没被压过 ——
 * 而这句话是结果页上唯一的现场，它说错的时候没有第二处能对。
 */
const waitedLine = (timeoutMs: number, ceiling: number): string =>
  timeoutMs < ceiling
    ? `等了 ${Math.round(timeoutMs / 1000)}s 没等到回复（这一轮剩下的时间把这一次的等待从 ` +
      `${Math.round(ceiling / 1000)}s 压到了这个数）。`
    : `等了 ${Math.round(timeoutMs / 1000)}s 没等到回复。思考型模型这一次可能想得特别久。`;

/**
 * 出错时报的是**哪个出口**，不是哪家的模型：拿到这句话的人要去查的是那个口的
 * key、地址、开通状态。几个出口的错法完全不一样，混成一句「模型调用失败」等于要人
 * 自己拿 curl 再打一遍。
 *
 * Bedrock 上那两个分开说：同一把 key、同一个域名，但**路径和协议是两套**，所以
 * 「Bedrock 调用失败」这一句在两条链路上要去查的东西不一样。
 */
function exitLabel(cfg: ModelConfig): string {
  switch (cfg.provider) {
    case "wangsu":
      return "网宿网关";
    case "deepseek":
      return "DeepSeek 直连";
    default:
      return "火山方舟";
  }
}

/**
 * 一次模型调用。**外面这一层只做一件事：把这一次的账记下来**（见 `cost-tap.ts`）。
 *
 * 套在这里而不是套在 `Harness` 上，是因为 `Harness` 只覆盖走 harness 的那几条链路 ——
 * 定题（A2）走的是 `callJson`，它的用量原来当场就丢了。这一层是所有非流式调用的唯一
 * 出口，套在它外面才数得全。关着的时候（没配 `TKOS_COST_TAP`）这一层就是一次读环境
 * 变量加一次转发。
 */
export async function callModel(
  opts: Parameters<typeof callModelInner>[0],
): Promise<CallResult> {
  if (!costTapPath()) return callModelInner(opts);
  const t0 = Date.now();
  try {
    const r = await callModelInner(opts);
    tapModelCall({
      hint: opts.hint ?? "",
      slot: r.slot,
      alias: r.alias,
      model: r.providerModelId,
      ...r.usage,
      ms: r.ms,
      ok: true,
    });
    return r;
  } catch (e) {
    tapModelCall({
      hint: opts.hint ?? "",
      slot: opts.slot ?? null,
      alias: opts.alias ?? "",
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      ms: Date.now() - t0,
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    throw e;
  }
}

async function callModelInner(opts: {
  slot?: Slot;
  alias?: ModelAlias;
  messages: WireMsg[];
  maxTokens?: number;
  temperature?: number;
  effort?: Effort;
  /**
   * 话说到多细（GPT-5.x 那个 `verbosity`）。**只有出稿那几次给 `high`**，不是全局默认 ——
   * 抽命题、抽证据那几次要的是一份紧凑的 JSON，让它把话说细只会多花钱。
   *
   * 只发给认这个字段的模型（`cfg.acceptsVerbosity`），并且可以由
   * `TKOS_MODEL_NO_VERBOSITY=1` 全局关掉。
   */
  verbosity?: "low" | "medium" | "high";
  json?: boolean;
  /** 这次调用是给哪个 prompt 用的。**不进请求体** —— 只给假模型分派罐头用。 */
  hint?: string;
  /**
   * 这一次最多等多久（毫秒）。不给就是 `MODEL_TIMEOUT_MS`。
   *
   * 由 harness 按「这一轮还剩多少时间」算出来（见 `a4/deadline.ts`）：一轮深研有 20 分钟
   * 的总上限，而一次调用等三分钟这件事本身就能把最后那点余量吃光 —— 那时候超时的不该是
   * 「这一次」，该是「这一次少等一会儿，好让收口那一次发得出去」。
   *
   * 压进 `[5s, 这个口自己那一档天花板]`，见 `timeoutFor` 与 `ceilingFor`。
   */
  timeoutMs?: number;
}): Promise<CallResult> {
  /*
   * 假模型先判，在解析槽位之前 —— mock 的用途之一就是在一把 key 都没配的机器上
   * 把那几条链路走通。放到 configFor 之后会先抛「没有可用的槽位」。
   */
  if (modelMockOn()) {
    return {
      // 递消息进去：区块那一支的罐头要对着这一轮真跑出来的证据编号交账。
      text: mockText(
        opts.hint,
        opts.messages.map((m) => ({
          role: m.role,
          content: flattenContent(m.content),
        })),
      ),
      usage: emptyUsage(),
      ms: 0,
      slot: opts.slot ?? null,
      alias: "mock",
      providerModelId: "mock",
      effortSent: null,
      stopReason: "stop",
      // 假模型不出网，也就不占任何出口的位子 —— 排队从来是 0，不是「没测到」。
      queuedMs: 0,
    };
  }

  const cfg = configFor(opts);
  /*
   * 调用方报的额度是**需求**，这里压成那个模型接得住的数（`cfg.maxOutput`，已经算过
   * `TKOS_MAX_OUTPUT_TOKENS` 覆盖）。分节出稿那一支按「一节要写多少」报额度
   * （`a4/run.ts` 的 `SECTION_MAX_TOKENS`），而那个数比几个口各自的上限都可能大 ——
   * 超上限在方舟和 Bedrock 上是 400，那一条链路整条挂掉。
   *
   * 压完仍然写不下的那一次由续写接上（`agent/json.ts` 的 `jsonlContinue`），所以压这一下
   * 不会让报告变短，只会多一次调用。**不在这里报警**：压到是常态，不是异常。
   */
  const maxTokens = Math.min(opts.maxTokens ?? 4000, cfg.maxOutput);
  // 只给认这个字段的模型发。方舟那几个都不认——发过去是 400，不是被忽略。
  const effortSent = opts.effort && cfg.acceptsEffort ? opts.effort : null;
  /*
   * 上限字段用哪个名字、发不发 `reasoning_effort`，是**方言**的事。
   *
   * Bedrock 那个兼容口要 `max_completion_tokens`；网宿这条口要标准的 `max_tokens`
   * （它文档里每个例子都是这个），所以这里恒为 false —— 字段名发错的表现不是被忽略，
   * 是 400。常量名留着不改：它问的仍然是同一个问题，走不走那套新字段。
   */
  const onBedrock = false;
  const ceiling = ceilingFor(cfg);
  const timeoutMs = timeoutFor(opts.timeoutMs, ceiling);


  const body: Record<string, unknown> = {
    model: cfg.model,
    // 认断点的口发内容块，不认的拼回一整段 —— 口径全在 `wireContent`。
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: wireContent(cfg, m.content),
    })),
    stream: false,
  };
  /*
   * OpenAI 兼容协议这一侧有两套方言（方舟 / Bedrock 兼容口），差异全部实测来的
   * （见 `registry.ts` 头部）：
   *
   *   · 上限字段：Bedrock 上那个拒收 `max_tokens`（400 `Unsupported parameter`），
   *     要的是 `max_completion_tokens`；方舟是标准的 `max_tokens`
   *   · temperature：Bedrock 那个只认默认值 1，所以那一个 `sampling: false`，这里根本不发
   *   · 思考深度两家两个名字：Bedrock 上是 `reasoning_effort`（OpenAI 自己的），
   *     方舟那条走 `output_config.effort`
   *
   * 写成分支而不是「都发一遍看谁认」：在这两个口上多发一个不认的字段是 400，不是被忽略。
   */
  body[onBedrock ? "max_completion_tokens" : "max_tokens"] = maxTokens;
  if (cfg.sampling) body.temperature = opts.temperature ?? 0.3;
  if (effortSent) {
    if (onBedrock) body.reasoning_effort = effortSent;
    else body.output_config = { effort: effortSent };
  }
  /*
   * `verbosity`（补遗 §3）。三道闸都得过：调用方明说了这一次要（出稿那几次），这个模型认它
   * （`acceptsVerbosity`，当前只有 Bedrock 上的 GPT-5.x 是 true），以及没被那个开关关掉。
   *
   * **这个字段没实测过**，而 Bedrock 兼容口对不认的参数是 400。所以留一道 kill switch：
   * 报错原话里出现 `Unsupported parameter` 就配 `TKOS_MODEL_NO_VERBOSITY=1`，别的都不用动。
   * 在取用时读，改了不用重启。
   */
  if (
    opts.verbosity &&
    cfg.acceptsVerbosity &&
    (process.env.TKOS_MODEL_NO_VERBOSITY ?? "").trim() !== "1"
  ) {
    body.verbosity = opts.verbosity;
  }
  if (opts.json !== false) {
    body.response_format = { type: "json_object" };
    /*
     * **这两个口都硬性要求消息里出现 `json` 这个词**，否则连模型都到不了就 400：
     * 方舟说「at least one message must contain the word 'json'」，Bedrock 兼容口说
     * 「'messages' must contain the word 'json' in some form」。
     *
     * 这条规矩最坏的地方是它**不像故障**：2026-08-27 之前 `a4.plan` 的提示词里画着一个
     * JSON 例子却没写这个词，于是每一轮深研的检索计划都 400，八个维度零条命题，N3 整段
     * 空转 —— 交出来的仍是一份读着挺像样的报告，只是一条外部证据都没有。查了一轮真运行
     * 的账才看见（RUN-A4-mtb3k2bt-2）。
     *
     * 所以补在这里而不是逐个去改提示词：漏一个的代价是整轮悄悄降级，而没有任何一处会响。
     *
     * **这一段跑在 `wireContent` 之后，所以 `content` 有两种形状**：一整段字符串，或者
     * 内容块数组（认断点的那个口）。按字符串一种形状写的那一版在块那一支上不抛也不红 ——
     * `/json/i.test(数组)` 认的是 `toString()` 出来的东西，拼接拼进去的是 `[object Object]`，
     * 一路发到服务端。**这正是这个文件反复警告的那类失败：读起来一切正常，只有服务端知道。**
     *
     * **补在哪一块**：最后一个 system 段的最后一块，而那一块正好是断点时，另起一块补在它
     * 后面。断点标的是「到这里为止的前缀存下来」，往那一块里塞字等于换一份前缀 —— 每次写一
     * 份新缓存，比不缓存还贵，而唯一看得出来的地方是账单。补在断点**之后**则一个字节都不碰
     * 前缀，命中照旧。
     *
     * 光靠「走缓存那几次都是 `json: false`」不够：那是**当前**的事实（今天唯一给 `cache`
     * 的是 `stage-write.ts` 的分节出稿，那一次确实 `json: false`），而它哪天变了不会有人
     * 想起这里。按块的位置判，则不依赖那个事实。
     */
    const wired = body.messages as { role: string; content: unknown }[];
    /** 块那一支要看得到块里的文本，否则「有没有这个词」问的是 `[object Object]`。 */
    const asText = (c: unknown): string =>
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((b) => (b as { text?: string }).text ?? "").join("\n\n")
          : "";
    if (!wired.some((m) => /json/i.test(asText(m.content)))) {
      const at = wired.findLastIndex((m) => m.role === "system");
      const line = "输出必须是一个合法的 json 对象。";
      const c = at >= 0 ? wired[at].content : null;
      if (at < 0) wired.unshift({ role: "system", content: line });
      else if (!Array.isArray(c))
        wired[at] = { ...wired[at], content: `${asText(c)}\n\n${line}` };
      else {
        const blocks = [...(c as Record<string, unknown>[])];
        const last = blocks[blocks.length - 1];
        if (last && !("cache_control" in last))
          blocks[blocks.length - 1] = { ...last, text: `${last.text as string}\n\n${line}` };
        else blocks.push({ type: "text", text: line });
        wired[at] = { ...wired[at], content: blocks };
      }
    }
  }

  const exit = exitLabel(cfg);
  const outlet = outletOf(cfg.provider);

  /*
   * **这一次调用的总期限，从进这个函数的那一刻起算 —— 在限速器门口排的那一段也算在里面。**
   *
   * 排队算不算进期限是这一处唯一需要想清楚的事。不算的话，一次排了 60 秒的调用还能拿满自己
   * 那份超时，于是这一轮的总时长悄悄多出 60 秒 —— 而 `a4/deadline.ts` 那套编排的前提正是
   * 「单次调用不会超过上层给的余量」（`streamWallFor` 上面那段写的是同一件事）。算进去之后，
   * 排队挤掉的是这一次自己的等待时间，不是别人的。
   *
   * 挤没了的那一次不发：见下面 `queuedMs` 之后那道判断。
   */
  const enteredAt = Date.now();
  const deadline = enteredAt + timeoutMs;

  /*
   * 拿一个出口的位子。拿不到就等 —— 撞限时排队而不是失败，理由整段在 `gate.ts` 头上。
   *
   * **不递 signal**：这一层的中止是靠期限走完的（下面那道判断），而递一个
   * `AbortSignal.timeout` 进去只是把「等到没时间了」换个说法抛出来，报错原话反而更难读。
   */
  let release = await acquire(outlet);
  let queuedMs = Date.now() - enteredAt;
  /**
   * 传输层那道「死得够早才重发」用的起点。**只是那一件事的起点**，不是这一次的计时器 ——
   * 「模型想了多久」是 `进门到现在` 减掉 `queuedMs`（见下面那句 `ms`）。
   *
   * 两个数分开是被一条用例逼出来的：429 退避那一秒原来整个落在 `Date.now() - started` 里，
   * 于是一次撞限被记成「模型多想了一秒」—— 正是这个字段存在要防的那件事。
   */
  const started = Date.now();
  let res: Awaited<ReturnType<typeof httpFetch>>;
  try {
    /** 传输层重发用掉了几次。**429 那条重发不占它的额度** —— 两件事的判据完全不同。 */
    let attempt = 0;
    /** 429 只重发一次。第二次仍然 429 说明限额本身不够，该调 `TKOS_GATE_*`，不是再等一轮。 */
    let rateRetried = false;
    for (;;) {
      let got: Awaited<ReturnType<typeof httpFetch>>;
      try {
        got = await httpFetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
          // 见 `slowDispatcher`：不带它的话 300 秒就掐断长生成。
          dispatcher: slowDispatcher,
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : typeof e;
        const spent = Date.now() - started;
        /*
         * 传输层重发。判据和分寸整段写在 `isTransportFailure` 上面那段注释里，这里
         * 只复述两条边界：**只认「请求根本没走通」**（4xx、模型拒答一律不重发，重发
         * 得到的是同一个答案只是多付一次钱），**只在它死得够早的时候重发**（死在
         * 170/180 秒那一次服务端很可能已经在生成了）。
         *
         * 这条缝是 2026-09-01 从一轮真运行上看见的：RUN-A4-mtievtms-2（ISS-225）的
         * `a4.layer.section(S1)` 一个 `TypeError: fetch failed` 直接把「分层成稿」打成
         * 0/6 节，前面十几分钟取回来的证据一条都没写进去，而报告照旧 status=ok。
         * 原来的重发只长在 Bedrock 那条流式路上，换网宿之后整条链走的是这个兼容口 ——
         * 也就是说这条链上最贵的那两次生成，此前一次重发都没有。
         */
        if (
          name !== "TimeoutError" &&
          name !== "AbortError" &&
          attempt < TRANSPORT_RETRIES &&
          isTransportFailure(e) &&
          spent < timeoutMs * EARLY_FAIL_RATIO
        ) {
          console.warn(
            `[tkos:model] ${cfg.model} 第 ${attempt + 1} 次没连上（${Math.round(spent / 100) / 10}s）：` +
              `${e instanceof Error ? e.message : String(e)} —— 重发。`,
          );
          await new Promise((r) =>
            setTimeout(r, RETRY_BACKOFF_MS[attempt] ?? 2_400),
          );
          attempt += 1;
          continue;
        }
        /*
         * 超时异常的 message 常常是空串，照原样拼出来是「调用失败: 」，看不出是超时
         * 也看不出等了多久。思考型模型超时是常态失败，这句话就是结果页上唯一的现场，
         * 必须自己把秒数写清楚。
         */
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ModelUnavailable(
            `${exit}调用超时 [${cfg.model}]（用的是 ${cfg.keyEnv}）：${waitedLine(timeoutMs, ceiling)}`,
          );
        }
        throw new ModelUnavailable(
          `${exit}调用失败 [${cfg.model}]（用的是 ${cfg.keyEnv}）: ` +
            `${name}: ${e instanceof Error ? e.message : String(e)}` +
            /*
             * **`cause` 必须带出来。** `fetch` 的传输层失败，message 恒是
             * 「fetch failed」，真正的原因（`HeadersTimeoutError` / `ECONNRESET` /
             * 证书）全在 `cause` 里。ISS-225 那一次就是因为只记了 message，
             * 「Node 掐的」和「网宿断的」在结果页上长得一模一样。
             */
            causeLine(e) +
            (attempt > 0 ? `（重发 ${attempt} 次后仍然如此）` : ""),
        );
      }

      /*
       * **429 是这一层唯一一种「4xx 也要重发」。**
       *
       * 上面那条判据的理由是「重发得到的是同一个答案，只是多付一次钱」—— 对 400（请求体不对）、
       * 401（key 不对）、404（模型没开通）都成立。429 不是那一类：它没有答案，它说的是**位子
       * 没了**。不重发的代价是这一次静默降级成台账上少一条证据、或者报告少一节，而两者在屏幕上
       * 都不像故障（`gate.ts` 头上那段）。
       *
       * 三件事按顺序做：整个出口退避（队里那几个发出去也是 429，只罚撞上的那一个等于把一次退避
       * 摊成一串失败）、**把位子还回去**再重新排队（不还的话这一次占着位子睡完退避，等于把并发
       * 额度扣掉一格）、然后重发一次。重发那一次的等待记进 `queuedMs`，不记进 `ms`。
       *
       * 退避完剩下的时间不够发一次的那一种，就地说清楚 —— 拿一个 1 秒的超时去撞墙，换回来的
       * 是一句「调用超时」，而真正发生的事是限额不够。
       */
      if (got.status === 429 && !rateRetried) {
        rateRetried = true;
        const backoff = retryAfterMs(got.headers.get("retry-after"));
        // 正文不读也得排掉，否则这条连接留在池子里等一份没人取的 body。
        await got.text().catch(() => "");
        coolDown(outlet, backoff);
        console.warn(
          `[tkos:model] ${cfg.model} 撞上 ${exit}的限流（429）：${outlet} 出口整体退避 ` +
            `${Math.round(backoff / 100) / 10}s，重新排队后重发一次。`,
        );
        release();
        const requeuedAt = Date.now();
        release = await acquire(outlet);
        queuedMs += Date.now() - requeuedAt;
        if (deadline - Date.now() < MIN_TIMEOUT_MS) {
          throw new ModelUnavailable(
            `${exit}限流 [${cfg.model}]（用的是 ${cfg.keyEnv}）：429 退避 ` +
              `${Math.round(backoff / 1000)}s 之后，这一轮剩下的时间不够再发一次（一共在出口排了 ` +
              `${Math.round(queuedMs / 1000)}s）。这不是模型答不上来 —— 调大 ${outlet} 那一档限额` +
              `（TKOS_GATE_*），或者少并发几条链。`,
          );
        }
        continue;
      }

      res = got;
      break;
    }

    if (!res.ok) {
      /*
       * 一定要带上服务端应答正文：状态码只说「404 Not Found」，而方舟真正的原因
       * 全在正文里 —— `ModelNotOpen`（没开通）、`InvalidEndpointOrModel.NotFound`
       * （模型 id 不对，或该用接入点 ep-*）、`AuthenticationError`（key 无效）。
       * 三种要做的事完全不同。不带出来的话，得有人拿 curl 再打一遍才知道改哪。
       */
      const text = (await res.text().catch(() => "")).slice(0, 400);
      throw new ModelUnavailable(
        `${exit}调用失败 [${cfg.model}]（用的是 ${cfg.keyEnv}）: HTTP ${res.status}` +
          (text ? ` — ${text}` : ""),
      );
    }

    const j = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const choice = j.choices?.[0];
    const u = j.usage ?? {};

    return {
      text: choice?.message?.content ?? "",
      usage: {
        inputTokens: Number(u.prompt_tokens ?? 0),
        outputTokens: Number(u.completion_tokens ?? 0),
        cachedInputTokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
        reasoningTokens: Number(
          u.completion_tokens_details?.reasoning_tokens ?? 0,
        ),
      },
      /*
       * **总时长减掉排队那几段。** 减而不是「从拿到位子那一刻算起」：位子可以还回去再排一次
       * （429 退避那一支），从最后一次算起会把前面几次请求的时间一起抹掉，从第一次算起又会把
       * 中间那段退避算成模型在想。两个数各自都是它字面上那个意思，加起来正好是墙钟。
       */
      ms: Date.now() - enteredAt - queuedMs,
      slot: opts.alias ? null : (opts.slot ?? "pro"),
      alias: cfg.alias,
      providerModelId: cfg.model,
      effortSent,
      stopReason: choice?.finish_reason ?? "",
      queuedMs,
    };
  } finally {
    /*
     * **位子必须还，成败都还。** 漏还一次不报错、不红任何一条测试 —— 表现是这个出口的并发
     * 额度永久少一格，越跑越慢，最后所有调用一起卡在门口等一个永远不会回来的位子。
     */
    release();
  }
}

function configFor(opts: { slot?: Slot; alias?: ModelAlias }): ModelConfig {
  if (opts.alias) {
    const spec = getModel(opts.alias);
    const key = (process.env[spec.keyEnv] ?? "").trim();
    if (!key) {
      throw new ModelUnavailable(
        `未配置 ${spec.keyEnv}（${spec.providerModelId} 用的是这一把）`,
      );
    }
    // 走别名时也必须由 slots 决定地址：地址、key、方言是一套，拆开配就会出现
    // 「Bedrock 的 key 打了带 /openai/v1 的地址去发 Anthropic 请求体」这种组合。
    // `SLOT_BY_ALIAS` 是 `Record<ModelAlias, Slot>` 的全映射，查不到由类型挡着（别名长出
    // 新值时编译器会要求补一行），所以这里只剩一件事要判：那个槽位到底配没配。
    const slot = SLOT_BY_ALIAS[opts.alias];
    const bySlot = resolveModel(slot);
    if (!bySlot)
      throw new ModelUnavailable(
        `别名 ${opts.alias} 的槽位 ${slot} 没有可用出口`,
      );
    return bySlot;
  }
  const slot = opts.slot ?? "pro";
  const cfg = resolveModel(slot);
  if (!cfg) {
    // 报这个槽位自己那把 key 的名字。列出全部变量的话，读的人得先自己算出
    // 「synth 是哪一把」——而这句话存在的全部意义就是替他算完。
    const keyEnv = getModel(SLOT_ALIAS[slot]).keyEnv;
    throw new ModelUnavailable(`没有可用的 ${slot} 槽位（缺 ${keyEnv}）。`);
  }
  return cfg;
}

/** 别名 → 槽位的反查。地址永远由槽位给，见 `configFor`。 */
const SLOT_BY_ALIAS: Record<ModelAlias, Slot> = {
  "deepseek-pro": "pro",
  "deepseek-flash": "flash",
  "claude-opus-5": "alt",
  "gpt-5.6": "synth",
};

