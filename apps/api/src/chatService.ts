import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { AskAnswerRecord, ConversationCard, type TAskAnswerRecord, type TConversationCard, type TConversationMessageRequest, type TPartnerMemoryItem } from "@warmap/contracts";
import { turnFailureCopy } from "./conversationRecovery.js";
import { segmentDateLabel, startsNewSegment } from "./conversationSegments.js";
import type { HomeTurnVia } from "./homeTurn.js";
import { logEvent } from "./observability.js";
import type { PageGuide } from "./pageGuides.js";
import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";

/**
 * 首页对话改走独立 Chat 服务（TokenkingOS/Chat_Service，开关 CHAT_SERVICE_URL）。接口以 Chat_Service 的 docs/service-contract.md 为准。
 * - 身份：天枢从登录态取本人 personId 和视角，带 INTERNAL_CHAT_TOKEN 转给 Chat（X-Owner-Id / X-Viewer-Role），浏览器碰不到凭据。
 * - 会话：Chat 里一个人一个视角可以有多段对话，首页接最近更新的那段；还没有就在发第一句、传第一个附件时新建。天枢不存对照。
 *   开了分段（CHAT_SESSION_ROTATION）：那段闲置满 12 小时或跨过北京时间凌晨 4 点，发句、传附件时新开一段（conversationSegments.ts）；
 *   界面拼最近 7 天的几段，段之间一行日期；「继续」进那一轮所在的段。
 * - 格式：Chat 的历史和事件翻成天枢现有对话的格式，界面不用改。Chat 没有的（步骤、范围标签、工具卡、出处标记）就没有。
 * - 项目对话（新首页第 16 节，projects.ts）：每人每个项目在 Chat 里单独一段（天枢记在 project_pipelines，以前 Task 管线的段在 task_pipelines，taskPipelines.ts）。
 *   带 target 的调用只认那一段：不判段、不记纪要；总管线挑段时排除这些段（pipelines）。
 */

export type ChatViewer = { personId: string; role: "ceo" | "member" };
export type ChatConversation = { conversationId: string; createdAt: string; updatedAt: string };
/** 首页这一句进了哪一段（纪要据此记下这段有新内容，conversationDigests.ts）。 */
export type ChatSegmentActivity = { conversationId: string; startedAt: Date };
/** 项目对话那一段：Chat 里的段 id、天枢这边的 scope（project:<projectId>）和项目 id。 */
export type ChatTarget = { conversationId: string; scope: string; projectId: string };

/** 开流之前就失败：路由按天枢的错误格式回给界面。 */
export class ChatServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

type ChatAttachment = { attachmentId: string; fileName: string; mime: string; size: number; status?: string };
type ChatMessage = { position?: string; role: "user" | "assistant"; text: string; runId: string; attachments?: ChatAttachment[]; turnAt?: string; channel?: HomeTurnVia | null;
  /** 伙伴的选项框（ask_user）：助手消息带提问卡，本人的作答消息带问答记录（契约 workHome.ts 顶部）。 */
  cards?: unknown; answers?: unknown };
type ChatRun = { runId: string; status: string };
type ChatMessagePage = { messages: ChatMessage[]; nextCursor: string | null; runs: ChatRun[] };
type ChatEvent = { type: string; [key: string]: unknown };
/**
 * 网页里问的那一轮（每人每视角每条线最近一轮：总管线和各项目对话各留各的）：翻好的事件全留着，界面切走、刷新、断线回来时先补发、再跟着往下写（follow）。
 * 写完也留着，直到这个人问下一句；api 一个环境一个进程，放在内存里。frame 为 null 表示这一轮结束了。
 */
type LiveTurn = { runId?: string; startedAt: number; frames: string[]; listeners: Set<(frame: string | null) => void>; finished: boolean };

/** 没完成的那一轮在历史里的说明行，与天枢自己的对话存档写法一致。 */
const STOPPED_NOTE = "（已停止，以上是停止前写出的部分。）";
const BROKEN_NOTE = "（这次回答在这里中断了，以上是已经写出的部分。）";
const EMPTY_NOTE = "（这次回答没有完成。）";

/**
 * Chat 不分快慢档（每一轮都是主模型边查边写），寒暄几秒就答完、要查的要 30 秒以上：
 * 开头按检索问答档显示「正在思考 · N 秒」；deepenAfterMs 内还没写出正文，改成深度档，界面换成「正在深度思考 · 预计 1–2 分钟」。
 */
export const CHAT_ROUTE = {
  start: { type: "route", tier: "grounded", expectSeconds: 30 },
  deep: { type: "route", tier: "deep", expectSeconds: 90 },
  deepenAfterMs: 20_000,
};

const attachmentInfo = (file: ChatAttachment) => ({ id: file.attachmentId, fileName: file.fileName, mimeType: file.mime, sizeBytes: file.size });

/** Chat 开流前的拒绝 → 天枢的码：界面已有文案的码对上；服务间凭据不对不能让界面当成登录过期。 */
function rejected(status: number, code: string, message: string | undefined): ChatServiceError {
  if (status === 401) return new ChatServiceError(500, "CHAT_UNAUTHORIZED", "天枢和对话服务的凭据没有对上，需要检查服务配置。");
  if (code === "TURN_RUNNING") return new ChatServiceError(409, "TURN_IN_PROGRESS", "上一轮回答还没结束，请等它写完或点「停止」后再发。");
  if (code === "INVALID_RESUME") return new ChatServiceError(404, "RESUME_NOT_FOUND", "要接着写的那一轮回答找不到了，请直接重新提问。");
  if (status >= 500) return new ChatServiceError(502, "CHAT_FAILED", "对话服务这次没有接下请求。");
  return new ChatServiceError(status, code, message ?? "对话服务没有接下这次请求。");
}

/**
 * Chat 的失败终态 → 天枢的 error 事件。界面自带文案的码（卡已不在）原样给；长度、上下文、重启用天枢的说明；
 * 其余配一句中文。能不能接着来照 Chat 说的。
 */
function failure(event: ChatEvent): ChatEvent {
  const partial = event.partial === true;
  const resume = event.resume === "continue" || event.resume === "retry" ? { resume: event.resume } : {};
  const kind = event.code === "OUTPUT_LIMIT" ? "length" as const
    : event.code === "SERVICE_RESTARTED" ? "restart" as const
    : event.code === "CONTEXT_BUDGET_EXCEEDED" || event.code === "CONTEXT_COMPACTION_FAILED" ? "context" as const : undefined;
  if (kind) {
    const copy = turnFailureCopy(kind, { partial });
    return { type: "error", code: copy.code, message: copy.message, partial, ...resume };
  }
  if (event.code === "ANCHOR_NOT_FOUND" || event.code === "REFERENCE_NOT_FOUND") return { type: "error", code: event.code, message: "", partial, ...resume };
  const keep = partial ? "已写出的部分保留在上方，点「继续」从断点接着写。" : "问题已保留，点「重新回答」再试一次。";
  return event.code === "MODEL_FAILED"
    ? { type: "error", code: "MODEL_UNAVAILABLE", message: `模型服务这次没有完成回答，已自动重试过。${keep}`, partial, ...resume }
    : { type: "error", code: "RUNTIME_FAILED", message: `这一轮没有完成。${keep}`, partial, ...resume };
}

/** Chat 的历史 → 天枢的消息：没完成的那一轮补上说明行；序号按顺序重排（说明行也占一个）；Chat 记下的来源回到 via。 */
export function historyMessages(messages: ChatMessage[], runs: ChatRun[]) {
  return joinSegments([{ messages, runs }]);
}

/** 拼几段（从旧到新）：每段之前一行这段开始的日期（第一段不加，kind=trace，界面画成一行淡字）；序号接着排。 */
export function joinSegments(segments: { messages: ChatMessage[]; runs: ChatRun[]; startedAt?: Date; conversationId?: string }[]) {
  type Item = { role: "user" | "assistant"; content: string; runId: string; via?: HomeTurnVia; running?: true; attachments?: ReturnType<typeof attachmentInfo>[]; kind?: "trace"; createdAt?: string;
    cards?: TConversationCard[]; answers?: TAskAnswerRecord };
  const ordered: Item[] = segments.flatMap((segment, index) => [
    ...(index && segment.startedAt ? [{ role: "assistant" as const, content: segmentDateLabel(segment.startedAt), runId: segment.conversationId ?? "",
      kind: "trace" as const, createdAt: segment.startedAt.toISOString() }] : []),
    ...segmentMessages(segment.messages, segment.runs),
  ]);
  return ordered.map((message, index) => ({ sequence: index + 1, referencesSnapshot: [], attachments: [], ...message }));
}

function segmentMessages(messages: ChatMessage[], runs: ChatRun[]) {
  const status = new Map(runs.map((run) => [run.runId, run.status]));
  const answered = new Set(messages.filter((message) => message.role === "assistant").map((message) => message.runId));
  const ordered: { role: "user" | "assistant"; content: string; runId: string; via?: HomeTurnVia; running?: true; attachments?: ReturnType<typeof attachmentInfo>[];
    cards?: TConversationCard[]; answers?: TAskAnswerRecord }[] = [];
  for (const message of messages) {
    const state = status.get(message.runId);
    const via = message.channel ? { via: message.channel } : {};
    if (message.role === "assistant") {
      const note = state === "aborted" ? STOPPED_NOTE : state === "failed" ? BROKEN_NOTE : undefined;
      // 提问卡照契约校验，不合格的丢掉，最多 4 张（界面只认这几种卡）。
      const cards = Array.isArray(message.cards) ? message.cards.filter((card): card is TConversationCard => Value.Check(ConversationCard, card)).slice(0, 4) : [];
      ordered.push({ role: "assistant", content: note ? `${message.text.trimEnd()}\n\n${note}` : message.text, runId: message.runId, ...via,
        ...(cards.length ? { cards } : {}) });
      continue;
    }
    // 还在回答的那一句标上 running：界面切走、刷新回来据此接上这一轮。
    ordered.push({ role: "user", content: message.text, runId: message.runId, ...via, ...(state === "running" ? { running: true as const } : {}),
      attachments: (message.attachments ?? []).map(attachmentInfo),
      ...(Value.Check(AskAnswerRecord, message.answers) ? { answers: message.answers } : {}) });
    if (state === "failed" && !answered.has(message.runId)) ordered.push({ role: "assistant", content: EMPTY_NOTE, runId: message.runId, ...via });
  }
  return ordered;
}

/** 首页界面拼最近几天的几段、最多约这么多条（拼够了就不再往前读，每 10 秒的轮询请求数有上限）。 */
const HISTORY_DAYS = 7;
const HISTORY_MESSAGES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createChatService(options: {
  baseUrl: string;
  token?: string;
  /** 首页分段（CHAT_SESSION_ROTATION）：关着时首页一直接最近更新的那一段，和分段之前一样。 */
  rotation?: boolean;
  /** 发一句、传附件进了哪一段（纪要据此记下有新内容）；失败只记日志，不影响这一句。 */
  onSegment?: (viewer: ChatViewer, segment: ChatSegmentActivity) => Promise<void>;
  /** 页面目录（CHAT_PAGE_CONTEXT=1 才给）：本人在二级页面问时，这一轮带上 page（这页的名字和说明；Task 页按本人读到的 Task 现算）。Chat 不收多余字段，没接 page 之前别开。 */
  pageGuide?: (path: string, viewer: ChatViewer) => Promise<PageGuide | null>;
  /** 本人的项目对话那几段（project_pipelines，和以前的 task_pipelines）：总管线挑段时排除，不当成首页的段。 */
  pipelines?: (viewer: ChatViewer) => Promise<Set<string>>;
}) {
  if (!options.token) throw new Error("CHAT_SERVICE_URL 需要同时配置 INTERNAL_CHAT_TOKEN");
  const base = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const rotation = options.rotation === true;

  const call = async (viewer: ChatViewer, requestId: string, path: string, init: RequestInit = {}): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`, "x-owner-id": viewer.personId, "x-viewer-role": viewer.role, "x-request-id": requestId } });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      logEvent({ event: "chat_service.unreachable", requestId, path, error: (error as Error)?.message });
      throw new ChatServiceError(503, "CHAT_UNAVAILABLE", "对话服务暂时连不上。");
    }
    if (response.ok) return response;
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? `HTTP_${response.status}`;
    logEvent({ event: "chat_service.rejected", requestId, path, httpStatus: response.status, errorCode: code });
    throw rejected(response.status, code, body.error?.message);
  };
  const json = async <T>(viewer: ChatViewer, requestId: string, path: string, init?: RequestInit) => (await (await call(viewer, requestId, path, init)).json()) as T;

  /** 本人本视角最近更新的 50 段（Chat 的顺序：最近更新的在前）。 */
  const conversations = async (viewer: ChatViewer, requestId: string) =>
    (await json<{ conversations: ChatConversation[] }>(viewer, requestId, "/conversations")).conversations;
  const messagesPage = (viewer: ChatViewer, requestId: string, conversationId: string, cursor = "0", limit = 100) =>
    json<ChatMessagePage>(viewer, requestId, `/conversations/${conversationId}/messages?limit=${limit}&cursor=${cursor}`);
  const allMessages = async (viewer: ChatViewer, requestId: string, conversationId: string) => {
    const messages: ChatMessage[] = [];
    let runs: ChatRun[] = [];
    for (let cursor: string | null = "0"; cursor !== null;) {
      const page = await messagesPage(viewer, requestId, conversationId, cursor);
      messages.push(...page.messages);
      runs = page.runs;
      cursor = page.nextCursor;
    }
    return { messages, runs };
  };
  /**
   * 不是总管线的段：给项目对话开了、天枢却没记成项目对话的那几段（登记失败，或这个项目已经登记了别的段）。
   * Chat 没有删段的接口，只能在总管线挑段时和项目对话那几段一起排除；放在内存里（api 一个环境一个进程），重启后靠日志（chat_service.pipeline_orphan）查。
   */
  const orphanSegments = new Set<string>();
  /** 总管线的段：去掉项目对话那几段和孤儿段（conversations() 本身照旧给全部，纪要核对隐藏的段要全部）。 */
  const mainConversations = async (viewer: ChatViewer, requestId: string) => {
    const [list, pipelines] = await Promise.all([conversations(viewer, requestId), options.pipelines?.(viewer)]);
    return list.filter((item) => !pipelines?.has(item.conversationId) && !orphanSegments.has(item.conversationId));
  };
  /** 开了分段时「当前这段」是最新开的那段（「继续」旧段会更新旧段的时间，但不让它变成当前段）；关着时照旧是最近更新的那段。 */
  const newestFirst = (list: ChatConversation[]) => (rotation ? [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) : list);

  /** 同一个人同一视角的「判段 + 新建」排队做：网页和飞书私聊同时发跨天后的第一句，只建一段（api 一个环境一个进程，飞书也走这个进程）。 */
  const queues = new Map<string, Promise<void>>();
  const exclusive = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    queues.set(key, tail);
    await previous;
    try { return await work(); } finally {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    }
  };

  /**
   * 这一句进哪一段：当前这段；还没有，或开了分段、rotate 且它闲置满 12 小时或跨过凌晨 4 点，就新建一段（create 时）。只读历史不建。
   * started：这一句开了新的一段。
   */
  const segment = async (viewer: ChatViewer, requestId: string, rotate: boolean): Promise<{ conversation: ChatConversation; started: boolean }> =>
    exclusive(`${viewer.personId}|${viewer.role}`, async () => {
      const [current] = newestFirst(await mainConversations(viewer, requestId));
      const stale = Boolean(current && rotation && rotate && startsNewSegment(new Date(current.updatedAt), new Date()));
      if (current && !stale) return { conversation: current, started: false };
      const created = await json<{ conversationId: string }>(viewer, requestId, "/conversations",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const at = new Date().toISOString();
      return { conversation: { conversationId: created.conversationId, createdAt: at, updatedAt: at }, started: stale };
    });
  /** 「继续」「重新回答」那一轮所在的段：在界面拼的那几段里找（每段只读一页拿 runs）；找不到交给 Chat 判（会回 INVALID_RESUME）。 */
  const segmentOfRun = async (viewer: ChatViewer, requestId: string, runId: string): Promise<ChatConversation | null> => {
    for (const conversation of shownSegments(await mainConversations(viewer, requestId))) {
      if ((await messagesPage(viewer, requestId, conversation.conversationId, "0", 1)).runs.some((run) => run.runId === runId)) return conversation;
    }
    return null;
  };
  /** 界面拼的那几段（从新到旧）：关着分段只有当前这段；开着是最近 7 天里说过话的几段，当前这段总在。 */
  const shownSegments = (list: ChatConversation[]) => newestFirst(list)
    .filter((item, index) => index === 0 || (rotation && Date.now() - Date.parse(item.updatedAt) <= HISTORY_DAYS * DAY_MS));
  const record = (viewer: ChatViewer, requestId: string, conversation: ChatConversation) => {
    if (!options.onSegment) return;
    void options.onSegment(viewer, { conversationId: conversation.conversationId, startedAt: new Date(conversation.createdAt) })
      .catch((error) => logEvent({ event: "chat_service.segment_record_failed", requestId, error: (error as Error)?.message }));
  };
  /** 每人每视角每条线网页里问的最近一轮（LiveTurn）：键带上 scope，总管线和各项目对话互不覆盖。 */
  const liveTurns = new Map<string, LiveTurn>();
  const liveKey = (viewer: ChatViewer, scope: string) => `${viewer.personId}|${viewer.role}|${scope}`;
  /** 本人点了停止的那几轮：Chat 随后回的「已停止」原样给界面，不当成 Chat 停机。 */
  const stoppedRuns = new Set<string>();
  const SSE_HEAD = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };

  return {
    conversations,
    messagesPage,
    /** 伙伴记住的本人的事（Chat 的长期记忆，「我的记忆」页只读显示）：现行的，最近更新的在前，最多 100 条。只取约定的字段。 */
    async memories(viewer: ChatViewer, requestId: string): Promise<TPartnerMemoryItem[]> {
      const { memories } = await json<{ memories: TPartnerMemoryItem[] }>(viewer, requestId, "/memories");
      return memories.map((item) => ({ id: item.id, category: item.category, text: item.text, project: item.project ?? null,
        tentative: item.tentative === true, updatedAt: item.updatedAt }));
    },
    async quality<S extends TSchema>(viewer: ChatViewer, requestId: string, path: string, schema: S, body?: unknown, signal?: AbortSignal): Promise<Static<S>> {
      const value: unknown = await json(viewer, requestId, `/task-quality${path}`, {
        signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]), redirect: "error",
        ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!Value.Check(schema, value)) throw new ChatServiceError(502, "CHAT_CONTRACT_MISMATCH", "对话服务的数据质量接口版本不匹配，请检查部署版本。");
      return value;
    },
    /**
     * 项目对话那一段：先查天枢记下的（existing），没有就在 Chat 开一段（最多等 15 秒），再记下（register 返回这个项目登记着的那段）。
     * 和总管线的「判段 + 新建」排在同一个队里做：记下之前总管线不会把这一段当成最新的一段，同一个人同时打开也只开一段。
     * 开了没记成的那段（登记失败，或这件已经登记了别的段）记成孤儿段，总管线不用；开段没拿到回应时不知道 id，只记日志。
     * created：这次开的段记下了。
     */
    async createConversation(viewer: ChatViewer, requestId: string, link: { existing: () => Promise<string | null>; register: (conversationId: string) => Promise<string> }):
      Promise<{ conversationId: string; created: boolean }> {
      return exclusive(`${viewer.personId}|${viewer.role}`, async () => {
        const existing = await link.existing();
        if (existing) return { conversationId: existing, created: false };
        let conversationId: string;
        try {
          ({ conversationId } = await json<{ conversationId: string }>(viewer, requestId, "/conversations",
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) }));
        } catch (error) {
          // Chat 回了拒绝就是没开；超时、连接断、回应读不出时 Chat 那边可能已经开了一段。
          if (error instanceof ChatServiceError && error.code !== "CHAT_UNAVAILABLE") throw error;
          logEvent({ event: "chat_service.pipeline_orphan", requestId, conversationId: null, error: (error as Error)?.message });
          throw new ChatServiceError(503, "CHAT_UNAVAILABLE", "对话服务暂时连不上。");
        }
        const orphan = (reason: string) => {
          orphanSegments.add(conversationId);
          logEvent({ event: "chat_service.pipeline_orphan", requestId, conversationId, reason });
        };
        let registered: string;
        try {
          registered = await link.register(conversationId);
        } catch (error) {
          orphan("register_failed");
          throw error;
        }
        if (registered !== conversationId) orphan("already_registered");
        return { conversationId: registered, created: registered === conversationId };
      });
    },
    /** 界面上的一条连续对话：拼几段，从新往旧读，拼够 HISTORY_MESSAGES 条就不再往前读（当前这段总会读）。带 target 时只读那一段。 */
    async history(viewer: ChatViewer, requestId: string, target?: ChatTarget) {
      if (target) {
        const { messages, runs } = await allMessages(viewer, requestId, target.conversationId);
        return { scope: target.scope, messages: historyMessages(messages, runs) };
      }
      const segments: Parameters<typeof joinSegments>[0] = [];
      let count = 0;
      for (const conversation of shownSegments(await mainConversations(viewer, requestId))) {
        if (count >= HISTORY_MESSAGES) break;
        const { messages, runs } = await allMessages(viewer, requestId, conversation.conversationId);
        segments.unshift({ messages, runs, startedAt: new Date(conversation.createdAt), conversationId: conversation.conversationId });
        count += messages.length;
      }
      return { scope: "global", messages: joinSegments(segments) };
    },

    /** 附件交给 Chat 解析、存在 Chat 那段对话上；有一份读不出文字就整批不收（和天枢自己的解析一样）。上传和随后那一句同一个判段规则。 */
    async upload(viewer: ChatViewer, requestId: string, files: { filename: string; mimetype: string; buffer: Buffer }[], target?: ChatTarget) {
      let id = target?.conversationId;
      if (!id) {
        const { conversation } = await segment(viewer, requestId, true);
        record(viewer, requestId, conversation);
        id = conversation.conversationId;
      }
      const form = new FormData();
      for (const file of files) form.append("files", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.filename);
      const result = await json<{ attachments: ChatAttachment[] }>(viewer, requestId, `/conversations/${id}/attachments`, { method: "POST", body: form });
      const unreadable = result.attachments.find((file) => file.status === "failed");
      if (unreadable) throw new ChatServiceError(400, "ATTACHMENT_UNREADABLE", `${unreadable.fileName} 没能读出文字，请换一份再传。`);
      return { attachments: result.attachments.map(attachmentInfo) };
    },

    /**
     * 发一句，把 Chat 的事件逐块翻好转给界面。开流前的拒绝抛 ChatServiceError；开流后在这里收尾。
     * 界面断开（切走、锁屏、刷新、关页面）不算停止：照样读到 Chat 写完，回答照常存下；网页里问的那一轮留在 liveTurns，回来时接上（follow）。
     * 停止只走 cancel（本人点「停止」）。
     * 带 target（项目对话）：只进那一段，不判段、不记纪要；没带页面路径时按这个项目的页面（/me/work/projects/<id>），Chat 就知道说的是哪个项目。
     */
    async relay(viewer: ChatViewer, requestId: string, body: TConversationMessageRequest, reply: FastifyReply, via?: HomeTurnVia, target?: ChatTarget): Promise<void> {
      const startedAt = Date.now();
      const scope = target?.scope ?? "global";
      // 「继续」进那一轮所在的段；带附件的这句进附件所在的那段（上传时已判过段）；其余按规则判段。
      const resumed = !target && rotation && body.resumeRunId ? await segmentOfRun(viewer, requestId, body.resumeRunId) : null;
      const current = target ? { conversation: { conversationId: target.conversationId, createdAt: "", updatedAt: "" }, started: false }
        : resumed ? { conversation: resumed, started: false } : await segment(viewer, requestId, !body.attachments?.length);
      if (!target) record(viewer, requestId, current.conversation);
      const id = current.conversation.conversationId;
      const pagePath = body.pagePath ?? (target ? `/me/work/projects/${encodeURIComponent(target.projectId)}` : undefined);
      const page = pagePath && options.pageGuide ? await options.pageGuide(pagePath, viewer) : null;
      const upstream = await call(viewer, requestId, `/conversations/${id}/turns`, {
        method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ clientRequestId: randomUUID(), message: body.message, attachmentIds: (body.attachments ?? []).map((item) => item.id),
          ...(body.anchorSelection ? { anchorSelection: body.anchorSelection } : {}),
          ...(body.references?.length ? { references: body.references } : {}),
          ...(body.resumeRunId ? { resumeRunId: body.resumeRunId } : {}),
          // 回答伙伴的选项框：原样转给 Chat，由 Chat 按自己存的提问卡核对、改写这一句。
          ...(body.answers ? { answers: body.answers } : {}),
          // 飞书、微信来的这一轮标上来源：Chat 的字段叫 channel，不认识的字段会整轮拒收。
          ...(via ? { channel: via } : {}),
          ...(page ? { page } : {}) }),
      });
      reply.hijack();
      reply.raw.writeHead(200, SSE_HEAD);
      // 飞书、微信来的那一轮不进 liveTurns：网页上照旧是「正在回答飞书里的提问」加轮询。
      const live: LiveTurn | undefined = via ? undefined : { startedAt, frames: [], listeners: new Set(), finished: false };
      if (live) liveTurns.set(liveKey(viewer, scope), live);
      let runId: string | undefined;
      let sequence = 0;
      let written = false;
      let outcome = "broken";
      let deepen: ReturnType<typeof setTimeout> | undefined;
      const frameOf = (event: ChatEvent) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, runId, scope, sequence: ++sequence })}\n\n`;
      const write = (event: ChatEvent) => {
        const frame = frameOf(event);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(frame);
        if (!live) return;
        live.frames.push(frame);
        for (const listener of live.listeners) listener(frame);
      };
      const translate = (event: ChatEvent): ChatEvent | null => {
        const { conversationId: _conversation, runId: _run, scope: _scope, sequence: _sequence, ...rest } = event;
        switch (event.type) {
          case "turn_started":
            runId = String(event.runId);
            if (live) live.runId = runId;
            deepen = setTimeout(() => { if (!written) write(CHAT_ROUTE.deep); }, CHAT_ROUTE.deepenAfterMs);
            return CHAT_ROUTE.start;
          case "message":
            if (typeof event.delta === "string" && event.delta) { written = true; clearTimeout(deepen); }
            return rest;
          case "thinking":
            // Chat 的 thinking 只带服务端的处理阶段（「状态：正在整理历史对话」这类），不是模型的思考：不给界面。
            return typeof event.delta === "string" && event.delta.startsWith("状态：") ? null : rest;
          case "done": {
            outcome = String(event.status);
            if (event.status !== "aborted" || (runId && stoppedRuns.has(runId))) return rest;
            // 不是本人点的停止却收到「已停止」：是 Chat 停机收尾，按服务更新处理，界面连上后自己接着写。
            const copy = turnFailureCopy("restart", { partial: written });
            return { type: "error", code: copy.code, message: copy.message, partial: written, ...(copy.resume ? { resume: copy.resume } : {}) };
          }
          case "error":
            outcome = String(event.code);
            return failure(event);
          default:
            return rest;
        }
      };
      try {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            // Chat 的心跳（注释行）照样转给界面（和接上来看的界面），代理和浏览器不会把连接当成断了。
            if (block.startsWith(":")) {
              if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(": ping\n\n");
              for (const listener of live?.listeners ?? []) listener(": ping\n\n");
              continue;
            }
            const data = block.split("\n").find((line) => line.startsWith("data:"));
            const event = data ? translate(JSON.parse(data.slice(5).trimStart()) as ChatEvent) : null;
            if (event) write(event);
          }
          if (done) break;
        }
      } catch {
        // 和 Chat 的连接断了（Chat 重启、网络）：不补事件，界面按回答途中断线处理，连上后自己接着写。
      } finally {
        clearTimeout(deepen);
        const clientClosed = reply.raw.destroyed && !reply.raw.writableEnded;
        logEvent({ event: "chat_service.turn", requestId, runId, outcome, ...(clientClosed ? { clientClosed: true } : {}),
          conversationId: current.conversation.conversationId, ...(current.started ? { newSegment: true } : {}) });
        if (runId) stoppedRuns.delete(runId);
        // 这一轮写完的时刻记成这段最后一次发言（纪要闲置 15 分钟后才写）。项目对话的段不记纪要。
        if (!target) record(viewer, requestId, current.conversation);
        if (!reply.raw.writableEnded) reply.raw.end();
        if (live) {
          // 接上来看的界面要一个结尾：和 Chat 的连接断了、没收到 done / error 时补一条「没有完成」（本人这条连接照旧不补，界面会自己接着写）。
          if (outcome === "broken") {
            const tail = frameOf(failure({ type: "error", code: "BROKEN", partial: written, resume: written ? "continue" : "retry" }));
            live.frames.push(tail);
            for (const listener of live.listeners) listener(tail);
          }
          live.finished = true;
          for (const listener of live.listeners) listener(null);
          live.listeners.clear();
        }
      }
    },

    /**
     * 接上本人网页里问的那一轮（切走、刷新、断线回来）：先补发已有的事件，还在写就跟着往下写到结束。
     * 不是这一轮（或这个进程里没有：api 重启过）返回 false，路由回 204。scope 是哪条线（项目对话是 project:<projectId>）。
     */
    follow(viewer: ChatViewer, runId: string, reply: FastifyReply, scope = "global"): boolean {
      const live = liveTurns.get(liveKey(viewer, scope));
      if (!live || live.runId !== runId) return false;
      reply.hijack();
      reply.raw.writeHead(200, { ...SSE_HEAD, "x-turn-started-at": String(live.startedAt) });
      for (const frame of live.frames) reply.raw.write(frame);
      if (live.finished) {
        reply.raw.end();
        return true;
      }
      const listener = (frame: string | null) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        if (frame === null) reply.raw.end();
        else reply.raw.write(frame);
      };
      live.listeners.add(listener);
      reply.raw.on("close", () => live.listeners.delete(listener));
      return true;
    },

    /** 本人点「停止」：请 Chat 停下这一轮（Chat 存下已写出的部分）；先记下是本人停的，Chat 回的「已停止」才原样给界面。 */
    async cancel(viewer: ChatViewer, requestId: string, runId: string): Promise<{ runId: string; status: string }> {
      stoppedRuns.add(runId);
      try {
        return await json<{ runId: string; status: string }>(viewer, requestId, `/turns/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
      } catch (error) {
        stoppedRuns.delete(runId);
        throw error;
      }
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
