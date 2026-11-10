"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseSseBlock, splitSse, type ConversationEvent } from "./sse";
import type { Step, StepStatus } from "@/components/steps/StepList";
import type { TAskAnswerInput, TAskAnswerRecord, TBuddyPlan, TConversationCard, TConversationModel, TReadScope, TReadScopeParams } from "@warmap/contracts";
import type { components } from "@/lib/api/schema";
import { afterResize, resizing } from "./resizeGate";
import { useStableCallback } from "./stableCallback";
import { backoff, HISTORY_RETRY_MS, offline, pause, RECONNECT_MS } from "./reconnect";
import { emitBuddyUi } from "@/lib/buddy/uiEvent";

/**
 * 对话的数据与调用：一个人在一个页面有一条当前对话（默认一直接着往下聊，用户感觉不到「会话」）。
 * 「新对话」把当前这条归档（不删除，能回看、能切回去继续），换一条空白的；入口很小，不打扰日常使用。
 * - 历史和发送都走按 scope 的端点；发送走 SSE，完成后重载历史；
 * - 附件直接挂在这条对话上，不用先选什么。
 * - 历史读取有自己的状态（载入中 / 已读到 / 失败可重试）：失败不显示成「暂无消息」，
 *   已读到且 0 条才是真的没有记录；换 scope 或卸载后，上一个 scope 迟到的结果一律不写进来。
 * 展示态（思考阶段、秒数、失败文案）在这里派生，供 clark 风格的界面使用。
 */

export type ReferenceSnapshot = { cardId: string; version: number; kind: string; title: string };
/**
 * runId：这一轮的标识（提问与回答同一个），提案卡按它插进时间线；本地刚发出、还没读回历史的那句没有。
 * recoveryNote：这一轮用了备用模型或走过恢复（重试、续写、精简历史）时，回答末尾那行很淡的说明（text）和悬停说明（detail）。
 */
export type RecoveryNote = { text: string; detail: string };
export type Message = { sequence: number; role: "user" | "assistant"; content: string; referencesSnapshot?: ReferenceSnapshot[]; attachments?: Attachment[]; createdAt?: string; runId?: string;
  recoveryNote?: RecoveryNote;
  /** 这一轮实际装进上下文的个人记忆 id（服务端随历史给）：回答里的记忆标记只认这些。 */
  memoryUsed?: string[];
  /** 这一轮工具生成的卡（生成复盘、帮我问问、请同事帮忙），排在回答后面。 */
  cards?: TConversationCard[];
  /** 这一轮跨对象读取的范围（三层取用），回答上显示成可以点开调整的范围标签。 */
  readScope?: TReadScope;
  /** 回答 Agent 提问的那一句：问答记录（界面画成紧凑的问答，不显示原文）。 */
  answers?: TAskAnswerRecord;
  /** carried：转议题时从首页带过来的一段；trace：首页留痕行「已转到议题 X」，meta.href 直达。 */
  kind?: "carried" | "trace";
  /**
   * 这一句是在飞书私聊天枢机器人或微信 ClawBot 里说的（问与答都标）；buddy 是伙伴从伙伴台转到项目对话里的本人那句（17.4 message_project）；
   * report 是子会话停了、云端替本人给项目主管线发的那句（18.10）：不画成本人的气泡，报告本身是项目动态里的 sub_session_report。
   */
  via?: "feishu" | "wechat" | "buddy" | "report";
  /** 只在本人的提问上：这一轮服务端还在回答。 */
  running?: boolean;
  /**
   * 伙伴对话里本人这一句的回执（17.4）：delivered 天枢收下了，read 伙伴读到了；failed 收下以后这一轮没开成，旁边给「重发」。读回的历史都算 read。
   */
  receipt?: "delivered" | "read" | "failed";
  /** 回执帧里天枢给这一句的 id（本地刚发出的那句，两帧按它对上）。 */
  messageId?: string;
  /** 伙伴这一轮最后一张计划清单（17.4，只在回答上）。 */
  plan?: TBuddyPlan;
  /** 这一轮实际用的来源和模型（只在走 Chat 的回答上）。 */
  model?: TConversationModel;
  meta?: { issueId?: string; title?: string; href?: string } };
export type Attachment = { id: string; fileName: string; mimeType: string };
export type ConversationStatus = "idle" | "streaming" | "complete" | "failed" | "aborted";
/** 历史读取：`ready` 且 0 条 = 真的没有记录；`error` = 没读到（不代表没有记录）。与一轮回答的 `status` 无关。 */
export type HistoryStatus = "loading" | "ready" | "error";
/** clark 的三段思考：尚无事件 = 思考；开始用工具 = 快速查证；首个文字 = 整理回答。 */
/**
 * understanding：刚发出、档位还没定；thinking：模型在思考；researching：在查证；answering：正文在写。
 * connecting / offline：这句还没送到（或回答断了正在接上），自己在重连 / 在等网络恢复。
 */
export type ThinkingStage = "understanding" | "thinking" | "researching" | "answering" | "connecting" | "offline";
/**
 * 进度行（第 2 段，系统生成，不由模型写）：最近一步在查什么 / 读到了什么、已查完几项、思考要点（推理摘要里有中文要点时）、
 * 非深度档的中途升级提示。
 */
export type TurnProgress = {
  label: string | null;
  checked: number;
  thought?: string | null;
  escalation?: { notice: string; expectSeconds: number } | null;
};
/**
 * 模型真实的思考摘要（Claude 档的 thinking 事件带 delta，英文段落服务端已译成中文）：回答进行中在进度区滚动显示最近几行；
 * 正文开始后收成「已思考 N 秒」，点开看全文。seconds：从发出到正文第一个字的秒数，正文还没开始时为 null。
 * 只放模型返回的摘要；GPT 档没有这段，仍用进度行的状态与要点。
 */
export type TurnThought = { text: string; seconds: number | null };
/** 本轮档位（服务端 route 事件）：深度档在开头先给一段开场说明和预计用时。 */
/** 一帧里排着要写进去的：正文有没有新到、最新的思考摘要、按到达顺序的进度变化。 */
type FrameUpdate = { partial: boolean; thought?: TurnThought; progress: ((current: TurnProgress) => TurnProgress)[] };
const emptyFrame = (): FrameUpdate => ({ partial: false, progress: [] });
/** partialFrame 的一个取值：这一帧到了，但对话层正在放大 / 收起，等过渡结束再写（resizeGate）。 */
const RESIZE_WAIT = -1;

export type TurnRoute = { tier: "quick" | "grounded" | "deep"; expectSeconds: number; notice?: string };

/** 深度档的开场说明在前，空一行接正文；与服务端存进记录的写法一致，读回历史时不跳。 */
export function withNotice(notice: string | undefined, body: string): string {
  if (!notice) return body;
  return body ? `${notice}\n\n${body}` : notice;
}
export type CardRef = { cardId: string; version: number };
/** 页面聚焦的卡（Anchor）：每一句都带上，服务端按它确定「这张卡」指的是什么；与批注引用分开。 */
export type AnchorSelection = NonNullable<components["schemas"]["ConversationMessageRequest"]["anchorSelection"]>;
/** 发送时带上卡片的类型与标题：只用来在乐观渲染的那条提问上先画出「引用了 N 张卡片」，请求里仍只发 cardId / version。 */
export type SentCardRef = CardRef & { kind?: string; title?: string };

/** 刚发出那句的本地形态：与服务端读回的同形（引用快照、附件），读回来时不闪不跳。 */
export function pendingUserMessage(sequence: number, content: string, references: SentCardRef[], attachments: Attachment[]): Message {
  const snapshots = references.filter((reference) => reference.title)
    .map(({ cardId, version, kind, title }) => ({ cardId, version, kind: kind ?? "", title: title ?? "" }));
  return { sequence, role: "user", content,
    ...(snapshots.length ? { referencesSnapshot: snapshots } : {}),
    ...(attachments.length ? { attachments } : {}) };
}

/** 伙伴对话（总管线、项目对话）：回执、计划清单、回复中再发会停掉上一轮（17.4）。 */
export const isBuddyScope = (scope: string) => scope === "global" || scope.startsWith("project:");

/** 别处改了这条对话的记录（转议题后首页多了留痕行）：detail.scope 是这条对话，收到就安静地重读历史。 */
export const CONVERSATION_RELOAD = "conversation-reload";

/** 页面替本人发一句（个人复盘的「提交前核对」）：detail.scope 是这条对话，detail.text 是这一句；右列打开私聊并发出。 */
export const CONVERSATION_SEND = "conversation-send";

/** 一句话发出 / 这一轮结束（成功、失败、停止都算）：detail.scope 是这条对话。 */
export const CONVERSATION_TURN_SENT = "conversation-turn-sent";
export const CONVERSATION_TURN_SETTLED = "conversation-turn-settled";

/** 飞书私聊机器人、微信 ClawBot 说的话记在首页对话里：开着时多久看一眼有没有新的；那边刚问、还没答完时看得勤一些。 */
export const FEISHU_POLL_MS = 10_000;
export const FEISHU_WAITING_POLL_MS = 3_000;

/** 读回的历史和眼前的比，有没有变（条数、最后一条的序号、长度、来源）。 */
/** 历史里最后一条带 model 的回答用的来源和模型；都没有为 null。 */
export function latestModel(list: readonly Message[]): TConversationModel | null {
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]!.role === "assistant" && list[i]!.model) return list[i]!.model!;
  return null;
}

export function historySignature(list: Message[]): string {
  const last = list.at(-1);
  return `${list.length}:${last?.sequence ?? 0}:${last?.content.length ?? 0}:${last?.via ?? ""}`;
}

/** 来源标签上的字。 */
export const VIA_LABEL = { feishu: "飞书", wechat: "微信", buddy: "伙伴转来" } as const;

/** 飞书或微信里问了、还没答完：最后一条是从那边来的提问（子会话回报那句也是，项目主管线在回它）。 */
export function feishuWaiting(list: Message[]): boolean {
  const last = list.at(-1);
  return last?.role === "user" && last.via !== undefined;
}

/** 云端替本人发给项目主管线的子会话回报那句（18.10）：不画气泡。 */
export const isReportPrompt = (message: Pick<Message, "role" | "via">) => message.role === "user" && message.via === "report";

export function messagesEndpoint(scope: string): string {
  return `/api/conversations/${encodeURIComponent(scope)}/messages`;
}

/** 一轮回答：接上它的事件流（stream，只有首页走独立 Chat 时有，其余回 204）/ 请服务端停下它（stop）。 */
function turnEndpoint(scope: string, runId: string, action: "stream" | "stop"): string {
  return `/api/conversations/${encodeURIComponent(scope)}/turns/${encodeURIComponent(runId)}/${action}`;
}

/** 最后一句是本人在网页里问的、服务端说这一轮还在写：那一句（飞书、微信来的照旧由「正在回答飞书里的提问」接住）。 */
function runningQuestion(list: Message[]): Message | undefined {
  const last = list.at(-1);
  return last?.role === "user" && last.running && !last.via ? last : undefined;
}
function runningTurn(list: Message[]): string | undefined {
  return runningQuestion(list)?.runId;
}
/** 接上这一轮要的：runId，和提问的时刻（服务端不给开始时刻时用时从它算）。 */
function attachOf(question: Message): { runId: string; running: true; since?: number } {
  const since = question.createdAt ? Date.parse(question.createdAt) : NaN;
  return { runId: question.runId!, running: true, ...(since > 0 ? { since } : {}) };
}

/** 接上的那一轮服务端这里没有事件流（对象页的对话、服务重启过）、历史里它还在写：多久读一次历史。 */
const RUN_POLL_MS = 3_000;

/** 点停止后最多等服务端这么久：迟迟不回也断开本地连接，停止键不会没反应。 */
const STOP_WAIT_MS = 3_000;

/** 请服务端停下这一轮，回来后（成功与否）再断开本地连接：断开连接不会停下这一轮。 */
function stopTurn(scope: string, runId: string, target: AbortController | null) {
  const settle = () => target?.abort();
  setTimeout(settle, STOP_WAIT_MS);
  void fetch(turnEndpoint(scope, runId, "stop"), { method: "POST" }).catch(() => undefined).finally(settle);
}

export function isAttachable(file: { name: string }): boolean {
  return /\.(pdf|docx|md)$/i.test(file.name);
}

/** 服务端给的说明能不能直接给一号位看：要有中文，不能夹着英文报错原文。 */
function readableCopy(text: string | undefined): text is string {
  return Boolean(text && /[一-龥]/.test(text) && !/[A-Za-z]{6,}/.test(text));
}

/**
 * 一轮没完成时给一号位的说明（clark 的失败文案）：服务端给了中文说明就用它（原因 + 已保留什么 + 下一步）；
 * 没有时按出错的环节说清楚。不显示英文原文，也没有笼统的「暂不可用」。客户端自己的几种：
 * UNREACHABLE 请求没发出去、HTTP_xxx 服务端没接下、STREAM_BROKEN / STREAM_ENDED / STREAM_SILENT 回答途中连接断了。
 */
export function failureCopy(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "TURN_IN_PROGRESS":
      return "上一轮回答还没结束，请等它写完或点「停止」后再发。";
    case "REFERENCE_VERSION_CONFLICT":
      return "批注的卡片已更新，请重新批注后再发。";
    case "REFERENCE_NOT_FOUND":
      return "批注的卡片已不存在，请移除后再发。";
    case "ANCHOR_NOT_FOUND":
      return "当前页面上的卡已不存在或看不到，请刷新后再发。";
    case "ATTACHMENT_NOT_FOUND":
      return "附件已失效，请重新上传。";
    case "RESUME_NOT_FOUND":
      return "要接着写的那一轮回答找不到了，请直接重新提问。";
    case "CONTENT_FILTER":
      return readableCopy(fallback) ? fallback : "模型服务没有受理这次请求（内容审核未通过）。问题已保留，可以换个说法后重试。";
    default:
      break;
  }
  if (readableCopy(fallback)) return fallback;
  switch (code) {
    case "UNREACHABLE":
      return "没发出去，原文已放回输入框。";
    case "HTTP_400":
      return "这条消息没有通过校验，没有发出去。原文已放回输入框，可以改短一些或去掉附件后重发。";
    case "HTTP_413":
      return "消息或附件太大，没有发出去。原文已放回输入框，可以拆成几次发。";
    case "STREAM_SILENT":
      return "连接超过一分钟没有数据，已断开。";
    case "STREAM_BROKEN":
    case "STREAM_ENDED":
      return "连接中断了。";
    default:
      if (code?.startsWith("HTTP_5")) return "没发出去，原文已放回输入框。";
      return "这次回答没有完成。";
  }
}

/** 没送到天枢服务的几种（没连上、代理连不上正在重启的服务）：这句留着，自己再发。 */
const UNDELIVERED = new Set(["UNREACHABLE", "HTTP_502", "HTTP_503"]);
/** 回答途中连接断了（服务端没来得及说什么），或服务停机前先存了档（SERVER_RESTARTING）：连上后自己接着写一次。 */
const CONNECTION_LOST = new Set(["STREAM_BROKEN", "STREAM_ENDED", "STREAM_SILENT", "SERVER_RESTARTING"]);

/** 历史没读到、要本人处理的原因；连接类（没连上、服务出错）自己重试过仍不行时没有原因，界面只说「暂未载入」。 */
export function historyFailureCopy(status?: number): string | null {
  if (status === 401) return "登录状态已失效，请重新进入后再试。";
  if (status === 403 || status === 404) return "暂无法读取该对话：对象可能已移除，或无查看权限。";
  return null;
}

/** 失败后这一轮能不能接着来：continue 从断点续写，retry 用已查到的材料重答。 */
export type TurnRecoveryMode = "continue" | "retry";
/** 「继续」「重新回答」作为一号位这一句的原话（发给服务端、显示在对话里）。 */
export const RESUME_TEXT: Record<TurnRecoveryMode, string> = { continue: "继续", retry: "重新回答" };
/** 回答途中这么久收不到任何数据（服务端每 15 秒有心跳）就当连接断了。 */
export const STREAM_SILENCE_MS = 60_000;
/** 本地补上的说明行（服务端没来得及存下这一轮时）：与服务端存档的写法一致。 */
const LOCAL_BREAK_NOTE = "（连接在这里中断了，以上是已经写出的部分。）";
const LOCAL_EMPTY_NOTE = "（这次回答没有完成。）";
const LOCAL_STOP_NOTE = "（已停止，以上是停止前写出的部分。）";

/** 回答进行中读回的历史：刚发出、还没写进历史的那句接在最后（带着它的引用与附件）；已经写进去了就不重复。 */
export function withPendingTurn(loaded: Message[], pending: Message | string | null): Message[] {
  if (pending === null) return loaded;
  const turn = typeof pending === "string" ? { sequence: 0, role: "user" as const, content: pending } : pending;
  for (let index = loaded.length - 1; index >= 0; index--) {
    if (loaded[index].role !== "user") continue;
    // 作答那一句的原文由服务端重写：按回答的是哪组提问认。
    if (loaded[index].content === turn.content || (turn.answers && loaded[index].answers?.askId === turn.answers.askId)) return loaded;
    break;
  }
  return [...loaded, { ...turn, sequence: (loaded.at(-1)?.sequence ?? 0) + 1 }];
}

/** 去掉本地追加、服务端没接下的那句（从后往前找最后一条同文的用户消息）。 */
function withoutPendingTurn(messages: Message[], pending: string): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user" && messages[index].content === pending) return [...messages.slice(0, index), ...messages.slice(index + 1)];
  }
  return messages;
}

class TurnError extends Error {
  constructor(public code: string | undefined, message: string) {
    super(message);
  }
}

export function useConversation(scope: string, viewingMaterial: { id: string; editable: boolean } | null = null, messageContext?: string,
  anchorSelection?: AnchorSelection) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [partial, setPartial] = useState("");
  const [stage, setStage] = useState<ThinkingStage>("thinking");
  /** 本轮正文已经结束（收到 done）：「正在整理回答」立刻撤掉，不等连接关闭和历史重读。 */
  const [bodyDone, setBodyDone] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [route, setRoute] = useState<TurnRoute | null>(null);
  /** 进度行：最近一步在查什么、已经查完几项。 */
  const [progress, setProgress] = useState<TurnProgress>({ label: null, checked: 0 });
  /** Agent 处理时的步骤（服务端 step 事件，按 id 取代）；有步骤时进度行的单行文字和计数由步骤列表替代。 */
  const [steps, setSteps] = useState<Step[]>([]);
  /** 本轮跨对象读取的范围（服务端 scope 事件，后一条取代前一条）；发下一句、换 scope 时清空。 */
  const [readScope, setReadScope] = useState<TReadScope | null>(null);
  /** 本轮（或刚结束那一轮）的思考摘要；换 scope、发下一句时清空。 */
  const [thought, setThought] = useState<TurnThought | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastReply, setLastReply] = useState<{ text: string; ms: number } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("loading");
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** 载入对话记录时连不上、正在自己重试：从什么时候开始等、是不是在等网络恢复。 */
  const [historyWaiting, setHistoryWaiting] = useState<{ since: number; offline: boolean } | null>(null);
  /** 这一轮没完成时能不能接着来（「继续」/「重新回答」）：哪一轮、怎么接；发下一句、换 scope 时清空。 */
  const [recoveryState, setRecoveryState] = useState<{ mode: TurnRecoveryMode; runId: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * 进行中的这一轮：停止要它的 runId（服务端第一条事件带来）。sent：请求已发出、在等回应；
   * 这时点停止先记下（stopWanted），拿到 runId 再请服务端停（首页 Chat 里断开连接不会停下这一轮）。
   */
  const turnRef = useRef<{ scope: string; runId?: string; sent: boolean; stopWanted: boolean } | null>(null);
  /** 进行中的那次历史读取：新的读取、换 scope、卸载都会作废它，作废后的结果不写进来。 */
  const historyRun = useRef<AbortController | null>(null);
  /** 本轮刚发出、可能还没写进历史的那句：回答进行中读回历史时补在最后。 */
  const pendingTurn = useRef<Message | null>(null);
  /** 每换一次 scope（或卸载）加一：上一个 scope 迟到的发送、上传结果不再改这里的状态。 */
  const generation = useRef(0);
  const [turnPlan, setTurnPlan] = useState<TBuddyPlan | null>(null);
  const [turnModel, setTurnModel] = useState<TConversationModel | null>(null);
  const [turnCards, setTurnCards] = useState<TConversationCard[]>([]);
  /**
   * 流式上屏合帧（B2）：一帧里到的正文、思考摘要、进度只写一次（整棵对话树一帧最多重画一次，不按每段 delta 重画）。
   * 对话层放大 / 收起的过渡里（resizeGate）排着不写，过渡结束一次补齐。
   * partialFrame：排着的那一帧（rAF id；等过渡结束时是 RESIZE_WAIT）；partialText：最新的全文。
   */
  const partialFrame = useRef<number | null>(null);
  const partialText = useRef("");
  const frameUpdate = useRef<FrameUpdate>(emptyFrame());
  const frameLive = useRef<() => boolean>(() => false);

  /** 把排着的写进去：思考摘要、进度、最新全文（顺带切到「整理回答」）。 */
  const commitFrame = useCallback(() => {
    partialFrame.current = null;
    const update = frameUpdate.current;
    frameUpdate.current = emptyFrame();
    if (!frameLive.current()) return;
    if (update.thought) setThought(update.thought);
    if (update.progress.length) setProgress((current) => update.progress.reduce((value, step) => step(value), current));
    if (update.partial) {
      setPartial(partialText.current);
      setStage("answering");
    }
  }, []);
  const commitAfterResize = useCallback(() => {
    if (partialFrame.current === RESIZE_WAIT) commitFrame();
  }, [commitFrame]);
  /** 排一帧（已经排着就并进去）；没有 rAF 的环境直接写。 */
  const scheduleFrame = useCallback((live: () => boolean) => {
    frameLive.current = live;
    if (typeof requestAnimationFrame !== "function") return commitFrame();
    if (partialFrame.current !== null) return;
    partialFrame.current = requestAnimationFrame(() => {
      if (!resizing()) return commitFrame();
      partialFrame.current = RESIZE_WAIT;
      afterResize(commitAfterResize);
    });
  }, [commitFrame, commitAfterResize]);
  /** 新到的正文：最新全文排进这一帧。 */
  const showPartial = useCallback((text: string, live: () => boolean) => {
    partialText.current = text;
    frameUpdate.current.partial = true;
    scheduleFrame(live);
  }, [scheduleFrame]);
  /** 思考摘要（累计全文）：排进这一帧，同一帧里多段只写最后一次。 */
  const showThought = useCallback((next: TurnThought, live: () => boolean) => {
    frameUpdate.current.thought = next;
    scheduleFrame(live);
  }, [scheduleFrame]);
  /** 进度行的变化：按到达顺序排进这一帧。 */
  const showProgress = useCallback((step: (current: TurnProgress) => TurnProgress, live: () => boolean) => {
    frameUpdate.current.progress.push(step);
    scheduleFrame(live);
  }, [scheduleFrame]);
  /** 不再等下一帧（也不等过渡结束）：排着的那一帧取消，排着的内容立刻写进来（结束、出错时）。 */
  const flushPartial = useCallback((live: () => boolean) => {
    if (partialFrame.current === null) return;
    if (partialFrame.current !== RESIZE_WAIT && typeof cancelAnimationFrame === "function") cancelAnimationFrame(partialFrame.current);
    frameLive.current = live;
    commitFrame();
  }, [commitFrame]);

  const historyUrl = messagesEndpoint(scope);

  /**
   * 读历史，返回读到的消息（没读到为 null）。`show`（首次、重试）显示载入中；`quiet`（发送后的重读）不闪载入态。
   * 读不到只记下失败，不清掉已显示的消息、不碰流式中的回答、输入草稿和待发附件。
   * 连接类失败（没连上、5xx）先自己按退避再试，`HISTORY_RETRY_MS` 内仍不行才记失败；登录、权限类直接记。
   * `probe`（一轮刚结束、断线后试探连上没有）：只读一次，读不到什么都不记，由调用方决定接下来怎么办。
   */
  const loadHistory = useCallback(async (mode: "show" | "quiet" | "probe" = "show"): Promise<Message[] | null> => {
    historyRun.current?.abort();
    const controller = new AbortController();
    historyRun.current = controller;
    const current = () => historyRun.current === controller && !controller.signal.aborted;
    if (mode === "show") {
      setHistoryStatus("loading");
      setHistoryError(null);
      setHistoryWaiting(null);
    }
    const began = Date.now();
    try {
      for (let attempt = 0; ; attempt++) {
        let failedStatus: number | undefined;
        try {
          const response = await fetch(historyUrl, { headers: { accept: "application/json" }, signal: controller.signal });
          if (!response.ok) {
            failedStatus = response.status;
            throw new Error(`历史读取失败：${response.status}`);
          }
          const body = (await response.json()) as { messages?: unknown };
          if (!Array.isArray(body.messages)) throw new Error("历史格式不对");
          if (!current()) return null;
          // 伙伴对话读回的本人那几句都已经读到了（17.4 的两个勾）。
          const saved = isBuddyScope(scope) ? (body.messages as Message[]).map((item) => (item.role === "user" ? { ...item, receipt: "read" as const } : item)) : body.messages as Message[];
          const loaded = withPendingTurn(saved, pendingTurn.current);
          setMessages(loaded);
          setHistoryStatus("ready");
          setHistoryError(null);
          setHistoryWaiting(null);
          return loaded;
        } catch {
          if (!current() || mode === "probe") return null;
          const connection = failedStatus === undefined || failedStatus >= 500;
          if (connection && Date.now() - began < HISTORY_RETRY_MS) {
            if (mode === "show") setHistoryWaiting({ since: began, offline: offline() });
            await pause(backoff(attempt), controller.signal);
            if (!current()) return null;
            continue;
          }
          setHistoryWaiting(null);
          setHistoryStatus("error");
          setHistoryError(historyFailureCopy(failedStatus));
          return null;
        }
      }
    } finally {
      if (historyRun.current === controller) historyRun.current = null;
    }
  }, [historyUrl]);

  useEffect(() => {
    setMessages([]);
    setPartial("");
    setStatus("idle");
    setError(null);
    setLastReply(null);
    setThought(null);
    setRecoveryState(null);
    // 附件挂在上一个 scope 的对话上，不能带到这里发送。
    setAttachments((current) => (current.length ? [] : current));
    setUploading(false);
    setAttachmentError(null);
    const started = generation.current;
    void loadHistory("show").then((loaded) => {
      // 刷新、切回来时最后一句还在回答：接上这一轮（同样的进行中一行、停止可用），写完换成回答。
      const run = loaded ? runningQuestion(loaded) : undefined;
      if (run && generation.current === started) followRef.current(run);
    });
    return () => {
      // 换 scope 或卸载：作废进行中的历史读取；不请服务端停，上一轮回答照常在服务端完成，只是不再写进这里，停止键也不再指向它。
      generation.current += 1;
      pendingTurn.current = null;
      if (partialFrame.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(partialFrame.current);
      partialFrame.current = null;
      abortRef.current = null;
      turnRef.current = null;
      historyRun.current?.abort();
      historyRun.current = null;
    };
  }, [loadHistory, scope]);

  // 回到前台（切走、锁屏回来）：没有在写、也没有在重连时安静地重读一次；最后一句还在回答就接上这一轮。
  useEffect(() => {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const onVisible = async () => {
      if (document.visibilityState !== "visible" || abortRef.current) return;
      const started = generation.current;
      const loaded = await loadHistory("quiet");
      const run = loaded ? runningQuestion(loaded) : undefined;
      if (run && generation.current === started && !abortRef.current) followRef.current(run);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadHistory, scope]);

  // 别处改了这条对话的记录（转议题后首页多了留痕行）：安静地重读。
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onReload = (event: Event) => {
      if ((event as CustomEvent<{ scope?: string }>).detail?.scope === scope) void loadHistory("quiet");
    };
    window.addEventListener(CONVERSATION_RELOAD, onReload);
    return () => window.removeEventListener(CONVERSATION_RELOAD, onReload);
  }, [loadHistory, scope]);

  // 自己重试过仍没读到：网络恢复、页面回到前台时再读一次，不等本人点「重试」。
  useEffect(() => {
    // 登录、权限类（有 historyError）要本人处理，不自动重读。
    if (historyStatus !== "error" || historyError !== null || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const again = () => { if (document.visibilityState === "visible") void loadHistory("show"); };
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("online", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [historyStatus, historyError, loadHistory]);

  // 飞书私聊天枢机器人 = 在首页对话里说（scope = global）：开着时隔几秒看一眼，飞书里有新的问答就安静地重读。
  const shownSignature = historySignature(messages);
  const waitingOnFeishu = feishuWaiting(messages);
  useEffect(() => {
    if (scope !== "global" || status === "streaming" || historyStatus !== "ready" || typeof window === "undefined") return;
    const timer = setInterval(async () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible" || historyRun.current) return;
      try {
        const response = await fetch(historyUrl, { headers: { accept: "application/json" } });
        const body = response.ok ? (await response.json()) as { messages?: unknown } : null;
        if (Array.isArray(body?.messages) && historySignature(body.messages as Message[]) !== shownSignature) void loadHistory("quiet");
      } catch { /* 下一次再看 */ }
    }, waitingOnFeishu ? FEISHU_WAITING_POLL_MS : FEISHU_POLL_MS);
    return () => clearInterval(timer);
  }, [scope, status, historyStatus, historyUrl, loadHistory, shownSignature, waitingOnFeishu]);

  /** 只重读历史：输入草稿、待发附件、已显示的消息和正在流式的回答都不动。 */
  const retryHistory = useCallback(() => {
    void loadHistory("show");
  }, [loadHistory]);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    const rejected = list.filter((file) => !isAttachable(file));
    const acceptable = list.filter(isAttachable);
    if (!acceptable.length) {
      setAttachmentError("仅支持 PDF、DOCX、Markdown（.md）附件。");
      return;
    }
    const started = generation.current;
    setUploading(true);
    setAttachmentError(null);
    try {
      const form = new FormData();
      for (const file of acceptable) form.append("files", file);
      const response = await fetch(`/api/conversations/${encodeURIComponent(scope)}/attachments`, {
        method: "POST",
        body: form,
      });
      if (response.status === 401) {
        window.location.assign("/access");
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "附件上传失败");
      }
      const body = (await response.json()) as { attachments?: Attachment[] } | Attachment[];
      const uploaded = Array.isArray(body) ? body : body.attachments ?? [];
      const live = generation.current === started;
      if (live) setAttachments((current) => [...current, ...uploaded]);
      // 个人复盘页按上传的材料决定能不能请 Co-Agent 起草：上传完立刻让它重读。
      window.dispatchEvent(new CustomEvent("conversation-attachments-changed", { detail: { scope } }));
      if (live && rejected.length) setAttachmentError(`已上传 ${acceptable.length} 份；${rejected.length} 份不是 PDF/DOCX/MD，已忽略。`);
    } catch (cause) {
      if (generation.current === started) setAttachmentError((cause as Error).message);
    } finally {
      if (generation.current === started) setUploading(false);
    }
  }

  /**
   * 回答断线后等连上：进度行显示「正在连接 / 等待网络 · N 秒」，「停止」可以取消；读得回对话记录就算连上了。
   * 返回读回的对话记录（连上了）、false 到时限仍没连上（或已换 scope）、"stopped" 本人点了停止。
   */
  async function reconnected(live: () => boolean): Promise<Message[] | false | "stopped"> {
    const waiting = new AbortController();
    abortRef.current = waiting;
    const since = Date.now();
    setStatus("streaming");
    setStartedAt(since);
    setStage(offline() ? "offline" : "connecting");
    setRoute(null);
    setProgress({ label: null, checked: 0 });
    setSteps([]);
    setReadScope(null);
    try {
      for (let attempt = 0; Date.now() - since < RECONNECT_MS; attempt++) {
        await pause(backoff(attempt), waiting.signal);
        if (waiting.signal.aborted) return "stopped";
        if (!live()) return false;
        const loaded = await loadHistory("probe");
        if (loaded) return loaded;
        if (live()) setStage(offline() ? "offline" : "connecting");
      }
      return false;
    } finally {
      if (abortRef.current === waiting) abortRef.current = null;
    }
  }

  /**
   * 发送一轮。返回 false 表示在服务端接收之前就失败了（C-04：调用方保留输入与引用）。
   * 请求与 SSE 处理与原实现相同；只在展示上派生思考阶段与失败文案。
   * 这一轮不管怎么结束（出错、断线、超时、停止），已经写出的正文和思考都留在界面上：服务端存了就用读回的，
   * 没来得及存就在本地补一条；能接着来的给出「继续」/「重新回答」（resume）。
   * options.resumeRunId：接着那一轮没完成的回答（「继续」按钮），这一句不带页面前缀。
   * options.answers：回答 Agent 的提问（AskPanel）；record 只用来先画出问答记录，原文由服务端按提问卡重写。
   * 连接类失败自己恢复（RECONNECT_MS 内）：没送到就留着这句、显示「正在连接」并重发；回答途中断了就等连上后先接上这一轮，
   * 接不上（已写完就到此为止）再自动「继续」一次（options.auto：这一句就是自动接上的那次，再断就交给本人）。
   * options.attach：不发新句，接上服务端还在写（或刚写完）的那一轮（切走、刷新、断线回来）：先补发已有的事件、再跟着写到结束；
   * running 是读回的历史里它还在写，since 是提问的时刻。服务端这里没有这一轮的事件流（204）时：还在写就每 3 秒读一次历史直到写完
   * （用时从 since 算），否则返回 false 交还调用方。
   */
  async function send(message: string, references: SentCardRef[], options: { resumeRunId?: string; scopeOverride?: TReadScopeParams;
    answers?: { input: TAskAnswerInput; record: TAskAnswerRecord }; auto?: boolean; attach?: { runId: string; running: boolean; since?: number };
    /** 这一句是在回答伙伴的哪个选项框（buddy_question）：原文照发，那张标 answered。 */
    buddyQuestionId?: string;
    /** 这一句带的附件（新首页的输入框自己传好了给回执）；不给时用输入条里待发的那几份。 */
    attachments?: Attachment[] } = {}): Promise<boolean> {
    const input = message.trim();
    const attach = options.attach;
    // 伙伴对话回复中本人再发（17.4）：天枢收下、停掉上一轮再开新的一轮；这里把上一轮交出去（不再写这页），已写出的先留在原处。
    const interrupting = status === "streaming" && !attach && isBuddyScope(scope);
    if ((!input && !attach) || (status === "streaming" && !interrupting)) return false;
    if (interrupting) {
      generation.current += 1;
      abortRef.current?.abort();
      const cut = partial;
      const cutPlan = turnPlan;
      if (cut || cutPlan) setMessages((current) => [...current, { sequence: (current.at(-1)?.sequence ?? 0) + 1, role: "assistant", content: cut,
        ...(cutPlan ? { plan: { ...cutPlan, collapsed: true } } : {}) }]);
    }
    const text = attach ? "" : messageContext && !options.resumeRunId && !options.answers && !options.buddyQuestionId ? `${messageContext}

${input}` : input;
    const controller = new AbortController();
    abortRef.current = controller;
    const handle: { scope: string; runId?: string; sent: boolean; stopWanted: boolean } = { scope, runId: attach?.runId, sent: false, stopWanted: false };
    turnRef.current = handle;
    const started = generation.current;
    /** 这一轮发出后没换 scope、也没卸载：只有这时才改本页的状态（事件照常发，带的是本轮的 scope）。 */
    const live = () => generation.current === started;
    let began = Date.now();
    frameUpdate.current = emptyFrame();
    setPartial("");
    setError(null);
    setRecoveryState(null);
    setStage(attach ? "thinking" : "understanding");
    setBodyDone(false);
    setStartedAt(began);
    setRoute(null);
    setProgress({ label: null, checked: 0 });
    setSteps([]);
    setReadScope(null);
    setThought(null);
    setTurnPlan(null);
    setTurnModel(null);
    setTurnCards([]);
    setStatus("streaming");
    const sentAttachments = options.attachments ?? attachments;
    const attachmentRefs = sentAttachments.map((attachment) => ({ id: attachment.id }));
    // 乐观渲染：引用的卡片、附的材料随这句一起立刻画出来，不等回答结束读回历史。
    const turn = { ...pendingUserMessage(0, text, references, sentAttachments), ...(options.answers ? { answers: options.answers.record } : {}) };
    /** 发出前已有的最后一条：没连上之后读回历史，若这句已经排在它后面，就是其实送到了，不再重发。 */
    const lastSequence = messages.reduce((max, item) => Math.max(max, item.sequence), 0);
    if (attach) {
      // 提问已在记录里；本地补过的那条半截回答先撤掉，补发的事件会从头写出来。
      setMessages((current) => current.filter((item) => !(item.role === "assistant" && item.runId === attach.runId)));
    } else {
      pendingTurn.current = turn;
      setMessages((current) => [...current, { ...turn, sequence: current.length + 1 }]);
      // 页面上跟着这条对话走的部分（月度计划逐段意见）：发出与这一轮结束时各通知一次，各自重读。
      window.dispatchEvent(new CustomEvent(CONVERSATION_TURN_SENT, { detail: { scope, content: text } }));
    }

    let accepted = false;
    /**
     * 回执（17.4）：两帧按 messageId 对上同一条；delivered 先到时记下这一轮发的那句（这一轮还在这页上时，最后一句本人的话）是这个 id。
     * 读到了不再退回送达。
     */
    let receipt: { messageId: string; state: "delivered" | "read" } | null = null;
    const markReceipt = (state: "delivered" | "read", messageId: string) => setMessages((current) => {
      let index = current.findIndex((item) => item.role === "user" && item.messageId === messageId);
      if (index < 0) {
        index = current.length - 1;
        while (index >= 0 && current[index].role !== "user") index -= 1;
      }
      return index < 0 || current[index].receipt === "read" ? current
        : current.map((item, at) => (at === index ? { ...item, receipt: state, messageId } : item));
    });
    let reply = "";
    let notice: string | undefined;
    /** 这一轮走过恢复时服务端在 done 里给的那行说明（读不回历史时本地补的那条回答也带上）。 */
    let recoveryNote: RecoveryNote | undefined;
    /** 这一轮的标识（服务端事件带着）：失败后「继续」按它接上。 */
    let runId: string | undefined = attach?.runId;
    /** 服务端在 error 事件里说的：能不能接着来（没带 resume = 不建议直接再试）。 */
    let serverError: { resume?: TurnRecoveryMode } | undefined;
    /** 还没结束的工具步骤：都结束了就回到「正在思考」（模型拿到结果在想下一步），不停在「查证」上。 */
    let runningTools = 0;
    /** 思考摘要全文，与正文第一个字出现时距发出的秒数。 */
    let thinking = "";
    let thoughtSeconds: number | null = null;
    /** 回答途中连接一直没有数据（服务端每 15 秒有心跳）：当断了处理，不让界面一直停在「正在思考」。 */
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      let response!: Response;
      let attempt = 0;
      for (; ; attempt++) {
        let undelivered: TurnError | null = null;
        handle.sent = true;
        try {
          response = attach ? await fetch(turnEndpoint(scope, attach.runId, "stream"), { headers: { accept: "text/event-stream" }, signal: controller.signal })
            : await fetch(historyUrl, {
            method: "POST",
            headers: { accept: "text/event-stream", "content-type": "application/json" },
            body: JSON.stringify({ message: text, references: references.map(({ cardId, version }) => ({ cardId, version })), attachments: attachmentRefs,
              ...(viewingMaterial ? { viewingMaterialId: viewingMaterial.id } : {}),
              ...(anchorSelection ? { anchorSelection } : {}),
              ...(options.resumeRunId ? { resumeRunId: options.resumeRunId } : {}),
              ...(options.answers ? { answers: options.answers.input } : {}),
              ...(options.buddyQuestionId ? { buddyQuestionId: options.buddyQuestionId } : {}),
              ...(options.scopeOverride ? { scopeOverride: options.scopeOverride } : {}),
              // 首页对话在每个二级页面都开着：带上本人此刻在哪个页面，Agent 才知道「这页」指什么。
              ...(scope === "global" ? { pagePath: window.location.pathname } : {}) }),
            signal: controller.signal,
          });
          if (UNDELIVERED.has(`HTTP_${response.status}`)) undelivered = new TurnError(`HTTP_${response.status}`, "");
        } catch (cause) {
          if (controller.signal.aborted) throw cause;
          undelivered = new TurnError("UNREACHABLE", (cause as Error)?.message ?? "fetch failed");
        }
        if (!undelivered) break;
        // 没送到：这时点停止直接断开（服务端没有这一轮）。
        handle.sent = false;
        if (Date.now() - began >= RECONNECT_MS) throw undelivered;
        if (live()) setStage(offline() ? "offline" : "connecting");
        await pause(backoff(attempt), controller.signal);
        if (controller.signal.aborted) throw undelivered;
        if (undelivered.code === "UNREACHABLE" && !attach) {
          // 请求可能已经送到、只是回应没回来：读回历史里有这句就不再重发，按回答中途断了接着处理。
          const seen = (await loadHistory("probe"))?.find((item) => item.role === "user" && item.content === text && item.sequence > lastSequence);
          if (seen) {
            accepted = true;
            runId = seen.runId;
            throw new TurnError("STREAM_BROKEN", "delivered, response lost");
          }
        }
      }
      if (attempt > 0 && live()) setStage(attach ? "thinking" : "understanding");
      if (attach && response.status === 204) {
        // 服务端这里没有这一轮的事件流（对象页的对话、服务重启过）：不在写了交还调用方；
        // 还在写就每 3 秒读一次历史（页面在前台时），写完换成读回的回答。停止照样可用，用时从提问时算。
        if (!attach.running) {
          if (live()) setStatus("idle");
          return false;
        }
        accepted = true;
        if (attach.since) {
          began = attach.since;
          if (live()) setStartedAt(attach.since);
        }
        for (;;) {
          await pause(RUN_POLL_MS, controller.signal);
          if (controller.signal.aborted) throw new TurnError("ABORTED", "aborted");
          if (!live()) return true;
          if (typeof document !== "undefined" && document.visibilityState !== "visible") continue;
          const loaded = await loadHistory("probe");
          if (!live()) return true;
          if (loaded && runningTurn(loaded) !== attach.runId) {
            setStatus("complete");
            return true;
          }
        }
      }
      if (attach) {
        // 接上的这一轮：用时从它开始时算（服务端给的时刻）。
        const at = Number(response.headers.get("x-turn-started-at"));
        if (at > 0) {
          began = at;
          if (live()) setStartedAt(at);
        }
      }
      if (response.status === 401) {
        // 按没接下返回：调用方把原文放回输入框（存成草稿），重新登录回来还在。
        window.location.assign("/access");
        return false;
      }
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string; error?: { code?: string; message?: string } };
        throw new TurnError(body.code ?? body.error?.code ?? `HTTP_${response.status}`, body.message ?? body.error?.message ?? "");
      }
      accepted = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      let finished = false;
      // 每次读各用自己的计时器（上一次读的收尾不能清掉这一次的）。
      const read = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timer = setTimeout(() => {
          void Promise.resolve(reader.cancel?.()).catch(() => undefined);
          reject(new TurnError("STREAM_SILENT", "stream silent"));
        }, STREAM_SILENCE_MS);
        silenceTimer = timer;
        reader.read().then(resolve, (cause) => reject(controller.signal.aborted ? cause : new TurnError("STREAM_BROKEN", (cause as Error)?.message ?? "stream broken")))
          .finally(() => clearTimeout(timer));
      });
      for (;;) {
        const { done, value } = await read();
        buffer += decoder.decode(value, { stream: !done });
        const { events, rest } = splitSse(buffer);
        buffer = rest;
        for (const block of events) {
          const event: ConversationEvent | null = parseSseBlock(block);
          if (!event) continue;
          if (event.runId) runId = event.runId;
          if (event.runId && !handle.runId) {
            handle.runId = event.runId;
            // 点停止时还不知道这一轮的 runId：拿到了就请服务端停下。
            if (handle.stopWanted) stopTurn(handle.scope, event.runId, controller);
          }
          if (event.type === "route" && event.tier) {
            notice = event.notice || undefined;
            if (live()) {
              setRoute({ tier: event.tier, expectSeconds: event.expectSeconds ?? 0, ...(notice ? { notice } : {}) });
              setStage((current) => (current === "understanding" ? "thinking" : current));
              // 开场说明（检索问答档、深度档）立刻显示在这条回答的开头，进度行（思考 / 查证）照常在下面走。
              if (notice) { partialText.current = notice; setPartial(notice); }
            }
          }
          // 模型在思考、还没有文字：进度行回到「正在思考」；推理摘要里有中文要点时显示一行。
          if (event.type === "thinking" && live()) {
            setStage((current) => (current === "answering" ? current : "thinking"));
            if (event.summary) showProgress((current) => ({ ...current, thought: event.summary ?? null }), live);
            if (event.delta) {
              thinking += event.delta;
              showThought({ text: thinking, seconds: thoughtSeconds }, live);
            }
          }
          if (event.type === "escalation" && event.notice && live())
            showProgress((current) => ({ ...current, escalation: { notice: event.notice!, expectSeconds: event.expectSeconds ?? 0 } }), live);
          // 上游出错、正在自动恢复：进度行说明在做什么（重连、换备用模型、从断点接着写）；已写出的正文原样留着，续写的字接在后面。
          // 先把排着的那一帧写进去（否则它会把阶段又切回「整理回答」），再回到「正在思考」。
          if (event.type === "recovery" && event.notice && live()) {
            flushPartial(live);
            setStage("thinking");
            showProgress((current) => ({ ...current, label: event.notice ?? null, thought: null }), live);
          }
          if (event.type === "message") {
            if (thoughtSeconds === null && thinking && live()) {
              thoughtSeconds = Math.max(1, Math.round((Date.now() - began) / 1000));
              // 与正文第一批字同一帧写进去：思考收起的那一帧，正文就在原处出现。
              showThought({ text: thinking, seconds: thoughtSeconds }, live);
            }
            reply += event.delta ?? "";
            if (live()) showPartial(withNotice(notice, reply), live);
          }
          if (event.type === "step" && event.id && event.label && live()) {
            const step: Step = { id: event.id, label: event.label, status: (event.status ?? "active") as StepStatus, ...(event.result ? { result: event.result } : {}) };
            setSteps((current) => current.some((item) => item.id === step.id) ? current.map((item) => (item.id === step.id ? step : item)) : [...current, step]);
          }
          if (event.type === "scope" && event.label && event.params && live())
            setReadScope({ label: event.label, params: event.params, ...(event.choices ? { choices: event.choices } : {}) });
          if (event.type === "tool" && event.phase === "started") runningTools += 1;
          if (event.type === "tool" && event.phase === "completed") runningTools = Math.max(0, runningTools - 1);
          if (event.type === "tool" && event.phase === "completed" && runningTools === 0 && live())
            setStage((current) => (current === "researching" ? "thinking" : current));
          if (event.type === "tool" && event.phase === "started" && live()) {
            setStage((current) => (current === "answering" ? current : "researching"));
            if (event.label) showProgress((current) => ({ ...current, label: event.label ?? null, thought: null }), live);
          }
          // 这一步读到了什么（系统按工具结果生成）替换开始时的「在查什么」。
          if (event.type === "tool" && event.phase === "completed" && !event.isError && live())
            showProgress((current) => ({ ...current, checked: current.checked + 1, ...(event.detail ? { label: event.detail } : {}) }), live);
          if (event.type === "tool" && event.phase === "completed" && !event.isError
            && (event.name === "edit_material" || event.name === "create_material" || event.name === "propose_material_edit"))
            window.dispatchEvent(new CustomEvent("materials-changed", { detail: { scope } }));
          // 复盘项：agent 给了改写建议，页面重新读取后在那一栏下显示「采用 / 忽略」。
          if (event.type === "tool" && event.phase === "completed" && !event.isError && event.name === "propose_review_edit")
            window.dispatchEvent(new CustomEvent("monthly-review-suggested", { detail: { scope } }));
          if (event.type === "tool" && event.phase === "completed" && !event.isError
            && (event.name === "edit_mission_card" || event.name === "edit_my_mission_card" || event.name === "ask_mission_card_question"))
            window.dispatchEvent(new CustomEvent("mission-card-changed", { detail: { scope } }));
          // 伙伴登记了拆卡：新首页在这台电脑上开规划员（V2 设计第 21.3 节；事件名同 components/home/HomeShell.tsx 的 SPLIT_EVENT）。
          if (event.type === "tool" && event.phase === "completed" && !event.isError && event.name === "register_card_split")
            window.dispatchEvent(new CustomEvent("card-split-registered", { detail: { scope } }));
          if (event.type === "receipt" && event.state && event.messageId) {
            receipt = { messageId: event.messageId, state: event.state };
            if (live()) markReceipt(event.state, event.messageId);
          }
          if (event.type === "plan" && event.plan && live()) setTurnPlan(event.plan);
          if (event.type === "model" && event.provider && event.model && live()) setTurnModel({ provider: event.provider, model: event.model });
          if (event.type === "card" && event.card && live()) { const card = event.card; setTurnCards((current) => [...current, card]); }
          if (event.type === "ui" && event.ui) emitBuddyUi(event.ui);
          if (event.type === "error") {
            serverError = { resume: event.resume };
            throw new TurnError(event.code, event.message ?? "");
          }
          if (event.type === "done" && event.status === "completed") completed = true;
          if (event.type === "done" && event.recoveryNote?.text) recoveryNote = event.recoveryNote;
          if (event.type === "done" && event.status === "aborted" && live()) setStatus("aborted");
          if (event.type === "done") finished = true;
        }
        if (done) break;
        // done 之后服务端 / 代理可能迟迟不关连接：不再等它，撤掉阶段提示、放掉连接，直接收尾。
        if (finished) {
          if (live()) setBodyDone(true);
          void Promise.resolve(reader.cancel?.()).catch(() => undefined);
          break;
        }
      }
      // 结束：最后一帧不等了，完整回答在重读历史期间就显示出来。
      flushPartial(live);
      if (!completed && !finished) throw new TurnError("STREAM_ENDED", "stream ended before done");
      // 服务端确认这一轮已停止（done aborted）：按停止处理。
      if (!completed) throw new TurnError("ABORTED", "aborted");
      if (!live()) return true;
      // 本地那句先放下，读回来的就是服务端保存的全部；读不回来时保留已显示的对话，并把这次回答接在后面。
      pendingTurn.current = null;
      const reloaded = await loadHistory("probe");
      if (!live()) return true;
      // 读不回来时先用本地这份，后台接着读，读到了再换成服务端保存的。
      if (!reloaded) void loadHistory("quiet");
      if (!reloaded && reply) setMessages((current) => [...current, { sequence: (current.at(-1)?.sequence ?? 0) + 1, role: "assistant", content: withNotice(notice, reply),
        ...(recoveryNote ? { recoveryNote } : {}) }]);
      setPartial("");
      // 接上的那一轮不是这次发的：输入条里待发的附件不动。
      if (!attach) setAttachments([]);
      setLastReply({ text: withNotice(notice, reply), ms: Date.now() - began });
      setStatus("complete");
      return true;
    } catch (cause) {
      if (silenceTimer) clearTimeout(silenceTimer);
      flushPartial(live);
      if (!live()) return accepted;
      pendingTurn.current = null;
      const reloaded = await loadHistory("probe");
      if (!live()) return accepted;
      const code = (cause as TurnError).code;
      let stopped = controller.signal.aborted || code === "ABORTED";
      // 收下了（delivered）却没开成（流里一帧 error 就结束，17.4）：撤掉第一个勾，这句旁边给「重发」。
      // 读回的历史里有这句就标在它上面（最后一句同样的话），没有就把它放回去。
      if (receipt?.state === "delivered" && serverError && !stopped && !attach) {
        const failed = receipt.messageId;
        setMessages((current) => {
          let index = current.length - 1;
          while (index >= 0 && !(current[index].role === "user" && current[index].content === text)) index -= 1;
          return index >= 0 ? current.map((item, at) => (at === index ? { ...item, receipt: "failed" as const, messageId: failed } : item))
            : [...current, { ...turn, sequence: (current.at(-1)?.sequence ?? 0) + 1, receipt: "failed", messageId: failed }];
        });
      }
      const written = reply.trim().length > 0;
      // 服务端没接下这句、历史也没读回来：撤掉本地那句，原文由输入框放回（C-04）。
      if (!reloaded && !accepted) setMessages((current) => withoutPendingTurn(current, text));
      if (accepted) {
        // 已经写出的正文（和思考）不能消失：服务端存下了这一轮就用读回的，没来得及存就在本地补上一条。
        const saved = Boolean(runId && reloaded?.some((item) => item.role === "assistant" && item.runId === runId));
        if (!saved && (written || thinking)) {
          const note = stopped ? LOCAL_STOP_NOTE : written ? LOCAL_BREAK_NOTE : LOCAL_EMPTY_NOTE;
          setMessages((current) => [...current, { sequence: (current.at(-1)?.sequence ?? 0) + 1, role: "assistant",
            content: withNotice(notice, written ? `${reply.trimEnd()}\n\n${note}` : note), ...(runId ? { runId } : {}) }]);
        }
        // 思考还没收成「已思考 N 秒」（正文没开始就断了）：按到现在的用时收起来，挂在这条回答上。
        if (thinking && thoughtSeconds === null) setThought({ text: thinking, seconds: Math.max(1, Math.round((Date.now() - began) / 1000)) });
      }
      setPartial("");
      // 服务端说了能不能接着来就照它；连接中途断了（服务端没来得及说）按有没有写出正文决定。
      const mode = serverError ? serverError.resume : accepted ? (written ? "continue" : "retry") : undefined;
      // 回答途中连接断了：等连上后自动接着来一次（服务端按这一轮已写出的部分接上），本人不用点；自动接的那次再断才交给本人。
      if (!stopped && !options.auto && mode && runId && CONNECTION_LOST.has(code ?? "")) {
        const back = await reconnected(live);
        if (!live()) return true;
        if (back !== false && back !== "stopped") {
          // 断的只是这条连接，这一轮在服务端照常写（或已写完）：先接上它；接不上时服务端没说出了事、历史里已有回答就到此为止，否则「继续」。
          const asked = runningQuestion(back);
          if (await send("", [], { attach: asked?.runId === runId ? { ...attachOf(asked), since: began } : { runId, running: false } })) return true;
          if (!serverError && back.some((item) => item.role === "assistant" && item.runId === runId)) {
            // 接的时候撤掉了这一轮的回答：放回读到的。
            setMessages(back);
            setStatus("complete");
            return true;
          }
          await send(RESUME_TEXT[mode], [], { resumeRunId: runId, auto: true });
          return true;
        }
        stopped = back === "stopped";
      }
      if (!reloaded) void loadHistory("quiet");
      if (stopped) {
        setStatus("aborted");
        setError(written ? "已停止。已写出的部分保留在上方，点「继续」可以接着写。" : "已停止本次回答。");
        if (written && runId) setRecoveryState({ mode: "continue", runId });
      } else {
        setStatus("failed");
        const copy = failureCopy(code, (cause as Error).message);
        // 说明里还没写下一步时补上：能接着来就指向按钮，不能就只说已保留了什么。
        const next = !accepted || /点「(继续|重新回答)」|保留在上方|放回输入框|问题已保留/.test(copy) ? ""
          : mode === "continue" ? "已写出的部分保留在上方，点「继续」从断点接着写。"
          : mode === "retry" ? "问题已保留，点「重新回答」再试一次。"
          : written ? "已写出的部分保留在上方。" : "";
        setError(`${copy}${next}`);
        if (mode && runId) setRecoveryState({ mode, runId });
      }
      return accepted;
    } finally {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (abortRef.current === controller) abortRef.current = null;
      if (turnRef.current === handle) turnRef.current = null;
      window.dispatchEvent(new CustomEvent(CONVERSATION_TURN_SETTLED, { detail: { scope } }));
    }
  }

  /** 「继续」/「重新回答」：接着上一轮没完成的回答（服务端按那一轮的档位和已写出的部分接上）。 */
  function resume(): Promise<boolean> {
    if (!recoveryState) return Promise.resolve(false);
    return send(RESUME_TEXT[recoveryState.mode], [], { resumeRunId: recoveryState.runId });
  }

  /** 「重发」（17.4）：收下了却没开成的那句，撤掉它旁边的按钮，原话再发一次。 */
  function resend(message: Message): Promise<boolean> {
    setMessages((current) => current.map((item) => (item === message ? { ...item, receipt: undefined } : item)));
    return send(message.content, []);
  }

  /** 范围标签改过范围：照原意按新范围重读一遍（这一句作为本人的原话发出，请求带上 scopeOverride）。 */
  function rescope(params: TReadScopeParams, label: string): Promise<boolean> {
    return send(`按「${label}」重新读`, [], { scopeOverride: params });
  }

  /**
   * 停止。知道这一轮的 runId 就先请服务端停下，回来后再断开本地连接（首页 Chat 回的「已停止」通常先到）；
   * 还不知道、请求已发出就等它带来 runId 再停；还没送到（在等重发）直接断开。断开连接本身不会停下这一轮。
   */
  const stop = useCallback(() => {
    const turn = turnRef.current;
    if (!turn) return void abortRef.current?.abort();
    turn.stopWanted = true;
    if (turn.runId) stopTurn(turn.scope, turn.runId, abortRef.current);
    else if (!turn.sent) abortRef.current?.abort();
  }, []);
  /** 接上服务端还在写的那一轮（刷新、切回来时历史里最后一句还在回答）；正在写或在重连时不接。 */
  const followRef = useRef<(question: Message) => void>(() => undefined);
  followRef.current = (question) => {
    if (!abortRef.current) void send("", [], { attach: attachOf(question) });
  };
  // 交给输入条（memo）的回调身份不变：流式中整棵对话树每帧重画，输入条不跟着重画。
  const stableSend = useStableCallback(send);
  const stableUpload = useStableCallback(uploadFiles);
  const stableRescope = useStableCallback(rescope);
  const stableResend = useStableCallback(resend);
  const removeAttachment = useCallback((id: string) => setAttachments((current) => current.filter((item) => item.id !== id)), []);

  return {
    scope,
    viewingMaterialEditable: viewingMaterial?.editable ?? false,
    messages,
    status,
    streaming: status === "streaming",
    /** 回复中也能再发（伙伴对话，17.4）。 */
    interruptible: isBuddyScope(scope),
    /** 「重发」收下了却没开成的那句（17.4）。 */
    resend: stableResend,
    /** 这一轮伙伴的计划清单和出的卡（17.4，回答还在写时；写完读回的历史里在那条回答上）。 */
    plan: turnPlan,
    turnCards,
    /** 最近一轮实际用的来源和模型：这一轮流里报了的，没报的取历史里最后一条带 model 的回答。 */
    model: turnModel ?? latestModel(messages),
    /** 显示「正在思考 / 查证 / 整理回答」那一行：回答进行中、且正文还没结束。 */
    thinking: status === "streaming" && !bodyDone,
    partial,
    stage,
    startedAt,
    route,
    progress,
    steps,
    readScope,
    rescope: stableRescope,
    thought,
    error,
    /** 这一轮没完成、能接着来时的那个按钮（「继续」从断点续写 / 「重新回答」用已查到的材料重答）；回答进行中没有。 */
    recovery: recoveryState && status !== "streaming" ? { mode: recoveryState.mode, label: RESUME_TEXT[recoveryState.mode], run: () => void resume() } : null,
    lastReply,
    historyStatus,
    historyError,
    historyWaiting,
    retryHistory,
    attachments,
    uploading,
    attachmentError,
    uploadFiles: stableUpload,
    removeAttachment,
    send: stableSend,
    stop,
  };
}

export type ConversationData = ReturnType<typeof useConversation>;
