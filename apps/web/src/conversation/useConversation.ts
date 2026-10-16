"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseSseBlock, splitSse, type ConversationEvent } from "./sse";
import { afterResize, resizing } from "./resizeGate";
import { useStableCallback } from "./stableCallback";

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
  recoveryNote?: RecoveryNote };
export type Attachment = { id: string; fileName: string; mimeType: string };
export type ConversationStatus = "idle" | "streaming" | "complete" | "failed" | "aborted";
/** 历史读取：`ready` 且 0 条 = 真的没有记录；`error` = 没读到（不代表没有记录）。与一轮回答的 `status` 无关。 */
export type HistoryStatus = "loading" | "ready" | "error";
/** clark 的三段思考：尚无事件 = 思考；开始用工具 = 快速查证；首个文字 = 整理回答。 */
/** understanding：刚发出、档位还没定；thinking：模型在思考；researching：在查证；answering：正文在写。 */
export type ThinkingStage = "understanding" | "thinking" | "researching" | "answering";
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

/** 一句话发出 / 这一轮结束（成功、失败、停止都算）：detail.scope 是这条对话。 */
export const CONVERSATION_TURN_SENT = "conversation-turn-sent";
export const CONVERSATION_TURN_SETTLED = "conversation-turn-settled";
/** 换了当前对话（新建 / 切回）：跟着这条对话走的部分（提案卡、台账）各自重读。 */
export const CONVERSATION_SWITCHED = "conversation-switched";

export function messagesEndpoint(scope: string): string {
  return `/api/conversations/${encodeURIComponent(scope)}/messages`;
}

/** 新建对话、历史对话列表、只读回看、切回继续（都按 scope，只认本人的）。 */
export const conversationEndpoints = {
  new: (scope: string) => `/api/conversations/${encodeURIComponent(scope)}/new`,
  archived: (scope: string) => `/api/conversations/${encodeURIComponent(scope)}/archived`,
  archivedMessages: (scope: string, id: string) => `/api/conversations/${encodeURIComponent(scope)}/archived/${encodeURIComponent(id)}/messages`,
  restore: (scope: string, id: string) => `/api/conversations/${encodeURIComponent(scope)}/archived/${encodeURIComponent(id)}/restore`,
};

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
      return "没有连上天枢服务（可能正在重启，或本机网络刚切换）。消息没有发出去，原文已放回输入框，稍后重发即可。";
    case "HTTP_400":
      return "这条消息没有通过校验，没有发出去。原文已放回输入框，可以改短一些或去掉附件后重发。";
    case "HTTP_413":
      return "消息或附件太大，没有发出去。原文已放回输入框，可以拆成几次发。";
    case "STREAM_SILENT":
      return "和天枢服务的连接超过一分钟没有任何数据，已断开。";
    case "STREAM_BROKEN":
    case "STREAM_ENDED":
      return "和天枢服务的连接在回答途中断开了（可能是服务重启或本机网络切换）。";
    default:
      if (code?.startsWith("HTTP_5")) return "天枢服务这次没有接下这条消息（服务出错，已记录）。原文已放回输入框，可以直接重发。";
      return "这次回答没有完成（原因已记录）。";
  }
}

/** 历史没读到的原因（中文，不显示英文原文）；界面再补一句「没载入不代表没有记录」或「已显示的内容仍保留」。 */
export function historyFailureCopy(status?: number): string {
  if (status === 401) return "登录状态已失效，请重新进入后再试。";
  if (status === 403 || status === 404) return "暂无法读取该对话：对象可能已移除，或无查看权限。";
  if (status && status >= 500) return "天枢服务读取对话记录时出错（已记录），可以点重试。";
  return "没有连上天枢服务，对话记录没读出来，可以点重试。";
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
    if (loaded[index].content === turn.content) return loaded;
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

export function useConversation(scope: string, viewingMaterial: { id: string; editable: boolean } | null = null, messageContext?: string) {
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
  /** 本轮（或刚结束那一轮）的思考摘要；换 scope、发下一句时清空。 */
  const [thought, setThought] = useState<TurnThought | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastReply, setLastReply] = useState<{ text: string; ms: number } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("loading");
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** 已归档、有内容的历史对话条数（服务端随历史一起给）：当前对话为空时据此给一行「查看历史对话」。 */
  const [archivedCount, setArchivedCount] = useState(0);
  /** 正在新建 / 切换对话：按钮不重复触发；失败时说明放在 switchError。 */
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  /** 换过几次当前对话：跟着对话走的数据（提案卡、撤销）按它重读。 */
  const [revision, setRevision] = useState(0);
  /** 这一轮没完成时能不能接着来（「继续」/「重新回答」）：哪一轮、怎么接；发下一句、换 scope 时清空。 */
  const [recoveryState, setRecoveryState] = useState<{ mode: TurnRecoveryMode; runId: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 进行中的那次历史读取：新的读取、换 scope、卸载都会作废它，作废后的结果不写进来。 */
  const historyRun = useRef<AbortController | null>(null);
  /** 本轮刚发出、可能还没写进历史的那句：回答进行中读回历史时补在最后。 */
  const pendingTurn = useRef<Message | null>(null);
  /** 每换一次 scope（或卸载）加一：上一个 scope 迟到的发送、上传结果不再改这里的状态。 */
  const generation = useRef(0);
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
   */
  const loadHistory = useCallback(async (mode: "show" | "quiet" = "show"): Promise<Message[] | null> => {
    historyRun.current?.abort();
    const controller = new AbortController();
    historyRun.current = controller;
    const current = () => historyRun.current === controller && !controller.signal.aborted;
    if (mode === "show") {
      setHistoryStatus("loading");
      setHistoryError(null);
    }
    let failedStatus: number | undefined;
    try {
      const response = await fetch(historyUrl, { headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) {
        failedStatus = response.status;
        throw new Error(`历史读取失败：${response.status}`);
      }
      const body = (await response.json()) as { messages?: unknown; archivedCount?: unknown };
      if (!Array.isArray(body.messages)) throw new Error("历史格式不对");
      if (!current()) return null;
      const loaded = withPendingTurn(body.messages as Message[], pendingTurn.current);
      setMessages(loaded);
      setArchivedCount(typeof body.archivedCount === "number" ? body.archivedCount : 0);
      setHistoryStatus("ready");
      setHistoryError(null);
      return loaded;
    } catch {
      if (!current()) return null;
      setHistoryStatus("error");
      setHistoryError(historyFailureCopy(failedStatus));
      return null;
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
    setArchivedCount(0);
    setSwitchError(null);
    // 附件挂在上一个 scope 的对话上，不能带到这里发送。
    setAttachments((current) => (current.length ? [] : current));
    setUploading(false);
    setAttachmentError(null);
    void loadHistory("show");
    return () => {
      // 换 scope 或卸载：作废进行中的历史读取；上一轮回答照常在服务端完成，只是不再写进这里，停止键也不再指向它。
      generation.current += 1;
      pendingTurn.current = null;
      if (partialFrame.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(partialFrame.current);
      partialFrame.current = null;
      abortRef.current = null;
      historyRun.current?.abort();
      historyRun.current = null;
    };
  }, [loadHistory]);

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
   * 发送一轮。返回 false 表示在服务端接收之前就失败了（C-04：调用方保留输入与引用）。
   * 请求与 SSE 处理与原实现相同；只在展示上派生思考阶段与失败文案。
   * 这一轮不管怎么结束（出错、断线、超时、停止），已经写出的正文和思考都留在界面上：服务端存了就用读回的，
   * 没来得及存就在本地补一条；能接着来的给出「继续」/「重新回答」（resume）。
   * options.resumeRunId：接着那一轮没完成的回答（「继续」按钮），这一句不带页面前缀。
   */
  async function send(message: string, references: SentCardRef[], options: { resumeRunId?: string } = {}): Promise<boolean> {
    const input = message.trim();
    if (!input || status === "streaming") return false;
    const text = messageContext && !options.resumeRunId ? `${messageContext}

${input}` : input;
    const controller = new AbortController();
    abortRef.current = controller;
    const started = generation.current;
    /** 这一轮发出后没换 scope、也没卸载：只有这时才改本页的状态（事件照常发，带的是本轮的 scope）。 */
    const live = () => generation.current === started;
    const began = Date.now();
    frameUpdate.current = emptyFrame();
    setPartial("");
    setError(null);
    setRecoveryState(null);
    setStage("understanding");
    setBodyDone(false);
    setStartedAt(began);
    setRoute(null);
    setProgress({ label: null, checked: 0 });
    setThought(null);
    setStatus("streaming");
    const attachmentRefs = attachments.map((attachment) => ({ id: attachment.id }));
    // 乐观渲染：引用的卡片、附的材料随这句一起立刻画出来，不等回答结束读回历史。
    const turn = pendingUserMessage(0, text, references, attachments);
    pendingTurn.current = turn;
    setMessages((current) => [...current, { ...turn, sequence: current.length + 1 }]);
    // 页面上跟着这条对话走的部分（月度计划逐段意见）：发出与这一轮结束时各通知一次，各自重读。
    window.dispatchEvent(new CustomEvent(CONVERSATION_TURN_SENT, { detail: { scope, content: text } }));

    let accepted = false;
    let reply = "";
    let notice: string | undefined;
    /** 这一轮走过恢复时服务端在 done 里给的那行说明（读不回历史时本地补的那条回答也带上）。 */
    let recoveryNote: RecoveryNote | undefined;
    /** 这一轮的标识（服务端事件带着）：失败后「继续」按它接上。 */
    let runId: string | undefined;
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
      let response: Response;
      try {
        response = await fetch(historyUrl, {
          method: "POST",
          headers: { accept: "text/event-stream", "content-type": "application/json" },
          body: JSON.stringify({ message: text, references: references.map(({ cardId, version }) => ({ cardId, version })), attachments: attachmentRefs,
            ...(viewingMaterial ? { viewingMaterialId: viewingMaterial.id } : {}),
            ...(options.resumeRunId ? { resumeRunId: options.resumeRunId } : {}) }),
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted) throw cause;
        throw new TurnError("UNREACHABLE", (cause as Error)?.message ?? "fetch failed");
      }
      if (response.status === 401) {
        window.location.assign("/access");
        return true;
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
      const reloaded = await loadHistory("quiet");
      if (!live()) return true;
      if (!reloaded && reply) setMessages((current) => [...current, { sequence: (current.at(-1)?.sequence ?? 0) + 1, role: "assistant", content: withNotice(notice, reply),
        ...(recoveryNote ? { recoveryNote } : {}) }]);
      setPartial("");
      setAttachments([]);
      setLastReply({ text: withNotice(notice, reply), ms: Date.now() - began });
      setStatus("complete");
      return true;
    } catch (cause) {
      if (silenceTimer) clearTimeout(silenceTimer);
      flushPartial(live);
      if (!live()) return accepted;
      pendingTurn.current = null;
      const reloaded = await loadHistory("quiet");
      if (!live()) return accepted;
      const code = (cause as TurnError).code;
      const stopped = controller.signal.aborted || code === "ABORTED";
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
      if (stopped) {
        setStatus("aborted");
        setError(written ? "已停止。已写出的部分保留在上方，点「继续」可以接着写。" : "已停止本次回答。");
        if (written && runId) setRecoveryState({ mode: "continue", runId });
      } else {
        setStatus("failed");
        const copy = failureCopy(code, (cause as Error).message);
        // 服务端说了能不能接着来就照它；连接中途断了（服务端没来得及说）按有没有写出正文决定。
        const mode = serverError ? serverError.resume : accepted ? (written ? "continue" : "retry") : undefined;
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
      window.dispatchEvent(new CustomEvent(CONVERSATION_TURN_SETTLED, { detail: { scope } }));
    }
  }

  /** 「继续」/「重新回答」：接着上一轮没完成的回答（服务端按那一轮的档位和已写出的部分接上）。 */
  function resume(): Promise<boolean> {
    if (!recoveryState) return Promise.resolve(false);
    return send(RESUME_TEXT[recoveryState.mode], [], { resumeRunId: recoveryState.runId });
  }

  /**
   * 换当前对话（新建一条空白的 / 切回一段历史对话）：服务端在「人 × scope」锁里切，成功后清掉本轮的展示态、重读历史。
   * 回答进行中不切；失败只给一句说明，已显示的对话不动。
   */
  async function switchTo(url: string): Promise<boolean> {
    if (status === "streaming" || switching) return false;
    const started = generation.current;
    setSwitching(true);
    setSwitchError(null);
    try {
      let response: Response;
      try {
        response = await fetch(url, { method: "POST", headers: { accept: "application/json" } });
      } catch {
        throw new TurnError("UNREACHABLE", "");
      }
      if (response.status === 401) {
        window.location.assign("/access");
        return false;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
        throw new TurnError(body.code ?? `HTTP_${response.status}`, body.message ?? "");
      }
      if (generation.current !== started) return true;
      pendingTurn.current = null;
      setMessages([]);
      setPartial("");
      setStatus("idle");
      setError(null);
      setLastReply(null);
      setThought(null);
      setRecoveryState(null);
      // 待发附件挂在原来那条对话上：换了对话就不再带着。
      setAttachments((current) => (current.length ? [] : current));
      setAttachmentError(null);
      await loadHistory("show");
      setRevision((value) => value + 1);
      window.dispatchEvent(new CustomEvent(CONVERSATION_SWITCHED, { detail: { scope } }));
      return true;
    } catch (cause) {
      if (generation.current === started) {
        const code = (cause as TurnError).code;
        setSwitchError(code === "TURN_IN_PROGRESS" ? "上一轮回答还没结束，请等它写完或点「停止」后再切换对话。"
          : code === "UNREACHABLE" ? "没有连上天枢服务，对话没有切换，可以稍后再试。"
          : "对话没有切换成功（原因已记录），当前对话不受影响，可以稍后再试。");
      }
      return false;
    } finally {
      if (generation.current === started) setSwitching(false);
    }
  }
  const startNew = useStableCallback(() => switchTo(conversationEndpoints.new(scope)));
  const restoreArchived = useStableCallback((id: string) => switchTo(conversationEndpoints.restore(scope, id)));

  const stop = useCallback(() => abortRef.current?.abort(), []);
  // 交给输入条（memo）的回调身份不变：流式中整棵对话树每帧重画，输入条不跟着重画。
  const stableSend = useStableCallback(send);
  const stableUpload = useStableCallback(uploadFiles);
  const removeAttachment = useCallback((id: string) => setAttachments((current) => current.filter((item) => item.id !== id)), []);

  return {
    scope,
    viewingMaterialEditable: viewingMaterial?.editable ?? false,
    messages,
    status,
    streaming: status === "streaming",
    /** 显示「正在思考 / 查证 / 整理回答」那一行：回答进行中、且正文还没结束。 */
    thinking: status === "streaming" && !bodyDone,
    partial,
    stage,
    startedAt,
    route,
    progress,
    thought,
    error,
    /** 这一轮没完成、能接着来时的那个按钮（「继续」从断点续写 / 「重新回答」用已查到的材料重答）；回答进行中没有。 */
    recovery: recoveryState && status !== "streaming" ? { mode: recoveryState.mode, label: RESUME_TEXT[recoveryState.mode], run: () => void resume() } : null,
    lastReply,
    historyStatus,
    historyError,
    retryHistory,
    /** 已归档、有内容的历史对话条数。 */
    archivedCount,
    /** 新建对话：当前对话有内容就归档，换一条空白的。 */
    startNew,
    /** 切回一段历史对话继续。 */
    restoreArchived,
    switching,
    switchError,
    revision,
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
