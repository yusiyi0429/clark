/**
 * 对话历史的后台滚动压缩（10/13 演示 12 一次轮前压缩让一号位干等 20 秒之后加的）。
 *
 * 一号位不懂「压缩」，也不该等它：
 * - 软阈值：一轮答完后，这条会话最近一次调用的上下文超过 SOFT_COMPACTION_TOKENS，就在后台起一次压缩，
 *   不在任何一轮的等待路径上；用户这时发下一问照常回答（用的还是原来的历史）。
 * - 滚动增量：新快照 = 压缩（上一份快照 + 之后新增、且不在最近原文里的轮次）。最近约 KEEP_RECENT_TOKENS 的轮次原样保留。
 * - 快照持久化在 conversation_compactions（带「覆盖到哪一条」：first_kept / covered / leaf 三个条目 id 与轮数）。
 *   下一轮开始时（持有这条会话的锁）原子换进去：在 pi 会话末尾追加一条 compaction 记录，firstKeptEntryId 指向快照算好的切点；
 *   快照算好之后才发生的那几轮都在切点之后，按原文接在摘要后面——这就是「镜像准备、无缝切换、再把增量补上」。
 *   正在跑的那一问不受影响（它开始时没有这份快照）。
 * - 硬阈值只作兜底，永远不当场压缩：历史仍超过 HARD_HISTORY_TOKENS（快照还没好、失败了、进程重启丢了任务）时，
 *   这一轮交给模型的是「已有快照 + 最近若干轮的文字」（conversationStream.ts 的 window 模式），存下来的历史不变；同时补起后台压缩。
 * - 任务生命周期：进程内按会话去重；库里一条会话同时只允许一个 running（唯一索引）；running 带租约，进程重启后租约过期即视为失败；
 *   失败按 COMPACTION_RETRY_DELAYS_MS 退避，下一次触发时再试。任何失败都不影响回答。
 * - 压缩只管对话本身的状态（一号位的决定与表态、偏好、没收尾的话题、引用过的对象 id）；正式事实每轮都从本体和上下文包重新读，不进摘要。
 *
 * 和「新建对话」/闲置重开的配合：快照按 conversation_id 存，归档的会话不再被换入；闲置重开读的是会话里最近一条 compaction，
 * 轮前已把就绪的快照换进历史，所以闲置重开拿到的是最新的摘要。
 */
import { randomUUID } from "node:crypto";
import {
  calculateContextTokens,
  convertToLlm,
  getLastAssistantUsage,
  sessionEntryToContextMessages,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { logEvent } from "./observability.js";
import { AGENT_ROLES, anonUserId, conversationScope, conversationThreadId, shortId, tracedTurn, tracingEnabled, withAgent } from "./tracing.js";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
type ContextMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

/** 一轮答完后，最近一次调用的上下文（系统提示 + 工具 + 历史 + 本轮）超过这么多 token 就在后台压缩。 */
export const SOFT_COMPACTION_TOKENS = 60_000;
/** 历史超过这么多 token 而快照还没好时，这一轮只带「快照 + 最近若干轮文字」（不当场压缩）。 */
export const HARD_HISTORY_TOKENS = 110_000;
/** 压缩时最近这么多 token（按中文估算）的轮次原样保留，至少保留最后一整轮；切点只落在一号位提问处，不切开一轮。 */
export const KEEP_RECENT_TOKENS = 16_000;
/** 能折进摘要的内容少于这么多 token 就不值得压缩（免得每轮都压一次）。 */
export const MIN_FOLD_TOKENS = 6_000;
/** 一次后台压缩最多跑这么久（不在任何人的等待路径上，只防挂死）。 */
export const COMPACTION_JOB_TIMEOUT_MS = 180_000;
/** running 的租约：进程重启或挂掉后，过了租约就视为失败，下一次触发重新压缩。 */
export const COMPACTION_LEASE_MS = 5 * 60_000;
/** 连续失败后的退避（第 1、2、3 次及以后）。 */
export const COMPACTION_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
/** 系统提示与工具定义大约占的 token（只在没有真实用量、按字数估算历史时补上）。 */
const PROMPT_OVERHEAD_TOKENS = 12_000;
/** 摘要正文的上限（字符）；超出说明模型没按要求写，按失败处理。 */
const SUMMARY_MAX_CHARS = 16_000;

/** 窗口兜底那一轮记在会话里（自定义条目）：下一轮的用量是窗口里的用量，不能拿来判断历史有多长。 */
export const HISTORY_WINDOW_ENTRY = "warmap.history-window";

/**
 * 中文为主的 token 估算：中文字符约 1.1 token / 字，其他字符约 3 字符 / token。
 * 用演示 12 真实用量的差值标定（Claude 偏多、GPT 偏少，取中间；pi 自带的「字符数 / 4」对中文少算 2–3 倍）。
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x3000 && code <= 0x303f)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.1 + other / 3);
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    const value = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
    if (value.type === "text") return value.text ?? "";
    if (value.type === "thinking") return value.thinking ?? "";
    if (value.type === "toolCall") return `${value.name ?? ""}${JSON.stringify(value.arguments ?? {})}`;
    return "";
  }).join("");
}

export function estimateMessageTokens(message: ContextMessage): number {
  const value = message as { role: string; content?: unknown; summary?: string };
  if (value.role === "compactionSummary" || value.role === "branchSummary") return estimateTextTokens(value.summary ?? "");
  return estimateTextTokens(blockText(value.content));
}

function entryTokens(entry: SessionEntry): number {
  return sessionEntryToContextMessages(entry).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

const isTurnStart = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "user";

/** pi 会话的当前分支（读不出来返回 undefined：坏历史由运行时自己重建，这里不碰）。 */
export function branchOf(entries: unknown[], sessionId: string): { manager: SessionManager; branch: SessionEntry[] } | undefined {
  if (!Array.isArray(entries) || entries.length < 2) return undefined;
  try {
    const manager = SessionManager.inMemory(process.cwd(), { id: sessionId }, structuredClone(entries) as Parameters<typeof SessionManager.inMemory>[2]);
    return { manager, branch: manager.getBranch() };
  } catch {
    return undefined;
  }
}

function latestCompactionIndex(branch: SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index -= 1) if (branch[index].type === "compaction") return index;
  return -1;
}

/** 最近一轮是不是窗口兜底（窗口标记在这一轮的提问之前、上一轮的提问之后）。 */
export function lastTurnWindowed(branch: SessionEntry[]): boolean {
  let seenTurn = false;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "compaction") return false;
    if (isTurnStart(entry)) {
      if (seenTurn) return false;
      seenTurn = true;
      continue;
    }
    if (seenTurn && entry.type === "custom" && entry.customType === HISTORY_WINDOW_ENTRY) return true;
  }
  return false;
}

/**
 * 这条会话现在的历史有多长（token）：
 * - 最近一次压缩之后有真实用量：取最后一次调用的上下文总量（含系统提示、工具与那一轮的上下文包，最准）；
 * - 最近一轮是窗口兜底，或压缩之后还没有用量：按字数估算最近一次压缩之后要发给模型的全部内容，再加上提示与工具的开销。
 */
export function historyTokens(branch: SessionEntry[]): { tokens: number; source: "usage" | "estimate" } {
  const compaction = latestCompactionIndex(branch);
  if (!lastTurnWindowed(branch)) {
    for (let index = branch.length - 1; index > compaction; index -= 1) {
      const entry = branch[index];
      const usage = entry.type === "message" ? getLastAssistantUsage([entry]) : undefined;
      if (usage) return { tokens: calculateContextTokens(usage), source: "usage" };
    }
  }
  let tokens = PROMPT_OVERHEAD_TOKENS;
  const start = compaction >= 0 ? (() => {
    const kept = branch.findIndex((entry) => entry.id === (branch[compaction] as { firstKeptEntryId?: string }).firstKeptEntryId);
    return kept >= 0 ? kept : compaction + 1;
  })() : 0;
  if (compaction >= 0) tokens += entryTokens(branch[compaction]);
  for (let index = start; index < branch.length; index += 1) if (branch[index].type !== "compaction") tokens += entryTokens(branch[index]);
  return { tokens, source: "estimate" };
}

export type CompactionPlan = {
  /** 快照建立在哪一条压缩记录之上（没有压缩过为 null）；换入时这条必须仍是分支上最近的压缩，否则快照过期。 */
  baseCompactionId: string | null;
  previousSummary?: string;
  /** 切点：从这一条（一号位的一次提问）起原样保留。 */
  firstKeptEntryId: string;
  /** 折进摘要的最后一条。 */
  coveredEntryId: string;
  /** 做快照时的最后一条（换入时必须仍在分支上）。 */
  leafEntryId: string;
  /** 折进摘要的轮数（含之前快照已经覆盖的）与原样保留的轮数。 */
  coveredTurns: number;
  keptTurns: number;
  /** 分支上第几条之前的都已折进摘要（covered 在分支里的下标 + 1）。 */
  coveredEntries: number;
  foldMessages: ContextMessage[];
  /** 原样保留的那几轮里一号位的原话（只取原话，给压缩模型记决定与偏好；原文另外保留）。 */
  keptQuestions: { text: string; at?: number }[];
  /** 折进摘要的最后一问的时间（毫秒）。 */
  lastCoveredAt?: number;
  foldTokens: number;
  keptTokens: number;
  /** 压缩前这条会话的历史长度（token，见 historyTokens）。 */
  tokensBefore: number;
  tokensSource: "usage" | "estimate";
};

export type CompactionSkip = { skip: "unreadable" | "below_threshold" | "no_turns" | "too_small"; tokensBefore?: number };

/**
 * 算一次滚动压缩要折哪些内容。切点只落在一号位的提问上（不把一轮切成两半），且在上一份快照之后，
 * 这样换入后模型看到的是「新摘要 + 切点之后的原文」，旧摘要不会夹在中间。
 */
export function planCompaction(entries: unknown[], sessionId: string, options: { softTokens?: number; keepRecentTokens?: number; minFoldTokens?: number; force?: boolean } = {}): CompactionPlan | CompactionSkip {
  const loaded = branchOf(entries, sessionId);
  if (!loaded) return { skip: "unreadable" };
  const { branch } = loaded;
  const size = historyTokens(branch);
  if (!options.force && size.tokens <= (options.softTokens ?? SOFT_COMPACTION_TOKENS)) return { skip: "below_threshold", tokensBefore: size.tokens };
  const previousIndex = latestCompactionIndex(branch);
  const previous = previousIndex >= 0 ? branch[previousIndex] as Extract<SessionEntry, { type: "compaction" }> : undefined;
  let start = 0;
  if (previous) {
    const kept = branch.findIndex((entry) => entry.id === previous.firstKeptEntryId);
    start = kept >= 0 ? kept : previousIndex + 1;
  }
  const candidates: number[] = [];
  for (let index = Math.max(previousIndex + 1, start + 1); index < branch.length; index += 1) if (isTurnStart(branch[index])) candidates.push(index);
  if (!candidates.length) return { skip: "no_turns", tokensBefore: size.tokens };
  const suffix = new Array<number>(branch.length + 1).fill(0);
  for (let index = branch.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + (branch[index].type === "compaction" ? 0 : entryTokens(branch[index]));
  const keep = options.keepRecentTokens ?? KEEP_RECENT_TOKENS;
  let cut = candidates[0];
  for (let at = candidates.length - 1; at >= 0; at -= 1) {
    if (suffix[candidates[at]] >= keep) { cut = candidates[at]; break; }
  }
  const fold = branch.slice(start, cut).filter((entry) => entry.type !== "compaction");
  const foldTokens = fold.reduce((sum, entry) => sum + entryTokens(entry), 0);
  if (foldTokens < (options.minFoldTokens ?? MIN_FOLD_TOKENS)) return { skip: "too_small", tokensBefore: size.tokens };
  const turnsBefore = branch.slice(0, cut).filter(isTurnStart).length;
  return {
    baseCompactionId: previous?.id ?? null,
    ...(previous?.summary ? { previousSummary: previous.summary } : {}),
    firstKeptEntryId: branch[cut].id,
    coveredEntryId: branch[cut - 1].id,
    leafEntryId: branch[branch.length - 1].id,
    coveredTurns: turnsBefore,
    keptTurns: candidates.filter((index) => index >= cut).length,
    coveredEntries: cut,
    foldMessages: fold.flatMap((entry) => sessionEntryToContextMessages(entry)),
    keptQuestions: branch.slice(cut).filter(isTurnStart).map((entry) => {
      const message = (entry as Extract<SessionEntry, { type: "message" }>).message as { content: unknown; timestamp?: number };
      const text = blockText(message.content);
      return { text: clip(questionOf(text)?.message ?? text, 600), ...(typeof message.timestamp === "number" ? { at: message.timestamp } : {}) };
    }),
    ...(() => {
      const last = branch.slice(0, cut).filter(isTurnStart).at(-1) as Extract<SessionEntry, { type: "message" }> | undefined;
      const at = (last?.message as { timestamp?: number } | undefined)?.timestamp;
      return typeof at === "number" ? { lastCoveredAt: at } : {};
    })(),
    foldTokens,
    keptTokens: suffix[cut],
    tokensBefore: size.tokens,
    tokensSource: size.source,
  };
}

// ───────────────────────────── 交给压缩模型的文字 ─────────────────────────────

/** 这些工具的结果是对话状态（生成的确认卡、真实写入的回执），留一小段；其余工具的结果（检索原文、读取的材料）不进摘要。 */
const STATE_TOOLS = /^(propose_|apply_business_proposal|update_business_object|create_business_object|run_business_action|edit_|create_material|propose_material_edit|ask_mission_card_question)/;

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text);

function beijingTime(timestamp: unknown): string {
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(String(timestamp ?? ""));
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms + 8 * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

type CardSnapshot = { kind?: string; title?: string; objectRef?: { type?: string; id?: string } };
const cardLine = (card: CardSnapshot) => `${card.kind ?? card.objectRef?.type ?? "对象"}「${card.title ?? ""}」（id=${card.objectRef?.id ?? ""}）`;

/** 一轮的上下文包（JSON）只留一号位的原话、所在页面对象与显式引用；页面摘要、预取的检索结果等每轮会重新给，不进历史摘要。 */
export function questionOf(text: string): { message: string; currentObject?: CardSnapshot; references: CardSnapshot[]; resumed: boolean } | undefined {
  try {
    const pack = JSON.parse(text) as { message?: unknown; currentObject?: CardSnapshot | null; references?: CardSnapshot[] | null; resume?: unknown };
    if (!pack || typeof pack !== "object" || typeof pack.message !== "string") return undefined;
    return {
      message: pack.message,
      ...(pack.currentObject && typeof pack.currentObject === "object" ? { currentObject: pack.currentObject } : {}),
      references: Array.isArray(pack.references) ? pack.references.filter((item) => item && typeof item === "object") : [],
      resumed: typeof pack.resume === "string",
    };
  } catch {
    return undefined;
  }
}

/** 把要折进摘要的消息写成一段对话记录（不是要续写的对话）。 */
export function transcriptForSummary(messages: ContextMessage[]): string {
  const lines: string[] = [];
  for (const message of convertToLlm(messages)) {
    const at = beijingTime((message as { timestamp?: unknown }).timestamp);
    if (message.role === "user") {
      const text = blockText(message.content);
      const question = questionOf(text);
      if (!question) { lines.push(`[一号位${at ? ` · ${at}` : ""}]：${clip(text, 4_000)}`); continue; }
      const where = question.currentObject ? ` · 页面：${cardLine(question.currentObject)}` : "";
      const refs = question.references.length ? `\n（引用：${question.references.map(cardLine).join("；")}）` : "";
      lines.push(`[一号位${at ? ` · ${at}` : ""}${where}]：${question.resumed ? "（点了「继续」）" : ""}${clip(question.message, 4_000)}${refs}`);
    } else if (message.role === "assistant") {
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
      if (text) lines.push(`[天枢]：${clip(text, 8_000)}`);
      for (const block of message.content) {
        if (block.type === "toolCall") lines.push(`[天枢调用工具]：${block.name}(${clip(JSON.stringify(block.arguments ?? {}), 400)})`);
      }
    } else if (message.role === "toolResult") {
      if (!STATE_TOOLS.test(message.toolName)) continue;
      lines.push(`[工具结果 · ${message.toolName}${message.isError ? " · 出错" : ""}]：${clip(blockText(message.content), 600)}`);
    }
  }
  return lines.join("\n\n");
}

export const COMPACTION_SYSTEM_PROMPT = "你负责整理一号位（集团 CEO）与天枢（一号位的 Agent）之间的长对话，写成一份「对话记忆」。只输出记忆正文，不回答对话里的问题，不调用工具。";

export const COMPACTION_INSTRUCTIONS = `请把上面的对话整理成一份「对话记忆」。之后天枢回答时只看得到这份记忆和最近几轮原文，看不到更早的对话。
战场目标、进展、议题、指标、会议这些正式事实每轮都会从系统实时重新读取，不需要你记；你只记对话本身的状态。

用中文，按下面几节写，某节没有内容就写「无」：

## 一号位的决定与表态
- 一号位明确拍板、同意、否定、要求的事：原话要点、针对哪个对象，按时间先后。

## 一号位明确说过的偏好与要求
- 表达方式、口径、关注点、不要什么（例如「统一成一段话说」）。只写一号位明确说出的，不要从提问内容推断。

## 已形成的结论
- 天枢给出、一号位没有反对的判断与建议，按话题写。
- 天枢已经答过的事实问题，保留答案里的关键名称、数字、日期和出处名称（例如融资的轮次、时间、金额、主要投资方），不必逐字。
- 被一号位推翻或后来更正的说法不写，只写最新版本。

## 还没收尾的话题
- 一号位问了但没有答完的、天枢答应了还没做的、等一号位确认的（含已经生成、等确认的确认卡）。

## 对话里引用过的对象
- 类型、名称和 id（议题、会议、战场、战役、确认卡等），id 原样照抄。

## 最近在谈什么
- 一两句：最近的话题和一号位的关注点。

规则：
- 只根据对话内容写，不补充对话里没有的事实，不自己推算数字。
- 检索原文、工具的中间结果、页面摘要不要抄进来，只留对后续对话有用的结论和出处名称。
- 有「之前的对话记忆」时，把它和新的对话合并成一份完整的新记忆：仍然成立的保留，其中的具体名称、数字、日期和 id 不要删减；被新对话更正的以新对话为准。
- 有「之后几轮一号位的原话」时：那几轮的原文会另外保留给天枢，其中一号位的决定、表态和偏好也写进前两节，其余内容不用写。
- 不要调用工具，只输出记忆正文，总长不超过 4000 字。`;

export function compactionPrompt(previousSummary: string | undefined, transcript: string, keptQuestions: { text: string; at?: number }[] = []): string {
  const kept = keptQuestions.length
    ? `<之后几轮一号位的原话>\n${keptQuestions.map((item) => `[一号位${item.at ? ` · ${beijingTime(item.at)}` : ""}]：${item.text}`).join("\n")}\n</之后几轮一号位的原话>\n\n` : "";
  return `${previousSummary ? `<之前的对话记忆>\n${previousSummary}\n</之前的对话记忆>\n\n` : ""}<对话>\n${transcript}\n</对话>\n\n${kept}${COMPACTION_INSTRUCTIONS}`;
}

/**
 * 记忆末尾一行覆盖范围（系统加，不是模型写的）：模型容易把记忆里写「无」当成整段对话都没有，
 * 这一行提醒它之后的原文比记忆新、以原文为准。滚动压缩时上一份的这一行会被下一份取代。
 */
export function coverageNote(plan: Pick<CompactionPlan, "coveredTurns" | "lastCoveredAt">): string {
  const at = plan.lastCoveredAt ? beijingTime(plan.lastCoveredAt) : "";
  return `（这份对话记忆覆盖到第 ${plan.coveredTurns} 轮${at ? `（最后一问在 ${at}）` : ""}；之后的对话以原文为准，记忆里写「无」的项，之后的原文里可能有。）`;
}
const COVERAGE_NOTE = /\n*（这份对话记忆覆盖到第 \d+ 轮[\s\S]*$/;
/** 交给下一次滚动压缩的上一份记忆：去掉旧的覆盖范围行。 */
export function withoutCoverageNote(summary: string): string {
  return summary.replace(COVERAGE_NOTE, "").trimEnd();
}

/** 一次滚动压缩交给压缩模型的整段文字：上一份记忆（去掉覆盖范围行）+ 要折进来的对话 + 保留原文那几轮的一号位原话 + 要求。 */
export function summaryPromptFor(plan: Pick<CompactionPlan, "previousSummary" | "foldMessages" | "keptQuestions">): string {
  return compactionPrompt(plan.previousSummary ? withoutCoverageNote(plan.previousSummary) : undefined, transcriptForSummary(plan.foldMessages), plan.keptQuestions);
}

// ───────────────────────────── 换入 ─────────────────────────────

export type StoredSnapshot = {
  id: string;
  summary: string;
  baseCompactionId: string | null;
  firstKeptEntryId: string;
  coveredEntryId: string;
  leafEntryId: string;
  coveredTurns: number;
  tokensBefore: number;
  model?: string | null;
  usage?: Usage | null;
};

export type ApplyResult =
  | { applied: true; runtimeEntries: unknown[]; entryId: string }
  | { applied: false; reason: "unreadable" | "already_applied" | "stale" };

/**
 * 把一份就绪的快照换进会话：分支上最近的压缩仍是快照的基础、切点与做快照时的最后一条都还在分支上，
 * 就在末尾追加一条 compaction 记录（details.snapshotId 记来源，重复换入会被认出来）。不调模型，毫秒级。
 */
export function applySnapshot(entries: unknown[], sessionId: string, snapshot: StoredSnapshot): ApplyResult {
  const loaded = branchOf(entries, sessionId);
  if (!loaded) return { applied: false, reason: "unreadable" };
  const { manager, branch } = loaded;
  if (branch.some((entry) => entry.type === "compaction" && (entry.details as { snapshotId?: unknown } | undefined)?.snapshotId === snapshot.id)) {
    return { applied: false, reason: "already_applied" };
  }
  const latest = latestCompactionIndex(branch);
  const base = latest >= 0 ? branch[latest].id : null;
  const ids = new Set(branch.map((entry) => entry.id));
  if (base !== snapshot.baseCompactionId || !ids.has(snapshot.firstKeptEntryId) || !ids.has(snapshot.leafEntryId)) return { applied: false, reason: "stale" };
  const firstKept = branch.findIndex((entry) => entry.id === snapshot.firstKeptEntryId);
  if (firstKept <= latest) return { applied: false, reason: "stale" };
  const entryId = manager.appendCompaction(snapshot.summary, snapshot.firstKeptEntryId, snapshot.tokensBefore,
    { snapshotId: snapshot.id, coveredEntryId: snapshot.coveredEntryId, coveredTurns: snapshot.coveredTurns, ...(snapshot.model ? { model: snapshot.model } : {}) },
    true, snapshot.usage ?? undefined);
  const header = manager.getHeader();
  return { applied: true, runtimeEntries: [...(header ? [header] : []), ...manager.getEntries()], entryId };
}

// ───────────────────────────── 后台任务 ─────────────────────────────

/** 由对话运行时提供：用后台压缩模型写摘要（失败时换备用模型）。 */
export type HistorySummarizer = (input: { systemPrompt: string; prompt: string; signal: AbortSignal }) => Promise<{ text: string; usage?: Usage; model: string; fallbackFrom?: string }>;

export type ConversationCompaction = {
  /**
   * 轮前（持有会话锁）：有就绪的快照就换进这一轮要用的历史；历史已经超过软阈值又没有快照在做，就补起一次后台压缩。
   * 不调模型、不等后台任务；任何出错都退回原历史。
   */
  prepareTurn(query: Query, row: { id: string; pi_session_id: string; runtime_entries: unknown[] }): Promise<{ runtimeEntries: unknown[]; snapshotId?: string }>;
  /** 这一轮的历史（含换入的快照）已经落库。 */
  markApplied(query: Query, snapshotId: string): Promise<void>;
  /** 一轮结束后（锁已释放）：需要就在后台压缩，调用方不等。 */
  schedule(conversationId: string, trigger: CompactionTrigger): void;
  /** 等进程内所有后台压缩结束（关闭服务、测试）。 */
  idle(): Promise<void>;
  /** 服务启动时：上一个进程留下的 running（进程重启、崩溃时在做的）记为失败，下一次触发时重新做。 */
  recoverInterrupted(): Promise<number>;
};

export type CompactionTrigger = "after_turn" | "turn_start";

export type ConversationCompactionOptions = {
  query: Query;
  summarize?: HistorySummarizer;
  softTokens?: number;
  keepRecentTokens?: number;
  minFoldTokens?: number;
  jobTimeoutMs?: number;
  leaseMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
};

const SNAPSHOT_COLUMNS = "id, summary, base_compaction_id, first_kept_entry_id, covered_entry_id, leaf_entry_id, covered_turns, tokens_before, model, usage";
const snapshotOf = (row: Record<string, unknown>): StoredSnapshot => ({
  id: String(row.id), summary: String(row.summary ?? ""), baseCompactionId: (row.base_compaction_id as string | null) ?? null,
  firstKeptEntryId: String(row.first_kept_entry_id), coveredEntryId: String(row.covered_entry_id), leafEntryId: String(row.leaf_entry_id),
  coveredTurns: Number(row.covered_turns ?? 0), tokensBefore: Number(row.tokens_before ?? 0), model: (row.model as string | null) ?? null,
  usage: (row.usage as Usage | null) ?? null,
});

function abortableTimeout(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`background compaction exceeded ${ms} ms`)), ms);
  (timer as { unref?: () => void }).unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export function createConversationCompaction(options: ConversationCompactionOptions): ConversationCompaction {
  const { query, summarize } = options;
  const now = options.now ?? (() => Date.now());
  const soft = options.softTokens ?? SOFT_COMPACTION_TOKENS;
  const delays = options.retryDelaysMs ?? COMPACTION_RETRY_DELAYS_MS;
  const leaseMs = options.leaseMs ?? COMPACTION_LEASE_MS;
  const inflight = new Map<string, Promise<void>>();
  const startedAt = Date.now();

  const run = async (conversationId: string, trigger: CompactionTrigger) => {
    const row = (await query(
      // 已归档（「新建对话」）的不做：切回来继续时，那一轮开头会按需补做。
      "SELECT id, owner_id, scope, pi_session_id, runtime_entries FROM conversations WHERE id = $1 AND deleted_at IS NULL AND archived_at IS NULL", [conversationId])).rows[0] as
      { id: string; owner_id: string | null; scope: string; pi_session_id: string; runtime_entries: unknown[] } | undefined;
    if (!row) return;
    const plan = planCompaction(row.runtime_entries, row.pi_session_id, { softTokens: soft, keepRecentTokens: options.keepRecentTokens, minFoldTokens: options.minFoldTokens });
    if ("skip" in plan) {
      if (plan.skip !== "below_threshold") logEvent({ event: "conversation.compaction", conversationId, trigger, status: "skipped", reason: plan.skip, tokensBefore: plan.tokensBefore });
      return;
    }
    // 租约过期的 running（进程重启、挂掉）算失败；同一时刻一条会话只做一份。
    await query(`UPDATE conversation_compactions SET status = 'failed', error = 'lease expired', completed_at = now(), lease_until = NULL
                  WHERE conversation_id = $1 AND status = 'running' AND lease_until < now()`, [conversationId]);
    const recent = (await query(`SELECT status, pi_session_id, base_compaction_id, completed_at FROM conversation_compactions
                                  WHERE conversation_id = $1 ORDER BY started_at DESC LIMIT 6`, [conversationId])).rows as
      { status: string; pi_session_id: string; base_compaction_id: string | null; completed_at: Date | null }[];
    if (recent.some((item) => item.status === "running")) return;
    // 还有一份没换入、仍然有效的快照：下一轮就会用上，不重复做。
    if (recent.some((item) => item.status === "ready" && item.pi_session_id === row.pi_session_id && item.base_compaction_id === plan.baseCompactionId)) return;
    // 连续失败按次数退避。
    let failures = 0;
    for (const item of recent) { if (item.status !== "failed") break; failures += 1; }
    if (failures > 0) {
      const last = recent[0].completed_at ? new Date(recent[0].completed_at).getTime() : 0;
      const wait = delays[Math.min(failures - 1, delays.length - 1)] ?? 0;
      if (now() - last < wait) {
        logEvent({ event: "conversation.compaction", conversationId, trigger, status: "backoff", failures, retryInMs: wait - (now() - last) });
        return;
      }
    }
    const id = randomUUID();
    const claimed = await query(
      `INSERT INTO conversation_compactions (id, conversation_id, pi_session_id, status, trigger_kind, attempt, base_compaction_id, first_kept_entry_id,
         covered_entry_id, leaf_entry_id, covered_entries, covered_turns, kept_turns, tokens_before, tokens_source, history_tokens_folded, history_tokens_kept, lease_until)
       VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now() + ($17::int * interval '1 millisecond'))
       ON CONFLICT (conversation_id) WHERE status = 'running' DO NOTHING RETURNING id`,
      [id, conversationId, row.pi_session_id, trigger, failures + 1, plan.baseCompactionId, plan.firstKeptEntryId, plan.coveredEntryId, plan.leafEntryId,
        plan.coveredEntries, plan.coveredTurns, plan.keptTurns, plan.tokensBefore, plan.tokensSource, plan.foldTokens, plan.keptTokens, leaseMs]);
    if (!claimed.rowCount) return;
    const startedAt = now();
    const base = { event: "conversation.compaction", conversationId, snapshotId: id, trigger, attempt: failures + 1 };
    logEvent({ ...base, status: "started", tokensBefore: plan.tokensBefore, tokensSource: plan.tokensSource, foldTokens: plan.foldTokens, keptTokens: plan.keptTokens,
      coveredTurns: plan.coveredTurns, keptTurns: plan.keptTurns, rolling: Boolean(plan.previousSummary) });
    const timeout = abortableTimeout(options.jobTimeoutMs ?? COMPACTION_JOB_TIMEOUT_MS);
    try {
      const prompt = summaryPromptFor(plan);
      const work = () => summarize!({ systemPrompt: COMPACTION_SYSTEM_PROMPT, prompt, signal: timeout.signal });
      const result = tracingEnabled() ? await tracedTurn({
        resolve: async () => ({
          agentRole: AGENT_ROLES.conversationCompaction,
          logicalTurnId: `cmp-${shortId(conversationId)}-t${plan.coveredTurns}`,
          attempt: failures + 1,
          threadId: await conversationThreadId(query, conversationId),
          scope: conversationScope(row.scope),
          anonUserId: anonUserId(row.owner_id ?? undefined),
          inputs: { trigger, tokensBefore: plan.tokensBefore, foldTokens: plan.foldTokens, keptTokens: plan.keptTokens, coveredTurns: plan.coveredTurns, rolling: Boolean(plan.previousSummary) },
        }),
        outputs: (value) => ({ model: value.model, summaryChars: value.text.length, summaryTokens: estimateTextTokens(value.text), historyTokensAfter: estimateTextTokens(value.text) + plan.keptTokens }),
      }, () => withAgent(AGENT_ROLES.conversationCompaction, work)) : await work();
      const written = result.text.trim();
      if (written.length < 10) throw new Error("summary too short");
      if (written.length > SUMMARY_MAX_CHARS) throw new Error(`summary too long (${written.length} chars)`);
      const text = `${withoutCoverageNote(written)}\n\n${coverageNote(plan)}`;
      const summaryTokens = estimateTextTokens(text);
      const durationMs = now() - startedAt;
      await query(
        `UPDATE conversation_compactions SET status = 'ready', summary = $2, model = $3, usage = $4::jsonb, summary_tokens = $5, history_tokens_after = $6,
           duration_ms = $7, completed_at = now(), lease_until = NULL WHERE id = $1 AND status = 'running'`,
        [id, text, result.model, JSON.stringify(result.usage ?? null), summaryTokens, summaryTokens + plan.keptTokens, durationMs]);
      await query("UPDATE conversation_compactions SET status = 'superseded' WHERE conversation_id = $1 AND status = 'ready' AND id <> $2", [conversationId, id]);
      logEvent({ ...base, status: "ready", durationMs, model: result.model, ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
        tokensBefore: plan.tokensBefore, historyTokensBefore: plan.foldTokens + plan.keptTokens + (plan.previousSummary ? estimateTextTokens(plan.previousSummary) : 0),
        historyTokensAfter: summaryTokens + plan.keptTokens, summaryChars: text.length, summaryTokens,
        summarizerInput: result.usage ? result.usage.input + result.usage.cacheRead + result.usage.cacheWrite : undefined, summarizerOutput: result.usage?.output });
    } catch (cause) {
      const message = (cause as Error)?.message ?? String(cause);
      await query("UPDATE conversation_compactions SET status = 'failed', error = $2, duration_ms = $3, completed_at = now(), lease_until = NULL WHERE id = $1",
        [id, message.slice(0, 1_000), now() - startedAt]).catch(() => undefined);
      logEvent({ ...base, status: "failed", durationMs: now() - startedAt, errorCode: timeout.signal.aborted ? "COMPACTION_TIMEOUT" : "COMPACTION_FAILED", reason: message.slice(0, 300) });
    } finally {
      timeout.dispose();
    }
  };

  const schedule = (conversationId: string, trigger: CompactionTrigger) => {
    if (!summarize || inflight.has(conversationId)) return;
    const job = run(conversationId, trigger)
      .catch((cause) => logEvent({ event: "conversation.compaction", conversationId, trigger, status: "failed", errorCode: "COMPACTION_SCHEDULE_FAILED", reason: String((cause as Error)?.message ?? cause).slice(0, 300) }))
      .finally(() => { inflight.delete(conversationId); });
    inflight.set(conversationId, job);
  };

  return {
    async prepareTurn(turnQuery, row) {
      const original = { runtimeEntries: row.runtime_entries };
      try {
        // 只认这条会话、这段 pi 会话上做的快照（闲置重开、坏历史重建会换 pi 会话，旧快照的条目 id 对不上）。
        const ready = (await turnQuery(`SELECT ${SNAPSHOT_COLUMNS}, completed_at FROM conversation_compactions
                                         WHERE conversation_id = $1 AND pi_session_id = $2 AND status = 'ready' ORDER BY completed_at DESC LIMIT 1`, [row.id, row.pi_session_id])).rows[0];
        if (ready) {
          const snapshot = snapshotOf(ready);
          const result = applySnapshot(row.runtime_entries, row.pi_session_id, snapshot);
          if (result.applied) {
            logEvent({ event: "conversation.compaction", conversationId: row.id, snapshotId: snapshot.id, status: "applied", coveredTurns: snapshot.coveredTurns,
              snapshotAgeMs: ready.completed_at ? now() - new Date(ready.completed_at).getTime() : undefined });
            return { runtimeEntries: result.runtimeEntries, snapshotId: snapshot.id };
          }
          await turnQuery(`UPDATE conversation_compactions SET status = $2, applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END WHERE id = $1`,
            [snapshot.id, result.reason === "already_applied" ? "applied" : "superseded"]);
          if (result.reason !== "already_applied") logEvent({ event: "conversation.compaction", conversationId: row.id, snapshotId: snapshot.id, status: "superseded", reason: result.reason });
        }
        // 历史已经很长、却没有快照在做（进程重启丢了任务、上一轮之前就很长）：现在就在后台补做，这一轮照常回答。
        const loaded = branchOf(row.runtime_entries, row.pi_session_id);
        if (summarize && loaded && historyTokens(loaded.branch).tokens > soft) schedule(row.id, "turn_start");
      } catch (cause) {
        logEvent({ event: "conversation.compaction", conversationId: row.id, status: "prepare_failed", reason: String((cause as Error)?.message ?? cause).slice(0, 300) });
      }
      return original;
    },
    async markApplied(turnQuery, snapshotId) {
      await turnQuery("UPDATE conversation_compactions SET status = 'applied', applied_at = now() WHERE id = $1 AND status = 'ready'", [snapshotId])
        .catch((cause) => logEvent({ event: "conversation.compaction", snapshotId, status: "mark_failed", reason: String((cause as Error)?.message ?? cause).slice(0, 300) }));
    },
    schedule,
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight.values()]);
    },
    async recoverInterrupted() {
      // 只动本进程启动之前开始的（同一个库只由一个服务进程写；租约过期判断照样兜底）。
      const result = await query(`UPDATE conversation_compactions SET status = 'failed', error = 'interrupted by restart', completed_at = now(), lease_until = NULL
                                   WHERE status = 'running' AND started_at < $1`, [new Date(startedAt)]);
      const count = result.rowCount ?? 0;
      if (count) logEvent({ event: "conversation.compaction", status: "interrupted", count });
      return count;
    },
  };
}
