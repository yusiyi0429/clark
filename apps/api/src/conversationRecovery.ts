/**
 * 对话主答的自动恢复（10/13 一号位对话「整条回答消失」之后加的，P0）。
 *
 * 一次模型调用（pi 的一次 streamSimple）出错时，在这一层就地恢复，agent 循环看到的是一次成功的调用：
 * - 还没写出正文（只有思考或什么都没有）：同一个模型换「净化历史」重试，再换备用模型，再用「精简历史」重试；
 *   思考在界面上只会往后追加，不会消失。
 * - 已经写出了正文：不重来，按「从断点续写」发一次新请求（历史 + 已写出的部分 + 一句续写说明，不带工具），
 *   续写的文字接在后面流出，最后合成一条完整的回答。
 * - 连续 MODEL_IDLE_TIMEOUT_MS 没有任何新事件（没有思考、正文、工具调用）才算卡住，中止这一次请求后同样按上面恢复；
 *   持续有思考或正文流入就不打断。
 * - 写到单次输出上限（length）：同样从断点续写，最多 LENGTH_CONTINUES 次。
 * 凭证失效（401/403）、一号位自己停止不重试；模型服务拒收内容（content_filter）只换一次备用模型。
 * 每一步都给界面发一条 recovery 事件（进度行显示在做什么），并记日志。
 *
 * 每轮的状态（备用模型、本轮已经换到哪个模型、用过几次恢复）经 AsyncLocalStorage 从 run() 带到 provider 的 streamSimple。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { HistoryMode, ModeStreamFn } from "./conversationStream.js";

type StreamFn = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/** 一次模型调用连续这么久没有任何新事件，判定卡住（中止这一次请求，按恢复流程重来或续写）。 */
export const MODEL_IDLE_TIMEOUT_MS = 90_000;
/** 一次模型调用最多尝试几次（含第一次）。 */
export const MAX_ATTEMPTS_PER_CALL = 5;
/** 一轮里所有调用合计最多恢复几次，防止反复失败把一轮拖成死循环。 */
export const MAX_RECOVERIES_PER_TURN = 10;
/** 写到输出上限后最多自动续写几次。 */
export const LENGTH_CONTINUES = 2;

export type FailureKind =
  | "network" | "upstream" | "stalled" | "rate_limited" | "context" | "rejected"
  | "auth" | "content_filter" | "length" | "aborted" | "unknown";

const CONTEXT_PATTERN = /context.?(length|window)|maximum context|prompt is too long|too many tokens|input.{0,20}too (long|large)|request too large|reduce the length|token limit|413/i;
const AUTH_PATTERN = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.?api.?key|authentication|permission denied|insufficient_quota|billing/i;
const RATE_PATTERN = /\b429\b|rate.?limit|too many requests|overloaded|\b529\b|resource.?exhausted|busy/i;
const NETWORK_PATTERN = /terminated|fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|other side closed|connection (error|lost|closed|reset|refused)|reset before headers|stream ended|ended without|premature|aborted by the server|UND_ERR/i;
const UPSTREAM_PATTERN = /\b5\d\d\b|unknown_service_err|service.?unavailable|server.?error|internal.?error|bad gateway|gateway|upstream|provider returned error|timed? ?out|timeout/i;
const REJECTED_PATTERN = /\b4\d\d\b|invalid|not found|unsupported|bad request|validation|signature|must|expected/i;
const STREAM_ERROR_PATTERN = /^Error Code |"type"\s*:\s*"(error|response\.failed)"/;

/** 把 pi / SDK 的英文报错归成几类，决定怎么恢复、给一号位怎么说。原文只进日志。 */
export function classifyFailure(message: string | undefined, flags: { stalled?: boolean; aborted?: boolean; length?: boolean } = {}): FailureKind {
  if (flags.stalled) return "stalled";
  if (flags.aborted) return "aborted";
  if (flags.length) return "length";
  const text = message ?? "";
  if (/content.?filter|content_policy|safety/i.test(text)) return "content_filter";
  if (CONTEXT_PATTERN.test(text)) return "context";
  if (AUTH_PATTERN.test(text)) return "auth";
  if (RATE_PATTERN.test(text)) return "rate_limited";
  if (NETWORK_PATTERN.test(text)) return "network";
  if (UPSTREAM_PATTERN.test(text)) return "upstream";
  if (REJECTED_PATTERN.test(text)) return "rejected";
  // 网关在流里发了错误事件、又没说是什么（pi 报成「Error Code undefined: undefined」）：按上游异常处理，换备用模型。
  if (STREAM_ERROR_PATTERN.test(text)) return "upstream";
  return "unknown";
}

export type RecoveryAction = "retry" | "fallback" | "trim" | "continue" | "skip";
export type RecoveryEvent = { type: "recovery"; reason: FailureKind | "compaction" | "tool"; action: RecoveryAction; attempt: number; notice: string };

const REASON_COPY: Record<FailureKind, string> = {
  network: "和模型服务的网络连接中断了",
  upstream: "模型服务这次没有响应",
  stalled: `模型超过 ${Math.round(MODEL_IDLE_TIMEOUT_MS / 1000)} 秒没有输出新内容`,
  rate_limited: "模型服务正忙",
  context: "对话历史太长",
  rejected: "模型服务没有接受这次请求",
  auth: "模型服务的访问凭证没有通过",
  content_filter: "模型服务没有受理这次请求",
  length: "回答较长，写到了单次输出上限",
  aborted: "已停止",
  unknown: "模型服务出错了",
};

/** 进度行上的一句：发生了什么、现在在做什么（不写模型名、不写英文原文）。 */
export function recoveryNotice(kind: FailureKind, action: RecoveryAction, attempt: number): string {
  const what = REASON_COPY[kind];
  if (action === "continue") return kind === "length" ? "回答较长，接着往下写" : `${what}，正在从断点接着写（第 ${attempt} 次）`;
  if (action === "fallback") return `${what}，换用备用模型继续（第 ${attempt} 次）`;
  if (action === "trim") return `${what}，精简对话历史后重试（第 ${attempt} 次）`;
  return `${what}，正在重试（第 ${attempt} 次）`;
}

/** upstreamEvent：网关在流里发的错误事件原文（pi 只取其中的 code、message，其余丢掉），有才记。 */
export type CallFailure = { kind: FailureKind; model: string; mode: HistoryMode; attempt: number; error: string; visible: boolean; at: number; upstreamEvent?: string };

/** 流内错误事件原文最多留这么多字（只进日志）。 */
const UPSTREAM_EVENT_CHARS = 800;

/**
 * 每次模型调用包一层 fetch：流式回包照常原样交给 pi，同时留下最后一个 error / response.failed 事件的原文。
 * 10/26 网关约 70 秒里对 sol 关思考的请求只回 {"type":"error"}，pi 报成「Error Code undefined: undefined」，原因看不到。
 */
export function captureStreamErrors(base: typeof fetch = fetch): { fetch: typeof fetch; event: () => string | undefined } {
  let event: string | undefined;
  const wrapped: typeof fetch = async (input, init) => {
    const response = await base(input, init);
    if (!response.body || !(response.headers.get("content-type") ?? "").includes("event-stream")) return response;
    const decoder = new TextDecoder();
    let buffer = "";
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        for (let match = /\r?\n\r?\n/.exec(buffer); match; match = /\r?\n\r?\n/.exec(buffer)) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (/"type"\s*:\s*"(error|response\.failed)"/.test(block)) event = block.replace(/^data:\s?/gm, "").slice(0, UPSTREAM_EVENT_CHARS);
        }
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch: wrapped, event: () => event };
}

/** 一轮对话的恢复状态（run() 里建，经 turnRecovery 带进 streamSimple）。 */
export type TurnRecovery = {
  emit: (event: RecoveryEvent) => void;
  /** 本轮的主答候选：第一个是本档模型，后面是备用（降档、换另一家）。 */
  candidates: Model<any>[];
  /** 只有这些模型的调用走换模型与续写（压缩摘要之类的辅助调用只做同模型重试）。 */
  mainModelIds: Set<string>;
  /** 本轮已经换到的模型：后面的调用直接从它开始，不再先撞一次已经失败的那个。 */
  preferred?: Model<any>;
  /** 本轮已经需要的历史模式：出过一次需要净化的错，后面的调用也净化。 */
  history: HistoryMode;
  idleMs: number;
  recoveries: number;
  failures: CallFailure[];
  /** 每一次恢复：因为什么、做了什么（重试 / 换备用模型 / 精简历史 / 续写），按发生顺序。 */
  steps: { reason: FailureKind; action: RecoveryAction }[];
  log?: (entry: Record<string, unknown>) => void;
  /** Claude 目标没有思考强度时用这一档（Claude 5.5 不接受关思考）。 */
  claudeFallbackReasoning?: SimpleStreamOptions["reasoning"];
};

export const turnRecovery = new AsyncLocalStorage<TurnRecovery>();

export function createTurnRecovery(input: Pick<TurnRecovery, "emit" | "candidates" | "mainModelIds"> & Partial<Pick<TurnRecovery, "idleMs" | "log" | "claudeFallbackReasoning">>): TurnRecovery {
  return { history: "normal", recoveries: 0, failures: [], steps: [], idleMs: input.idleMs ?? MODEL_IDLE_TIMEOUT_MS, ...input };
}

export const CONTINUE_AFTER_BREAK = "（系统说明，不是一号位的话）上面这条回答在输出途中因为连接中断停在了这里，一号位已经看到了这些文字。请紧接着最后一个字继续写完：不要重复已经写出的内容，不要加开场白、过渡语或道歉，也不要提到中断。";
export const CONTINUE_AFTER_LENGTH = "（系统说明，不是一号位的话）上面这条回答写到了单次输出上限，一号位已经看到了这些文字。请紧接着最后一个字继续写完：不要重复已经写出的内容，不要加开场白或过渡语。";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function continuationContext(context: Context, partial: string, model: Model<any>, length: boolean): Context {
  const now = Date.now();
  const assistant: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: partial }], usage: ZERO_USAGE, stopReason: "stop", timestamp: now };
  return { ...context, messages: [...context.messages, assistant,
    { role: "user", content: [{ type: "text", text: length ? CONTINUE_AFTER_LENGTH : CONTINUE_AFTER_BREAK }], timestamp: now }] };
}

function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function failedMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: ZERO_USAGE,
    stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error ?? "unknown error"), timestamp: Date.now() };
}

/** 下一次尝试换不换模型、用什么历史；undefined = 不再恢复。 */
function nextStep(kind: FailureKind, attempt: number, hasOther: boolean): { model: "same" | "next"; mode: HistoryMode } | undefined {
  if (kind === "auth" || kind === "aborted") return undefined;
  if (kind === "content_filter") return attempt === 1 && hasOther ? { model: "next", mode: "sanitized" } : undefined;
  if (attempt >= MAX_ATTEMPTS_PER_CALL) return undefined;
  const severe = kind === "rejected" || kind === "context";
  if (attempt === 1) return { model: "same", mode: kind === "context" ? "minimal" : "sanitized" };
  if (attempt === 2) return { model: "next", mode: severe ? "minimal" : "sanitized" };
  return { model: "next", mode: "minimal" };
}

function delayFor(kind: FailureKind, attempt: number): number {
  if (kind === "rate_limited") return Math.min(8_000, 2_000 * attempt);
  if (kind === "network") return Math.min(4_000, 1_000 * attempt);
  if (kind === "stalled" || kind === "length") return 0;
  return 500;
}

/** window（历史太长时一轮开始就定的兜底，conversationCompaction.ts）已经只带文字，介于净化与精简之间。 */
const MODE_RANK: Record<HistoryMode, number> = { normal: 0, sanitized: 1, window: 2, minimal: 3 };

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * 包住带历史模式的 streamSimple：出错就按上面的规则在这一层恢复。没有本轮状态时（测试、单独调用）只做卡住检测与同模型重试。
 */
export function recoveringStream(inner: ModeStreamFn, deps: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}): StreamFn {
  const sleep = deps.sleep ?? abortableSleep;
  return (requestedModel, context, options) => {
    const out = createAssistantMessageEventStream();
    const turn = turnRecovery.getStore();
    const main = turn ? turn.mainModelIds.has(requestedModel.id) : false;
    void (async () => {
      const outer = options?.signal;
      // 本轮已经换过模型：直接从换到的那个开始。
      let model = main && turn?.preferred ? turn.preferred : requestedModel;
      const tried = new Set<string>([model.id]);
      let mode: HistoryMode = main && turn ? turn.history : "normal";
      let visible = "";
      let started = false;
      let continueReason: "break" | "length" | undefined;
      let lengthContinues = 0;
      for (let attempt = 1; ; attempt += 1) {
        const controller = new AbortController();
        const onOuter = () => controller.abort(outer?.reason);
        if (outer?.aborted) controller.abort(outer.reason); else outer?.addEventListener("abort", onOuter, { once: true });
        let stalled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idleMs = turn?.idleMs ?? MODEL_IDLE_TIMEOUT_MS;
        const arm = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { stalled = true; controller.abort(new Error(`model stream idle for ${idleMs} ms`)); }, idleMs);
          (timer as { unref?: () => void }).unref?.();
        };
        arm();
        const claude = model.api === "anthropic-messages";
        const reasoning = options?.reasoning ?? (claude && model.id !== requestedModel.id ? turn?.claudeFallbackReasoning ?? "low" : undefined);
        const capture = captureStreamErrors(options?.fetch);
        const callOptions: SimpleStreamOptions = { ...options, signal: controller.signal, fetch: capture.fetch, ...(reasoning ? { reasoning } : {}),
          ...(continueReason ? { toolChoice: "none" as const } : {}) };
        const callContext = continueReason ? continuationContext(context, visible, model, continueReason === "length") : context;
        let final: AssistantMessage | undefined;
        let openThinking: number | undefined;
        try {
          const stream = inner(model, callContext, callOptions, mode);
          for await (const event of stream) {
            arm();
            if (event.type === "start") {
              if (!started) { started = true; out.push(event); }
              continue;
            }
            if (event.type === "done") { final = event.message; break; }
            if (event.type === "error") { final = event.error; break; }
            if (!started) { started = true; out.push({ type: "start", partial: event.partial }); }
            if (event.type === "text_delta") visible += event.delta;
            if (event.type === "thinking_start") openThinking = event.contentIndex;
            if (event.type === "thinking_end") openThinking = undefined;
            out.push(event);
          }
          final ??= await stream.result();
        } catch (error) {
          final = failedMessage(model, error, Boolean(outer?.aborted));
        } finally {
          if (timer) clearTimeout(timer);
          outer?.removeEventListener("abort", onOuter);
        }
        // 断开的思考块先收尾，界面上的思考段落不和下一次的拼在一起。
        if (openThinking !== undefined && final.stopReason !== "stop" && final.stopReason !== "toolUse") {
          out.push({ type: "thinking_end", contentIndex: openThinking, content: "", partial: final });
        }
        const length = final.stopReason === "length" && visible.length > 0 && main && lengthContinues < LENGTH_CONTINUES;
        if (final.stopReason !== "error" && final.stopReason !== "aborted" && !length) {
          // 成功。续写过的：合成一条只有文字的回答（续写不带工具），思考块不拼接（签名绑定各自的请求）。
          const message: AssistantMessage = continueReason
            ? { ...final, content: [{ type: "text", text: visible }, ...final.content.filter((block) => block.type === "toolCall")] }
            : final;
          if (turn && main) {
            if (model.id !== requestedModel.id) turn.preferred = model;
            if (MODE_RANK[mode] > MODE_RANK[turn.history]) turn.history = mode;
          }
          out.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
          out.end();
          return;
        }
        const aborted = Boolean(outer?.aborted);
        const upstreamEvent = capture.event();
        const kind = classifyFailure([final.errorMessage, upstreamEvent].filter(Boolean).join(" "), { stalled: stalled && !aborted, aborted: aborted || (final.stopReason === "aborted" && !stalled), length });
        const failure: CallFailure = { kind, model: model.id, mode, attempt, error: String(final.errorMessage ?? final.stopReason).slice(0, 400), visible: visible.length > 0, at: Date.now(),
          ...(upstreamEvent ? { upstreamEvent } : {}) };
        turn?.failures.push(failure);
        turn?.log?.({ event: "conversation.recovery", ...failure });
        const candidates = main && turn ? turn.candidates.filter((candidate) => !tried.has(candidate.id)) : [];
        const step = kind === "length" ? { model: "same" as const, mode } : nextStep(kind, attempt, candidates.length > 0);
        const budgetLeft = !turn || turn.recoveries < MAX_RECOVERIES_PER_TURN;
        // 辅助调用（不是主答模型）只做同模型重试，最多两次，不续写。
        const allowed = step && budgetLeft && (main || (attempt < 3 && kind !== "length" && visible.length === 0));
        if (!allowed) {
          // 放弃：把已写出的正文放在这条失败消息里（运行时据此把它存进对话），原始报错留给日志。
          const content = visible ? [{ type: "text" as const, text: visible }] : final.content.filter((block) => block.type === "text");
          const error: AssistantMessage = { ...final, content, stopReason: aborted || kind === "aborted" ? "aborted" : "error",
            errorMessage: final.errorMessage ?? (kind === "length" ? "Response length limit reached" : kind) };
          out.push({ type: "error", reason: error.stopReason as "error" | "aborted", error });
          out.end();
          return;
        }
        if (turn) turn.recoveries += 1;
        let action: RecoveryAction = "retry";
        if (step.model === "next" && candidates.length) {
          model = candidates[0];
          tried.add(model.id);
          action = "fallback";
        }
        if (MODE_RANK[step.mode] > MODE_RANK[mode]) {
          mode = step.mode;
          if (action === "retry" && step.mode === "minimal") action = "trim";
        }
        if (visible) {
          continueReason = kind === "length" ? "length" : "break";
          if (kind === "length") lengthContinues += 1;
          action = "continue";
        }
        turn?.steps.push({ reason: kind, action });
        turn?.emit({ type: "recovery", reason: kind, action, attempt: attempt + 1, notice: recoveryNotice(kind, action, attempt) });
        await sleep(delayFor(kind, attempt), outer);
        if (outer?.aborted) {
          const content = visible ? [{ type: "text" as const, text: visible }] : [];
          out.push({ type: "error", reason: "aborted", error: { ...final, content, stopReason: "aborted", errorMessage: "Conversation aborted" } });
          out.end();
          return;
        }
      }
    })().catch((error) => {
      // 兜底：这一层自己出错也要给 agent 一个结束事件，不能让一轮卡住。
      out.push({ type: "error", reason: "error", error: failedMessage(requestedModel, error, false) });
      out.end();
    });
    return out;
  };
}

/**
 * 一轮走过恢复的汇总（写进运行记录、日志与 LangSmith 轨迹）：原模型、实际完成这一轮的备用模型（没换就没有）、
 * 触发原因（去重，按首次出现）、各类恢复各几次、合计恢复几次。这一轮没有恢复过时没有汇总。
 */
export type TurnRecoverySummary = {
  originalModel: string;
  fallbackModel?: string;
  reasons: FailureKind[];
  actions: Partial<Record<RecoveryAction, number>>;
  retries: number;
};

export function summarizeRecovery(turn: Pick<TurnRecovery, "candidates" | "preferred" | "recoveries" | "steps" | "failures">): TurnRecoverySummary | undefined {
  if (!turn.recoveries && !turn.steps.length) return undefined;
  const originalModel = turn.candidates[0]?.id ?? turn.failures[0]?.model ?? "";
  // 换到的模型：成功时记在 preferred；没成功时看最后一次失败用的是哪个。
  const finalModel = turn.preferred?.id ?? turn.failures.at(-1)?.model;
  const actions: Partial<Record<RecoveryAction, number>> = {};
  for (const step of turn.steps) actions[step.action] = (actions[step.action] ?? 0) + 1;
  return {
    originalModel,
    ...(finalModel && finalModel !== originalModel ? { fallbackModel: finalModel } : {}),
    reasons: [...new Set(turn.steps.map((step) => step.reason))],
    actions,
    retries: turn.recoveries,
  };
}

const ACTION_COPY: Record<Exclude<RecoveryAction, "skip">, string> = {
  retry: "自动重试",
  fallback: "换用备用模型",
  trim: "精简较早的对话历史后重试",
  continue: "从断点续写",
};

/**
 * 回答末尾那行说明（一轮成功、但走过恢复时）：text 是 12px 的一行，detail 是悬停时的说明。
 * 只说发生了什么、怎么处理的，不写模型名、不写英文报错原文。优先级：换了备用模型 > 中途续写 > 精简历史 > 重试。
 */
export function recoveryNote(summary: TurnRecoverySummary | undefined): { text: string; detail: string } | undefined {
  if (!summary) return undefined;
  const count = (action: RecoveryAction) => summary.actions[action] ?? 0;
  const lengthOnly = summary.reasons.length > 0 && summary.reasons.every((reason) => reason === "length");
  const times = (n: number) => (n === 1 ? "一次" : ` ${n} 次`);
  const text = summary.fallbackModel ? "本轮因上游异常改由备用模型完成"
    : count("continue") && lengthOnly ? "本轮回答较长，已自动续写完成"
    : count("continue") ? `本轮中途重连${times(count("continue"))}，已续写`
    : count("trim") ? "本轮精简了较早的对话历史后完成"
    : count("retry") || count("fallback") ? "本轮遇到上游异常，已自动重试完成"
    : undefined;
  if (!text) return undefined;
  const reasons = summary.reasons.map((reason) => REASON_COPY[reason]).filter(Boolean);
  const handled = (["continue", "fallback", "trim", "retry"] as const).filter((action) => count(action))
    .map((action) => `${ACTION_COPY[action]} ${count(action)} 次`);
  const detail = [
    reasons.length ? `原因：${reasons.join("；")}。` : "",
    handled.length ? `处理：${handled.join("，")}。` : "",
  ].join("");
  return { text, detail };
}

/** 运行时放弃这一轮时抛出的错误：带上分类、已写出的正文和要存的会话记录，路由层据此存档并给一号位说明。 */
export class ConversationTurnError extends Error {
  constructor(message: string, readonly kind: FailureKind | "search_budget" | "internal", readonly details: {
    code?: string; runtimeEntries?: unknown[]; piSessionId?: string; recoveries?: number; failures?: CallFailure[];
    recoverySummary?: TurnRecoverySummary;
  } = {}) {
    super(message);
    if (details.code) (this as { code?: string }).code = details.code;
  }
  get runtimeEntries() { return this.details.runtimeEntries; }
}

/** restart：服务停机（部署换版本），正在写的这一轮先存档收尾，界面连上新实例后自动接着写。 */
export type TurnFailureKind = FailureKind | "search_budget" | "internal" | "turn_timeout" | "turn_stalled" | "restart";

/** 存进对话记录的那一行说明（括号整行），续写时不算已写出的正文。 */
const SETTLED_NOTE = /\n*（(这次回答在这里中断了|这次回答没有完成|已停止|回答持续了|回答在 \d+ 秒时限内没有写完)[\s\S]*）\s*$/;

/** 存进对话记录的说明里用的一句原因（不带括号，免得和外层括号嵌套）。 */
export function shortFailureReason(kind: TurnFailureKind): string {
  switch (kind) {
    case "turn_timeout": return "持续时间超过上限";
    case "turn_stalled": return "长时间没有进展";
    case "restart": return "天枢服务更新";
    case "search_budget": return "外部检索次数用完";
    case "internal": return "天枢处理时出错";
    default: return REASON_COPY[kind];
  }
}

/**
 * 「继续」交给模型的说明（放进上下文包的 resume 字段）：
 * - 上一轮写出了部分正文：从结尾接着写，不重复、不加开场白；
 * - 一个字都没写出：完整重答，这一轮已经查到的材料（模型历史里的工具结果）直接用。
 * tier 是那一轮的档位，沿用；读不到时由路由重新判断。
 */
export function resumeInstruction(question: string, written: string | undefined, tier?: string): { tier?: "quick" | "grounded" | "deep"; question: string; instruction: string } {
  const body = (written ?? "").replace(SETTLED_NOTE, "").trim();
  const tail = body.length > 80 ? `…${body.slice(-80)}` : body;
  const known = tier === "quick" || tier === "grounded" || tier === "deep" ? tier : undefined;
  const instruction = body
    ? `上一轮回答（问题：「${question.slice(0, 300)}」）在中途中断了，已经写出的部分就是对话里你的上一条回答，结尾是「${tail}」。一号位点了「继续」：请紧接着这个结尾继续写完，不要重复已经写出的内容，不要加开场白、过渡语或道歉；还需要查证的可以继续查证。`
    : `上一轮回答（问题：「${question.slice(0, 300)}」）没有完成。一号位点了「重新回答」：请完整回答这个问题；之前已经查到的材料（对话里的工具结果）可以直接使用，不必重复查。`;
  return { ...(known ? { tier: known } : {}), question, instruction };
}

/**
 * 一轮没完成时给一号位的说明：原因（具体到哪一层）+ 已经保留了什么 + 下一步（继续 / 重新回答）。
 * 不出现英文原文和笼统的「暂不可用」；原始报错只进日志和运行记录。
 */
export function turnFailureCopy(kind: TurnFailureKind, input: { partial: boolean; recoveries?: number; stallSeconds?: number; capMinutes?: number }):
  { code: string; message: string; resume?: "continue" | "retry" } {
  const retried = input.recoveries ? `，已自动恢复 ${input.recoveries} 次仍未成功` : "";
  const keep = input.partial ? "已写出的部分保留在上方，点「继续」从断点接着写。" : "问题已保留，点「重新回答」再试一次，这一轮已经查到的材料会直接用上。";
  const resume = input.partial ? "continue" as const : "retry" as const;
  switch (kind) {
    case "network": return { code: "NETWORK_INTERRUPTED", message: `和模型服务的网络连接中断了${retried}（多半是本机网络或代理切换）。${keep}`, resume };
    case "upstream": return { code: "MODEL_UNAVAILABLE", message: `模型服务这次没有响应${retried}（已换用备用模型）。${keep}`, resume };
    case "stalled": return { code: "MODEL_STALLED", message: `模型连续 ${Math.round(MODEL_IDLE_TIMEOUT_MS / 1000)} 秒没有输出新内容${retried}。${keep}`, resume };
    case "rate_limited": return { code: "MODEL_BUSY", message: `模型服务正忙${retried}。${keep}`, resume };
    case "context": return { code: "CONTEXT_TOO_LONG", message: `这段对话已经很长，模型一次装不下，精简历史后仍未成功。${keep}`, resume };
    case "rejected": return { code: "MODEL_REJECTED", message: `模型服务没有接受这次请求${retried}（已精简对话历史并换用备用模型）。${keep}`, resume };
    case "auth": return { code: "MODEL_AUTH", message: `模型服务的访问凭证没有通过校验，需要检查服务配置后再试。${input.partial ? "已写出的部分保留在上方。" : "问题已保留。"}` };
    case "content_filter": return { code: "CONTENT_FILTER", message: `模型服务没有受理这次请求（内容审核未通过）。${input.partial ? "已写出的部分保留在上方，" : "问题已保留，"}可以换个说法后重试。` };
    case "length": return { code: "ANSWER_TOO_LONG", message: `回答很长，已经写到单次输出上限并自动续写过。已写出的部分保留在上方，点「继续」接着写。`, resume: "continue" };
    case "search_budget": return { code: "SEARCH_BUDGET_EXHAUSTED", message: `这一轮的外部检索次数已经用完。${input.partial ? "已写出的部分保留在上方。" : "问题已保留，"}可以把问题缩小一些再问。` };
    case "turn_timeout": return { code: "TURN_TIMEOUT", message: `这次回答已经持续 ${input.capMinutes ?? 10} 分钟，为防止陷入循环先停在这里。${keep}`, resume };
    case "turn_stalled": return { code: "TURN_STALLED", message: `这一轮超过 ${input.stallSeconds ?? 120} 秒没有任何进展（没有新的思考、正文或查证结果）。${keep}`, resume };
    case "restart": return { code: "SERVER_RESTARTING", message: `天枢服务在更新。${keep}`, resume };
    case "aborted": return { code: "ABORTED", message: `已停止。${input.partial ? "已写出的部分保留在上方，点「继续」可以接着写。" : ""}`, ...(input.partial ? { resume: "continue" as const } : {}) };
    case "internal":
    case "unknown":
    default: return { code: "RUNTIME_FAILED", message: `天枢在处理这一轮时出错（已记录）${retried}。${keep}`, resume };
  }
}
