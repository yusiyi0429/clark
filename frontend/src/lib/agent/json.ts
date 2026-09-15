/**
 * 一次成文型 agent（A2 / A3 / A4 / A10）共用的模型调用与 JSON 解析。
 *
 * 抽出来的理由不是「减少重复」——是这四个 agent 踩的是同一批坑，坑一旦在四处
 * 各修一遍，就一定有一处漏掉，而漏掉的那一处会在演示当天出现：
 *
 *  1. **裸引号毁 JSON。** 模型在 JSON 字符串里写 ASCII 双引号（"…"）是高频行为。
 *     `response_format: {type:"json_object"}` 从结构上解决它 —— 结构手段优于
 *     prompt 恳求，这条对所有 agent 都成立。
 *  2. **max_tokens 截断。** 截断的 JSON 解析必然失败，落到下游是一个看不懂的
 *     SyntaxError。必须在这里认出 `finish_reason === "length"` 并说人话。
 *  3. **模型偶尔加壳。** ```json 包裹、前后带一句解释。容忍，但不容忍解析不出来。
 *
 * 与对话路径（/api/chat）故意不共用：那条是流式 + 工具轮，约束完全不同。
 */
import {
  addUsage,
  callModel,
  callFloorMs,
  type CallResult,
  type Effort,
  type MsgContent,
} from "@/lib/models/complete";
import type { Slot } from "@/lib/models/slots";
import type { Statement, TraceKind } from "@/lib/data/types";

const TRACE_KINDS: TraceKind[] = ["ext", "int", "human", "agent", "judgment", "peer"];

/**
 * 一条消息。`content` 给成几块时，标了 `cache` 的那一块末尾是**缓存断点** ——
 * 详见 `models/complete.ts` 的 `ContentPart`。给字符串是从前的写法，行为不变。
 */
export type Msg = { role: string; content: MsgContent };

export type CallOpts = {
  slot?: Slot;
  /** 一次成文的产物比对话长得多。A4 会写到 3000+ tokens。 */
  maxTokens?: number;
  temperature?: number;
  /** 关掉时返回自由文本，不强制 JSON。目前只有实验路径用。 */
  json?: boolean;
  /** 思考深度。只发给认这个字段的模型；火山三个都不认，发过去是 400。 */
  effort?: Effort;
  /** 话说到多细。只有出稿那几次给 `high`，见 `callModel` 那个同名参数。 */
  verbosity?: "low" | "medium" | "high";
  /** 这次调用是给哪个 prompt 用的。只进日志与假模型分派，不发给模型。 */
  hint?: string;
  /**
   * 这一句 `callModelJson` **整个**最多花多久（毫秒），续写那几次算在里面。见 `callModel`
   * 那个同名参数 —— 由 harness 按「这一轮还剩多少时间」算出来。
   *
   * 是整段的预算而不是「每一次的上限」：截断续写会让一次调用变成两三次，各给一次满额
   * 上限的话，一个 20 分钟的总上限能被一次带续写的出稿调用超出去五分钟 —— 那时候超的
   * 是总账，而调用处看不出是谁超的。所以这里减掉已经花掉的再往下发。
   */
  timeoutMs?: number;
  /**
   * **JSONL 那一支**被 `max_tokens` 截断时，最多接着写几次。不给 = 照旧当场抛。
   *
   * 只做 JSONL：接缝按整行对齐（截断那一行整行丢掉，让它从下一行重写）。散文和 JSON
   * 对象都没有这种接缝 —— 一段被切在句子中间的散文续上去会重复半句，一个被切开的 JSON
   * 对象续写多半拼不回合法的那一个。那两种照旧抛，抛出来的话说得清是额度不够。
   */
  jsonlContinue?: number;
  /**
   * JSONL 被截断、又**不续写**时怎么办。默认 `throw`（截断的 JSON 落到下游是看不懂的 SyntaxError，
   * 所以在这里说人话）。`keep` 是 2026-09-04 加的：按整行收尾、把写完的那几行带回去，`stopReason`
   * 照旧是 `length`。分节那一步用它——额度就是墙上时间的上限，截断只该丢最后半块，不该丢整节
   * （ISS-229 四节全在 8000 上被截、全部抛掉，正文 0 块）。
   */
  onLength?: "throw" | "keep";
};

/** 续写那一句。要它接着往下，而不是从头再写一遍 —— 后者会交回一份和前半段重复的报告。 */
const CONTINUE_PROMPT = [
  "上面那一段被输出额度截断了，最后一行已经整行丢掉。",
  "**接着往下写**：从下一行开始，续到写完为止。",
  "不要重复上面已经写过的行，不要重新开头，不要写任何解释 —— 只交 JSONL 行。",
].join("\n");

/** 截断的那一行整行不要。留着它的话解析器会记一条坏行，而那一行的内容本来就不全。 */
const trimToLastLine = (text: string): string => {
  const at = text.lastIndexOf("\n");
  return at < 0 ? "" : text.slice(0, at);
};

/**
 * 调一次模型，拿回正文。**不重试** —— 重试是 agent 自己的事，因为只有它知道
 * 「这次为什么不合格」，而带着违规重试才收敛；无脑重试只是烧钱。
 */
export async function callJson(messages: Msg[], opts: CallOpts = {}): Promise<string> {
  return (await callModelJson(messages, opts)).text;
}

/**
 * 一次**已经付过钱、但没交出可用正文**的调用。
 *
 * ## 为什么异常要带着账
 *
 * 这几种失败（额度用完在思考上、被 `max_tokens` 截断、一行都没写完）都发生在模型
 * 已经算完之后 —— token 真的烧掉了，`usage` 就在手上。而上一版把它扔了：`harness`
 * 的 catch 只记一句 error，`this.acc` 一个数都不加。
 *
 * 代价是一整轮的账偏低而且**没有任何症状**。`RUN-A4-mth5jkf0-6`（ISS-118）里 N2 计划
 * 那两次各烧满 8000 输出 token（错误原文自己写着「这一次思考花了 8000 token」），
 * 落进记录的 `usage` 是 0；`pnpm cost:report` 照着这份记录算，于是那一轮的报价
 * ¥5.74 里**一分钱都不含这两次**。失败越多、账看起来越便宜 —— 这是最坏的一种偏。
 *
 * 所以这些地方抛的是这个异常，它把那一次的账一起带出去。`harness.callMessages` 认得
 * 它，照常记进 trace 和累计里，只是多一条 `error`。
 */
export class SpentError extends Error {
  readonly spent: CallResult;
  constructor(message: string, spent: CallResult) {
    super(message);
    this.name = "SpentError";
    this.spent = spent;
  }
}

/**
 * 「没有正文」那一句话该怎么说。
 *
 * 上一版只说「模型返回里没有正文。」，**而收笔原因就在手上、只是被扔了**。
 * 代价是真的：2026-08-29 一号位报预研跑不成，记录里只有这一句，于是第一反应是
 * 「新加的那几次调用额度给小了」—— 拿真模型逐个验完两个都好好的，最后才定位到
 * 第三个（Bedrock 上的 Opus，额度 1500，思考把额度吃光）。**那一栏本来能一句话
 * 指对地方。**
 *
 * 三种空正文的成因完全不同，修法也完全不同，所以要分开说：
 *
 *   `length`                     额度花完了，而且没剩给正文 —— 调大 `maxTokens`
 *   `content_filter` / `refusal` 模型或网关拒答 —— 改的是提示词或材料，不是额度
 *   其余（含空）                   出口本身异常 —— 该看的是那一次调用的记录
 *
 * 中间那一档是真会遇到的：`complete.ts` 的归一有意保留认不出的收笔原因，
 * 而网关（不只是模型自己）会回 `content_filter` 并且正文是空串。
 */
export function noBodyWhy(r: CallResult): string {
  const used = r.usage.reasoningTokens
    ? `（这一次思考花了 ${r.usage.reasoningTokens} token，正文 0）`
    : "";
  switch (r.stopReason) {
    case "length":
      return `模型返回里没有正文：额度用完在思考上了${used}。这一次的上限是 ${r.usage.outputTokens} token 左右 —— 要么调大它，要么让这一步少想一点。`;
    case "content_filter":
    case "refusal":
      return `模型拒答，没有给正文（收笔原因 ${r.stopReason}）${used}。这一档不是额度问题 —— 该看的是这一次喂进去的提示词和材料。`;
    default:
      return `模型返回里没有正文（收笔原因 ${r.stopReason || "没给"}）${used}。`;
  }
}

/**
 * 和 `callJson` 同一条路，但把 token 计量、耗时、实际模型、实际发出的深度一起
 * 带回来。A1a / A3 / A4 落 Run 记录要用它 —— 只拿正文的话，一次运行花了多少
 * 就只能靠猜。
 */
export async function callModelJson(messages: Msg[], opts: CallOpts = {}): Promise<CallResult> {
  const t0 = Date.now();
  /** 这段预算还剩多少。没给上限时是 `undefined`，`callModel` 那边照旧用它自己的。 */
  const left = (): number | undefined =>
    opts.timeoutMs === undefined ? undefined : opts.timeoutMs - (Date.now() - t0);
  const once = (m: Msg[]): Promise<CallResult> =>
    callModel({
      slot: opts.slot ?? "pro",
      messages: m,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      effort: opts.effort,
      verbosity: opts.verbosity,
      json: opts.json,
      hint: opts.hint,
      ...(left() === undefined ? {} : { timeoutMs: left() }),
    });

  let r = await once(messages);
  if (!r.text) throw new SpentError(noBodyWhy(r), r);
  if (r.stopReason !== "length") return r;

  /*
   * 截断的 JSON 解析必然失败，落到下游是一个看不懂的 SyntaxError。必须在这里认出来并
   * 说人话 —— 除非调用方明说了要续写（`jsonlContinue`）。
   *
   * 续写这一支（补遗 §3）：一份用完了整包证据的报告本来就可能超过任何一个模型的单次
   * 输出上限，而那时截断的表现是**报告在半句话上停住**，屏幕上照旧是一份看着正常的报告。
   * 所以这一支不抛：把已经写出来的当前缀递回去，让它接着往下写。
   *
   * 递回去的是 `assistant` + 一句「接着写」，不是 prefill：几个出口对 prefill 的支持
   * 各不一样，而这两条消息在四种协议上都是合法的。
   */
  const rounds = Math.max(0, Math.floor(opts.jsonlContinue ?? 0));
  if (!rounds) {
    if (opts.onLength === "keep") {
      const kept = trimToLastLine(r.text);
      if (kept.trim()) return { ...r, text: kept };
    }
    throw new SpentError(`模型输出被 max_tokens(${opts.maxTokens ?? 4000}) 截断。`, r);
  }

  let text = trimToLastLine(r.text);
  // 一行都没写完就被截断了 —— 没有可以接着写的前缀（空的 assistant 消息有几个口直接拒）。
  // 那时候问题不是「写得太长」而是额度压根不够，照旧抛。
  if (!text.trim()) throw new SpentError(`模型输出被 max_tokens(${opts.maxTokens ?? 4000}) 截断，一行都没写完。`, r);
  let usage = r.usage;
  let ms = r.ms;
  /** 续写那几次各自也要在出口门口排一次队。不累加的话，最后那一次的等待会盖掉前面全部。 */
  let queuedMs = r.queuedMs;
  for (let i = 0; i < rounds && r.stopReason === "length"; i++) {
    /*
     * 预算见底就不再续了，**把已经写出来的那一段带回去** —— 收笔原因照旧是 `length`，
     * 所以「这一份不全」在 trace 和成稿自检上都看得见。
     *
     * 发一个注定超时的续写反而更糟：这个循环里的异常没人接，抛出去等于把前面那几千字
     * 一起丢掉，而屏幕上只剩一句「调用超时」。
     */
    const room = left();
    // 下限按槽位（`callFloorMs`）：首包 80 秒的出口剩 60 秒时不该再发一次续写。
    if (room !== undefined && room < callFloorMs(opts.slot)) break;
    r = await once([
      ...messages,
      { role: "assistant", content: text },
      { role: "user", content: CONTINUE_PROMPT },
    ]);
    usage = addUsage(usage, r.usage);
    ms += r.ms;
    queuedMs += r.queuedMs;
    const piece = r.stopReason === "length" ? trimToLastLine(r.text) : r.text.trim();
    if (piece) text = `${text}\n${piece}`;
  }
  // `stopReason` 照实带回最后那一次的：还是 `length` 的话这一份仍然是不全的，
  // 而那件事要在 trace 上看得见（`harness.callMessages` 记的就是这个字段）。
  return { ...r, text, usage, ms, queuedMs };
}

/** 模型偶尔用 ```json 包裹，或在 JSON 前后带一句话。都容忍。 */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON。");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v.trim() : fallback;

export const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [];

/**
 * `{label?, text, traces}` 的宽松整形。
 *
 * 不认识的 `kind` 落到 `agent`（推断）而不是丢弃：一条没有分类的溯源仍然比
 * 没有溯源好，而丢弃会让下游的「每条都要有溯源」误判成模型没写。
 *
 * `label` 是那条判断式短标题（S02 的依据有，A4/A5 没有）—— 空的就整个不带这个键，
 * 不落一个空串：`{label: ""}` 和「这条产出没有这一层」在屏幕上和统计里要分得开。
 * **这里不洗 markdown**（不叫 `plain()`）：各 agent 的 `validate.ts` 里 `FE-md` 是
 * p0，在校验之前把星号洗掉，那条门就永远不会红，而模型交出来的形状并没有变好。
 */
export function toStatements(v: unknown): Statement[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x ?? {}) as { label?: unknown; text?: unknown; traces?: unknown };
      const traces = Array.isArray(o.traces)
        ? o.traces
            .map((t) => {
              const tt = (t ?? {}) as { kind?: unknown; source?: unknown; href?: unknown };
              const kind = TRACE_KINDS.includes(tt.kind as TraceKind)
                ? (tt.kind as TraceKind)
                : "agent";
              return { kind, source: str(tt.source, "未标注来源"), href: str(tt.href) || undefined };
            })
            .filter((t) => t.source)
        : [];
      const label = str(o.label);
      return { ...(label ? { label } : {}), text: str(o.text), traces };
    })
    .filter((s) => s.text);
}
