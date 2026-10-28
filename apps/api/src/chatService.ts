import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { TConversationMessageRequest } from "@warmap/contracts";
import { turnFailureCopy } from "./conversationRecovery.js";
import type { HomeTurnVia } from "./homeTurn.js";
import { logEvent } from "./observability.js";
import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";

/**
 * 首页对话改走独立 Chat 服务（TokenkingOS/Chat_Service，开关 CHAT_SERVICE_URL）。接口以 Chat_Service 的 docs/service-contract.md 为准。
 * - 身份：天枢从登录态取本人 personId 和视角，带 INTERNAL_CHAT_TOKEN 转给 Chat（X-Owner-Id / X-Viewer-Role），浏览器碰不到凭据。
 * - 会话：Chat 里一个人一个视角可以有多段对话，首页接最近更新的那段；还没有就在发第一句、传第一个附件时新建。天枢不存对照。
 * - 格式：Chat 的历史和事件翻成天枢现有对话的格式，界面不用改。Chat 没有的（步骤、范围标签、工具卡、出处标记）就没有。
 */

export type ChatViewer = { personId: string; role: "ceo" | "member" };

/** 开流之前就失败：路由按天枢的错误格式回给界面。 */
export class ChatServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

type ChatAttachment = { attachmentId: string; fileName: string; mime: string; size: number; status?: string };
type ChatMessage = { role: "user" | "assistant"; text: string; runId: string; attachments?: ChatAttachment[]; source?: HomeTurnVia | null };
type ChatRun = { runId: string; status: string };
type ChatEvent = { type: string; [key: string]: unknown };

/** 工具开始时进度行的一句（只写在查什么）。工具名归 Chat 定，没列到的不显示这一句。 */
const TOOL_LABELS: Record<string, string> = {
  read_anchor: "展开当前页面",
  read_reference: "读取引用的资料",
  list_world_objects: "查找本体里的对象",
  read_world_object: "读取本体对象",
  list_confirmed_meetings: "查找已确认的会议",
  read_confirmed_meeting: "读取会议确认版",
  read_meeting_transcript: "读取会议逐字稿",
  read_attachment: "阅读附件",
  web_search: "检索公开来源",
  update_memory: "记下你的偏好",
  check_task_quality: "核对任务数据缺口",
  prepare_task_repair: "保存本人补齐草稿",
  analyze_meeting_tasks: "核对会议结论归位",
  list_task_repairs: "查看本人补齐记录",
};

/** 没完成的那一轮在历史里的说明行，与天枢自己的对话存档写法一致。 */
const STOPPED_NOTE = "（已停止，以上是停止前写出的部分。）";
const BROKEN_NOTE = "（这次回答在这里中断了，以上是已经写出的部分。）";
const EMPTY_NOTE = "（这次回答没有完成。）";

/** Chat 每一轮都是边查边写（主模型加工具），实测首字 1–2 分钟：按天枢的深度档显示「预计 1–2 分钟」。 */
const ROUTE_EVENT = { type: "route", tier: "deep", expectSeconds: 90 };

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
  const status = new Map(runs.map((run) => [run.runId, run.status]));
  const answered = new Set(messages.filter((message) => message.role === "assistant").map((message) => message.runId));
  const ordered: { role: "user" | "assistant"; content: string; runId: string; via?: HomeTurnVia; attachments?: ReturnType<typeof attachmentInfo>[] }[] = [];
  for (const message of messages) {
    const state = status.get(message.runId);
    const via = message.source ? { via: message.source } : {};
    if (message.role === "assistant") {
      const note = state === "aborted" ? STOPPED_NOTE : state === "failed" ? BROKEN_NOTE : undefined;
      ordered.push({ role: "assistant", content: note ? `${message.text.trimEnd()}\n\n${note}` : message.text, runId: message.runId, ...via });
      continue;
    }
    ordered.push({ role: "user", content: message.text, runId: message.runId, ...via, attachments: (message.attachments ?? []).map(attachmentInfo) });
    if (state === "failed" && !answered.has(message.runId)) ordered.push({ role: "assistant", content: EMPTY_NOTE, runId: message.runId, ...via });
  }
  return ordered.map((message, index) => ({ sequence: index + 1, referencesSnapshot: [], attachments: [], ...message }));
}

export function createChatService(options: { baseUrl: string; token?: string }) {
  if (!options.token) throw new Error("CHAT_SERVICE_URL 需要同时配置 INTERNAL_CHAT_TOKEN");
  const base = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;

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

  /** 首页接的那段 Chat 对话：最近更新的一段；create 时没有就新建。 */
  const conversation = async (viewer: ChatViewer, requestId: string, create: boolean): Promise<string | null> => {
    const list = await json<{ conversations: { conversationId: string }[] }>(viewer, requestId, "/conversations");
    if (list.conversations[0]) return list.conversations[0].conversationId;
    if (!create) return null;
    const created = await json<{ conversationId: string }>(viewer, requestId, "/conversations",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return created.conversationId;
  };

  return {
    async quality<S extends TSchema>(viewer: ChatViewer, requestId: string, path: string, schema: S, body?: unknown, signal?: AbortSignal): Promise<Static<S>> {
      const value: unknown = await json(viewer, requestId, `/task-quality${path}`, {
        signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]), redirect: "error",
        ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!Value.Check(schema, value)) throw new ChatServiceError(502, "CHAT_CONTRACT_MISMATCH", "对话服务的数据质量接口版本不匹配，请检查部署版本。");
      return value;
    },
    async history(viewer: ChatViewer, requestId: string) {
      const id = await conversation(viewer, requestId, false);
      if (!id) return { scope: "global", messages: [] };
      const messages: ChatMessage[] = [];
      let runs: ChatRun[] = [];
      for (let cursor: string | null = "0"; cursor !== null;) {
        const page: { messages: ChatMessage[]; nextCursor: string | null; runs: ChatRun[] } =
          await json(viewer, requestId, `/conversations/${id}/messages?limit=100&cursor=${cursor}`);
        messages.push(...page.messages);
        runs = page.runs;
        cursor = page.nextCursor;
      }
      return { scope: "global", messages: historyMessages(messages, runs) };
    },

    /** 附件交给 Chat 解析、存在 Chat 那段对话上；有一份读不出文字就整批不收（和天枢自己的解析一样）。 */
    async upload(viewer: ChatViewer, requestId: string, files: { filename: string; mimetype: string; buffer: Buffer }[]) {
      const id = await conversation(viewer, requestId, true);
      const form = new FormData();
      for (const file of files) form.append("files", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.filename);
      const result = await json<{ attachments: ChatAttachment[] }>(viewer, requestId, `/conversations/${id}/attachments`, { method: "POST", body: form });
      const unreadable = result.attachments.find((file) => file.status === "failed");
      if (unreadable) throw new ChatServiceError(400, "ATTACHMENT_UNREADABLE", `${unreadable.fileName} 没能读出文字，请换一份再传。`);
      return { attachments: result.attachments.map(attachmentInfo) };
    },

    /**
     * 发一句，把 Chat 的事件逐块翻好转给界面。开流前的拒绝抛 ChatServiceError；开流后在这里收尾。
     * 界面断开（点停止、关页面）就断开对 Chat 的请求，Chat 照它的规则停下这一轮、存下已写出的部分。
     */
    async relay(viewer: ChatViewer, requestId: string, body: TConversationMessageRequest, reply: FastifyReply, via?: HomeTurnVia): Promise<void> {
      const abort = new AbortController();
      let ended = false;
      reply.raw.on("close", () => { if (!ended) abort.abort(); });
      let upstream: Response;
      try {
        const id = await conversation(viewer, requestId, true);
        upstream = await call(viewer, requestId, `/conversations/${id}/turns`, {
          method: "POST", signal: abort.signal, headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ clientRequestId: randomUUID(), message: body.message, attachmentIds: (body.attachments ?? []).map((item) => item.id),
            ...(body.anchorSelection ? { anchorSelection: body.anchorSelection } : {}),
            ...(body.references?.length ? { references: body.references } : {}),
            ...(body.resumeRunId ? { resumeRunId: body.resumeRunId } : {}),
            ...(via ? { source: via } : {}) }),
        });
      } catch (error) {
        if (!abort.signal.aborted) throw error;
        ended = true;
        reply.hijack();
        reply.raw.end();
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let runId: string | undefined;
      let sequence = 0;
      let written = false;
      let outcome = "broken";
      const write = (event: ChatEvent) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, runId, scope: "global", sequence: ++sequence })}\n\n`);
      };
      const translate = (event: ChatEvent): ChatEvent | null => {
        const { conversationId: _conversation, runId: _run, scope: _scope, sequence: _sequence, ...rest } = event;
        switch (event.type) {
          case "turn_started":
            runId = String(event.runId);
            return ROUTE_EVENT;
          case "message":
            if (typeof event.delta === "string" && event.delta) written = true;
            return rest;
          case "tool": {
            const label = event.phase === "started" ? TOOL_LABELS[String(event.name)] : undefined;
            return label ? { ...rest, label } : rest;
          }
          case "done": {
            outcome = String(event.status);
            if (event.status !== "aborted") return rest;
            // 界面还连着却收到「已停止」：不是本人停的，是 Chat 停机收尾，按服务更新处理，界面连上后自己接着写。
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
            // Chat 的心跳（注释行）照样转给界面，代理和浏览器不会把连接当成断了。
            if (block.startsWith(":")) {
              if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(": ping\n\n");
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
        ended = true;
        logEvent({ event: "chat_service.turn", requestId, runId, outcome: abort.signal.aborted ? "client_closed" : outcome });
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
