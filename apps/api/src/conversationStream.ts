/**
 * 对话主答发给网关之前的最后一层（按档位换模型以后才需要，10/13）：
 * - 历史按目标模型过滤推理：Claude 的 thinking 块（含签名）不发给 GPT，GPT 的推理（加密推理与英文摘要）不发给 Claude。
 *   pi 的 transformMessages 默认会把别家模型的思考摘要改写成一段普通文字塞回历史，这里先把它们去掉，
 *   免得一个模型的思考被另一个模型当成「自己说过的话」，也省 token。同一模型的思考块原样保留（Claude 续聊要回传带签名的块）。
 * - 此前各轮里由 Responses 上游生成的条目身份不回传（见 withoutUpstreamItemIds）。
 * - 缓存按模型分开（见 cacheKeyFor）；Anthropic 的缓存本来就按模型分（前缀里有模型）。
 * - 压缩摘要换入之前生成的 Claude 思考块不再回传（见 withoutPreCompactionThinking）。
 */
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { estimateTextTokens, questionOf } from "./conversationCompaction.js";

type StreamFn = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
type Message = Context["messages"][number];
type AssistantMessage = Extract<Message, { role: "assistant" }>;

/**
 * 历史怎么交给模型：
 * - normal：此前各轮去掉上游条目身份，本轮原样；
 * - sanitized：本轮也去掉（出错后的重试）；Claude 目标同时去掉此前各轮的思考块；
 * - window：历史太长、后台压缩还没好时的兜底（conversationCompaction.ts）：压缩摘要 + 最近若干轮的文字（按 WINDOW_HISTORY_TOKENS），本轮原样；
 * - minimal：在 sanitized 之上，此前各轮只留文字（不带工具调用与结果），最多留最近 MINIMAL_TURNS 轮和压缩摘要。
 * window 与 minimal 里此前各轮的提问只留一号位的原话和页面对象（上下文包每轮会重新给）。
 */
export type HistoryMode = "normal" | "sanitized" | "window" | "minimal";
export const MINIMAL_TURNS = 6;
/** window 模式最多带这么多 token 的此前各轮文字（至少 WINDOW_MIN_TURNS 轮、最多 WINDOW_MAX_TURNS 轮）。 */
export const WINDOW_HISTORY_TOKENS = 24_000;
export const WINDOW_MIN_TURNS = 2;
export const WINDOW_MAX_TURNS = 12;

/** 历史里不是目标模型产出的推理一律去掉；去掉后没有内容的助手消息原样保留给 pi（它会自己跳过空消息）。 */
export function withoutForeignReasoning(messages: Context["messages"], model: Pick<Model<any>, "id" | "api" | "provider">): Context["messages"] {
  let changed = false;
  const result = messages.map((message: Message) => {
    if (message.role !== "assistant") return message;
    const same = message.model === model.id && message.api === model.api && message.provider === model.provider;
    if (same || !message.content.some((block) => block.type === "thinking")) return message;
    changed = true;
    return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
  });
  return changed ? result : messages;
}

/** 本轮从哪一条开始：最后一条用户消息（本轮的提问；之后是本轮的工具往返）。 */
function currentTurnStart(messages: Context["messages"]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index].role === "user") return index;
  return 0;
}

const callIdOf = (id: string) => id.split("|")[0];

/**
 * Responses 上游生成的条目身份：推理条目（thinking 块的 thinkingSignature 是整条 reasoning item，含加密推理）、
 * 正文 message 的 msg_ id（textSignature）、function_call 的 fc_ id（工具调用 id 里「|」后面那段）。
 * 10/13 一号位对话实测（离线重放同一段历史）：网宿 gpt-5.6-sol 收到早先轮次的这些身份时，
 * 隔约 16–24 秒返回 503 unknown_service_err，一个字都不出——只留任何一种都会失败，三种都去掉就正常；
 * 换 gpt-5.6-terra 或去掉这些身份都能答。这些身份只在同一上游实例里有效，对话隔几轮、网关换了实例就成了毒数据。
 * 去掉后 pi 用自己的 msg_pi_N 作 message id、function_call 只带 call_id，文字、工具调用与结果本身都在，
 * 此前各轮的推理本来也不参与后续推理（OpenAI 只在同一轮的工具往返里用到）。
 */
export function withoutUpstreamItemIds(messages: Context["messages"], model: Pick<Model<any>, "api">, mode: HistoryMode = "normal"): Context["messages"] {
  // window 是一轮开始时就定的兜底（不是出错重试），本轮的条目照常回传。
  const boundary = mode === "normal" || mode === "window" ? currentTurnStart(messages) : messages.length;
  const anthropic = model.api === "anthropic-messages";
  const responses = model.api === "openai-responses";
  if (!responses && !(anthropic && mode !== "normal")) return messages;
  const turnStart = currentTurnStart(messages);
  let changed = false;
  const result = messages.map((message: Message, index) => {
    if (index >= boundary) return message;
    if (responses && message.role === "toolResult" && message.toolCallId.includes("|")) {
      changed = true;
      return { ...message, toolCallId: callIdOf(message.toolCallId) };
    }
    if (message.role !== "assistant") return message;
    // Claude：sanitized 时只去掉此前各轮的思考块；本轮最后一次工具调用要带着自己的思考块回传，不能动。
    if (anthropic) {
      if (index >= turnStart || !message.content.some((block) => block.type === "thinking")) return message;
      changed = true;
      return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
    }
    const content = message.content.flatMap((block) => {
      if (block.type === "thinking") return [];
      if (block.type === "text" && block.textSignature) { const { textSignature: _signature, ...rest } = block; return [rest]; }
      if (block.type === "toolCall" && block.id.includes("|")) return [{ ...block, id: callIdOf(block.id) }];
      return [block];
    });
    const same = content.length === message.content.length && content.every((block, at) => block === message.content[at]);
    if (same) return message;
    changed = true;
    return { ...message, content } as AssistantMessage;
  });
  return changed ? result : messages;
}

const userText = (message: Message) => (typeof message.content === "string" ? message.content
  : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));

/** pi 把压缩摘要作为一条用户消息放在最前（convertToLlm 的 COMPACTION_SUMMARY_PREFIX）。 */
export function isCompactionSummary(message: Message | undefined): boolean {
  return message?.role === "user" && /^The conversation history before this point was compacted/.test(userText(message));
}

type CardBrief = { kind?: string; title?: string; objectRef?: unknown };
const brief = (card: CardBrief) => ({ ...(card.kind ? { kind: card.kind } : {}), ...(card.title ? { title: card.title } : {}), ...(card.objectRef ? { objectRef: card.objectRef } : {}) });

/** 只带文字的历史里，此前一轮的提问与回答最多留这么多字（附件抽取文本、超长回答截短；本轮不截）。 */
const PREVIOUS_QUESTION_CHARS = 4_000;
const PREVIOUS_ANSWER_CHARS = 8_000;
const clipText = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…（较早一轮的内容较长，已截短）` : text);

/** 此前一轮的提问只留一号位原话、页面对象与显式引用（页面摘要、预取的检索结果每轮会重新给）。不是上下文包的原样保留。 */
export function briefQuestion(message: Message): Message {
  if (message.role !== "user") return message;
  const question = questionOf(userText(message));
  if (!question) return isCompactionSummary(message) ? message : { ...message, content: [{ type: "text", text: clipText(userText(message), PREVIOUS_QUESTION_CHARS) }] };
  const text = JSON.stringify({
    ...(question.currentObject ? { currentObject: brief(question.currentObject) } : {}),
    ...(question.references.length ? { references: question.references.map(brief) } : {}),
    message: clipText(question.message, PREVIOUS_QUESTION_CHARS),
  });
  return { ...message, content: [{ type: "text", text }] };
}

/** 写入类工具在只带文字的历史里怎么说（10/14 重放：窗口里看不到工具结果，下一轮把已经生成的 7 张确认卡说成「没有生成」）。 */
const STATE_TOOL_LABELS: [RegExp, string][] = [
  [/^propose_business_change$/, "生成确认卡"], [/^apply_business_proposal$/, "执行已批准的确认卡"], [/^update_business_object$/, "修改业务对象"],
  [/^create_business_object$/, "新建业务对象"], [/^run_business_action$/, "执行业务动作"], [/^propose_material_edit$/, "提议修改材料"],
  [/^(edit_material|create_material)$/, "改写或新写材料"], [/^propose_(create_issue|update_battlefield|remember_principle)$/, "生成确认卡"],
  [/^(edit_current_object|edit_mission_card)$/, "修改当前对象"], [/^propose_review_edit$/, "提改写建议"],
];

/** 一轮里写入类工具的结果，写成接在那一轮回答后面的一行（系统记录，不是回答原文）。 */
function actionNote(actions: { name: string; title?: string; ok: boolean }[]): string | undefined {
  if (!actions.length) return undefined;
  const groups = new Map<string, { ok: number; failed: number; titles: string[] }>();
  for (const action of actions) {
    const label = STATE_TOOL_LABELS.find(([pattern]) => pattern.test(action.name))?.[1] ?? action.name;
    const group = groups.get(label) ?? { ok: 0, failed: 0, titles: [] };
    if (action.ok) { group.ok += 1; if (action.title && group.titles.length < 8) group.titles.push(action.title.slice(0, 40)); } else group.failed += 1;
    groups.set(label, group);
  }
  const parts = [...groups.entries()].map(([label, group]) => `${label}：成功 ${group.ok} 次${group.failed ? `、失败 ${group.failed} 次` : ""}${group.titles.length ? `（${group.titles.join("；")}）` : ""}`);
  return `（系统记录：这一轮实际执行了${parts.join("；")}。）`;
}

/** 拷出来的回答不带原来的用量：那是带着完整工具往返时的上下文大小（见 textOnlyHistory）。 */
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * 此前各轮只留文字：一号位的提问（briefQuestion）与回答正文，不带工具调用、工具结果与思考；开头的压缩摘要保留，本轮原样。
 * 从最近一轮往前按整轮取：最多 maxTurns 轮；给了 budgetTokens 时，取够 minTurns 轮之后超出预算就停。
 * 拷出来的回答不带用量：pi-ai 按「历史里最后一条回答的用量」估算上下文、把输出上限压到「窗口 − 估算」，
 * 留着原来的 14 万用量，GPT（12.8 万窗口）的输出上限会被压到十几个 token，回答写两个字就到上限（10/14 重放第 8 轮实测）。
 */
function textOnlyHistory(messages: Context["messages"], limits: { maxTurns: number; minTurns?: number; budgetTokens?: number }): Context["messages"] {
  const turnStart = currentTurnStart(messages);
  const previous = messages.slice(0, turnStart);
  const summary = isCompactionSummary(previous[0]) ? [previous[0]] : [];
  const kept: Message[] = [];
  let pending: Message[] = [];
  let pendingTokens = 0;
  let turns = 0;
  let tokens = 0;
  // 这一轮里写入类工具的结果（工具往返不带了，但「确认卡生成了没有」这类状态要留住）。
  let outcomes = new Map<string, boolean>();
  let actions: { name: string; title?: string; ok: boolean }[] = [];
  const fits = (more: number) => limits.budgetTokens === undefined || turns < (limits.minTurns ?? 0) || tokens + more <= limits.budgetTokens;
  let stopped = false;
  for (let index = previous.length - 1; index >= summary.length; index -= 1) {
    const message = previous[index];
    if (message.role === "toolResult") {
      if (STATE_TOOL_LABELS.some(([pattern]) => pattern.test(message.toolName))) outcomes.set(message.toolCallId, !message.isError);
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall" || !outcomes.has(block.id)) continue;
        const title = (block.arguments as { title?: unknown; values?: { title?: unknown } } | undefined);
        const named = typeof title?.title === "string" ? title.title : typeof title?.values?.title === "string" ? title.values.title : undefined;
        actions.unshift({ name: block.name, ...(named ? { title: named } : {}), ok: outcomes.get(block.id)! });
      }
      const text = message.content.filter((block) => block.type === "text");
      if (!text.length || message.stopReason === "error" || message.stopReason === "aborted") continue;
      const answer = clipText(text.map((block) => block.text).join(""), PREVIOUS_ANSWER_CHARS);
      pending.unshift({ ...message, content: [{ type: "text" as const, text: answer }], usage: ZERO_USAGE });
      pendingTokens += estimateTextTokens(answer);
      continue;
    }
    const question = briefQuestion(message);
    const note = actionNote(actions);
    const last = pending.at(-1);
    if (note && last?.role === "assistant") {
      const text = `${(last.content[0] as { text: string }).text}\n\n${note}`;
      pending[pending.length - 1] = { ...last, content: [{ type: "text" as const, text }] };
      pendingTokens += estimateTextTokens(note);
    }
    outcomes = new Map();
    actions = [];
    const turnTokens = pendingTokens + estimateTextTokens(userText(question));
    if (!fits(turnTokens)) { stopped = true; break; }
    kept.unshift(question, ...pending);
    pending = [];
    pendingTokens = 0;
    turns += 1;
    tokens += turnTokens;
    if (turns >= limits.maxTurns) { stopped = true; break; }
  }
  // 摘要之后、第一条提问之前的回答（旧的切点落在一轮中间时会有）：放得下就留。
  if (!stopped && pending.length && fits(pendingTokens)) kept.unshift(...pending);
  return [...summary, ...kept, ...messages.slice(turnStart)];
}

/**
 * minimal：此前各轮只留文字（一号位的提问、回答正文），不带工具调用、工具结果与思考；只留最近 MINIMAL_TURNS 轮，
 * 开头的压缩摘要（pi 把它作为一条用户消息放在最前）保留。本轮原样。用于上游拒收这段历史、或历史太长时的最后一档重试。
 */
export function minimalHistory(messages: Context["messages"]): Context["messages"] {
  return textOnlyHistory(messages, { maxTurns: MINIMAL_TURNS });
}

/**
 * window：历史超过硬阈值、后台压缩的快照还没好时，这一轮只带「压缩摘要 + 最近若干轮的文字」（约 WINDOW_HISTORY_TOKENS），
 * 不当场压缩、也不改存下来的历史（conversationCompaction.ts）。
 */
export function windowHistory(messages: Context["messages"]): Context["messages"] {
  return textOnlyHistory(messages, { maxTurns: WINDOW_MAX_TURNS, minTurns: WINDOW_MIN_TURNS, budgetTokens: WINDOW_HISTORY_TOKENS });
}

/**
 * 压缩摘要换进来之前生成的 Claude 思考块不再回传：Claude 5.5 的思考块绑定生成它时的整段前缀，
 * 摘要替换了更早的轮次以后，保留下来的那几轮（以及后台压缩期间新增的几轮）的思考块都对不上了（新开户强制 400）。
 * 文字与工具调用照常保留；摘要之后才生成的轮次、本轮自己的思考块不动。
 */
export function withoutPreCompactionThinking(messages: Context["messages"], model: Pick<Model<any>, "api">): Context["messages"] {
  if (model.api !== "anthropic-messages" || !isCompactionSummary(messages[0])) return messages;
  const swappedAt = messages[0].timestamp;
  if (typeof swappedAt !== "number" || !Number.isFinite(swappedAt)) return messages;
  const turnStart = currentTurnStart(messages);
  let changed = false;
  const result = messages.map((message: Message, index) => {
    if (index >= turnStart || message.role !== "assistant" || message.timestamp >= swappedAt || !message.content.some((block) => block.type === "thinking")) return message;
    changed = true;
    return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
  });
  return changed ? result : messages;
}

/** 按历史模式整理交给目标模型的消息。 */
export function historyFor(messages: Context["messages"], model: Pick<Model<any>, "id" | "api" | "provider">, mode: HistoryMode = "normal"): Context["messages"] {
  const own = withoutPreCompactionThinking(withoutForeignReasoning(messages, model), model);
  const trimmed = mode === "minimal" ? minimalHistory(own) : mode === "window" ? windowHistory(own) : own;
  return withoutUpstreamItemIds(trimmed, model, mode);
}

const defaultStream: StreamFn = (model, context, options) => {
  const api = getApiProvider(model.api);
  if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
  return api.streamSimple(model, context, options);
};

/**
 * 缓存键（pi 用 sessionId 作 Responses 的 prompt_cache_key）：
 * - Responses：按「模型 + 系统提示 + 工具」取键，不同对话只要提示与工具相同就共用一份前缀缓存
 *   （10/13 实测按会话取键时，每段新对话的第一次调用都是 1.27 万 token 全量未命中）；
 * - Anthropic：缓存按前缀自动匹配，键只用于会话亲和请求头（没开），按「会话 + 模型」分开即可。
 */
export function cacheKeyFor(model: Pick<Model<any>, "id" | "api">, context: Pick<Context, "systemPrompt" | "tools">, sessionId: string): string {
  if (model.api !== "openai-responses") return `${sessionId}:${model.id}`;
  const prefix = createHash("sha256").update(`${context.systemPrompt ?? ""}\u0000${(context.tools ?? []).map((tool) => tool.name).join(",")}`).digest("hex").slice(0, 16);
  return `warmap:${model.id}:${prefix}`;
}

/** 带历史模式的 streamSimple（第四个参数）；按普通 StreamFn 调用时是 normal。 */
export type ModeStreamFn = (model: Model<any>, context: Context, options?: SimpleStreamOptions, mode?: HistoryMode) => AssistantMessageEventStream;

/** 包住 provider 的 streamSimple（可以是追踪包装后的）：先按历史模式整理历史、把缓存键按模型分开，再发请求。 */
export function conversationStreamSimple(inner: StreamFn | undefined): ModeStreamFn {
  const base = inner ?? defaultStream;
  return (model, context, options, mode = "normal") => base(model, { ...context, messages: historyFor(context.messages, model, mode) },
    options?.sessionId ? { ...options, sessionId: cacheKeyFor(model, context, options.sessionId) } : options);
}
