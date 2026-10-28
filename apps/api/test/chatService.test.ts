import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { homeTurn } from "../src/homeTurn.js";

const CHAT_TOKEN = "chat-token-test";
const RUN = "6f0c1a52-6d7e-4e57-9a51-0a9a4c3e2b10";

type ChatRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
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
} = {}) {
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
    const request = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    requests.push(request);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${CHAT_TOKEN}`) return send(401, { error: { code: "UNAUTHORIZED", message: "内部服务凭据无效" } });
    if (request.method === "GET" && request.url === "/conversations") return send(200, { conversations: listed.slice(0, 50) });
    if (request.method === "POST" && request.url === "/conversations") {
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
    if (request.method === "POST" && request.url.endsWith("/turns")) {
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

/** 界面收到的事件（只取 data 行）。 */
function events(payload: string): Record<string, unknown>[] {
  return payload.split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
    return line ? [JSON.parse(line.slice(5)) as Record<string, unknown>] : [];
  });
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
  run: (t: Awaited<ReturnType<typeof createTestApp>>) => Promise<void>, token = CHAT_TOKEN) {
  const t = await createTestApp({ internalChatToken: token, chatServiceUrl: chat.url }, runtime);
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
      expect(received[0]).toMatchObject({ tier: "deep", expectSeconds: 90 });
      expect(received[2]).toMatchObject({ phase: "started", name: "read_world_object", label: "读取本体对象" });
      expect(received.every((event, index) => event.runId === RUN && event.scope === "global" && event.sequence === index + 1)).toBe(true);
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
        { message: "这周怎么样", source: "wechat" }, { message: "下周呢", source: "feishu" },
      ]);
      expect(runtime.calls).toBe(0);
    });
  });

  it("历史里 Chat 记下的来源回到消息的 via，网页问的没有 via", async () => {
    const [r1, r2] = [randomUUID(), randomUUID()];
    const message = (role: string, text: string, runId: string, position: number, source: string | null) =>
      ({ id: randomUUID(), position: String(position), role, text, runId, attachmentIds: [], attachments: [], source });
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
      { attachments: [{ attachmentId: randomUUID(), fileName: "scan.md", mime: "text/markdown", size: 3, status: "failed", extractedChars: 0, reason: "empty" }] },
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

      await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "看看附件", attachments: [{ id: attachmentId }] } });
      expect(JSON.parse(chat.turns()[0].body).attachmentIds).toEqual([attachmentId]);

      const unreadable = await upload(multipart("scan.md", "   "));
      expect([unreadable.statusCode, unreadable.json().code]).toEqual([400, "ATTACHMENT_UNREADABLE"]);
    });
  });

  it("界面断开（点停止、关页面）就断开对 Chat 的请求", async () => {
    let chatClosed!: () => void;
    const closed = new Promise<void>((resolve) => { chatClosed = resolve; });
    const chat = await fakeChat({ turn: (res) => {
      res.on("close", () => chatClosed());
      sse(res, [{ type: "turn_started" }, { type: "message", delta: "正在写" }], false);
    } });
    await withChat(chat, countingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      await t.app.listen({ port: 0, host: "127.0.0.1" });
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/conversations/global/messages`, {
        method: "POST", signal: controller.signal,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ message: "写长一点" }),
      });
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes("正在写")) text += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      await expect(Promise.race([closed.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("still open"), 3000))])).resolves.toBe("closed");
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
      // 这一句进了哪一段记进纪要表（视角、段 id），纪要后台据此去读。
      expect(await t.sql("SELECT owner_id, viewer_role, source, source_ref, status FROM conversation_digests")).toEqual([
        { owner_id: TEST_CEO.personId, viewer_role: "ceo", source: "chat", source_ref: idle.conversations[0], status: "stale" }]);
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
      expect((await t.app.inject({ url: "/internal/conversation-catalog", headers: headers("member") })).statusCode).toBe(403);
      expect((await t.app.inject({ url: "/internal/conversation-recall/search?from=yesterday", headers: headers() })).statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });
});
