import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { HealthResponse } from "@warmap/contracts";
import { configureLangSmith, recordAgentTrace } from "../src/langsmith.js";
import { logEvent, redactSecrets } from "../src/observability.js";
import { SESSION_COOKIE, createSessionToken } from "../src/session.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import type { RadarService } from "../src/radar.js";
import { TEST_CEO, createTestApp, createTestDb, testEnv } from "./helpers.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const fakeRuntime = () => {
  const runtime = {
    modelSlot: "light",
    modelId: "test-light-model",
    promptHash: "c".repeat(64),
    calls: 0,
    async run(input: { emit: (event: Record<string, unknown>) => void }) {
      runtime.calls += 1;
      input.emit({ type: "tool", phase: "started", toolCallId: "c1", name: "web_search" });
      input.emit({ type: "tool", phase: "completed", toolCallId: "c1", name: "web_search", isError: false });
      input.emit({ type: "usage", input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 });
      input.emit({ type: "message", delta: "answer" });
      return { assistantMessage: "answer", runtimeEntries: [] };
    },
  };
  return runtime;
};

/** 捕获 logEvent 写出的 JSON 行，同时屏蔽测试期间的其它 stdout 噪声。 */
function captureLogs(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    try {
      const parsed = JSON.parse(String(chunk)) as Record<string, unknown>;
      if (typeof parsed.event === "string") lines.push(parsed);
    } catch {
      // 非 JSON 输出（reporter）忽略
    }
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("security boundaries not covered elsewhere", () => {
  it("rejects an expired or tampered CEO session cookie", async () => {
    const t = await createTestApp({}, fakeRuntime());
    try {
      const expired = createSessionToken(testEnv.sessionSecret, -1, { pid: TEST_CEO.personId, v: 1 });
      const expiredRes = await t.app.inject({
        method: "GET",
        url: "/api/cards/home",
        headers: { cookie: `${SESSION_COOKIE}=${expired}` },
      });
      expect(expiredRes.statusCode).toBe(401);
      expect(expiredRes.json().code).toBe("UNAUTHORIZED");

      const valid = createSessionToken(testEnv.sessionSecret, 3600, { pid: TEST_CEO.personId, v: 1 });
      const tampered = `${valid.slice(0, -2)}xx`;
      const tamperedRes = await t.app.inject({
        method: "GET",
        url: "/api/cards/home",
        headers: { cookie: `${SESSION_COOKIE}=${tampered}` },
      });
      expect(tamperedRes.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });
});

describe("structured logs and redaction", () => {
  it("clears secrets, full CompanyMemory passages and full Transcripts while keeping safe fields", () => {
    expect(redactSecrets({
      password: "p",
      cookie: "c",
      token: "t",
      apiKey: "k",
      authorization: "Bearer x",
      transcript: { turns: [{ text: "逐字稿" }] },
      passages: [{ text: "公司认知" }],
      nested: { secretRef: "s", scope: "global", durationMs: 12 },
      totalTokens: 5,
    })).toEqual({
      password: "[REDACTED]",
      cookie: "[REDACTED]",
      token: "[REDACTED]",
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
      transcript: "[REDACTED]",
      passages: "[REDACTED]",
      nested: { secretRef: "[REDACTED]", scope: "global", durationMs: 12 },
      totalTokens: 5,
    });
  });

  it("emits request, action and agent runs with the required fields and no secret values", async () => {
    const t = await createTestApp({}, fakeRuntime());
    const capture = captureLogs();
    try {
      const cookie = await t.loginCookie();
      const rejected = await t.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: t.publicOrigin },
        payload: { loginId: TEST_CEO.loginId, passcode: "0000" },
      });
      expect(rejected.statusCode).toBe(401);
      const issue = await t.createIssue();
      const issueCard = (await t.app.inject({ method: "GET", url: `/api/cards/issues/${issue.objectRef.id}`, headers: { cookie } })).json().cards[0];
      const dismiss = issueCard.actions.find((action: { actionType: string }) => action.actionType === "issue.dismiss");
      const action = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { cookie, origin: t.publicOrigin },
        payload: { actionId: dismiss.actionId, input: { reason: "误升级" } },
      });
      expect(action.statusCode).toBe(200);

      await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "总结当前决策面" },
      });
      await flush();

      const actionLog = capture.lines.find((line) => line.event === "http.request" && line.actionType === "issue.dismiss");
      expect(actionLog).toMatchObject({
        requestId: expect.stringMatching(/^req-/),
        actionType: "issue.dismiss",
        objectRef: `issue:${issue.objectRef.id}`,
        status: "200",
      });
      expect(typeof actionLog?.durationMs).toBe("number");

      const agentLog = capture.lines.find((line) => line.event === "agent.run" && line.agentKind === "conversation");
      expect(agentLog).toMatchObject({
        requestId: expect.stringMatching(/^req-/),
        runId: expect.any(String),
        scope: "global",
        provider: "warmap",
        model: "test-light-model",
        status: "succeeded",
      });
      expect(typeof agentLog?.durationMs).toBe("number");

      const errorLog = capture.lines.find((line) => line.errorCode === "INVALID_CREDENTIALS");
      expect(errorLog).toBeTruthy();
      logEvent({ event: "test.redaction", requestId: "req-x", apiKey: "leak", transcript: { turns: [] }, safe: "kept" });
      const redactionLog = capture.lines.find((line) => line.event === "test.redaction");
      expect(redactionLog).toMatchObject({ apiKey: "[REDACTED]", transcript: "[REDACTED]", safe: "kept" });
    } finally {
      capture.restore();
      await t.close();
    }
  });
});

describe("health", () => {
  it("separates API, database and necessary dependencies without model, Search or persistent side effects", async () => {
    const runtime = fakeRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const health = await t.app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(Value.Check(HealthResponse, health.json())).toBe(true);
      expect(health.json()).toEqual({
        status: "ok",
        api: true,
        database: true,
        buildSha: "test-sha",
        dependencies: { piRuntime: true, modelSlots: true, companyMemoryMcp: true, search: false, wechat: false, outlets: false },
      });

      const gets = [
        "/api/cards/home",
        "/api/cards/radar",
        "/api/cards/signals",
        "/api/cards/meetings",
        "/api/cards/monthly-plans",
        "/api/cards/notifications",
        "/api/cards/battlefields",
        "/api/conversations/global/messages",
      ];
      for (const url of gets) {
        const res = await t.app.inject({ method: "GET", url, headers: { cookie } });
        expect(res.statusCode, url).toBe(200);
      }

      // 无模型/Search 调用：唯一的模型入口是 Conversation Runtime
      expect(runtime.calls).toBe(0);
      expect(await t.agentRuns()).toEqual([]);
      expect((await t.sql("SELECT count(*)::int AS n FROM conversations"))[0].n).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("reports a degraded API with the database clearly distinguished", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      // 用真实 Pool 的失败查询模拟数据库不可用，而不结束后续清理需要的连接池。
      const broken = {
        query: async () => {
          throw new Error("database unavailable");
        },
      } as unknown as import("pg").Pool;
      const app = await buildApp({ pool: broken, env: testEnv, conversationRuntime: fakeRuntime() });
      try {
        const res = await app.inject({ method: "GET", url: "/healthz" });
        expect(res.statusCode).toBe(200);
        expect(Value.Check(HealthResponse, res.json())).toBe(true);
        expect(res.json()).toMatchObject({ status: "degraded", api: true, database: false });
      } finally {
        await app.close();
      }
    });
  });

  it("reflects real provider readiness instead of constants", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const radarService = {
        providerStatus: { web: true, wechat: true },
        async recoverStaleRuns() {},
        async runManual() {
          return { trigger: "manual", status: "failed", companyDay: "2026-01-01", createdSignals: 0, warnings: [] };
        },
        async runScheduled() {
          return { trigger: "scheduled", status: "failed", companyDay: "2026-01-01", createdSignals: 0, warnings: [] };
        },
      } as unknown as RadarService;
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: fakeRuntime(), radarService });
      try {
        const res = await app.inject({ method: "GET", url: "/healthz" });
        expect(res.json()).toMatchObject({ status: "ok", dependencies: { search: true, wechat: true } });
      } finally {
        await app.close();
      }
    });
  });
});

describe("LangSmith optional adapter", () => {
  it("is a no-op when unconfigured and never fails the business path", async () => {
    const t = await createTestApp({}, fakeRuntime());
    try {
      configureLangSmith({});
      let calls = 0;
      configureLangSmith({ fetchImpl: async () => { calls += 1; return { ok: true, status: 200 }; } });
      await recordAgentTrace({
        runId: "r0", name: "conversation", agentKind: "conversation",
        status: "succeeded", startedAt: Date.now(), durationMs: 1,
      });
      expect(calls).toBe(0);

      const cookie = await t.loginCookie();
      const res = await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "hello" },
      });
      expect(res.body).toContain('"status":"completed"');
    } finally {
      configureLangSmith({});
      await t.close();
    }
  });

  it("records application-visible I/O, tool events, usage and status with credentials redacted", async () => {
    const payloads: { url: string; body: Record<string, unknown> }[] = [];
    const t = await createTestApp({}, fakeRuntime());
    try {
      configureLangSmith({
        apiKey: "ls-secret-key",
        project: "warmap-test",
        endpoint: "https://langsmith.test",
        fetchImpl: async (url, init) => {
          payloads.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
          return { ok: true, status: 202 };
        },
      });
      const cookie = await t.loginCookie();
      await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "总结当前决策面" },
      });
      await flush();

      expect(payloads).toHaveLength(1);
      expect(payloads[0].url).toBe("https://langsmith.test/runs");
      expect(payloads[0].body).toMatchObject({
        name: "conversation",
        session_name: "warmap-test",
        inputs: { agentKind: "conversation", promptHash: "c".repeat(64), input: { message: "总结当前决策面" } },
        outputs: { assistantMessage: "answer" },
        extra: {
          status: "succeeded",
          toolEvents: [{ name: "web_search", isError: false }],
          usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
        },
      });
      expect(JSON.stringify(payloads[0].body)).not.toContain("ls-secret-key");

      await recordAgentTrace({
        runId: "r-redact",
        name: "conversation",
        agentKind: "conversation",
        inputs: { password: "p", token: "t", transcript: { turns: [{ text: "逐字稿" }] }, passages: [{ text: "公司认知" }] },
        outputs: { assistantMessage: "ok" },
        status: "succeeded",
        startedAt: Date.now(),
        durationMs: 2,
      });
      const redactedInput = (payloads[1].body.inputs as { input: Record<string, unknown> }).input;
      expect(redactedInput).toEqual({
        password: "[REDACTED]",
        token: "[REDACTED]",
        transcript: "[REDACTED]",
        passages: "[REDACTED]",
      });
    } finally {
      configureLangSmith({});
      await t.close();
    }
  });

  it("downgrades a LangSmith failure to a warning without changing the AgentRun or business result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await createTestApp({}, fakeRuntime());
    try {
      configureLangSmith({
        apiKey: "ls-secret-key",
        fetchImpl: async () => {
          throw new Error("langsmith unreachable");
        },
      });
      const cookie = await t.loginCookie();
      const res = await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "hello" },
      });
      await flush();
      expect(res.body).toContain('"status":"completed"');
      expect(await t.agentRuns()).toEqual([expect.objectContaining({ kind: "conversation", status: "succeeded" })]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("langsmith trace failed"));
    } finally {
      warn.mockRestore();
      configureLangSmith({});
      await t.close();
    }
  });
});
