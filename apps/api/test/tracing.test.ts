import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
} from "@earendil-works/pi-ai";
import { runCandidateAgent } from "../src/candidateAgentRuntime.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createArkChat, type DictationPolishDeps } from "../src/dictationPolish.js";
import { makeMemoryTools } from "../src/memoryTools.js";
import { migrate } from "../src/migrate.js";
import {
  AGENT_ROLES,
  CLIENT_TAGS,
  METADATA_KEYS,
  RUN_NAME_PATTERN,
  annotateTurn,
  clientTagFor,
  configureTracing,
  resetTracing,
  runNames,
  traceTools,
  tracedStreamSimple,
  tracedTurn,
  withAgent,
  withRetrieve,
  type TraceClientLike,
} from "../src/tracing.js";
import { TEST_CEO, createTestApp, createTestDb, testEnv } from "./helpers.js";

/** 不连 LangSmith：记录 SDK 发出的 create / update，按 id 合并成最终 Run。 */
function fakeClient(options: { fail?: boolean } = {}) {
  const creates: Record<string, any>[] = [];
  const updates: Record<string, any>[] = [];
  const client: TraceClientLike = {
    async createRun(run) {
      if (options.fail) throw new Error("langsmith unreachable");
      creates.push(structuredClone(run));
    },
    async updateRun(id, run) {
      if (options.fail) throw new Error("langsmith unreachable");
      updates.push({ id, ...structuredClone(run) });
    },
  };
  const runs = () => {
    const byId = new Map<string, Record<string, any>>();
    for (const run of creates) byId.set(run.id, { ...run });
    for (const run of updates) {
      const prev = byId.get(run.id) ?? {};
      byId.set(run.id, { ...prev, ...Object.fromEntries(Object.entries(run).filter(([, v]) => v !== undefined)) });
    }
    return [...byId.values()];
  };
  return { client, creates, updates, runs };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function childrenOf(runs: Record<string, any>[], parent: Record<string, any>) {
  return runs.filter((run) => run.parent_run_id === parent.id).sort((a, b) => String(a.dotted_order).localeCompare(String(b.dotted_order)));
}

function byName(runs: Record<string, any>[], name: string) {
  return runs.filter((run) => run.name === name);
}

function expectWhitelistedMetadata(payloads: Record<string, any>[]) {
  const allowed = new Set<string>(METADATA_KEYS);
  for (const payload of payloads) {
    const keys = Object.keys(payload.extra?.metadata ?? {});
    for (const key of keys) expect(allowed.has(key), `metadata key ${key} on ${payload.name}`).toBe(true);
  }
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const realUsage = { input: 7, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 12, cost: zeroCost };
const noUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost };

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], usage = realUsage): AssistantMessage {
  return { role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-heavy", content, usage, stopReason, timestamp: Date.now() };
}

/** 逐块推事件：text 块推真实 text_delta；toolCall 块只有 start / end（没有 delta，即没有首 token）。 */
function stream(final: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    final.content.forEach((block, index) => {
      if (block.type === "text") {
        events.push({ type: "text_start", contentIndex: index, partial: final });
        events.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: final });
        events.push({ type: "text_end", contentIndex: index, content: block.text, partial: final });
      } else if (block.type === "toolCall") {
        events.push({ type: "toolcall_start", contentIndex: index, partial: final });
        events.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: final } as AssistantMessageEvent);
      }
    });
    events.push(final.stopReason === "toolUse"
      ? { type: "done", reason: "toolUse", message: final }
      : { type: "done", reason: "stop", message: final });
  });
  return events;
}

const Candidate = Type.Object({ summary: Type.String() }, { additionalProperties: false });

afterEach(() => {
  resetTracing();
});

describe("LangSmith 命名", () => {
  it("run 名全小写、冒号分段，不含中文与自由文本", () => {
    expect(runNames.turn("mtg-42-r1", 2)).toBe("turn:mtg-42-r1#a2");
    expect(runNames.agent(AGENT_ROLES.preflight)).toBe("agent:preflight-agent");
    expect(runNames.model("pi", "GPT-5.6-Terra")).toBe("model:pi/gpt-5.6-terra");
    expect(runNames.tool("web_search")).toBe("tool:web_search");
    expect(runNames.retrieve("company-memory")).toBe("retrieve:company-memory");
    expect(runNames.agent("会前 预审")).toBe("agent:unknown");
    for (const name of [
      runNames.turn("conv-1a2b3c4d-t12", 1), runNames.agent(AGENT_ROLES.ceoAgent), runNames.agent(AGENT_ROLES.dictationPolish),
      runNames.model("ark", "deepseek-v4-1-flash-260910"), runNames.tool("search_sections"), runNames.retrieve("web-search"),
    ]) expect(name).toMatch(RUN_NAME_PATTERN);
    for (const role of Object.values(AGENT_ROLES)) expect(runNames.agent(role)).toMatch(RUN_NAME_PATTERN);
  });

  it("接入方按请求来源判定，只进 tags", () => {
    expect(clientTagFor("/api/conversations/global/messages", false)).toBe(CLIENT_TAGS.web);
    expect(clientTagFor("/api/conversations/global/messages", true)).toBe(CLIENT_TAGS.demo);
    expect(clientTagFor("/mcp?x=1", false)).toBe(CLIENT_TAGS.mcp);
    expect(METADATA_KEYS).not.toContain("client" as never);
  });
});

describe("LANGSMITH_TRACING=false", { timeout: 30_000 }, () => {
  it("零调用：不包装模型与工具、不写计数表、不发送", async () => {
    const fake = fakeClient();
    configureTracing({ env: { LANGSMITH_TRACING: "false", LANGSMITH_API_KEY: "ls-should-not-be-used" }, client: fake.client });
    const inner = () => stream(assistant([{ type: "text", text: "x" }], "stop"));
    expect(tracedStreamSimple(inner)).toBe(inner);
    expect(tracedStreamSimple(undefined)).toBeUndefined();
    const tools = [defineTool({ name: "noop", label: "noop", description: "noop", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) })];
    expect(traceTools(tools)).toBe(tools);
    const resolve = vi.fn();
    expect(await tracedTurn({ resolve }, async () => "ok")).toBe("ok");
    expect(resolve).not.toHaveBeenCalled();

    await createTestDb(async ({ db }) => {
      await migrate(db);
      await runCandidateAgent({
        query: db.query.bind(db), kind: "issue-research", objectRef: { type: "issue", id: "fixture-001" },
        input: { q: 1 }, prompt: "只提交候选。", schema: Candidate, baseUrl: "https://provider.invalid/v1", apiKey: "k", modelId: "fake-heavy",
        streamSimple: () => stream(assistant([{ type: "toolCall", id: "s1", name: "submit_candidate", arguments: { summary: "ok" } }], "toolUse")),
      });
      expect((await db.query("SELECT count(*)::int AS n FROM trace_threads")).rows[0].n).toBe(0);
    });
    await settle();
    expect(fake.creates).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it("开关缺省也是关闭；打开但没有 API key 时同样关闭", () => {
    configureTracing({ env: {} });
    const inner = () => stream(assistant([{ type: "text", text: "x" }], "stop"));
    expect(tracedStreamSimple(inner)).toBe(inner);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      configureTracing({ env: { LANGSMITH_TRACING: "true" } });
      expect(tracedStreamSimple(inner)).toBe(inner);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("candidate Agent 的 Span 树", { timeout: 30_000 }, () => {
  it("root → agent → llm / tool → retrieve；usage 来自真实返回，首 token 只在真实 delta 时记录", async () => {
    const fake = fakeClient();
    configureTracing({ enabled: true, client: fake.client, project: "test-project", salt: "test-salt" });
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const memoryTools = makeMemoryTools(async () => ({ content: [{ type: "text", text: "章节目录" }], details: {} }));
      let call = 0;
      await runCandidateAgent({
        query: db.query.bind(db), kind: "issue-research", objectRef: { type: "issue", id: "0d9e1f2a-1111-4222-8333-444455556666" },
        personId: TEST_CEO.personId, personName: "测试甲",
        input: { question: "比较供应链" }, prompt: "只提交候选。", schema: Candidate,
        baseUrl: "https://provider.invalid/v1", apiKey: "k", modelId: "fake-heavy", extraTools: memoryTools,
        streamSimple: () => {
          call += 1;
          return call === 1
            ? stream(assistant([{ type: "toolCall", id: "t1", name: "list_sections", arguments: {} }], "toolUse"))
            : stream(assistant([{ type: "text", text: "提交" }, { type: "toolCall", id: "s1", name: "submit_candidate", arguments: { summary: "选择合作" } }], "toolUse", noUsage));
        },
      });
      await settle();
      const runs = fake.runs();
      const roots = runs.filter((run) => !run.parent_run_id);
      expect(roots).toHaveLength(1);
      const root = roots[0];
      expect(root).toMatchObject({ name: "turn:iss-0d9e1f2a-r1#a1", run_type: "chain", session_name: "test-project", tags: [CLIENT_TAGS.system] });
      expect(root.extra.metadata).toMatchObject({ logical_turn_id: "iss-0d9e1f2a-r1", attempt: 1, scope: "issue:0d9e1f2a-1111-4222-8333-444455556666" });
      expect(root.extra.metadata.thread_id).toMatch(UUID7);
      expect(root.extra.metadata.anon_user_id).toMatch(/^u_[0-9a-f]{16}$/);

      const [agent] = childrenOf(runs, root);
      expect(agent).toMatchObject({ name: "agent:research-agent", run_type: "chain" });
      expect(agent.extra.metadata).toMatchObject({ agent_role: "research-agent", ls_agent_type: "root" });
      const steps = childrenOf(runs, agent).map((run) => run.name);
      expect(steps).toEqual(["model:pi/fake-heavy", "tool:list_sections", "model:pi/fake-heavy", "tool:submit_candidate"]);

      const [firstModel, secondModel] = byName(runs, "model:pi/fake-heavy").sort((a, b) => a.dotted_order.localeCompare(b.dotted_order));
      expect(firstModel.run_type).toBe("llm");
      expect(firstModel.extra.metadata).toMatchObject({ ls_provider: "pi", ls_model_name: "fake-heavy", agent_role: "research-agent" });
      expect(firstModel.extra.metadata.ls_agent_type).toBeUndefined();
      // 供应方真实 usage（input 7 + cacheRead 2）→ usage_metadata；全零的 usage 视为没给。
      expect(firstModel.outputs.usage_metadata).toEqual({ input_tokens: 9, output_tokens: 3, total_tokens: 12, input_token_details: { cache_read: 2 } });
      expect(secondModel.outputs.usage_metadata).toBeUndefined();
      // 只有工具调用、没有 delta 的那次请求不记首 token；有真实 text_delta 的那次记一次 new_token。
      expect(firstModel.events ?? []).toEqual([]);
      expect(secondModel.events).toEqual([expect.objectContaining({ name: "new_token" })]);
      expect(Date.parse(secondModel.events[0].time)).toBeGreaterThanOrEqual(Date.parse(secondModel.start_time ?? 0) || 0);

      const [tool] = byName(runs, "tool:list_sections");
      expect(tool).toMatchObject({ run_type: "tool" });
      expect(tool.extra.metadata.ls_tool_name).toBe("list_sections");
      const [retrieve] = childrenOf(runs, tool);
      expect(retrieve).toMatchObject({ name: "retrieve:company-memory", run_type: "retriever" });

      for (const run of runs) {
        expect(run.name).toMatch(RUN_NAME_PATTERN);
        expect(run.extra.metadata.thread_id).toBe(root.extra.metadata.thread_id);
        expect(run.extra.metadata.logical_turn_id).toBe("iss-0d9e1f2a-r1");
        expect(run.trace_id).toBe(root.id);
      }
      expectWhitelistedMetadata([...fake.creates, ...fake.updates]);
      const wire = JSON.stringify([...fake.creates, ...fake.updates]);
      expect(wire).not.toContain(TEST_CEO.personId);
      expect(wire).not.toContain("测试甲");
      expect(wire).not.toContain("ls-");
    });
  });

  it("失败后重跑：同 thread_id 与 logical_turn_id，attempt+1 的新 root；成功后才进入下一个 Turn", async () => {
    const fake = fakeClient();
    configureTracing({ enabled: true, client: fake.client, salt: "test-salt" });
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const run = (submit: boolean) => runCandidateAgent({
        query: db.query.bind(db), kind: "meeting_preflight", objectRef: { type: "meeting", id: "42" },
        input: {}, prompt: "只提交候选。", schema: Candidate, baseUrl: "https://provider.invalid/v1", apiKey: "k", modelId: "fake-light",
        streamSimple: () => stream(submit
          ? assistant([{ type: "toolCall", id: "s1", name: "submit_candidate", arguments: { summary: "ok" } }], "toolUse")
          : assistant([{ type: "text", text: "散文" }], "stop")),
      });
      await expect(run(false)).rejects.toThrow("did not call submit_candidate");
      await run(true);
      await run(true);
      await settle();
      const roots = fake.runs().filter((item) => !item.parent_run_id).sort((a, b) => a.dotted_order.localeCompare(b.dotted_order));
      const short = roots[0].extra.metadata.logical_turn_id.split("-")[1];
      expect(roots.map((item) => item.name)).toEqual([`turn:mtg-${short}-r1#a1`, `turn:mtg-${short}-r1#a2`, `turn:mtg-${short}-r2#a1`]);
      expect(new Set(roots.map((item) => item.extra.metadata.thread_id)).size).toBe(1);
      expect(roots[0].error).toContain("submit_candidate");
      expect(roots[1].error).toBeUndefined();
      expect(roots.map((item) => item.extra.metadata.attempt)).toEqual([1, 2, 1]);
    });
  });

  it("追踪发送失败不影响 Agent 结果", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = fakeClient({ fail: true });
    configureTracing({ enabled: true, client: fake.client, salt: "s" });
    try {
      await createTestDb(async ({ db }) => {
        await migrate(db);
        const result = await runCandidateAgent({
          query: db.query.bind(db), kind: "thread-intro", objectRef: { type: "issue", id: "x" },
          input: {}, prompt: "只提交候选。", schema: Candidate, baseUrl: "https://provider.invalid/v1", apiKey: "k", modelId: "m",
          streamSimple: () => stream(assistant([{ type: "toolCall", id: "s1", name: "submit_candidate", arguments: { summary: "ok" } }], "toolUse")),
        });
        expect(result.candidate).toEqual({ summary: "ok" });
        expect((await db.query("SELECT status FROM agent_runs")).rows).toEqual([{ status: "succeeded" }]);
      });
      await settle();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("Turn 与 Agent 按需物化", () => {
  it("没有任何真实步骤的 Turn 不发送；子 Agent 标为 subagent", async () => {
    const fake = fakeClient();
    configureTracing({ enabled: true, client: fake.client, salt: "s" });
    const spec = { agentRole: "radar-assess", logicalTurnId: "rdr-20261013-abcd", attempt: 1, threadId: "01890000-0000-7000-8000-000000000000", scope: "global" };
    await tracedTurn({ resolve: () => spec }, async () => withAgent("radar-assess", async () => "skipped"));
    await settle();
    expect(fake.creates).toHaveLength(0);

    await tracedTurn({ resolve: () => spec }, async () => withAgent("radar-assess", () =>
      withAgent("research-agent", () => withRetrieve("web-search", () => ({ query: "q" }), async () => ({ results: [] })))));
    await settle();
    const runs = fake.runs();
    expect(runs.map((run) => run.name).sort()).toEqual(["agent:radar-assess", "agent:research-agent", "retrieve:web-search", "turn:rdr-20261013-abcd#a1"]);
    expect(byName(runs, "agent:radar-assess")[0].extra.metadata.ls_agent_type).toBe("root");
    expect(byName(runs, "agent:research-agent")[0].extra.metadata.ls_agent_type).toBe("subagent");
    expectWhitelistedMetadata(fake.creates);
  });
});

describe("恢复信息记在 Turn 根节点", () => {
  it("annotateTurn 补记的键在根节点结束时发出，白名单外的键丢掉；没有当前 Turn 时什么都不做", async () => {
    const fake = fakeClient();
    configureTracing({ enabled: true, client: fake.client, salt: "s" });
    annotateTurn({ recovery_retries: 1 });
    const spec = { agentRole: "ceo-agent", logicalTurnId: "conv-abcd1234-t1", attempt: 1, threadId: "01890000-0000-7000-8000-000000000000", scope: "global" };
    await tracedTurn({ resolve: () => spec }, async () => withAgent("ceo-agent", async () => {
      await withRetrieve("web-search", () => ({ query: "q" }), async () => ({ results: [] }));
      annotateTurn({ recovery_original_model: "claude-sonnet-5-5", recovery_fallback_model: "gpt-5.6-sol", recovery_reasons: "network",
        recovery_actions: "continue:1,fallback:1", recovery_retries: 2, ...({ error_text: "terminated" } as object) });
    }));
    await settle();
    const runs = fake.runs();
    const [root] = runs.filter((run) => !run.parent_run_id);
    expect(root.extra.metadata).toMatchObject({ recovery_original_model: "claude-sonnet-5-5", recovery_fallback_model: "gpt-5.6-sol",
      recovery_reasons: "network", recovery_actions: "continue:1,fallback:1", recovery_retries: 2 });
    expect(root.extra.metadata).not.toHaveProperty("error_text");
    expect(byName(runs, "agent:ceo-agent")[0].extra.metadata).not.toHaveProperty("recovery_retries");
    expectWhitelistedMetadata([...fake.creates, ...fake.updates]);
  });
});

describe("对话与听写的 Span 树（经过 HTTP 路由）", { timeout: 30_000 }, () => {
  it("一轮对话：thread_id 持久化在 conversations，root=conv-<会话>-t<序号>，接入方 tag", async () => {
    const fake = fakeClient();
    configureTracing({ enabled: true, client: fake.client, salt: "s" });
    let call = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://provider.invalid/v1/responses", apiKey: "k", modelId: "fake-light",
      streamSimple: (_model, _context: Context) => {
        call += 1;
        return call % 2 === 1
          ? stream(assistant([{ type: "toolCall", id: `t${call}`, name: "list_sections", arguments: {} }], "toolUse"))
          : stream(assistant([{ type: "text", text: "答案" }], "stop"));
      },
    });
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      for (const message of ["第一问", "第二问"]) {
        const res = await t.app.inject({
          method: "POST", url: "/api/conversations/global/messages",
          headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message },
        });
        expect(res.body).toContain('"status":"completed"');
      }
      await settle();
      const conversation = (await t.pool.query("SELECT id, thread_id FROM conversations WHERE owner_id = $1 AND scope = 'global'", [TEST_CEO.personId])).rows[0];
      expect(conversation.thread_id).toMatch(UUID7);
      const runs = fake.runs();
      const roots = runs.filter((run) => !run.parent_run_id).sort((a, b) => a.dotted_order.localeCompare(b.dotted_order));
      const short = String(conversation.id).slice(0, 8);
      expect(roots.map((run) => run.name)).toEqual([`turn:conv-${short}-t1#a1`, `turn:conv-${short}-t3#a1`]);
      for (const root of roots) {
        expect(root.tags).toEqual([CLIENT_TAGS.web]);
        expect(root.extra.metadata).toMatchObject({ thread_id: conversation.thread_id, scope: "global", attempt: 1 });
        expect(root.outputs).toEqual({ assistantMessage: "答案" });
        const [agent] = childrenOf(runs, root);
        expect(agent).toMatchObject({ name: "agent:ceo-agent" });
        expect(agent.extra.metadata.ls_agent_type).toBe("root");
        expect(childrenOf(runs, agent).map((run) => run.name)).toEqual(["retrieve:context-pack", "model:pi/fake-light", "tool:list_sections", "model:pi/fake-light"]);
        expect(childrenOf(runs, byName(childrenOf(runs, agent), "tool:list_sections")[0]).map((run) => run.name)).toEqual(["retrieve:company-memory"]);
      }
      expectWhitelistedMetadata([...fake.creates, ...fake.updates]);
      for (const run of runs) expect(Object.values(run.extra.metadata)).not.toContain(TEST_CEO.personId);
    } finally {
      await t.close();
      await runtime.close();
    }
  });

  it("听写整理：model:ark/<model> 的 usage 取方舟回包；非流式没有首 token 事件", async () => {
    const fake = fakeClient();
    configureTracing({ enabled: true, client: fake.client, salt: "s" });
    const deps: DictationPolishDeps = {
      readConfig: () => ({ apiKey: "ark-key", baseUrl: "https://ark.invalid/api/v3", model: "polish-model", backupModel: null, timeoutMs: 2000 }),
      chat: createArkChat(async (_url, init) => {
        const body = JSON.parse(init.body) as { messages: unknown[] };
        expect(body.messages).toHaveLength(2);
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "明天开会。" }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 } }) };
      }),
    };
    const t = await createTestApp({}, undefined, { dictationPolishDeps: deps });
    try {
      const cookie = await t.loginCookie();
      const res = await t.app.inject({ method: "POST", url: "/api/me/dictation/polish", headers: { cookie, origin: t.publicOrigin }, payload: { text: "嗯明天那个开会" } });
      expect(res.json()).toEqual({ text: "明天开会。", polished: true });
      // 已经干净的句子不调用模型，也不留轨迹
      await t.app.inject({ method: "POST", url: "/api/me/dictation/polish", headers: { cookie, origin: t.publicOrigin }, payload: { text: "明天开会。" } });
      await settle();
      const runs = fake.runs();
      const roots = runs.filter((run) => !run.parent_run_id);
      expect(roots).toHaveLength(1);
      expect(roots[0].name).toMatch(/^turn:dict-[0-9a-f]{8}#a1$/);
      const [agent] = childrenOf(runs, roots[0]);
      expect(agent.name).toBe("agent:dictation-polish");
      const [model] = childrenOf(runs, agent);
      expect(model).toMatchObject({ name: "model:ark/polish-model", run_type: "llm" });
      expect(model.extra.metadata).toMatchObject({ ls_provider: "ark", ls_model_name: "polish-model" });
      expect(model.outputs.usage_metadata).toEqual({ input_tokens: 40, output_tokens: 5, total_tokens: 45 });
      expect(model.events ?? []).toEqual([]);
      expectWhitelistedMetadata([...fake.creates, ...fake.updates]);
      expect(JSON.stringify([...fake.creates, ...fake.updates])).not.toContain("ark-key");
    } finally {
      await t.close();
    }
  });
});
