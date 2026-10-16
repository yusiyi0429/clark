import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { HealthResponse } from "@warmap/contracts";
import { configureLangSmith, flushLangSmith, withTurnTrace } from "../src/langsmith.js";
import { logEvent, redactSecrets } from "../src/observability.js";
import { SESSION_COOKIE, createSessionToken } from "../src/session.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import type { RadarService } from "../src/radar.js";
import { TEST_CEO, createTestApp, createTestDb, testEnv } from "./helpers.js";

import { captureTraceTransport } from "./langsmithTransport.js";
import { v7 } from "uuid";

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

  it("keeps Company availability metadata while excluding new reference bodies from logs and traces", () => {
    expect(redactSecrets({
      company: { status: "ready", entries: [{ title: "经营战略", text: "应保密的公司正文" }], more: true, nextCursor: "CP1" },
      companyMemory: [{ title: "公司结果", text: "旧消费字段的新公司正文" }],
      companyStatus: "partial", totalTokens: 10,
    })).toEqual({
      company: { status: "ready", entries: "[REDACTED]", more: true, nextCursor: "[REDACTED]" },
      companyMemory: "[REDACTED]", companyStatus: "partial", totalTokens: 10,
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
      await flushLangSmith();

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
        dependencies: { piRuntime: true, modelSlots: true, peopleDirectory: true, companyConfigured: false, search: false, wechat: false, outlets: false, recording: { tos: false, asr: false }, voiceprint: false, world: false },
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

describe("LangSmith SDK adapter", () => {
  it("is a no-op when tracing is disabled and preserves the business result", async () => {
    const t = await createTestApp({}, fakeRuntime());
    const transport = captureTraceTransport();
    try {
      configureLangSmith({ apiKey: 'test-key', tracing: false, fetchImplementation: transport.fetchImplementation });
      const cookie=await t.loginCookie();
      const result=await t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers:{cookie,origin:t.publicOrigin},payload:{message:'hello'}});
      await flushLangSmith();
      expect(result.body).toContain('"status":"completed"');
      expect(transport.sent).toHaveLength(0);
    } finally { await t.close(); configureLangSmith({}); }
  });

  it("records only actual runs, strict durable identity and redacted application inputs", async () => {
    const runtime=fakeRuntime();
    const t=await createTestApp({},runtime);
    const transport=captureTraceTransport();
    try {
      configureLangSmith({apiKey:'test-key',project:'clark_oct',tracing:true,endpoint:'https://langsmith.test',fetchImplementation:transport.fetchImplementation});
      const cookie=await t.loginCookie();
      const send=(message:string)=>t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers:{cookie,origin:t.publicOrigin},payload:{message}});
      await send('总结当前决策面'); await send('继续'); await flushLangSmith();
      const roots=transport.sent.filter(x=>x.method==='POST').map(x=>x.body);
      // A controlled runtime emits fake UI events, not real tool/model invocations: no invented spans.
      expect(roots).toHaveLength(4); // two roots and two actual Personal retrievals
      const turns=roots.filter(x=>x.name.startsWith('turn:'));
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({run_type:'chain',session_name:'clark_oct',inputs:{message:'总结当前决策面'},extra:{metadata:{scope:'global',agent_role:'ceo-agent',attempt:1}}});
      const first=turns[0].extra.metadata;
      expect(first.thread_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(turns[1].extra.metadata.thread_id).toBe(first.thread_id);
      expect(turns[1].extra.metadata.logical_turn_id).not.toBe(first.logical_turn_id);
      expect(first.anon_user_id).not.toBe(TEST_CEO.personId);
      expect(roots.every(x=>!['llm','tool'].includes(x.run_type))).toBe(true);
      expect(transport.sent.find(x=>x.method==='PATCH'&&x.url.endsWith(turns[0].id))?.body).toMatchObject({outputs:{status:'succeeded'}});
      await withTurnTrace({threadId:v7(),logicalTurnId:v7(),attempt:1,scope:'test',agentRole:'test',caller:'test'},async()=>{},
        {inputs:{password:'p',token:'t',transcript:{text:'逐字稿'},passages:[{text:'公司认知'}]}});
      await flushLangSmith();
      expect(transport.sent.filter(x=>x.method==='POST').at(-1)?.body.inputs).toEqual({password:'[REDACTED]',token:'[REDACTED]',transcript:'[REDACTED]',passages:'[REDACTED]'});
      expect(JSON.stringify(transport.sent)).not.toContain('test-key');
    } finally { await t.close(); configureLangSmith({}); }
  });

  it("isolates SDK transport failures from the AgentRun, business result and credentials", async () => {
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    const t=await createTestApp({},fakeRuntime());
    try {
      configureLangSmith({apiKey:'test-secret-key',tracing:true,fetchImplementation:async()=>{throw new Error('test-secret-key unavailable');}});
      const cookie=await t.loginCookie();
      const res=await t.app.inject({method:'POST',url:'/api/conversations/global/messages',headers:{cookie,origin:t.publicOrigin},payload:{message:'hello'}});
      await flushLangSmith();
      expect(res.body).toContain('"status":"completed"');
      expect(await t.agentRuns()).toEqual([expect.objectContaining({kind:'conversation',status:'succeeded'})]);
      expect(errors).toHaveBeenCalled();
      expect(errors.mock.calls.flat().map(String).join()).not.toContain('test-secret-key');
    } finally {await t.close();configureLangSmith({});errors.mockRestore();}
  });
});
