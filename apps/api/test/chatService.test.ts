import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { homeTurn } from "../src/homeTurn.js";
import { CHAT_ROUTE, historyMessages } from "../src/chatService.js";
import { THIRD, boardFixture } from "./boardFixture.js";

const CHAT_TOKEN = "chat-token-test";
const RUN = "6f0c1a52-6d7e-4e57-9a51-0a9a4c3e2b10";
/** Chat（8699279）TurnCommand 收的字段；它不收多余字段。answers 是伙伴选项框的作答（契约 workHome.ts 顶部）。 */
const TURN_FIELDS = new Set(["clientRequestId", "message", "attachmentIds", "resumeRunId", "channel", "anchorSelection", "references", "page", "answers"]);
/** Chat 的 page：path、title、guide 都必填，最多 200、40、150 字（10/29 人豪）。 */
const validPage = (page: unknown) => {
  if (page === undefined) return true;
  const { path, title, guide } = (page ?? {}) as Record<string, unknown>;
  return [[path, 200], [title, 40], [guide, 150]].every(([value, max]) => typeof value === "string" && value.length > 0 && value.length <= (max as number));
};

type ChatRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: string; raw?: Buffer };
type Page = { messages: unknown[]; runs: unknown[]; nextCursor: string | null };

/** Chat 的一轮 SSE：先一行心跳，事件带 Chat 自己的 conversationId / runId / scope / sequence。 */
function sse(res: ServerResponse, events: Record<string, unknown>[], end = true) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  res.write(": heartbeat\n\n");
  events.forEach((event, index) => res.write(`data: ${JSON.stringify({ conversationId: "chat-conversation", runId: RUN, scope: "global", sequence: index + 1, ...event })}\n\n`));
  if (end) res.end();
}

/**
 * 假 Chat 服务（照 Chat_Service 的接口形状）：会话列表、新建、按游标翻历史、附件、发一轮。
 * 内部凭据不对一律 401；turns 按 turn 脚本回（默认一轮正常回答）。
 */
type FakeConversation = { conversationId: string; createdAt: string; updatedAt: string };
async function fakeChat(options: {
  /** 最近更新的在前；只给 id 时两个时间都是现在。 */
  conversations?: (string | FakeConversation)[];
  /** 按游标的历史页（所有会话共用）；segments 给了某段时按段取。 */
  pages?: Record<string, Page>;
  segments?: Record<string, Record<string, Page>>;
  turn?: (res: ServerResponse, request: ChatRequest) => void;
  upload?: (request: ChatRequest) => unknown;
  /** POST /turns/:id/cancel（本人点停止）；没给时 404。 */
  cancel?: (res: ServerResponse, request: ChatRequest) => void;
  /** POST /conversations 开段之前先等它（模拟 Chat 卡住、或开段期间别的进程先登记了）。 */
  beforeCreate?: () => Promise<void>;
  /** 按对话选模型（17.2 第 36 条）：GET /models 回它，GET/PUT /conversations/:id/model 读改；没给时这几条 404（老 Chat）。 */
  models?: { source: string; modelId: string; label: string; efforts: string[]; defaultEffort: string; isDefault: boolean }[];
} = {}) {
  const choices = new Map<string, unknown>();
  const requests: ChatRequest[] = [];
  const now = () => new Date().toISOString();
  const listed: FakeConversation[] = (options.conversations ?? []).map((item) => (typeof item === "string" ? { conversationId: item, createdAt: now(), updatedAt: now() } : item));
  const conversations = listed.map((item) => item.conversationId);
  const touch = (id: string) => {
    const item = listed.find((entry) => entry.conversationId === id);
    if (!item) return;
    item.updatedAt = now();
    listed.splice(listed.indexOf(item), 1);
    listed.unshift(item);
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const request = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw.toString("utf8"), raw };
    requests.push(request);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${CHAT_TOKEN}`) return send(401, { error: { code: "UNAUTHORIZED", message: "内部服务凭据无效" } });
    if (request.method === "GET" && request.url === "/conversations") return send(200, { conversations: listed.slice(0, 50) });
    if (request.method === "POST" && request.url === "/conversations") {
      await options.beforeCreate?.();
      const created = { conversationId: randomUUID(), createdAt: now(), updatedAt: now() };
      listed.unshift(created);
      conversations.unshift(created.conversationId);
      return send(201, { conversationId: created.conversationId });
    }
    const history = /\/conversations\/([^/]+)\/messages\?limit=\d+&cursor=(\d+)$/.exec(request.url);
    if (request.method === "GET" && history) {
      return send(200, (options.segments?.[history[1]] ?? options.pages)?.[history[2]] ?? { messages: [], runs: [], nextCursor: null });
    }
    if (request.method === "POST" && request.url.endsWith("/attachments")) return send(200, options.upload?.(request));
    const modelPath = /^\/conversations\/([^/]+)\/model$/.exec(request.url);
    if (options.models && request.method === "GET" && request.url === "/models") return send(200, { models: options.models });
    if (options.models && modelPath && request.method === "GET") return send(200, { choice: choices.get(modelPath[1]) ?? null });
    if (options.models && modelPath && request.method === "PUT") {
      const { choice } = JSON.parse(request.body) as { choice: { source: string; modelId: string; effort: string } | null };
      if (choice && !options.models.some((model) => model.source === choice.source && model.modelId === choice.modelId && model.efforts.includes(choice.effort)))
        return send(400, { error: { code: "INVALID_MODEL_CHOICE", message: "没有这个模型，或它不支持这档思考程度" } });
      choices.set(modelPath[1], choice);
      return send(200, { choice });
    }
    if (request.method === "POST" && /^\/turns\/[^/]+\/cancel$/.test(request.url) && options.cancel) return options.cancel(res, request);
    if (request.method === "POST" && request.url.endsWith("/turns")) {
      // 和 Chat 的 TurnCommand 一样不收多余字段：字段名对不上时整轮 400。
      const command = JSON.parse(request.body) as Record<string, unknown>;
      const unknown = Object.keys(command).filter((key) => !TURN_FIELDS.has(key));
      if (unknown.length || !validPage(command.page)) return send(400, { error: { code: "INVALID_INPUT", message: "请求字段或格式无效" } });
      touch(request.url.split("/")[2]);
      if (options.turn) return options.turn(res, request);
      return sse(res, [{ type: "turn_started", userMessageId: randomUUID() }, { type: "message", delta: "好的" }, { type: "done", status: "completed" }]);
    }
    send(404, { error: { code: "NOT_FOUND", message: "没有这个接口" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    conversations,
    listed,
    turns: () => requests.filter((request) => request.url.endsWith("/turns")),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** 天枢自己的运行时：首页对话走 Chat 时它一次都不该跑。 */
function countingRuntime(): ConversationRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    async run(input: Parameters<ConversationRuntime["run"]>[0]) {
      runtime.calls += 1;
      input.emit({ type: "message", delta: "天枢回答" });
      return { assistantMessage: "天枢回答", runtimeEntries: [] };
    },
  };
  return runtime;
}

/** 界面收到的所有事件（只取 data 行）。 */
function allEvents(payload: string): Record<string, unknown>[] {
  return payload.split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
    return line ? [JSON.parse(line.slice(5)) as Record<string, unknown>] : [];
  });
}
/** 界面收到的事件，去掉每轮最前面的两个回执（17.4，单独测）。 */
function events(payload: string): Record<string, unknown>[] {
  return allEvents(payload).filter((event) => event.type !== "receipt");
}

function multipart(filename: string, content: string): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `----vitest-${Date.now()}`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`),
      Buffer.from(content, "utf8"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function withChat(chat: Awaited<ReturnType<typeof fakeChat>>, runtime: ConversationRuntime,
  run: (t: Awaited<ReturnType<typeof createTestApp>>) => Promise<void>, token = CHAT_TOKEN, extra: { chatPageContext?: boolean } = {}) {
  const t = await createTestApp({ internalChatToken: token, chatServiceUrl: chat.url, ...extra }, runtime);
  try {
    await run(t);
  } finally {
    await t.close();
    await chat.close();
  }
}

describe("首页对话走独立 Chat（CHAT_SERVICE_URL）", () => {
  it("带内部凭据转发本人身份、发第一句时新建 Chat 会话、事件翻成天枢格式；天枢自己的运行时不跑、不建会话", async () => {
    const chat = await fakeChat({ turn: (res) => sse(res, [
      { type: "turn_started", userMessageId: randomUUID() },
      { type: "thinking", delta: "状态：正在整理历史对话\n" },
      { type: "thinking" },
      { type: "tool", phase: "started", toolCallId: "t1", name: "read_world_object" },
      { type: "tool", phase: "completed", toolCallId: "t1", name: "read_world_object" },
      { type: "message", delta: "本月" },
      { type: "message", delta: "重点是上线" },
      { type: "usage", input: 10, output: 5 },
      { type: "done", status: "completed" },
    ]) });
    const runtime = countingRuntime();
    await withChat(chat, runtime, async (t) => {
      const cookie = await t.loginCookie();
      const empty = await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } });
      expect(empty.json()).toEqual({ scope: "global", messages: [] });
      // 只读历史不建 Chat 会话。
      expect(chat.conversations).toEqual([]);

      const response = await t.app.inject({
        method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "这个月的重点？", anchorSelection: { cardId: "radar:default", version: 1 } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.payload).toContain(": ping");
      const received = events(response.payload);
      expect(received.map((event) => event.type)).toEqual(["route", "thinking", "tool", "tool", "message", "message", "usage", "done"]);
      // 正文很快就来：一直是检索问答档，不说「预计 1–2 分钟」。
      expect(received[0]).toMatchObject({ tier: "grounded", expectSeconds: 30 });
      // Chat 的「状态：…」不是模型的思考，不给界面；工具只转 Chat 给的，不再配一句「在查什么」。
      expect(received[1]).not.toHaveProperty("delta");
      expect(received[2]).toMatchObject({ phase: "started", name: "read_world_object" });
      expect(received.filter((event) => event.type === "tool").some((event) => "label" in event)).toBe(false);
      // 回执（17.4）排在最前：天枢收下了、伙伴读到了；序号接着排。
      // 回执按这条消息的 id（转给 Chat 的 clientRequestId）对上。
      const messageId = JSON.parse(chat.turns()[0].body).clientRequestId as string;
      expect(allEvents(response.payload).slice(0, 2)).toEqual([{ type: "receipt", state: "delivered", messageId, runId: RUN, scope: "global", sequence: 1 },
        { type: "receipt", state: "read", messageId, runId: RUN, scope: "global", sequence: 2 }]);
      expect(received.every((event, index) => event.runId === RUN && event.scope === "global" && event.sequence === index + 3)).toBe(true);
      expect(received.some((event) => "conversationId" in event)).toBe(false);

      // 每个请求都带内部凭据和本人身份，浏览器的 Cookie 不转给 Chat。
      expect(chat.requests.length).toBeGreaterThanOrEqual(3);
      for (const request of chat.requests) {
        expect(request.headers.authorization).toBe(`Bearer ${CHAT_TOKEN}`);
        expect(request.headers["x-owner-id"]).toBe(TEST_CEO.personId);
        expect(request.headers["x-viewer-role"]).toBe("ceo");
        expect(request.headers.cookie).toBeUndefined();
      }
      const [turn] = chat.turns();
      expect(turn.url).toBe(`/conversations/${chat.conversations[0]}/turns`);
      expect(JSON.parse(turn.body)).toEqual({
        clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/), message: "这个月的重点？", attachmentIds: [],
        anchorSelection: { cardId: "radar:default", version: 1 },
      });

      // 第二句接同一段 Chat 对话，不再新建。
      await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "再说说风险" } });
      expect(chat.conversations).toHaveLength(1);
      expect(chat.turns()[1].url).toBe(`/conversations/${chat.conversations[0]}/turns`);

      expect(runtime.calls).toBe(0);
      expect(await t.sql("SELECT id FROM conversations")).toEqual([]);
      expect(await t.agentRuns()).toEqual([]);
    });
  });

  it("迟迟没写出正文：先按检索问答档，过了时限补一次深度档（界面换成「预计 1–2 分钟」）", async () => {
    const chat = await fakeChat({ turn: (res) => {
      sse(res, [{ type: "turn_started", userMessageId: randomUUID() }, { type: "thinking" }], false);
      setTimeout(() => {
        for (const [index, event] of [{ type: "message", delta: "好的" }, { type: "done", status: "completed" }].entries())
          res.write(`data: ${JSON.stringify({ conversationId: "chat-conversation", runId: RUN, scope: "global", sequence: index + 3, ...event })}

`);
        res.end();
      }, 150);
    } });
    const before = CHAT_ROUTE.deepenAfterMs;
    CHAT_ROUTE.deepenAfterMs = 30;
    try {
      await withChat(chat, countingRuntime(), async (t) => {
        const cookie = await t.loginCookie();
        const response = await t.app.inject({
          method: "POST", url: "/api/conversations/global/messages",
          headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "我这周负责的事有哪些？" },
        });
        const received = events(response.payload);
        expect(received.map((event) => event.type)).toEqual(["route", "thinking", "route", "message", "done"]);
        expect(received[0]).toMatchObject({ tier: "grounded" });
        expect(received[2]).toMatchObject({ tier: "deep", expectSeconds: 90 });
      });
    } finally {
      CHAT_ROUTE.deepenAfterMs = before;
    }
  });
  it("历史翻到底再转成天枢消息：没完成的那一轮补说明行，附件带上", async () => {
    const [r1, r2, r3, r4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const runs = [{ runId: r1, status: "completed", errorCode: null }, { runId: r2, status: "failed", errorCode: "MODEL_FAILED" },
      { runId: r3, status: "failed", errorCode: "RUNTIME_ERROR" }, { runId: r4, status: "aborted", errorCode: null }];
    const message = (role: string, text: string, runId: string, position: number, attachments: unknown[] = []) =>
      ({ id: randomUUID(), position: String(position), role, text, runId, attachmentIds: [], attachments });
    const file = { attachmentId: randomUUID(), fileName: "brief.md", mime: "text/markdown", size: 12, status: "ready", extractedChars: 4, reason: null };
    const chat = await fakeChat({
      conversations: [randomUUID()],
      pages: {
        "0": { messages: [message("user", "第一问", r1, 1), message("assistant", "第一答", r1, 2), message("user", "第二问", r2, 3, [file]),
          message("assistant", "写了一半", r2, 4)], runs, nextCursor: "4" },
        "4": { messages: [message("user", "第三问", r3, 5), message("user", "第四问", r4, 6), message("assistant", "停之前", r4, 7)], runs, nextCursor: null },
      },
    });
    await withChat(chat, countingRuntime(), async (t) => {
      const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: await t.loginCookie() } })).json();
      expect(history.scope).toBe("global");
      expect(history.messages.map((item: { sequence: number; role: string; content: string; runId: string }) => [item.sequence, item.role, item.content, item.runId])).toEqual([
        [1, "user", "第一问", r1],
        [2, "assistant", "第一答", r1],
        [3, "user", "第二问", r2],
        [4, "assistant", "写了一半\n\n（这次回答在这里中断了，以上是已经写出的部分。）", r2],
        [5, "user", "第三问", r3],
        [6, "assistant", "（这次回答没有完成。）", r3],
        [7, "user", "第四问", r4],
        [8, "assistant", "停之前\n\n（已停止，以上是停止前写出的部分。）", r4],
      ]);
      expect(history.messages[2].attachments).toEqual([{ id: file.attachmentId, fileName: "brief.md", mimeType: "text/markdown", sizeBytes: 12 }]);
      expect(chat.requests.filter((request) => request.url.includes("/messages")).map((request) => request.url.split("cursor=")[1])).toEqual(["0", "4"]);
    });
  });

  it("没完成的一轮：error 换成天枢的码和中文说明，Chat 停机的「已停止」按服务更新处理，「继续」带上 resumeRunId", async () => {
    const scripts: Record<string, unknown>[][] = [
      [{ type: "turn_started" }, { type: "message", delta: "写了一半" },
        { type: "error", code: "MODEL_FAILED", message: "本轮未完成，已保存可回读内容", partial: true, resume: "continue" }],
      [{ type: "turn_started" }, { type: "done", status: "aborted" }],
      [{ type: "turn_started" }, { type: "error", code: "ANCHOR_NOT_FOUND", message: "本轮未完成，已保存可回读内容", partial: false, resume: "retry" }],
      [{ type: "turn_started" }, { type: "error", code: "SERVICE_RESTARTED", message: "本轮未完成，已保存可回读内容", partial: true, resume: "continue" }],
    ];
    const chat = await fakeChat({ turn: (res) => sse(res, scripts.shift()!) });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      const send = async (payload: Record<string, unknown>) => events((await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload })).payload).at(-1);

      const failed = await send({ message: "说说进展" });
      expect(failed).toMatchObject({ type: "error", code: "MODEL_UNAVAILABLE", partial: true, resume: "continue", runId: RUN });
      expect(failed?.message).toMatch(/点「继续」/);
      expect(await send({ message: "继续", resumeRunId: RUN })).toMatchObject({ type: "error", code: "SERVER_RESTARTING", partial: false, resume: "retry" });
      expect(JSON.parse(chat.turns()[1].body)).toMatchObject({ message: "继续", resumeRunId: RUN });
      expect(await send({ message: "看这张卡" })).toMatchObject({ type: "error", code: "ANCHOR_NOT_FOUND", message: "", resume: "retry" });
      expect(await send({ message: "再来" })).toMatchObject({ type: "error", code: "SERVER_RESTARTING", partial: true, resume: "continue" });
    });
  });

  it("开流前的拒绝：上一轮没完 409、续不上 404、服务间凭据不对 500（不当成登录过期）、连不上 503", async () => {
    const answers = [
      { status: 409, error: { code: "TURN_RUNNING", message: "本会话已有运行中的轮次" } },
      { status: 400, error: { code: "INVALID_RESUME", message: "只能续答本会话中断的轮次" } },
    ];
    const chat = await fakeChat({ conversations: [randomUUID()], turn: (res) => {
      const { status, error } = answers.shift()!;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error }));
    } });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      const send = (payload: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload });
      const busy = await send({ message: "在吗" });
      expect([busy.statusCode, busy.json().code]).toEqual([409, "TURN_IN_PROGRESS"]);
      const lost = await send({ message: "继续", resumeRunId: RUN });
      expect([lost.statusCode, lost.json().code]).toEqual([404, "RESUME_NOT_FOUND"]);
    });

    const wrongToken = await fakeChat();
    await withChat(wrongToken, countingRuntime(), async (t) => {
      const history = await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: await t.loginCookie() } });
      expect([history.statusCode, history.json().code]).toEqual([500, "CHAT_UNAUTHORIZED"]);
    }, "another-token");

    const gone = await fakeChat();
    await gone.close();
    const t = await createTestApp({ internalChatToken: CHAT_TOKEN, chatServiceUrl: gone.url }, countingRuntime());
    try {
      const cookie = await t.loginCookie();
      const history = await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } });
      expect([history.statusCode, history.json().code]).toEqual([503, "CHAT_UNAVAILABLE"]);
      const sent = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "在吗" } });
      expect(sent.statusCode).toBe(503);
    } finally {
      await t.close();
    }
  });

  it("成员走 member 视角；成员带卡片引用照旧 404，不转给 Chat", async () => {
    const chat = await fakeChat();
    await withChat(chat, countingRuntime(), async (t) => {
      const member = await t.memberCookie();
      const send = (payload: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" }, payload });
      const cited = await send({ message: "看这张", references: [{ cardId: "radar:default", version: 1 }] });
      expect([cited.statusCode, cited.json().code]).toEqual([404, "REFERENCE_NOT_FOUND"]);
      expect(chat.requests).toEqual([]);
      expect((await send({ message: "我这周做什么" })).statusCode).toBe(200);
      expect(chat.turns()[0].headers).toMatchObject({ "x-owner-id": TEST_MEMBER.personId, "x-viewer-role": "member" });
    });
  });

  it("飞书私聊、微信里问（homeTurn）也走 Chat：来源带给 Chat；天枢库里没有这一轮，回答取流里的文字", async () => {
    const chat = await fakeChat();
    const runtime = countingRuntime();
    await withChat(chat, runtime, async (t) => {
      const deps = { app: t.app, q: t.pool.query.bind(t.pool), env: { sessionSecret: t.env.sessionSecret, publicOrigin: t.publicOrigin } };
      const result = await homeTurn(deps, { personId: TEST_CEO.personId, role: "ceo" }, "这周怎么样", { via: "wechat" });
      expect(result).toMatchObject({ kind: "done", runId: RUN, content: "好的", failure: null });
      await homeTurn(deps, { personId: TEST_CEO.personId, role: "ceo" }, "下周呢", { via: "feishu" });
      expect(chat.turns().map((turn) => JSON.parse(turn.body))).toMatchObject([
        { message: "这周怎么样", channel: "wechat" }, { message: "下周呢", channel: "feishu" },
      ]);
      expect(runtime.calls).toBe(0);
    });
  });

  it("历史里 Chat 记下的来源回到消息的 via，网页问的没有 via", async () => {
    const [r1, r2] = [randomUUID(), randomUUID()];
    const message = (role: string, text: string, runId: string, position: number, channel: string | null) =>
      ({ id: randomUUID(), position: String(position), role, text, runId, attachmentIds: [], attachments: [], ...(channel ? { channel } : {}) });
    const chat = await fakeChat({
      conversations: [randomUUID()],
      pages: { "0": { messages: [message("user", "微信问", r1, 1, "wechat"), message("assistant", "微信答", r1, 2, "wechat"),
        message("user", "网页问", r2, 3, null), message("assistant", "网页答", r2, 4, null)],
      runs: [{ runId: r1, status: "completed", errorCode: null }, { runId: r2, status: "completed", errorCode: null }], nextCursor: null } },
    });
    await withChat(chat, countingRuntime(), async (t) => {
      const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: await t.loginCookie() } })).json();
      expect(history.messages.map((item: { content: string; via?: string }) => [item.content, item.via])).toEqual([
        ["微信问", "wechat"], ["微信答", "wechat"], ["网页问", undefined], ["网页答", undefined],
      ]);
    });
  });

  it("对象页的对话不受开关影响，照旧走天枢自己的运行时", async () => {
    const chat = await fakeChat();
    const runtime = countingRuntime();
    await withChat(chat, runtime, async (t) => {
      const issue = await t.createIssue();
      const response = await t.app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(`issue:${issue.objectRef.id}`)}/messages`,
        headers: { cookie: await t.loginCookie(), origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "这个议题怎么看" } });
      expect(response.statusCode).toBe(200);
      expect(runtime.calls).toBe(1);
      expect(chat.requests).toEqual([]);
    });
  });

  it("附件转给 Chat 解析、存在那段对话上；发送时带上 Chat 的附件编号；读不出文字整批退回", async () => {
    const attachmentId = randomUUID();
    const results = [
      { attachments: [{ attachmentId, fileName: "brief.md", mime: "text/markdown", size: 15, status: "ready", extractedChars: 5, reason: null }] },
      { attachments: [{ attachmentId: randomUUID(), fileName: "scan.md", mime: "text/markdown", size: 3, status: "failed", extractedChars: 0, reason: null }] },
      { attachments: [{ attachmentId: randomUUID(), fileName: "截图.jpg", mime: "image/jpeg", size: 8, status: "ready", extractedChars: 0, reason: null }] },
      { attachments: [{ attachmentId: randomUUID(), fileName: "大图.png", mime: "image/png", size: 8, status: "failed", extractedChars: 0,
        reason: "图片超过 5 MB（模型能看的单张上限），请压缩后再发" }] },
    ];
    const chat = await fakeChat({ upload: () => results.shift() });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      const upload = (body: ReturnType<typeof multipart>) => t.app.inject({ method: "POST", url: "/api/conversations/global/attachments",
        headers: { cookie, origin: t.publicOrigin, ...body.headers }, payload: body.payload });
      const uploaded = await upload(multipart("brief.md", "# 渠道备忘"));
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json()).toEqual({ attachments: [{ id: attachmentId, fileName: "brief.md", mimeType: "text/markdown", sizeBytes: 15 }] });
      const forwarded = chat.requests.find((request) => request.url.endsWith("/attachments"))!;
      expect(forwarded.url).toBe(`/conversations/${chat.conversations[0]}/attachments`);
      expect(forwarded.headers["content-type"]).toMatch(/^multipart\/form-data/);
      expect(forwarded.body).toContain('filename="brief.md"');
      expect(forwarded.body).toContain("# 渠道备忘");
      // 认不得的类型（新首页 14.5 的清单以外）不转给 Chat。
      const exe = await upload(multipart("tool.exe", "MZ"));
      expect([exe.statusCode, exe.json().code, exe.json().message]).toEqual([400, "UNSUPPORTED_ATTACHMENT", "tool.exe：格式不支持"]);
      expect(chat.requests.filter((request) => request.url.endsWith("/attachments"))).toHaveLength(1);

      await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "看看附件", attachments: [{ id: attachmentId }] } });
      expect(JSON.parse(chat.turns()[0].body).attachmentIds).toEqual([attachmentId]);

      const unreadable = await upload(multipart("scan.md", "   "));
      expect([unreadable.statusCode, unreadable.json().code, unreadable.json().message]).toEqual([400, "ATTACHMENT_UNREADABLE", "scan.md 没能读出文字，请换一份再传。"]);

      // 图片（17.2 第 37 条）：原样转给 Chat（字节和类型不变），Chat 认了就是 ready；Chat 写了不收的原因照它说。
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      const image = (name: string, type: string) => ({ headers: { "content-type": "multipart/form-data; boundary=img" }, payload: Buffer.concat([
        Buffer.from(`--img\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), jpg, Buffer.from("\r\n--img--\r\n")]) });
      const photo = await upload(image("截图.jpg", "image/jpeg"));
      expect(photo.json().attachments[0]).toMatchObject({ fileName: "截图.jpg", mimeType: "image/jpeg" });
      const sent = chat.requests.filter((request) => request.url.endsWith("/attachments")).at(-1)!;
      expect(sent.body).toContain("Content-Type: image/jpeg");
      expect(sent.raw!.includes(jpg)).toBe(true);
      const big = await upload(image("大图.png", "image/png"));
      expect([big.statusCode, big.json().message]).toEqual([400, "大图.png：图片超过 5 MB（模型能看的单张上限），请压缩后再发"]);
    });
  });

  it("界面断开（切走、刷新）不算停止：照样读到 Chat 写完；回来接上这一轮，先补发已有的、再跟着写到结束", async () => {
    let upstream!: ServerResponse;
    let chatClosed = false;
    const chat = await fakeChat({ turn: (res) => {
      upstream = res;
      res.on("close", () => { chatClosed = true; });
      sse(res, [{ type: "turn_started" }, { type: "message", delta: "正在写" }], false);
    } });
    const chatEvent = (sequence: number, event: Record<string, unknown>) =>
      `data: ${JSON.stringify({ conversationId: "chat-conversation", runId: RUN, scope: "global", sequence, ...event })}\n\n`;
    const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>, until?: string, text = "") => {
      for (;;) {
        if (until && text.includes(until)) return text;
        const { done, value } = await reader.read();
        if (done) return text;
        text += new TextDecoder().decode(value);
      }
    };
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      await t.app.listen({ port: 0, host: "127.0.0.1" });
      const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
      const controller = new AbortController();
      const response = await fetch(`${base}/api/conversations/global/messages`, {
        method: "POST", signal: controller.signal,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ message: "写长一点" }),
      });
      await readAll(response.body!.getReader(), "正在写");
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(chatClosed).toBe(false);

      // 别的轮次、别的视角接不上（204）。
      expect((await t.app.inject({ method: "GET", url: `/api/conversations/global/turns/${randomUUID()}/stream`, headers: { cookie } })).statusCode).toBe(204);
      expect((await t.app.inject({ method: "GET", url: `/api/conversations/global/turns/${RUN}/stream`, headers: { cookie: await t.memberCookie() } })).statusCode).toBe(204);

      const follow = await fetch(`${base}/api/conversations/global/turns/${RUN}/stream`, { headers: { cookie, accept: "text/event-stream" } });
      expect(follow.status).toBe(200);
      expect(follow.headers.get("content-type")).toContain("text/event-stream");
      expect(Date.now() - Number(follow.headers.get("x-turn-started-at"))).toBeLessThan(10_000);
      const reader = follow.body!.getReader();
      let followed = await readAll(reader, "正在写");
      expect(events(followed).map((event) => event.type)).toEqual(["route", "message"]);
      upstream.write(chatEvent(3, { type: "message", delta: "，写完了" }));
      upstream.end(chatEvent(4, { type: "done", status: "completed" }));
      followed = await readAll(reader, undefined, followed);
      const received = events(followed);
      expect(received.map((event) => event.type)).toEqual(["route", "message", "message", "done"]);
      expect(received.map((event) => event.delta ?? "").join("")).toBe("正在写，写完了");
      expect(received.every((event) => event.runId === RUN)).toBe(true);

      // 写完以后再接：整轮重放到 done 就结束。
      const again = await t.app.inject({ method: "GET", url: `/api/conversations/global/turns/${RUN}/stream`, headers: { cookie } });
      expect(events(again.payload).map((event) => event.type)).toEqual(["route", "message", "message", "done"]);
    });
  });

  it("和 Chat 的连接断了：接上来看的界面收到一条「没有完成」（能接着写），不会一直等", async () => {
    const chat = await fakeChat({ turn: (res) => {
      sse(res, [{ type: "turn_started" }, { type: "message", delta: "写了一半" }], false);
      setTimeout(() => res.destroy(), 50);
    } });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      const sent = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "说说" } });
      expect(events(sent.payload).map((event) => event.type)).toEqual(["route", "message"]);
      const followed = events((await t.app.inject({ method: "GET", url: `/api/conversations/global/turns/${RUN}/stream`, headers: { cookie } })).payload);
      expect(followed.at(-1)).toMatchObject({ type: "error", code: "RUNTIME_FAILED", partial: true, resume: "continue", runId: RUN });
    });
  });

  it("本人点停止：转给 Chat 的 cancel；Chat 随后回的「已停止」原样给界面，不当成 Chat 停机", async () => {
    let upstream!: ServerResponse;
    const chat = await fakeChat({
      turn: (res) => { upstream = res; sse(res, [{ type: "turn_started" }, { type: "message", delta: "写了一半" }], false); },
      cancel: (res, request) => {
        upstream.end(`data: ${JSON.stringify({ conversationId: "chat-conversation", runId: RUN, scope: "global", sequence: 3, type: "done", status: "aborted" })}\n\n`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ runId: request.url.split("/")[2], status: "aborted" }));
      },
    });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      await t.app.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(`http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/conversations/global/messages`, {
        method: "POST", headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ message: "写长一点" }),
      });
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes("写了一半")) text += new TextDecoder().decode((await reader.read()).value);

      const stopped = await t.app.inject({ method: "POST", url: `/api/conversations/global/turns/${RUN}/stop`, headers: { cookie, origin: t.publicOrigin } });
      expect([stopped.statusCode, stopped.json()]).toEqual([200, { runId: RUN, status: "aborted" }]);
      const cancel = chat.requests.find((request) => request.url === `/turns/${RUN}/cancel`);
      expect(cancel).toMatchObject({ method: "POST", headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_CEO.personId, "x-viewer-role": "ceo" } });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(events(text).at(-1)).toMatchObject({ type: "done", status: "aborted", runId: RUN });

      // 对象页的对话由断开连接停下：这里不做事，也不找 Chat。
      const requests = chat.requests.length;
      expect((await t.app.inject({ method: "POST", url: `/api/conversations/task:demo/turns/${RUN}/stop`, headers: { cookie, origin: t.publicOrigin } })).statusCode).toBe(204);
      expect(chat.requests).toHaveLength(requests);
    });
  });

  it("历史里还在回答的那一句标上 running（界面据此接上这一轮），答完的不标", async () => {
    const [r1, r2] = [randomUUID(), randomUUID()];
    const said = (role: string, text: string, runId: string, position: number) => ({ id: randomUUID(), position: String(position), role, text, runId, attachmentIds: [], attachments: [] });
    const chat = await fakeChat({ conversations: [randomUUID()], pages: { "0": { nextCursor: null,
      messages: [said("user", "第一问", r1, 1), said("assistant", "第一答", r1, 2), said("user", "第二问", r2, 3)],
      runs: [{ runId: r1, status: "completed" }, { runId: r2, status: "running" }] } } });
    await withChat(chat, countingRuntime(), async (t) => {
      const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: await t.loginCookie() } })).json();
      expect(history.messages.map((item: { content: string; running?: boolean }) => [item.content, item.running ?? false]))
        .toEqual([["第一问", false], ["第一答", false], ["第二问", true]]);
    });
  });
});

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** 最近一次北京时间凌晨 4 点（对话日的开始）。 */
function lastFourAm(now = new Date()): Date {
  const day = new Date(now.getTime() + 8 * HOUR - 4 * HOUR).toISOString().slice(0, 10);
  return new Date(`${day}T04:00:00+08:00`);
}
const page = (messages: unknown[], runs: unknown[] = []): Page => ({ messages, runs, nextCursor: null });
const said = (role: string, text: string, runId: string, position: number) => ({ id: randomUUID(), position: String(position), role, text, runId, attachmentIds: [], attachments: [] });

async function rotating(chat: Awaited<ReturnType<typeof fakeChat>>, run: (t: Awaited<ReturnType<typeof createTestApp>>, cookie: string) => Promise<void>, rotation = true) {
  const t = await createTestApp({ internalChatToken: CHAT_TOKEN, chatServiceUrl: chat.url, chatSessionRotation: rotation }, countingRuntime());
  try {
    await run(t, await t.loginCookie());
  } finally {
    await t.close();
    await chat.close();
  }
}
const sendHome = (t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, payload: Record<string, unknown>) => t.app.inject({
  method: "POST", url: "/api/conversations/global/messages", headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload });

describe("首页分段（CHAT_SESSION_ROTATION）", () => {
  it("同一天间隔短接着用这一段；闲置满 12 小时新开一段；跨过凌晨 4 点新开一段", async () => {
    const recent = { conversationId: randomUUID(), createdAt: ago(2 * HOUR), updatedAt: ago(5_000) };
    const chat = await fakeChat({ conversations: [recent] });
    await rotating(chat, async (t, cookie) => {
      await sendHome(t, cookie, { message: "接着问" });
      expect(chat.conversations).toHaveLength(1);
      expect(chat.turns()[0].url).toBe(`/conversations/${recent.conversationId}/turns`);
    });

    const idle = await fakeChat({ conversations: [{ conversationId: randomUUID(), createdAt: ago(20 * HOUR), updatedAt: ago(12 * HOUR + 60_000) }] });
    await rotating(idle, async (t, cookie) => {
      await sendHome(t, cookie, { message: "隔了半天" });
      expect(idle.conversations).toHaveLength(2);
      expect(idle.turns()[0].url).toBe(`/conversations/${idle.conversations[0]}/turns`);
      // 这一句进了哪一段记进纪要表（视角、段 id），纪要后台据此去读。登记在后台写、不挡回复，所以等它落库。
      await vi.waitFor(async () => expect(await t.sql("SELECT owner_id, viewer_role, source, source_ref, status FROM conversation_digests")).toEqual([
        { owner_id: TEST_CEO.personId, viewer_role: "ceo", source: "chat", source_ref: idle.conversations[0], status: "stale" }]), { timeout: 5000 });
    });

    const overnight = await fakeChat({ conversations: [{ conversationId: randomUUID(), createdAt: ago(20 * HOUR), updatedAt: new Date(lastFourAm().getTime() - 60_000).toISOString() }] });
    await rotating(overnight, async (t, cookie) => {
      await sendHome(t, cookie, { message: "第二天" });
      expect(overnight.conversations).toHaveLength(2);
    });
  });

  it("开关关着：闲置再久也接着最近那一段，和分段之前一样", async () => {
    const old = { conversationId: randomUUID(), createdAt: ago(48 * HOUR), updatedAt: ago(30 * HOUR) };
    const chat = await fakeChat({ conversations: [old] });
    await rotating(chat, async (t, cookie) => {
      await sendHome(t, cookie, { message: "隔天" });
      expect(chat.conversations).toEqual([old.conversationId]);
      const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json();
      expect(history.messages.some((item: { kind?: string }) => item.kind === "trace")).toBe(false);
    }, false);
  });

  it("「继续」进那一轮所在的旧段；之后的新问题还进最新那段", async () => {
    const latest = { conversationId: randomUUID(), createdAt: ago(1 * HOUR), updatedAt: ago(5_000) };
    const old = { conversationId: randomUUID(), createdAt: ago(40 * HOUR), updatedAt: ago(30 * HOUR) };
    const chat = await fakeChat({ conversations: [latest, old], segments: {
      [old.conversationId]: { "0": page([], [{ runId: RUN, status: "failed", errorCode: "MODEL_FAILED" }]) },
      [latest.conversationId]: { "0": page([], [{ runId: randomUUID(), status: "completed", errorCode: null }]) },
    } });
    await rotating(chat, async (t, cookie) => {
      await sendHome(t, cookie, { message: "继续", resumeRunId: RUN });
      expect(chat.turns()[0].url).toBe(`/conversations/${old.conversationId}/turns`);
      expect(JSON.parse(chat.turns()[0].body)).toMatchObject({ resumeRunId: RUN });
      await sendHome(t, cookie, { message: "新问题" });
      expect(chat.turns()[1].url).toBe(`/conversations/${latest.conversationId}/turns`);
      expect(chat.conversations).toHaveLength(2);
    });
  });

  it("跨天后先传附件：附件进新段，随后那一句和附件在同一段，不再开一段", async () => {
    const attachmentId = randomUUID();
    const chat = await fakeChat({ conversations: [{ conversationId: randomUUID(), createdAt: ago(40 * HOUR), updatedAt: ago(13 * HOUR) }],
      upload: () => ({ attachments: [{ attachmentId, fileName: "brief.md", mime: "text/markdown", size: 15, status: "ready", extractedChars: 5, reason: null }] }) });
    await rotating(chat, async (t, cookie) => {
      const body = multipart("brief.md", "# 渠道备忘");
      await t.app.inject({ method: "POST", url: "/api/conversations/global/attachments", headers: { cookie, origin: t.publicOrigin, ...body.headers }, payload: body.payload });
      const created = chat.conversations[0];
      expect(chat.requests.find((request) => request.url.endsWith("/attachments"))!.url).toBe(`/conversations/${created}/attachments`);
      await sendHome(t, cookie, { message: "看附件", attachments: [{ id: attachmentId }] });
      expect(chat.turns()[0].url).toBe(`/conversations/${created}/turns`);
      expect(chat.requests.filter((request) => request.method === "POST" && request.url === "/conversations")).toHaveLength(1);
    });
  });

  it("网页和飞书私聊同时发跨天后的第一句：只建一段，两句都在里面", async () => {
    const chat = await fakeChat({ conversations: [{ conversationId: randomUUID(), createdAt: ago(40 * HOUR), updatedAt: ago(13 * HOUR) }] });
    await rotating(chat, async (t, cookie) => {
      await Promise.all([sendHome(t, cookie, { message: "网页这句" }), sendHome(t, cookie, { message: "飞书这句" })]);
      expect(chat.requests.filter((request) => request.method === "POST" && request.url === "/conversations")).toHaveLength(1);
      expect(new Set(chat.turns().map((turn) => turn.url))).toEqual(new Set([`/conversations/${chat.conversations[0]}/turns`]));
    });
  });

  it("界面拼最近 7 天的几段，从旧到新，段之间一行日期；更早的段不读", async () => {
    const [r1, r2, r3] = [randomUUID(), randomUUID(), randomUUID()];
    const current = { conversationId: randomUUID(), createdAt: ago(1 * HOUR), updatedAt: ago(5_000) };
    const earlier = { conversationId: randomUUID(), createdAt: ago(50 * HOUR), updatedAt: ago(49 * HOUR) };
    const stale = { conversationId: randomUUID(), createdAt: ago(9 * 24 * HOUR), updatedAt: ago(8 * 24 * HOUR) };
    const chat = await fakeChat({ conversations: [current, earlier, stale], segments: {
      [current.conversationId]: { "0": page([said("user", "今天的问题", r3, 1), said("assistant", "今天的回答", r3, 2)], [{ runId: r3, status: "completed" }]) },
      [earlier.conversationId]: { "0": page([said("user", "前天的问题", r2, 1), said("assistant", "前天的回答", r2, 2)], [{ runId: r2, status: "completed" }]) },
      [stale.conversationId]: { "0": page([said("user", "上周的问题", r1, 1)], [{ runId: r1, status: "completed" }]) },
    } });
    await rotating(chat, async (t, cookie) => {
      const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json();
      const { segmentDateLabel } = await import("../src/conversationSegments.js");
      expect(history.messages.map((item: { sequence: number; content: string; kind?: string }) => [item.sequence, item.content, item.kind ?? null])).toEqual([
        [1, "前天的问题", null], [2, "前天的回答", null], [3, segmentDateLabel(new Date(current.createdAt)), "trace"], [4, "今天的问题", null], [5, "今天的回答", null]]);
      // 轮询有界：只读 7 天内的两段，更早的那段一次都不读。
      expect(chat.requests.filter((request) => request.url.includes("/messages")).map((request) => request.url.split("/")[2]).sort())
        .toEqual([current.conversationId, earlier.conversationId].sort());
    });
  });

  it("当前这段已经够 200 条：更早的段不再往前读", async () => {
    const run = randomUUID();
    const current = { conversationId: randomUUID(), createdAt: ago(1 * HOUR), updatedAt: ago(5_000) };
    const earlier = { conversationId: randomUUID(), createdAt: ago(30 * HOUR), updatedAt: ago(29 * HOUR) };
    const many = Array.from({ length: 200 }, (_, index) => said(index % 2 ? "assistant" : "user", `第 ${index} 条`, run, index + 1));
    const chat = await fakeChat({ conversations: [current, earlier], segments: { [current.conversationId]: { "0": page(many, [{ runId: run, status: "completed" }]) } } });
    await rotating(chat, async (t, cookie) => {
      const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json();
      expect(history.messages).toHaveLength(200);
      expect(chat.requests.some((request) => request.url.startsWith(`/conversations/${earlier.conversationId}/`))).toBe(false);
    });
  });
});

describe("给 Chat 的回看接口（/internal/conversation-*）", () => {
  const headers = (role = "ceo", owner: string = TEST_CEO.personId, token = CHAT_TOKEN) => ({ authorization: `Bearer ${token}`, "x-owner-id": owner, "x-viewer-role": role });
  async function seedDigest(t: Awaited<ReturnType<typeof createTestApp>>, row: { owner: string; role?: "ceo" | "member"; source: "chat" | "tianshu"; ref: string;
    title: string; digest: string; startedHoursAgo: number; label?: string; keywords?: string[] }) {
    const id = randomUUID();
    await t.sql(`INSERT INTO conversation_digests (id, owner_id, viewer_role, source, source_ref, scope, scope_label, started_at, ended_at, title, digest, keywords, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(hours => $8), now() - make_interval(hours => $8) + interval '1 hour', $9, $10, $11, 'ready')`,
    [id, row.owner, row.source === "chat" ? row.role ?? "ceo" : null, row.source, row.ref, row.source === "chat" ? "global" : "issue:x", row.label ?? (row.source === "chat" ? "首页" : "议题：渠道"),
      row.startedHoursAgo, row.title, row.digest, row.keywords ?? []]);
    return id;
  }

  it("目录：上一段的完整纪要 + 近 14 天其他段；首页段按视角隔离、天枢页面的段两种视角都有；别人的查不到", async () => {
    const t = await createTestApp({ internalChatToken: CHAT_TOKEN });
    try {
      const pageId = randomUUID();
      await t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, 'issue:x', $3)", [pageId, TEST_CEO.personId, randomUUID()]);
      const current = randomUUID();
      await seedDigest(t, { owner: TEST_CEO.personId, source: "chat", ref: current, title: "今天", digest: "截至 今天\n- 今天的", startedHoursAgo: 1 });
      const previous = await seedDigest(t, { owner: TEST_CEO.personId, source: "chat", ref: randomUUID(), title: "昨天聊渠道", digest: "截至 昨天\n- 本人确认先做县城样板", startedHoursAgo: 26 });
      const memberView = await seedDigest(t, { owner: TEST_CEO.personId, role: "member", source: "chat", ref: randomUUID(), title: "成员视角的", digest: "x", startedHoursAgo: 30 });
      const onPage = await seedDigest(t, { owner: TEST_CEO.personId, source: "tianshu", ref: pageId, title: "议题页聊定价", digest: "- 助手建议，本人未表态：先提价", startedHoursAgo: 50, keywords: ["定价"] });
      const othersPage = randomUUID();
      await t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, 'issue:x', $3)", [othersPage, TEST_MEMBER.personId, randomUUID()]);
      const others = await seedDigest(t, { owner: TEST_MEMBER.personId, source: "tianshu", ref: othersPage, title: "别人的定价", digest: "y", startedHoursAgo: 3, keywords: ["定价"] });

      const catalog = await t.app.inject({ url: `/internal/conversation-catalog?conversationId=${current}`, headers: headers() });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json()).toMatchObject({ viewerRole: "ceo", previous: { segmentId: previous, page: "首页", title: "昨天聊渠道", digest: "截至 昨天\n- 本人确认先做县城样板" } });
      expect(catalog.json().recent.map((item: { segmentId: string }) => item.segmentId)).toEqual([onPage]);
      expect(JSON.stringify(catalog.json())).not.toContain(memberView);
      expect(JSON.stringify(catalog.json())).not.toContain(others);

      const found = (await t.app.inject({ url: `/internal/conversation-recall/search?query=${encodeURIComponent("定价")}`, headers: headers() })).json();
      expect(found.segments.map((item: { segmentId: string; page: string }) => [item.segmentId, item.page])).toEqual([[onPage, "议题：渠道"]]);
      const read = await t.app.inject({ url: `/internal/conversation-recall/${previous}`, headers: headers() });
      expect(read.json()).toMatchObject({ segmentId: previous, digest: "截至 昨天\n- 本人确认先做县城样板", rawCursor: "0" });
      // 成员看不到 CEO 的段；从没聊过的如实说没有。
      expect((await t.app.inject({ url: `/internal/conversation-recall/${previous}`, headers: headers("member", TEST_MEMBER.personId) })).statusCode).toBe(404);
      const nothing = (await t.app.inject({ url: `/internal/conversation-recall/search?query=${encodeURIComponent("火星殖民")}`, headers: headers() })).json();
      expect(nothing).toMatchObject({ segments: [], message: "本人以前的对话里没有找到相关内容。" });

      expect((await t.app.inject({ url: "/internal/conversation-catalog", headers: headers("ceo", TEST_CEO.personId, "wrong") })).statusCode).toBe(401);
      expect((await t.app.inject({ url: "/internal/conversation-catalog", headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_CEO.personId } })).json().code).toBe("VIEW_REQUIRED");
      // 用不了的视角 403：成员用不了 CEO 视角。CEO 能切到工作模式（17.2 第 45 条），成员视角对他放行。
      expect((await t.app.inject({ url: "/internal/conversation-catalog", headers: headers("ceo", TEST_MEMBER.personId) })).statusCode).toBe(403);
      expect((await t.app.inject({ url: "/internal/conversation-catalog", headers: headers("member") })).statusCode).toBe(200);
      expect((await t.app.inject({ url: "/internal/conversation-recall/search?from=yesterday", headers: headers() })).statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("首页分段开着时，首页卡后面多一张「以前的对话」：上一段纪要 + 近 14 天目录，只用 Chat 认得的字段，内容不变版本不变；没开或没有旧段时没有", async () => {
    type Card = { cardId: string; kind: string; title: string; label: string; version: number; payload: { note?: string; summary?: string; items?: Record<string, string>[] } };
    const homeCards = async (t: Awaited<ReturnType<typeof createTestApp>>) =>
      (await t.app.inject({ url: "/internal/home-cards", headers: headers() })).json().cards as Card[];
    const seed = async (t: Awaited<ReturnType<typeof createTestApp>>) => {
      const pageId = randomUUID();
      await t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, 'issue:x', $3)", [pageId, TEST_CEO.personId, randomUUID()]);
      await seedDigest(t, { owner: TEST_CEO.personId, source: "chat", ref: randomUUID(), title: "今天", digest: "截至 今天\n- 今天的", startedHoursAgo: 1 });
      await seedDigest(t, { owner: TEST_CEO.personId, source: "chat", ref: randomUUID(), title: "昨天聊渠道", digest: "截至 昨天\n- 本人确认先做县城样板", startedHoursAgo: 26 });
      await seedDigest(t, { owner: TEST_CEO.personId, source: "tianshu", ref: pageId, title: "议题页聊定价", digest: "截至 前天\n- 助手建议，本人未表态：先提价", startedHoursAgo: 50 });
    };
    const on = await createTestApp({ internalChatToken: CHAT_TOKEN, chatSessionRotation: true });
    try {
      expect((await homeCards(on)).some((card) => card.kind === "conversation-catalog")).toBe(false);
      await seed(on);
      const past = (await homeCards(on)).at(-1)!;
      expect(past).toMatchObject({ cardId: "conversation-catalog", kind: "conversation-catalog", title: "以前的对话", label: "以前的对话" });
      expect(Number.isSafeInteger(past.version) && past.version >= 1).toBe(true);
      expect(past.payload.summary).toMatch(/^上一段：\d+月\d+日 · 首页 · 昨天聊渠道\n截至 昨天\n- 本人确认先做县城样板$/);
      expect(past.payload.items).toEqual([{ occurred_at: expect.stringMatching(/^\d+月\d+日$/), title: "议题：渠道 · 议题页聊定价", summary: "- 助手建议，本人未表态：先提价" }]);
      // Chat 只把它认得的字段转成正文（Chat_Service src/evidence-content.ts 的 LABELS），别的字段会被丢掉。
      expect(Object.keys(past.payload).sort()).toEqual(["items", "note", "summary"]);
      expect(past.payload.items!.every((item) => Object.keys(item).every((key) => ["occurred_at", "title", "summary"].includes(key)))).toBe(true);
      expect((await homeCards(on)).at(-1)!.version).toBe(past.version);
    } finally {
      await on.close();
    }
    const off = await createTestApp({ internalChatToken: CHAT_TOKEN });
    try {
      await seed(off);
      expect((await homeCards(off)).some((card) => card.kind === "conversation-catalog")).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe("首页对话带上本人所在页面（CHAT_PAGE_CONTEXT）", () => {
  const send = async (t: Awaited<ReturnType<typeof createTestApp>>, pagePath?: string) => {
    const response = await t.app.inject({
      method: "POST", url: "/api/conversations/global/messages",
      headers: { cookie: await t.loginCookie(), origin: t.publicOrigin, accept: "text/event-stream" },
      payload: { message: "这页是干嘛的", ...(pagePath ? { pagePath } : {}) },
    });
    expect(response.statusCode).toBe(200);
    expect(events(response.payload).map((event) => event.type)).toContain("done");
  };
  const pages = (chat: Awaited<ReturnType<typeof fakeChat>>) => chat.turns().map((request) => (JSON.parse(request.body) as { page?: unknown }).page ?? null);

  it("开着时二级页面带上页面名和说明，首页和目录里没有的页面不带，Chat 照常受理", async () => {
    const chat = await fakeChat();
    await withChat(chat, countingRuntime(), async (t) => {
      await send(t, "/me/task-quality");
      await send(t, "/me");
      await send(t, "/no-such-page");
      await send(t);
      const [taskQuality, ...rest] = pages(chat);
      expect(taskQuality).toMatchObject({ path: "/me/task-quality", title: "任务数据质量" });
      expect((taskQuality as { guide: string }).guide).toContain("现在核对");
      expect(rest).toEqual([null, null, null]);
    }, CHAT_TOKEN, { chatPageContext: true });
  });

  it("Task 页（本月页 /me/month/tasks/<id>、新首页锚到 Task 的 /me/work/tasks/<id>）带上本人读到的这个 Task；新首页本身、不是本人的 Task 不带", async () => {
    const chat = await fakeChat();
    const now = new Date("2026-11-06T02:00:00.000Z");
    const t = await createTestApp({ internalChatToken: CHAT_TOKEN, chatServiceUrl: chat.url, chatPageContext: true }, countingRuntime(), {
      monthlyNow: () => now,
      planTasks: async (missions) => missions.some((mission) => mission.id === "m-page") ? [{ taskId: "task-1", missionId: "m-page", name: "对话质量达标", doneDefinition: null,
        criteria: ["有题库打分结果", "有新人上手录屏"] }] : [],
    });
    try {
      await t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,source_ref,source_document_id,source_revision,source_title)
        VALUES('m-page',1,'m-page','2026-11','内部版上线',$1,'method','["growth"]','目标','[]','fixture://p','fixture',1,'fixture')`, [TEST_CEO.personId]);
      await t.sql("INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,plan_task_id) VALUES($1,'写方案',$2,'self','in_progress','m-page',1,'task-1')",
        [randomUUID(), TEST_CEO.personId]);
      for (const path of ["/me/month/tasks/task-1", "/me/work/tasks/task-1", "/me/work", "/me/work/tasks/task-other"]) await send(t, path);
      const guide = expect.stringContaining("它有 2 条验收标准；看板上待开始 0 张、进行中 1 张");
      expect(pages(chat)).toEqual([{ path: "/me/month/tasks/task-1", title: "Task：对话质量达标", guide }, { path: "/me/work/tasks/task-1", title: "Task：对话质量达标", guide },
        null, null]);
    } finally {
      await t.close();
      await chat.close();
    }
  }, 30_000);

  it("关着时（缺省）即使网页带了页面路径也不发 page", async () => {
    const chat = await fakeChat();
    await withChat(chat, countingRuntime(), async (t) => {
      await send(t, "/me/task-quality");
      expect(pages(chat)).toEqual([null]);
    });
  });
});

describe("项目对话走 Chat（project:<projectId>，新首页第 16 节）", () => {
  /** 本人负责 task-open（boardFixture）；Chat 里已有一段总管线 main-segment。 */
  const pipelineFixture = async (chat: Awaited<ReturnType<typeof fakeChat>>) =>
    boardFixture({}, { internalChatToken: CHAT_TOKEN, chatServiceUrl: chat.url, chatPageContext: true, boardCloudAgents: false });
  /** 本人建一个项目，挂上 task-open。 */
  const newProject = async (f: Awaited<ReturnType<typeof boardFixture>>) => {
    const res = await f.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" });
    expect(res.statusCode).toBe(201);
    return res.json().projectId as string;
  };
  const open = (f: Awaited<ReturnType<typeof boardFixture>>, projectId: string) => f.call("POST", `/api/me/projects/${projectId}/pipeline`);
  const createdSegments = (chat: Awaited<ReturnType<typeof fakeChat>>) => chat.requests.filter((request) => request.method === "POST" && request.url === "/conversations");
  const say = (f: Awaited<ReturnType<typeof boardFixture>>, scope: string, payload: Record<string, unknown>) => f.t.app.inject({ method: "POST",
    url: `/api/conversations/${encodeURIComponent(scope)}/messages`, headers: { cookie: f.member, origin: f.t.publicOrigin, accept: "text/event-stream" }, payload });
  const history = (f: Awaited<ReturnType<typeof boardFixture>>, scope: string) =>
    f.t.app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(scope)}/messages`, headers: { cookie: f.member } });

  it("伙伴把话转给项目对话（17.4 message_project）：立即回、不等项目对话回完；那句带「伙伴转来」开头进项目那段；项目对话正在回上一轮时不打断，隔几秒再发；读回历史标 via=buddy", async () => {
    const upstreams: ServerResponse[] = [];
    let busy = false;
    const chat = await fakeChat({ conversations: ["main-segment"], turn: (res) => {
      if (busy) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "TURN_RUNNING", message: "本会话已有运行中的轮次" } }));
        return;
      }
      busy = true;
      upstreams.push(res);
      sse(res, [{ type: "turn_started" }, { type: "message", delta: "收到" }], false);
    } });
    const f = await pipelineFixture(chat);
    const finish = () => {
      upstreams.at(-1)!.end(`data: ${JSON.stringify({ conversationId: "chat-conversation", runId: RUN, scope: "global", sequence: 9, type: "done", status: "completed" })}\n\n`);
      busy = false;
    };
    try {
      const projectId = await newProject(f);
      const act = (args: unknown) => f.t.app.inject({ method: "POST", url: "/internal/me/buddy-actions/message_project",
        headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_MEMBER.personId }, payload: { args } });
      expect((await act({ projectId, text: "录屏先停" })).json().code).toBe("BUDDY_NOT_AUTHORIZED");
      await f.call("PUT", "/api/me/buddy-authority", { authority: "full" });

      // 项目对话还在回（流没结束）时动作已经回了。
      const forwarded = await act({ projectId, text: "录屏先停，先把打分做完" });
      expect(forwarded.json()).toMatchObject({ summary: expect.stringContaining("项目「对话质量」"), undoable: false, auditId: expect.any(String) });
      await vi.waitFor(() => expect(chat.turns()).toHaveLength(1));
      const pipeline = (await open(f, projectId)).json().conversationId as string;
      expect(chat.turns()[0].url).toBe(`/conversations/${pipeline}/turns`);
      expect(JSON.parse(chat.turns()[0].body).message).toBe("【伙伴转来】录屏先停，先把打分做完");
      // 项目对话自己也有这张动作清单：从项目对话里再转（转回自己）不做，免得一轮接一轮转下去。
      const loop = await f.t.app.inject({ method: "POST", url: "/internal/me/buddy-actions/message_project",
        headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_MEMBER.personId }, payload: { args: { projectId, text: "再转一次" }, conversationId: pipeline } });
      expect([loop.statusCode, loop.json().code]).toEqual([409, "ALREADY_IN_PROJECT"]);

      // 再转一句：项目对话还在回，不打断（不请 Chat 停），等它回完再发。
      await act({ projectId, text: "再加一条" });
      await vi.waitFor(() => expect(chat.turns()).toHaveLength(2));
      expect(chat.requests.some((request) => request.url.endsWith("/cancel"))).toBe(false);
      finish();
      await vi.waitFor(() => expect(chat.turns()).toHaveLength(3), { timeout: 10_000 });
      expect(JSON.parse(chat.turns()[2].body).message).toBe("【伙伴转来】再加一条");
      finish();

      expect((await act({ projectId: randomUUID(), text: "别人的" })).statusCode).toBe(404);
      expect(historyMessages([{ role: "user", text: "【伙伴转来】录屏先停", runId: RUN }, { role: "assistant", text: "好", runId: RUN }],
        [{ runId: RUN, status: "completed" }])[0]).toMatchObject({ role: "user", content: "录屏先停", via: "buddy" });
      // 子会话报告替本人发的那句（18 节第 10 条）：去掉开头、标 report，网页不画成本人的气泡。
      expect(historyMessages([{ role: "user", text: "【子会话回报】B · 修登录页：做完一轮停下了。", runId: RUN }, { role: "assistant", text: "好", runId: RUN }],
        [{ runId: RUN, status: "completed" }])[0]).toMatchObject({ role: "user", content: "B · 修登录页：做完一轮停下了。", via: "report" });
    } finally {
      await f.close();
      await chat.close();
    }
  }, 40_000);

  it("17.2 第 36 条：项目对话选模型和思考程度转给 Chat——列表照 Chat 的；没选为 null；改选存在项目那段上（还没建先建），不合法照 Chat 的 400；别人的项目 404；老 Chat 没这几条接口时列表为空", async () => {
    const models = [{ source: "TokenHub · wangsu", modelId: "wangsu/claude", label: "claude", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true },
      { source: "TokenHub · aliyun", modelId: "aliyun/qwen", label: "千问", efforts: ["off", "high"], defaultEffort: "off", isDefault: false }];
    const chat = await fakeChat({ conversations: ["main-segment"], models });
    const f = await pipelineFixture(chat);
    try {
      const projectId = await newProject(f);
      expect((await f.call("GET", "/api/me/conversation-models")).json()).toEqual({ models });
      const path = `/api/me/projects/${projectId}/pipeline/model`;
      // 项目对话还没建：读是 null，不开段。
      expect((await f.call("GET", path)).json()).toEqual({ choice: null });
      expect(createdSegments(chat)).toHaveLength(0);
      const qwen = { source: "TokenHub · aliyun", modelId: "aliyun/qwen", effort: "high" };
      expect((await f.call("PUT", path, { choice: qwen })).json()).toEqual({ choice: qwen });
      const pipeline = (await open(f, projectId)).json().conversationId as string;
      expect(createdSegments(chat)).toHaveLength(1);
      expect(chat.requests.filter((request) => request.method === "PUT").map((request) => [request.url, request.headers["x-viewer-role"]]))
        .toEqual([[`/conversations/${pipeline}/model`, "member"]]);
      expect((await f.call("GET", path)).json()).toEqual({ choice: qwen });
      const invalid = await f.call("PUT", path, { choice: { ...qwen, effort: "medium" } });
      expect([invalid.statusCode, invalid.json().code]).toEqual([400, "INVALID_MODEL_CHOICE"]);
      expect((await f.call("PUT", path, { choice: null })).json()).toEqual({ choice: null });
      expect((await f.call("GET", path)).json()).toEqual({ choice: null });
      expect((await f.call("GET", `/api/me/projects/${randomUUID()}/pipeline/model`)).statusCode).toBe(404);
      expect((await f.call("PUT", `/api/me/projects/${randomUUID()}/pipeline/model`, { choice: null })).statusCode).toBe(404);
    } finally {
      await f.close();
      await chat.close();
    }
    const old = await fakeChat({ conversations: ["main-segment"] });
    const g = await pipelineFixture(old);
    try {
      const projectId = await newProject(g);
      expect((await g.call("GET", "/api/me/conversation-models")).json()).toEqual({ models: [] });
      await open(g, projectId);
      expect((await g.call("GET", `/api/me/projects/${projectId}/pipeline/model`)).json()).toEqual({ choice: null });
    } finally {
      await g.close();
      await old.close();
    }
  }, 40_000);

  it("第一次打开在 Chat 开一段（201），再打开还是这一段（200）；两个同时打开也只开一段", async () => {
    const chat = await fakeChat({ conversations: ["main-segment"] });
    const f = await pipelineFixture(chat);
    try {
      const projectId = await newProject(f);
      const first = await open(f, projectId);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toEqual({ projectId, conversationId: chat.conversations[0], scope: `project:${projectId}` });
      expect(chat.conversations[0]).not.toBe("main-segment");
      const again = await open(f, projectId);
      expect([again.statusCode, again.json()]).toEqual([200, first.json()]);
      expect(createdSegments(chat)).toHaveLength(1);
      // 项目对话那一段按 member 视角开（只在 DRI 工作台）。
      expect(createdSegments(chat)[0].headers).toMatchObject({ "x-owner-id": TEST_MEMBER.personId, "x-viewer-role": "member" });

      // 同时打开：只开一段，两个请求拿到同一段。
      await f.t.sql("DELETE FROM project_pipelines");
      const before = createdSegments(chat).length;
      const both = await Promise.all([open(f, projectId), open(f, projectId)]);
      expect(both.map((res) => res.statusCode).sort()).toEqual([200, 201]);
      expect(new Set(both.map((res) => res.json().conversationId)).size).toBe(1);
      expect(createdSegments(chat)).toHaveLength(before + 1);
      expect(await f.t.sql("SELECT project_id, owner_id, conversation_id FROM project_pipelines")).toEqual([
        { project_id: projectId, owner_id: TEST_MEMBER.personId, conversation_id: both[0].json().conversationId }]);
    } finally {
      await f.close();
      await chat.close();
    }
  }, 30_000);

  it("项目对话那段比总管线新：总管线的历史和发一句仍进原来那段；项目对话发一句进自己那段，帧的 scope 是 project，带上这个项目的页面，选项框作答转给 Chat", async () => {
    const chat = await fakeChat({ conversations: ["main-segment"] });
    const f = await pipelineFixture(chat);
    try {
      const projectId = await newProject(f);
      const scope = `project:${projectId}`;
      const pipeline = (await open(f, projectId)).json().conversationId as string;
      // Chat 那边项目对话这段是最近更新的。
      expect(chat.listed[0].conversationId).toBe(pipeline);

      await history(f, "global");
      expect(chat.requests.filter((request) => request.url.includes("/messages")).map((request) => request.url.split("/")[2])).toEqual(["main-segment"]);
      expect((await say(f, "global", { message: "今天先做什么" })).statusCode).toBe(200);
      expect(chat.turns().at(-1)!.url).toBe("/conversations/main-segment/turns");

      const askId = randomUUID();
      const sent = await say(f, scope, { message: "就按推荐的来", answers: { askId, items: [{ questionId: "q1", option: 0 }] } });
      expect(sent.statusCode).toBe(200);
      const turn = chat.turns().at(-1)!;
      expect(turn.url).toBe(`/conversations/${pipeline}/turns`);
      expect(turn.headers).toMatchObject({ "x-owner-id": TEST_MEMBER.personId, "x-viewer-role": "member" });
      const command = JSON.parse(turn.body) as Record<string, unknown>;
      expect(command.answers).toEqual({ askId, items: [{ questionId: "q1", option: 0 }] });
      expect(command.page).toEqual({ path: `/me/work/projects/${projectId}`, title: "项目：对话质量", guide: expect.stringContaining("现在挂着的目标：对话质量达标") });
      const received = events(sent.payload);
      expect(received.map((event) => event.type)).toEqual(["route", "message", "done"]);
      expect(received.every((event) => event.scope === scope)).toBe(true);
      // 没在 Chat 多开段，天枢自己的对话也没建。
      expect(createdSegments(chat)).toHaveLength(1);
      expect(await f.t.sql("SELECT id FROM conversations WHERE scope LIKE 'project:%'")).toEqual([]);

      // 总管线和项目对话各留各的最近一轮：项目对话这一轮在自己的线上接得上，总管线上不是它。
      const follow = (target: string) => f.t.app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(target)}/turns/${RUN}/stream`, headers: { cookie: f.member } });
      const followed = await follow(scope);
      expect(followed.statusCode).toBe(200);
      expect(events(followed.payload).at(-1)).toMatchObject({ type: "done", scope });
      expect(events((await follow("global")).payload).every((event) => event.scope === "global")).toBe(true);
    } finally {
      await f.close();
      await chat.close();
    }
  }, 30_000);

  it("历史：没开过是空的（不建）；开过读那一段，提问卡和作答记录照契约原样给界面，不合格的丢掉", async () => {
    const [r1, r2] = [randomUUID(), randomUUID()];
    const askId = randomUUID();
    const questions = { kind: "questions", askId, questions: [{ id: "q1", question: "先做哪个？", options: [{ label: "先补录屏", recommended: true }, { label: "先跑题库" }] }] };
    const record = { askId, items: [{ questionId: "q1", question: "先做哪个？", kind: "option", answer: "先补录屏", recommended: true }] };
    const said = (role: string, text: string, runId: string, position: number, extra: Record<string, unknown> = {}) =>
      ({ id: randomUUID(), position: String(position), role, text, runId, attachmentIds: [], attachments: [], ...extra });
    const chat = await fakeChat({ conversations: ["pipe-1", "main-segment"], segments: { "pipe-1": { "0": { messages: [
      said("user", "怎么拆", r1, 1),
      said("assistant", "有两种做法", r1, 2, { cards: [questions, { kind: "questions", askId, questions: [] }, { kind: "made_up" }] }),
      said("user", "先补录屏", r2, 3, { answers: record }),
      said("assistant", "好", r2, 4, { cards: "坏的" }),
    ], runs: [{ runId: r1, status: "completed" }, { runId: r2, status: "completed" }], nextCursor: null } } } });
    const f = await pipelineFixture(chat);
    try {
      const projectId = await newProject(f);
      const scope = `project:${projectId}`;
      expect((await history(f, scope)).json()).toEqual({ scope, messages: [] });
      expect(chat.requests).toEqual([]);

      await f.t.sql("INSERT INTO project_pipelines (project_id, owner_id, conversation_id) VALUES ($1, $2, 'pipe-1')", [projectId, TEST_MEMBER.personId]);
      const read = (await history(f, scope)).json();
      expect(read.scope).toBe(scope);
      expect(read.messages.map((item: { role: string; content: string; cards?: unknown; answers?: unknown }) => [item.role, item.content, item.cards, item.answers])).toEqual([
        ["user", "怎么拆", undefined, undefined],
        ["assistant", "有两种做法", [questions], undefined],
        ["user", "先补录屏", undefined, record],
        ["assistant", "好", undefined, undefined],
      ]);
      // 总管线照旧只读 main-segment，看不到项目对话那段。
      expect((await history(f, "global")).json().messages).toEqual([]);
      expect(chat.requests.filter((request) => request.url.includes("/messages")).map((request) => request.url.split("/")[2])).toEqual(["pipe-1", "main-segment"]);
    } finally {
      await f.close();
      await chat.close();
    }
  }, 30_000);

  it("别人的项目、没有的项目都 404：开对话、读历史、发一句、传附件都不找 Chat", async () => {
    const chat = await fakeChat();
    const f = await pipelineFixture(chat);
    try {
      const theirs = randomUUID();
      await f.t.sql("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ($1, $2, '别人的项目', now(), now())", [theirs, THIRD.personId]);
      const malformed = await open(f, "not-a-uuid");
      expect([malformed.statusCode, malformed.json().code]).toEqual([404, "NOT_FOUND"]);
      for (const projectId of [theirs, randomUUID()]) {
        const scope = `project:${projectId}`;
        const opened = await open(f, projectId);
        expect([opened.statusCode, opened.json().code]).toEqual([404, "NOT_FOUND"]);
        expect((await history(f, scope)).statusCode).toBe(404);
        expect((await say(f, scope, { message: "进展？" })).statusCode).toBe(404);
        const upload = multipart("brief.md", "# 方案");
        expect((await f.t.app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(scope)}/attachments`,
          headers: { cookie: f.member, origin: f.t.publicOrigin, ...upload.headers }, payload: upload.payload })).statusCode).toBe(404);
      }
      expect(chat.requests).toEqual([]);
      expect(await f.t.sql("SELECT * FROM project_pipelines")).toEqual([]);
    } finally {
      await f.close();
      await chat.close();
    }
  }, 30_000);

  /** 截下这段时间写出的结构化日志里某个 event 的几行。 */
  const captureLogs = () => {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    return (event: string) => lines.flatMap((line) => line.split("\n")).filter((line) => line.includes(`"event":"${event}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const globalReads = (chat: Awaited<ReturnType<typeof fakeChat>>) =>
    chat.requests.filter((request) => request.method === "GET" && request.url.includes("/messages")).map((request) => request.url.split("/")[2]);

  it("Chat 开段卡住时不占着数据库连接和事务；15 秒没回应回 503，只记一条 id 不明的孤儿段日志", async () => {
    let created!: () => void;
    const reached = new Promise<void>((resolve) => { created = resolve; });
    const chat = await fakeChat({ conversations: ["main-segment"], beforeCreate: () => { created(); return new Promise<void>(() => undefined); } });
    const f = await pipelineFixture(chat);
    const logs = captureLogs();
    try {
      const pending = open(f, await newProject(f));
      await reached;
      // Chat 卡着的时候，这个库里没有开着事务等着的连接。
      expect(await f.t.sql("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'")).toEqual([]);
      const started = Date.now();
      const res = await pending;
      expect([res.statusCode, res.json().code]).toEqual([503, "CHAT_UNAVAILABLE"]);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(await f.t.sql("SELECT * FROM project_pipelines")).toEqual([]);
      expect(logs("chat_service.pipeline_orphan")).toEqual([expect.objectContaining({ conversationId: null })]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
      await chat.close();
    }
  }, 40_000);

  it("Chat 开了段、天枢没登记上：这段记成孤儿段（日志带 id），总管线读历史、发一句仍进原来那段", async () => {
    const chat = await fakeChat({ conversations: ["main-segment"] });
    const f = await pipelineFixture(chat);
    const logs = captureLogs();
    try {
      const projectId = await newProject(f);
      await f.t.sql(`CREATE FUNCTION refuse_pipeline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'connection lost'; END $$;
        CREATE TRIGGER refuse_pipeline BEFORE INSERT ON project_pipelines FOR EACH ROW EXECUTE FUNCTION refuse_pipeline();`);
      expect((await open(f, projectId)).statusCode).toBe(500);
      const orphan = chat.conversations[0];
      expect(orphan).not.toBe("main-segment");
      // Chat 那边这段是最新的一段。
      expect(chat.listed[0].conversationId).toBe(orphan);
      expect(logs("chat_service.pipeline_orphan")).toEqual([expect.objectContaining({ conversationId: orphan })]);

      await history(f, "global");
      expect(globalReads(chat)).toEqual(["main-segment"]);
      expect((await say(f, "global", { message: "今天先做什么" })).statusCode).toBe(200);
      expect(chat.turns().at(-1)!.url).toBe("/conversations/main-segment/turns");

      // 登记恢复以后再开：开新的一段并记下，总管线还是原来那段。
      await f.t.sql("DROP TRIGGER refuse_pipeline ON project_pipelines");
      const again = await open(f, projectId);
      expect(again.statusCode).toBe(201);
      expect(again.json().conversationId).not.toBe(orphan);
      expect((await say(f, "global", { message: "还有呢" })).statusCode).toBe(200);
      expect(chat.turns().at(-1)!.url).toBe("/conversations/main-segment/turns");
    } finally {
      vi.restoreAllMocks();
      await f.close();
      await chat.close();
    }
  }, 30_000);

  it("开段期间这个项目已经登记了别的段：用已登记的那段（200），刚开的那段记成孤儿段，总管线不用它", async () => {
    let f!: Awaited<ReturnType<typeof boardFixture>>;
    let projectId!: string;
    const chat = await fakeChat({ conversations: ["main-segment"], beforeCreate: async () => {
      await f.t.sql("INSERT INTO project_pipelines (project_id, owner_id, conversation_id) VALUES ($1, $2, 'elsewhere')", [projectId, TEST_MEMBER.personId]);
    } });
    f = await pipelineFixture(chat);
    const logs = captureLogs();
    try {
      projectId = await newProject(f);
      const res = await open(f, projectId);
      expect([res.statusCode, res.json().conversationId]).toEqual([200, "elsewhere"]);
      const orphan = chat.conversations[0];
      expect(orphan).not.toBe("main-segment");
      expect(logs("chat_service.pipeline_orphan")).toEqual([expect.objectContaining({ conversationId: orphan })]);
      expect(await f.t.sql("SELECT conversation_id FROM project_pipelines")).toEqual([{ conversation_id: "elsewhere" }]);

      await history(f, "global");
      expect(globalReads(chat)).toEqual(["main-segment"]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
      await chat.close();
    }
  }, 30_000);
});

describe("伙伴代本人做事走 Chat（17.4）", () => {
  it("动作做完往这一轮的流里插界面效果、计划清单、卡，写动作做成了替伙伴打勾；读回历史时接上清单和卡；回答到一半再发一句：停掉上一轮、清单收起，新一轮照常", async () => {
    const upstreams: ServerResponse[] = [];
    const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify({ conversationId: "chat-conversation", runId: RUN, scope: "global", sequence: 9, ...event })}\n\n`;
    let busy = false;
    const chat = await fakeChat({
      conversations: [randomUUID()],
      pages: { "0": { messages: [{ role: "user", text: "换成深色", runId: RUN }, { role: "assistant", text: "换好了", runId: RUN }],
        runs: [{ runId: RUN, status: "completed" }], nextCursor: null } },
      turn: (res) => {
        // 上一轮还没结束时 Chat 回 TURN_RUNNING；停掉以后才收下。
        if (busy) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "TURN_RUNNING", message: "本会话已有运行中的轮次" } }));
          return;
        }
        busy = true;
        upstreams.push(res);
        sse(res, [{ type: "turn_started" }, { type: "message", delta: "我来" }], false);
      },
      cancel: (res, request) => {
        upstreams.at(-1)!.end(frame({ type: "done", status: "aborted" }));
        busy = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ runId: request.url.split("/")[2], status: "aborted" }));
      },
    });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.memberCookie();
      await t.app.listen({ port: 0, host: "127.0.0.1" });
      const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
      const ask = async (message: string) => {
        const response = await fetch(`${base}/api/conversations/global/messages`, { method: "POST",
          headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ message }) });
        const reader = response.body!.getReader();
        let text = "";
        const until = async (needle: string) => { while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value); };
        const rest = async () => { for (;;) { const { done, value } = await reader.read(); if (done) return text; text += new TextDecoder().decode(value); } };
        return { until, rest };
      };
      const act = (name: string, args: unknown) => t.app.inject({ method: "POST", url: `/internal/me/buddy-actions/${name}`,
        headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_MEMBER.personId }, payload: { args, runId: RUN, conversationId: "chat-conversation" } });
      expect((await t.app.inject({ method: "PUT", url: "/api/me/buddy-authority", headers: { cookie, origin: t.publicOrigin }, payload: { authority: "full" } })).statusCode).toBe(200);

      const first = await ask("换成深色，再跟测试甲说一声");
      await first.until("我来");
      const entries = [{ content: "换外观", status: "in_progress" }, { content: "转达测试甲", status: "pending" }];
      expect((await act("update_plan", { entries })).json()).toMatchObject({ summary: "清单更新了", auditId: null, undoable: false });
      expect((await act("set_appearance", { appearance: "dark" })).json()).toMatchObject({ undoable: true });
      const draftedRes = await act("send_message", { toPersonIds: [TEST_CEO.personId], text: "下午的会改到四点" });
      expect([draftedRes.statusCode, draftedRes.json().code]).toEqual([200, undefined]);
      const drafted = draftedRes.json();
      upstreams[0].end(frame({ type: "done", status: "completed" }));
      busy = false;
      const received = events(await first.rest());
      const draftId = drafted.result.draftId as string;
      expect(received.filter((event) => ["plan", "ui", "card"].includes(event.type as string)).map(({ type, plan, ui, card }) => ({ type, plan, ui, card }))).toEqual([
        { type: "plan", plan: { entries, collapsed: false }, ui: undefined, card: undefined },
        { type: "ui", plan: undefined, ui: { kind: "appearance", appearance: "dark" }, card: undefined },
        // 换外观做成了而伙伴没打勾：天枢替它把进行中的那一步标成完成。
        { type: "plan", plan: { entries: [{ ...entries[0], status: "completed" }, entries[1]], collapsed: false }, ui: undefined, card: undefined },
        { type: "card", plan: undefined, ui: undefined, card: { kind: "buddy_message", draftId } },
      ]);
      expect(received.every((event) => event.runId === RUN && event.scope === "global")).toBe(true);

      // 读回历史：这一轮的回答带上最后那张清单和转达卡。
      const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json();
      expect(history.messages.find((message: { role: string }) => message.role === "assistant")).toMatchObject({
        plan: { entries: [{ ...entries[0], status: "completed" }, entries[1]], collapsed: false }, cards: [{ kind: "buddy_message", draftId }] });

      // 回答到一半再发一句：上一轮停掉（以「已停止」结束，清单收起），新一句开新的一轮、回执照给。
      const second = await ask("算了，先别发");
      await second.until("我来");
      const third = await ask("就这样");
      const thirdText = await (async () => { await third.until("我来"); upstreams.at(-1)!.end(frame({ type: "done", status: "completed" })); return third.rest(); })();
      const stopped = events(await second.rest());
      expect(stopped.filter((event) => event.type === "done")).toEqual([expect.objectContaining({ status: "aborted" })]);
      expect(chat.requests.filter((request) => request.url === `/turns/${RUN}/cancel`)).toHaveLength(1);
      // 中途插话：第一个勾在停上一轮之前就到（还没有这一轮，不带 runId），第二个勾等新一轮开始；同一条消息 id，重发时也不变。
      const thirdTurns = chat.turns().slice(-2).map((turn) => JSON.parse(turn.body).clientRequestId as string);
      expect(new Set(thirdTurns).size).toBe(1);
      expect(allEvents(thirdText).slice(0, 2)).toEqual([{ type: "receipt", state: "delivered", messageId: thirdTurns[0], scope: "global", sequence: 1 },
        { type: "receipt", state: "read", messageId: thirdTurns[0], runId: RUN, scope: "global", sequence: 2 }]);
      expect(events(thirdText).at(-1)).toMatchObject({ type: "done", status: "completed" });
      expect((await t.sql("SELECT collapsed FROM buddy_plans WHERE run_id=$1", [RUN]))[0]).toEqual({ collapsed: true });
    });
  }, 30_000);

  it("中途插话给了第一个勾以后还是没开成：流里给一帧 error（不带 runId）就结束，码照开流前的拒绝", async () => {
    let upstream!: ServerResponse;
    let state: "free" | "busy" | "broken" = "free";
    const chat = await fakeChat({
      conversations: [randomUUID()],
      turn: (res) => {
        if (state === "free") {
          state = "busy";
          upstream = res;
          sse(res, [{ type: "turn_started" }, { type: "message", delta: "我来" }], false);
          return;
        }
        // 上一轮还在回时 409；停掉以后对话服务出了问题（500）。
        res.writeHead(state === "busy" ? 409 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: state === "busy" ? { code: "TURN_RUNNING", message: "本会话已有运行中的轮次" } : { code: "INTERNAL", message: "坏了" } }));
      },
      cancel: (res, request) => {
        upstream.end(`data: ${JSON.stringify({ conversationId: "chat-conversation", runId: RUN, scope: "global", sequence: 9, type: "done", status: "aborted" })}\n\n`);
        state = "broken";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ runId: request.url.split("/")[2], status: "aborted" }));
      },
    });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.memberCookie();
      await t.app.listen({ port: 0, host: "127.0.0.1" });
      const url = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/conversations/global/messages`;
      const post = (message: string) => fetch(url, { method: "POST", headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream",
        "content-type": "application/json" }, body: JSON.stringify({ message }) });
      const first = await post("写长一点");
      const reader = first.body!.getReader();
      let text = "";
      while (!text.includes("我来")) text += new TextDecoder().decode((await reader.read()).value);
      const second = await post("算了");
      expect(second.status).toBe(200);
      const received = allEvents(await second.text());
      const messageId = JSON.parse(chat.turns()[1].body).clientRequestId as string;
      expect(received).toEqual([{ type: "receipt", state: "delivered", messageId, scope: "global", sequence: 1 },
        { type: "error", code: "CHAT_FAILED", message: "对话服务这次没有接下请求。", scope: "global", sequence: 2 }]);
    });
  }, 30_000);
  it("选项框（18 节第 9 条 ask_user）：参数照规矩校验；存成这一轮的卡、经流推给网页、读历史读得回；本人发出任何新消息把 open 的标 dismissed，带 buddyQuestionId 的标 answered；项目对话的框只被项目对话里的话收掉", async () => {
    const deploy = { header: "部署方式", question: "这次发到哪？", options: [
      { label: "只发预发", detail: "先在预发看一眼，不碰生产", recommended: true }, { label: "预发和生产", detail: "一起发，省一轮" }] };
    const when = { header: "时间", question: "什么时候发？", options: [{ label: "今天", detail: "现在就发" }, { label: "本周五", detail: "等周五没人用的时候" }], multiSelect: false };
    const asks: unknown[][] = [];
    let act: (name: string, args: unknown, extra?: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }> = async () => { throw new Error("not ready"); };
    const chat = await fakeChat({
      conversations: ["chat-conversation"],
      pages: { "0": { messages: [{ role: "user", text: "部署吧", runId: RUN }, { role: "assistant", text: "先问两件事", runId: RUN }],
        runs: [{ runId: RUN, status: "completed" }], nextCursor: null } },
      // 这一轮里伙伴调 ask_user（队列里有的话），然后结束这一轮。
      turn: (res) => void (async () => {
        sse(res, [{ type: "turn_started" }, { type: "message", delta: "先问两件事" }], false);
        const questions = asks.shift();
        if (questions) expect((await act("ask_user", { questions })).statusCode).toBe(200);
        res.end(`data: ${JSON.stringify({ conversationId: "chat-conversation", runId: RUN, scope: "global", sequence: 9, type: "done", status: "completed" })}\n\n`);
      })(),
    });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.memberCookie();
      act = (name, args, extra = { runId: RUN, conversationId: "chat-conversation" }) => t.app.inject({ method: "POST", url: `/internal/me/buddy-actions/${name}`,
        headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_MEMBER.personId }, payload: { args, ...extra } });
      const say = (payload: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload });
      const cards = async () => (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json()
        .messages.find((message: { role: string }) => message.role === "assistant").cards;

      // 没授权也能用（只动界面）；动作清单里有它，说明写清什么时候用。
      const listed = (await t.app.inject({ method: "GET", url: "/internal/me/buddy-actions",
        headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_MEMBER.personId } })).json().actions
        .find((action: { name: string }) => action.name === "ask_user");
      expect(listed).toMatchObject({ kind: "ui", description: expect.stringContaining("不要把问题写成一段话") });
      // 参数校验：推荐的不在第一个、一题只有一个选项、选项没说明、超过 4 题都是 400；这一轮没带 runId 出不来。
      const bad = [
        { questions: [{ ...deploy, options: [deploy.options[1], deploy.options[0]] }] },
        { questions: [{ ...deploy, options: [deploy.options[0]] }] },
        { questions: [{ ...deploy, options: [{ label: "只发预发" }, deploy.options[1]] }] },
        { questions: [deploy, when, deploy, when, deploy] },
      ];
      for (const args of bad) expect([(await act("ask_user", args)).statusCode, (await act("ask_user", args)).json().code]).toEqual([400, "INVALID_ARGS"]);
      const noTurn = await act("ask_user", { questions: [deploy] }, {});
      expect([noTurn.statusCode, noTurn.json().code]).toEqual([409, "NO_TURN"]);

      // 第一轮：伙伴出一个框，经 card 事件推给网页；读历史在那一轮的回答上、open。
      asks.push([deploy, when]);
      const first = events((await say({ message: "部署吧" })).body).filter((event) => event.type === "card");
      expect(first).toEqual([expect.objectContaining({ runId: RUN, scope: "global",
        card: { kind: "buddy_question", questionId: expect.any(String), questions: [deploy, when], status: "open" } })]);
      const firstId = (first[0].card as { questionId: string }).questionId;
      expect(await cards()).toEqual([{ kind: "buddy_question", questionId: firstId, questions: [deploy, when], status: "open" }]);

      // 本人没答、聊了别的：那张 dismissed；伙伴这一轮又出了一个，新的那张 open。
      asks.push([deploy]);
      const second = events((await say({ message: "先说说昨天的会" })).body).find((event) => event.type === "card")!;
      const secondId = (second.card as { questionId: string }).questionId;
      expect((await cards()).map((card: { questionId: string; status: string }) => [card.questionId, card.status])).toEqual([[firstId, "dismissed"], [secondId, "open"]]);

      // 点选项回答：网页把选择拼成一句话发出、带 buddyQuestionId；那张 answered。Chat 那边只收到原话（不认识的字段 Chat 会整轮拒收）。
      await say({ message: "部署方式：只发预发（推荐）", buddyQuestionId: secondId });
      expect((await cards()).map((card: { status: string }) => card.status)).toEqual(["dismissed", "answered"]);
      expect(JSON.parse(chat.turns().at(-1)!.body)).not.toHaveProperty("buddyQuestionId");
      // 已经收掉的不能再答成 answered。
      await say({ message: "还是预发和生产", buddyQuestionId: firstId });
      expect((await cards()).map((card: { status: string }) => card.status)).toEqual(["dismissed", "answered"]);

      // 项目对话里出的框记在那个项目对话上：伙伴台的话收不掉它，只有项目对话里的话收掉。
      const projectId = (await t.app.inject({ method: "POST", url: "/api/me/projects", headers: { cookie, origin: t.publicOrigin }, payload: { name: "对话质量" } })).json().projectId as string;
      const pipeline = (await t.app.inject({ method: "POST", url: `/api/me/projects/${projectId}/pipeline`, headers: { cookie, origin: t.publicOrigin } })).json().conversationId as string;
      const projectRun = randomUUID();
      const inProject = (await act("ask_user", { questions: [when] }, { runId: projectRun, conversationId: pipeline })).json().result.questionId as string;
      const status = async () => (await t.sql("SELECT scope,status FROM buddy_questions WHERE id=$1", [inProject]))[0];
      await say({ message: "伙伴台这边说一句" });
      expect(await status()).toEqual({ scope: `project:${projectId}`, status: "open" });
      await t.app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(`project:${projectId}`)}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "时间：本周五", buddyQuestionId: inProject } });
      expect(await status()).toEqual({ scope: `project:${projectId}`, status: "answered" });
    });
  }, 30_000);
  it("回话带上这一轮实际用的来源和模型：Chat 的 usage 报了就给界面一帧 model（换了才再给），记下最后一次，读历史时在回答上；没报的没有", async () => {
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
    let turns = 0;
    const chat = await fakeChat({
      conversations: ["chat-conversation"],
      pages: { "0": { messages: [{ role: "user", text: "你好", runId: RUN }, { role: "assistant", text: "在", runId: RUN }],
        runs: [{ runId: RUN, status: "completed" }], nextCursor: null } },
      turn: (res) => sse(res, ++turns === 1 ? [{ type: "turn_started" },
        { type: "usage", ...usage, provider: "tokenhub", model: "claude-opus-5-5" },
        { type: "usage", ...usage, provider: "tokenhub", model: "claude-opus-5-5" },
        { type: "usage", ...usage, provider: "tokenhub", model: "qwen3.8-flash" },
        { type: "message", delta: "在" }, { type: "done", status: "completed" }]
        : [{ type: "turn_started" }, { type: "usage", ...usage }, { type: "message", delta: "在" }, { type: "done", status: "completed" }]),
    });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.memberCookie();
      const say = () => t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "你好" } });
      const answer = async () => (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json()
        .messages.find((message: { role: string }) => message.role === "assistant");
      const first = events((await say()).body).filter((event) => event.type === "model");
      expect(first.map(({ provider, model }) => ({ provider, model }))).toEqual([
        { provider: "tokenhub", model: "claude-opus-5-5" }, { provider: "tokenhub", model: "qwen3.8-flash" }]);
      expect(first.every((event) => event.runId === RUN && Object.keys(event).sort().join() === "model,provider,runId,scope,sequence,type")).toBe(true);
      await vi.waitFor(async () => expect((await answer()).model).toEqual({ provider: "tokenhub", model: "qwen3.8-flash" }));
      // Chat 没报模型（老版本）：不给 model 帧，记下的那一轮照旧。
      expect(events((await say()).body).some((event) => event.type === "model")).toBe(false);
      expect(await t.sql("SELECT run_id,provider,model FROM chat_turn_models")).toEqual([{ run_id: RUN, provider: "tokenhub", model: "qwen3.8-flash" }]);
    });
  }, 30_000);
});
