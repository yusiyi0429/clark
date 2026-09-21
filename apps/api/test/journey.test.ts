import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { Card, SessionResponse } from "@warmap/contracts";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { TEST_PASSWORD, createTestApp, preflightCandidate, testEnv } from "./helpers.js";

const USAGE = {
  input: 4,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fakeStream(final: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    const block = final.content[0];
    if (block.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: 0, partial: final });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: final });
      events.push({ type: "done", reason: "toolUse", message: final });
    } else {
      events.push({ type: "text_start", contentIndex: 0, partial: final });
      events.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: final });
      events.push({ type: "text_end", contentIndex: 0, content: block.text, partial: final });
      events.push({ type: "done", reason: "stop", message: final });
    }
  });
  return events;
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content, usage: USAGE, stopReason, timestamp: Date.now() };
}

describe("CEO login → real Card journey", () => {
  it("rejects wrong password and unauthenticated card access", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const bad = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: t.publicOrigin },
        payload: { password: "wrong" },
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toMatchObject({ code: "INVALID_CREDENTIALS", retryable: false });

      const anon = await app.inject({ method: "GET", url: "/api/cards/home" });
      expect(anon.statusCode).toBe(401);
      expect(anon.json()).toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await t.close();
    }
  });

  it("issues an HttpOnly Secure SameSite=Strict cookie and serves real home Cards", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: t.publicOrigin },
        payload: { password: TEST_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      expect(Value.Check(SessionResponse, login.json())).toBe(true);

      const setCookie = login.headers["set-cookie"] as string;
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Strict");

      const cookie = setCookie.split(";")[0];
      const res = await app.inject({
        method: "GET",
        url: "/api/cards/home",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { cards: { kind: string; payload: unknown }[] };
      // 首页是真实投影：Radar 配置 + 注册战场，不再有 fixture home Card
      expect(body.cards[0].kind).toBe("radar");
      expect(body.cards.some((card) => card.kind === "battlefield")).toBe(true);
      for (const card of body.cards) expect(Value.Check(Card, card)).toBe(true);

      const session = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie },
      });
      expect(session.json()).toEqual({ authenticated: true });
    } finally {
      await t.close();
    }
  });

  it("GET /api/cards/home performs no writes", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const cookie = await t.loginCookie();
      const issue = await t.createIssue();
      const first = await app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie } });
      const second = await app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie } });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(second.json().cards.some((card: { id: string }) => card.id === `issue:${issue.objectRef.id}`)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("logout clears the session", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const cookie = await t.loginCookie();
      const out = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { origin: t.publicOrigin, cookie },
      });
      expect(out.statusCode).toBe(200);
      const after = await app.inject({
        method: "GET",
        url: "/api/cards/home",
        headers: { cookie: out.headers["set-cookie"] as string },
      });
      expect(after.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("rejects writes without a same-origin header", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "https://evil.example" },
        payload: { password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "ORIGIN_MISMATCH" });
    } finally {
      await t.close();
    }
  });

  it("rate limits login attempts per IP", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: t.publicOrigin },
          payload: { password: "wrong" },
        });
        expect(r.statusCode).toBe(401);
      }
      const sixth = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: t.publicOrigin },
        payload: { password: TEST_PASSWORD },
      });
      expect(sixth.statusCode).toBe(429);
    } finally {
      await t.close();
    }
  });

  it("service tokens are a separate boundary from the CEO session", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const noToken = await app.inject({ method: "POST", url: "/mcp/company-memory" });
      expect(noToken.statusCode).toBe(401);

      const wrongToken = await app.inject({
        method: "POST",
        url: "/mcp/company-memory",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` },
      });
      expect(wrongToken.statusCode).toBe(401);

      const mcp = await app.inject({
        method: "POST",
        url: "/mcp/company-memory",
        headers: { authorization: `Bearer ${t.env.mcpServiceToken}` },
      });
      // Ticket 03 起 MCP 已是真实实现：非 MCP 客户端请求（无 Accept/JSON-RPC）由协议层拒绝（非 501 stub）
      expect(mcp.statusCode).toBe(406);

      // CEO cookie 不能访问服务边界
      const cookie = await t.loginCookie();
      const ceoAsService = await app.inject({
        method: "POST",
        url: "/api/dri/issues",
        headers: { cookie },
      });
      expect(ceoAsService.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("runs the CEO main journey through Card, Action, SSE, PostgreSQL, controlled Pi and MCP", async () => {
    const contexts: Context[] = [];
    const streamSimple = (_model: unknown, context: Context) => {
      contexts.push(context);
      if (contexts.length === 1) {
        return fakeStream(assistantMessage([{ type: "toolCall", id: "call-1", name: "search_people", arguments: { query: "测试甲" } }], "toolUse"));
      }
      const toolResult = context.messages.findLast((item) => item.role === "toolResult");
      const text = JSON.stringify(toolResult).includes("person-fixture-001") ? "MCP OK" : "MCP missing";
      return fakeStream(assistantMessage([{ type: "text", text }], "stop"));
    };
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple,
    });
    const t = await createTestApp({}, runtime, {
      // Preflight 不是本旅程的验证目标：用确定性假稿避免额外的失败 AgentRun。
      preflightAgent: {
        async generate(input: { issues: { id: string }[] }) {
          return {
            runId: "preflight-1",
            candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)),
          };
        },
      },
    });
    try {
      const cookie = await t.loginCookie();

      // 1. Web 首页读取真实 Card 投影
      const home = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie } });
      expect(home.statusCode).toBe(200);
      expect(home.json().cards.length).toBeGreaterThan(0);
      for (const card of home.json().cards) expect(Value.Check(Card, card)).toBe(true);

      // 2. 真实 Action：DRI Issue → scheduled Meeting
      const issue = await t.createIssue();
      const issueRes = await t.app.inject({ method: "GET", url: `/api/cards/issues/${issue.objectRef.id}`, headers: { cookie } });
      const createMeeting = issueRes.json().cards[0].actions.find((action: { actionType: string }) => action.actionType === "issue.create_meeting");
      expect(createMeeting).toBeTruthy();
      const action = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { cookie, origin: t.publicOrigin },
        payload: {
          actionId: createMeeting.actionId,
          input: {
            title: "渠道投入决策会",
            scheduledAt: "2026-06-01T10:00:00.000+08:00",
            leadDriId: "person-fixture-002",
            ceoParticipantId: "person-fixture-001",
            participants: ["person-fixture-002"],
            issueIds: [issue.objectRef.id],
          },
        },
      });
      expect(action.statusCode).toBe(200);
      const meetingCard = action.json().cards[0];
      expect(Value.Check(Card, meetingCard)).toBe(true);
      expect(meetingCard.kind).toBe("meeting");
      const meetingId = meetingCard.objectRef.id as string;

      // 3. PostgreSQL 是可核对的事实源
      const persisted = (await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(persisted.status).toBe("scheduled");

      // 4. 对象 Conversation SSE → 受控 Pi → 只读 MCP
      const scope = `meeting:${meetingId}`;
      const turn = await t.app.inject({
        method: "POST",
        url: `/api/conversations/${scope}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "负责人是谁？" },
      });
      const events = turn.body
        .split("\n\n")
        .filter((block) => block.includes("data: "))
        .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as { type: string; name?: string; delta?: string; status?: string });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool", name: "search_people" }),
        expect.objectContaining({ type: "message", delta: "MCP OK" }),
        expect.objectContaining({ type: "done", status: "completed" }),
      ]));
      const state = await t.conversationState(scope);
      expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(state.messages[1].content).toBe("MCP OK");
      expect(await t.agentRuns()).toEqual([expect.objectContaining({ kind: "conversation", status: "succeeded" })]);
    } finally {
      await runtime.close?.();
      await t.close();
    }
  });
});
