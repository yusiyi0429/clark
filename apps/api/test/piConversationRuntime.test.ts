import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import type { ConversationRuntime } from "../src/conversations.js";
import type { Pool } from "pg";
import { createFakeWebSearchAdapter, createTestApp, testEnv } from "./helpers.js";
import { createObjectMaterial, getObjectMaterialDetail, readObjectMaterial } from "../src/objectMaterials.js";
import { createMaterialAnnotationAgent } from "../src/materialAnnotationAgent.js";

const CEO_VIEWER = { personId: "person-fixture-001", displayName: "测试甲", role: "ceo" as const };
const MEMBER_VIEWER = { personId: "person-fixture-002", displayName: "测试乙", role: "member" as const };
const COLLABORATOR = { personId: "person-fixture-003", displayName: "测试丙", role: "member" as const };
const PEOPLE = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));

const usage = {
  input: 4,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  messageUsage = usage,
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "warmap",
    model: "fake-light",
    content,
    usage: messageUsage,
    stopReason,
    timestamp: Date.now(),
  };
}

function stream(final: AssistantMessage) {
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

describe("controlled Pi conversation adapter public behavior", () => {
  it("classifies provider content_filter without retrying or reporting a saved answer", async () => {
    let calls = 0;
    const runtime = await createPiConversationRuntime({ companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      streamSimple: () => {
        calls++;
        const filtered = { ...message([{ type: "text", text: "I'm sorry, but I cannot assist with that request." }], "error"), errorMessage: "Response incomplete: content_filter" };
        const events = createAssistantMessageEventStream();
        queueMicrotask(() => { events.push({ type: "error", reason: "error", error: filtered }); });
        return events;
      } });
    try {
      await expect(runtime.run({ scope: "signal:11111111-1111-4111-8111-111111111111", viewer: CEO_VIEWER, message: "概括核心观点",
        currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal,
        emit: () => undefined })).rejects.toMatchObject({ code: "CONTENT_FILTER", message: "Response incomplete: content_filter" });
      expect(calls).toBe(1);
    } finally { await runtime.close?.(); }
  });
  it("材料提议工具拒绝非唯一 find，唯一修改只生成本人的 pending 提议", async () => {
    const t = await createTestApp();
    const issue = await t.createIssue();
    const ref = { objectType: "issue" as const, objectId: issue.objectRef.id };
    const made = await createObjectMaterial(t.pool, ref, CEO_VIEWER, "讨论材料", "今天开会。今天复盘。", "起草", null);
    let calls = 0;
    const results: string[] = [];
    const runtime = await createPiConversationRuntime({ companyMemory: loadCompanyMemory(testEnv), materialPool: t.pool,
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      streamSimple: (_model, context) => {
        calls++;
        expect(context.systemPrompt).toContain("不确定是否共识就不提议");
        if (calls > 1) results.push(JSON.stringify(context.messages.findLast((item) => item.role === "toolResult")));
        if (calls <= 2) return stream(message([{ type: "toolCall", id: `proposal-${calls}`, name: "propose_material_edit",
          arguments: { materialId: made.id, summary: "改开会日期", edits: [{ find: calls === 1 ? "今天" : "今天开会。", replace: "明天开会。" }] } }], "toolUse"));
        return stream(message([{ type: "text", text: "已提议" }], "stop"));
      } });
    try {
      await runtime.run({ scope: `issue:${ref.objectId}`, viewer: CEO_VIEWER, message: "同意这个改法", currentObject: { viewingMaterial: { id: made.id } },
        referencesSnapshot: [], runtimeEntries: [], piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal, emit: () => undefined });
      expect(results[0]).toContain("MATERIAL_FIND_NOT_UNIQUE");
      expect(results[1]).toContain("已在左侧材料上方提议");
      const detail = await getObjectMaterialDetail(t.pool.query.bind(t.pool), ref, made.id, CEO_VIEWER, new Map());
      expect(detail.version).toBe(1);
      expect(detail.proposals).toHaveLength(1);
      expect(detail.proposals[0]).toMatchObject({ status: "pending", proposedFor: { personId: CEO_VIEWER.personId }, changes: [{ before: "今天开会。", after: "明天开会。" }] });
    } finally { await runtime.close?.(); await t.close(); }
  }, 20_000);

  it("批注 Agent 使用 heavy 与严格输出工具，输入含最新版和定位信息", async () => {
    const t = await createTestApp();
    let modelId: string | undefined;
    const agent = createMaterialAnnotationAgent({ baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-heavy",
      streamSimple: (model, context) => {
        modelId = model.id;
        expect(context.tools?.map((tool) => tool.name)).toEqual(["submit_candidate"]);
        expect(context.tools?.[0].parameters).toMatchObject({ additionalProperties: false,
          properties: { edits: { items: { additionalProperties: false } } } });
        expect(context.systemPrompt).toContain("不加外链脚本");
        expect(JSON.stringify(context.messages)).toContain("今天开会");
        return stream(message([{ type: "toolCall", id: "annotation-output", name: "submit_candidate", arguments: {
          edits: [{ find: "今天", replace: "明天" }], summary: "改日期", noChange: null,
        } }], "toolUse"));
      } });
    try {
      const result = await agent.generate({ materialId: "fixture-material", objectType: "issue", objectId: "fixture-issue", title: "讨论日期",
        format: "markdown", source: "今天开会。", version: 2, quote: "今天", prefix: "", suffix: "开会。", body: "改为明天",
        author: CEO_VIEWER, previousError: null }, new AbortController().signal, t.pool.query.bind(t.pool));
      expect(modelId).toBe("fake-heavy");
      expect(result.candidate).toMatchObject({ edits: [{ find: "今天", replace: "明天" }], noChange: null });
      expect((await t.sql("SELECT kind,model_slot,status FROM agent_runs WHERE id=$1", [result.runId]))[0])
        .toMatchObject({ kind: "material-annotation", model_slot: "heavy", status: "succeeded" });
    } finally { await t.close(); }
  }, 20_000);

  it("only offers material tools in issue, task and meeting scopes", async () => {
    const toolsByScope: string[][] = [];
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv), materialPool: { query: async () => ({ rows: [] }) } as unknown as Pool,
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      streamSimple: (_model, context) => {
        toolsByScope.push(context.tools?.map((tool) => tool.name) ?? []);
        return stream(message([{ type: "text", text: "已读" }], "stop"));
      },
    });
    try {
      for (const scope of ["global", "issue:fixture-001", "task:fixture-001", "meeting:fixture-001", "monthly-review-item:fixture-001"] as const)
        // 带「写进」：有写入意图的轮次才带 create_material（没有修改意图时不带直接写入的工具，见 conversationPrompt.ts）。
        await runtime.run({ scope, viewer: CEO_VIEWER, message: "看看材料，需要的话写进一份新材料", currentObject: null, referencesSnapshot: [],
          runtimeEntries: [], piSessionId: "11111111-1111-4111-8111-111111111111", signal: new AbortController().signal,
          emit: () => undefined });
      expect(toolsByScope[0]).not.toContain("edit_material");
      // 这里没有本人能改的材料，所以不给 edit_material（能不能改见下一条）。
      for (const names of [toolsByScope[1], toolsByScope[2], toolsByScope[3]]) {
        expect(names).toEqual(expect.arrayContaining(["list_materials", "read_material", "create_material", "propose_material_edit"]));
        expect(names).not.toContain("edit_material");
      }
      expect(toolsByScope[0]).not.toContain("propose_material_edit");
      expect(toolsByScope[4]).not.toContain("propose_material_edit");
      // 复盘项对话只多一个改写建议工具，不带材料工具
      expect(toolsByScope[4]).toContain("propose_review_edit");
      expect(toolsByScope[4]).not.toContain("edit_material");
      expect(toolsByScope.slice(0, 4).flat()).not.toContain("propose_review_edit");
    } finally { await runtime.close?.(); }
  });
  it("不能改这份材料的人拿不到 edit_material，对话里的修改提议交给上传者；能改的人照旧直接改", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE });
    const ref = { objectType: "task" as const, objectId: randomUUID() };
    await t.sql("INSERT INTO tasks(id,title,status,owner_id,created_by) VALUES($1,'材料走查','not_started',$2,$2)", [ref.objectId, MEMBER_VIEWER.personId]);
    await t.sql("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('task',$1,$2,$2),('task',$1,$3,$2)",
      [ref.objectId, MEMBER_VIEWER.personId, COLLABORATOR.personId]);
    const made = await createObjectMaterial(t.pool, ref, MEMBER_VIEWER, "方案", "今天开会。", "起草", null);
    const tools: string[][] = [];
    let calls = 0, toolResult = "";
    const runtime = await createPiConversationRuntime({ companyMemory: loadCompanyMemory(t.env), materialPool: t.pool,
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      streamSimple: (_model, context) => {
        calls++;
        tools.push(context.tools?.map((tool) => tool.name) ?? []);
        expect(context.systemPrompt).toContain("canEdit=false 或没有 edit_material 时不直接改");
        if (calls === 2) toolResult = JSON.stringify(context.messages.at(-1));
        return stream(calls === 1 ? message([{ type: "toolCall", id: "proposal", name: "propose_material_edit",
          arguments: { materialId: made.id, summary: "改开会日期", edits: [{ find: "今天", replace: "明天" }] } }], "toolUse")
          : message([{ type: "text", text: "好" }], "stop"));
      } });
    const turn = (viewer: typeof MEMBER_VIEWER) => runtime.run({ scope: `task:${ref.objectId}`, viewer, message: "把开会改到明天",
      currentObject: { viewingMaterial: { id: made.id } }, referencesSnapshot: [], runtimeEntries: [],
      piSessionId: "11111111-1111-4111-8111-111111111111", signal: new AbortController().signal, emit: () => undefined });
    try {
      await turn(COLLABORATOR);
      expect(tools[0]).toEqual(expect.arrayContaining(["list_materials", "read_material", "create_material", "propose_material_edit"]));
      expect(tools[0]).not.toContain("edit_material");
      expect(toolResult).toContain("已交给测试乙");
      expect(await t.sql("SELECT proposed_by,proposed_for,status FROM material_edit_proposals WHERE material_id=$1", [made.id]))
        .toEqual([{ proposed_by: COLLABORATOR.personId, proposed_for: MEMBER_VIEWER.personId, status: "pending" }]);
      const q = t.pool.query.bind(t.pool), names = new Map<string, string>();
      expect((await readObjectMaterial(q, ref, made.id, COLLABORATOR)).version).toBe(1);
      expect((await getObjectMaterialDetail(q, ref, made.id, MEMBER_VIEWER, names)).proposals).toHaveLength(1);
      expect((await getObjectMaterialDetail(q, ref, made.id, COLLABORATOR, names)).proposals).toEqual([]);
      await turn(MEMBER_VIEWER);
      expect(tools[2]).toContain("edit_material");
    } finally { await runtime.close?.(); await t.close(); }
  }, 20_000);

  it("does not call the model when the public abort signal is already aborted", async () => {
    let modelCalls = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple: () => {
        modelCalls += 1;
        return stream(message([{ type: "text", text: "must not run" }], "stop"));
      },
    });
    const abort = new AbortController();
    abort.abort(new Error("stopped before start"));
    try {
      await expect(runtime.run({
        scope: "global",
        viewer: CEO_VIEWER,
        message: "不要开始",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: abort.signal,
        emit: () => undefined,
      })).rejects.toThrow("Conversation aborted");
      expect(modelCalls).toBe(0);
    } finally {
      await runtime.close?.();
    }
  });

  it("makes Search available but does not call it when internal context is sufficient", async () => {
    const contexts: Context[] = [];
    const search = createFakeWebSearchAdapter({});
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (_model, context) => {
        contexts.push(context);
        return stream(message([{ type: "text", text: "[内部证据] 当前对象已经足够。" }], "stop"));
      },
    });
    try {
      const result = await runtime.run({
        scope: "issue:fixture-001",
        viewer: CEO_VIEWER,
        message: "总结当前对象",
        currentObject: null,
        referencesSnapshot: [],
        recentMessages: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
        checkpoint: async () => undefined,
      });
      expect(result.assistantMessage).toContain("内部证据");
      expect(contexts[0].tools?.map((tool) => tool.name)).toContain("web_search");
      expect(search.calls).toEqual([]);
    } finally {
      await runtime.close?.();
    }
  });

  it("searches once for missing current facts and stops when evidence is sufficient", async () => {
    const search = createFakeWebSearchAdapter({
      "月球供应链最新公告": [{
        title: "供应链公告",
        url: "https://example.com/latest",
        publishedAt: "2025-09-15T00:00:00.000Z",
        excerpt: "合作方今天公布新窗口。",
        provider: "fake-search",
      }],
    });
    let turn = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (_model, context) => {
        turn += 1;
        if (turn === 1) return stream(message([{
          type: "toolCall", id: "search-1", name: "web_search", arguments: { query: "月球供应链最新公告" },
        }], "toolUse"));
        const evidence = JSON.stringify(context.messages.findLast((item) => item.role === "toolResult"));
        return stream(message([{ type: "text", text: evidence.includes("合作方今天公布新窗口")
          ? "[外部证据] 公告显示新窗口。\n[推断] 需要重新比较时点。"
          : "missing evidence" }], "stop"));
      },
    });
    try {
      const result = await runtime.run({
        scope: "global",
        viewer: CEO_VIEWER,
        message: "最新窗口是什么？",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(result.assistantMessage).toContain("[外部证据]");
      expect(result.assistantMessage).toContain("[推断]");
      expect(search.calls).toEqual([{ query: "月球供应链最新公告" }]);
    } finally {
      await runtime.close?.();
    }
  });

  // 检索到上限时不让整轮作废：第 8 次照常返回结果并说明额度已用完，之后的检索不执行、退回提示，模型据已有材料作答。
  it("returns the eighth Search with a limit notice, refuses further Searches without running them, and still answers", async () => {
    const search = createFakeWebSearchAdapter({
      loop: [{ title: "外部条目", url: "https://example.com/a", publishedAt: "2025-09-15T00:00:00.000Z", excerpt: "摘要", provider: "fake-search" }],
    });
    const contexts: Context[] = [];
    let modelCalls = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (_model, context) => {
        contexts.push({ ...context, messages: [...context.messages] });
        modelCalls += 1;
        // 前 9 次都检索（第 9 次无视提示），之后作答。
        if (modelCalls <= 9) return stream(message([{
          type: "toolCall", id: `search-${modelCalls}`, name: "web_search", arguments: { query: "loop" },
        }], "toolUse"));
        const toolTexts = context.messages.filter((item) => item.role === "toolResult").map((item) => JSON.stringify(item));
        return stream(message([{ type: "text", text: toolTexts.some((item) => item.includes("检索已到上限"))
          ? "本轮检索已到上限，以下基于已检索到的材料作答。" : "没有看到上限提示" }], "stop"));
      },
    });
    try {
      const events: unknown[] = [];
      const result = await runtime.run({
        scope: "global",
        viewer: CEO_VIEWER,
        message: "loop",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      });
      expect(result.assistantMessage).toBe("本轮检索已到上限，以下基于已检索到的材料作答。");
      expect(search.calls).toHaveLength(8);
      const toolResults = contexts.at(-1)!.messages.filter((item) => item.role === "toolResult") as { isError: boolean; content: { type: string; text?: string }[] }[];
      expect(toolResults).toHaveLength(9);
      const eighth = JSON.parse(toolResults[7].content[0].text!);
      expect(eighth.results).toHaveLength(1);
      expect(eighth.notice).toContain("检索已到上限");
      expect(toolResults[8].isError).toBe(true);
      expect(toolResults[8].content[0].text).toContain("检索已到上限");
      expect(toolResults[8].content[0].text).toContain("说明");
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool", phase: "completed", name: "web_search", isError: true })]));
    } finally {
      await runtime.close?.();
    }
  });

  it("still terminates an abnormal loop that keeps calling Search after the limit, without switching models", async () => {
    const search = createFakeWebSearchAdapter({ loop: [] });
    let modelCalls = 0;
    const seenModels: string[] = [];
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (model) => {
        seenModels.push(model.id);
        modelCalls += 1;
        if (modelCalls > 30) throw new Error("unbounded search loop");
        return stream(message([{
          type: "toolCall", id: `search-${modelCalls}`, name: "web_search", arguments: { query: "loop" },
        }], "toolUse"));
      },
    });
    try {
      await expect(runtime.run({
        scope: "global",
        viewer: CEO_VIEWER,
        message: "loop",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      })).rejects.toMatchObject({ code: "SEARCH_BUDGET_EXHAUSTED" });
      expect(search.calls).toHaveLength(8);
      expect(modelCalls).toBeLessThanOrEqual(17);
      expect(seenModels).toEqual(Array(seenModels.length).fill("fake-light"));
    } finally {
      await runtime.close?.();
    }
  });

  // 压缩只在后台做（conversationCompaction.ts）：pi 的自动压缩（轮前、两次工具之间、轮末）全部关掉，一号位不再干等。
  it("never compacts inside a turn, even when a tool round pushes the context past the model window", async () => {
    const search = createFakeWebSearchAdapter({ latest: [] });
    const highUsage = { ...usage, input: 120_000, totalTokens: 120_002 };
    const events: unknown[] = [];
    const checkpoints: unknown[][] = [];
    let regularCalls = 0;
    let summaryCalls = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      search,
      streamSimple: (_model, context) => {
        if (context.systemPrompt.includes("context summarization assistant")) {
          summaryCalls += 1;
          return stream(message([{ type: "text", text: "自动压缩摘要" }], "stop"));
        }
        regularCalls += 1;
        if (regularCalls === 3) return stream(message([{
          type: "toolCall", id: "search-auto", name: "web_search", arguments: { query: "latest" },
        }], "toolUse", highUsage));
        return stream(message(
          [{ type: "text", text: `regular-${regularCalls}` }],
          "stop",
          regularCalls >= 3 ? highUsage : usage,
        ));
      },
    });
    const turn = (text: string, entries: unknown[], piSessionId?: string | null, emit: (event: unknown) => void = () => undefined) => runtime.run({
      scope: "global",
      viewer: CEO_VIEWER,
      message: text,
      currentObject: null,
      referencesSnapshot: [],
      runtimeEntries: JSON.parse(JSON.stringify(entries)),
      piSessionId: piSessionId ?? "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
      emit,
      checkpoint: async (saved) => { checkpoints.push(saved); },
    });
    try {
      const history = await turn("历史上下文".repeat(30_000), []);
      const middle = await turn("近期上下文".repeat(30_000), history.runtimeEntries, history.piSessionId);
      const last = await turn("查询当前事实", middle.runtimeEntries, middle.piSessionId, (event) => events.push(event));
      const after = await turn("再问一句", last.runtimeEntries, last.piSessionId, (event) => events.push(event));
      expect(after.assistantMessage).toMatch(/^regular-/);
      expect(summaryCalls).toBe(0);
      expect(checkpoints).toEqual([]);
      expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "compaction" })]));
      expect(JSON.stringify(after.runtimeEntries)).not.toContain('"type":"compaction"');
      // 原始历史都还在（后台压缩之前不丢任何东西）。
      expect(JSON.stringify(after.runtimeEntries)).toContain("历史上下文历史上下文");
    } finally {
      await runtime.close?.();
    }
  });

  it("JSON round-trips entries; a turn over the hard threshold answers from a window without the compaction slot and keeps the full history", async () => {
    const contexts: Context[] = [];
    let lightTurns = 0;
    let compactionCalls = 0;
    const highUsage = { ...usage, input: 120_000, totalTokens: 120_002 };
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      compactionModelId: "fake-compaction",
      streamSimple: (model, context) => {
        if (model.id === "fake-compaction") {
          compactionCalls += 1;
          return stream(message([{ type: "text", text: "旧讨论的压缩摘要" }], "stop"));
        }
        lightTurns += 1;
        contexts.push(context);
        return stream(message([{ type: "text", text: `light-${lightTurns}` }], "stop"));
      },
    });
    const turn = (text: string, entries: unknown[], piSessionId?: string | null) => runtime.run({
      scope: "global", viewer: CEO_VIEWER, message: text, currentObject: null, referencesSnapshot: [],
      runtimeEntries: entries, piSessionId: piSessionId ?? "11111111-1111-4111-8111-111111111111", signal: new AbortController().signal, emit: () => undefined,
    });
    try {
      const first = await turn("旧上下文".repeat(30_000), []);
      const middle = await turn("仍需保留的近期上下文".repeat(10_000), JSON.parse(JSON.stringify(first.runtimeEntries)), first.piSessionId);
      const roundTripped = JSON.parse(JSON.stringify(middle.runtimeEntries));
      const latestAssistant = roundTripped.findLast((entry: { type?: string; message?: { role?: string; usage?: unknown } }) =>
        entry.type === "message" && entry.message?.role === "assistant");
      latestAssistant.message.usage = highUsage;
      const second = await turn("继续", roundTripped, middle.piSessionId);
      expect(second.assistantMessage).toBe("light-3");
      expect(compactionCalls).toBe(0);
      // 这一轮交给模型的是窗口：此前各轮只有截短的原话，不带完整的旧上下文。
      const sent = JSON.stringify(contexts.at(-1)!.messages);
      expect(sent).not.toContain("旧上下文".repeat(2_000));
      expect(sent).toContain("继续");
      // 存下来的历史完整（后台压缩之前不丢），并记下这一轮走过窗口。
      expect(JSON.stringify(second.runtimeEntries)).toContain("旧上下文".repeat(2_000));
      expect(JSON.stringify(second.runtimeEntries)).toContain("warmap.history-window");
    } finally {
      await runtime.close?.();
    }
  });

  // 10/13 压缩死锁：会话最后一条是压缩记录、之前那条助手用量仍是压缩前的大数；拿它判断会每轮再压一次。
  // 现在一轮里不压缩，压缩记录之后按字数估算历史长度，下一轮照常回答。
  it("does not use a usage recorded before the latest compaction; the next turns answer normally without compaction calls", async () => {
    const highUsage = { ...usage, input: 120_000, totalTokens: 120_002 };
    let compactionCalls = 0;
    let regularCalls = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      compactionModelId: "fake-compaction",
      streamSimple: (model, context) => {
        if (model.id === "fake-compaction" || context.systemPrompt.includes("context summarization assistant")) {
          compactionCalls += 1;
          return stream(message([{ type: "text", text: "压缩摘要" }], "stop"));
        }
        regularCalls += 1;
        return stream(message([{ type: "text", text: `regular-${regularCalls}` }], "stop", highUsage));
      },
    });
    const turn = (text: string, entries: unknown[], piSessionId?: string | null, emit: (event: unknown) => void = () => undefined) => runtime.run({
      scope: "global",
      viewer: CEO_VIEWER,
      message: text,
      currentObject: null,
      referencesSnapshot: [],
      runtimeEntries: JSON.parse(JSON.stringify(entries)),
      piSessionId: piSessionId ?? "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
      emit,
    });
    try {
      const first = await turn("历史上下文", []);
      // 与 10/13 卡死的那段对话形状相同：以压缩记录结尾，之前的用量是大数。
      const sessionId = first.piSessionId ?? "11111111-1111-4111-8111-111111111111";
      const manager = SessionManager.inMemory(process.cwd(), { id: sessionId }, structuredClone(first.runtimeEntries) as Parameters<typeof SessionManager.inMemory>[2]);
      const kept = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
      manager.appendCompaction("压缩摘要", kept.id, 120_002);
      const events: unknown[] = [];
      const third = await turn("继续", [manager.getHeader(), ...manager.getEntries()], sessionId, (event) => events.push(event));
      expect(third.assistantMessage).toBe(`regular-${regularCalls}`);
      expect(compactionCalls).toBe(0);
      expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "compaction" })]));
      // 压缩记录之后没有窗口标记：按字数估算，历史很短。
      expect(JSON.stringify(third.runtimeEntries)).not.toContain("warmap.history-window");
      const fourth = await turn("再继续", third.runtimeEntries, third.piSessionId);
      expect(fourth.assistantMessage).toBe(`regular-${regularCalls}`);
    } finally {
      await runtime.close?.();
    }
  });


  it("continues the turn when a pre-turn compaction has nothing to compact, and the conversation recovers", async () => {
    const highUsage = { ...usage, input: 120_000, totalTokens: 120_002 };
    let regularCalls = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      compactionModelId: "fake-compaction",
      streamSimple: (model) => {
        if (model.id === "fake-compaction") return stream(message([{ type: "text", text: "不应调用" }], "stop"));
        regularCalls += 1;
        return stream(message([{ type: "text", text: `regular-${regularCalls}` }], "stop"));
      },
    });
    const turn = (text: string, entries: unknown[], piSessionId?: string | null) => runtime.run({
      scope: "global",
      viewer: CEO_VIEWER,
      message: text,
      currentObject: null,
      referencesSnapshot: [],
      runtimeEntries: JSON.parse(JSON.stringify(entries)),
      piSessionId: piSessionId ?? "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    try {
      const first = await turn("短问题", []);
      // 用量记录很大、实际历史很短：压缩找不到可压的内容。修复前整轮在这里失败。
      const entries = JSON.parse(JSON.stringify(first.runtimeEntries));
      entries.findLast((entry: { type?: string; message?: { role?: string } }) => entry.type === "message" && entry.message?.role === "assistant").message.usage = highUsage;
      const second = await turn("继续", entries, first.piSessionId);
      expect(second.assistantMessage).toBe("regular-2");
      const third = await turn("再继续", second.runtimeEntries, second.piSessionId);
      expect(third.assistantMessage).toBe("regular-3");
    } finally {
      await runtime.close?.();
    }
  });

  it("rebuilds corrupted entries from recent raw messages and reports the public recovery result", async () => {
    const contexts: Context[] = [];
    const emitted: unknown[] = [];
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple: (_model, context) => {
        contexts.push(context);
        return stream(message([{ type: "text", text: "recovered" }], "stop"));
      },
    });
    try {
      const result = await runtime.run({
        scope: "issue:fixture-001",
        viewer: CEO_VIEWER,
        message: "继续",
        currentObject: null,
        referencesSnapshot: [],
        recentMessages: [
          { role: "user", content: "原始问题", createdAt: "2025-09-15T00:00:00.000Z" },
          { role: "assistant", content: "原始回答", createdAt: "2025-09-15T00:00:01.000Z" },
        ],
        runtimeEntries: [{ broken: true }],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: (event) => emitted.push(event),
      });
      expect(result.recovery).toMatchObject({ recreated: true, warning: expect.stringContaining("corrupted") });
      expect(result.piSessionId).not.toBe("11111111-1111-4111-8111-111111111111");
      expect(emitted).toContainEqual(expect.objectContaining({ type: "warning", code: "RUNTIME_RECREATED" }));
      expect(JSON.stringify(contexts[0].messages)).toContain("原始问题");
      expect(JSON.parse(JSON.stringify(result.runtimeEntries))).toEqual(result.runtimeEntries);
    } finally {
      await runtime.close?.();
    }
  });

  it("三层取用的工具每个页面都有；转议题只在 CEO 首页；带过来的那段首页对话接进模型历史", async () => {
    const contexts: Context[] = [];
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      streamSimple: (_model, context) => { contexts.push(context); return stream(message([{ type: "text", text: "好" }], "stop")); },
    });
    const companyMap = { readMissionCards: async () => ({}), readProgress: async () => ({}), readReviews: async () => ({}), readObjectTree: async () => ({}) } as never;
    const issueSuggest = { propose: async () => ({}), readIssueConversation: async () => ({}) };
    const base = { currentObject: null, referencesSnapshot: [], runtimeEntries: [], signal: new AbortController().signal, emit: () => undefined };
    const tools = (index: number) => (contexts[index].tools ?? []).map((tool) => tool.name);
    const anchor = (scene: string, range: string) => ({ view: { scene, period: "2026-10", range, summary: "当前可见", items: [], more: false }, focus: null,
      ref: { scene, focus: null, items: [] }, read: async () => ({}), refOf: () => undefined, readRef: async () => ({}) });
    try {
      await runtime.run({ ...base, scope: "global", viewer: CEO_VIEWER, message: "渠道预算转不转", piSessionId: randomUUID(), companyMap, issueSuggest,
        anchor: anchor("公司首页", "全员 · 10 月"), issueContext: { issueThreads: [], declinedIssueTopics: ["渠道预算"] } });
      expect(tools(0)).toEqual(expect.arrayContaining(["read_mission_cards", "read_progress", "read_reviews", "read_object_tree", "propose_issue", "read_issue_conversation"]));
      expect(contexts[0].systemPrompt).toContain("# 三层取用");
      expect(contexts[0].systemPrompt).toContain("# 深聊转议题");
      expect(JSON.stringify(contexts[0].messages)).toContain("declinedIssueTopics");
      expect(tools(0)).toContain("read_anchor");
      expect(JSON.stringify(contexts[0].messages)).toContain("全员 · 10 月");

      await runtime.run({ ...base, scope: "task:11111111-1111-4111-8111-111111111111", viewer: MEMBER_VIEWER, message: "别人进展怎样", piSessionId: randomUUID(), companyMap,
        anchor: anchor("执行事项详情", "我 · 10 月"), scopeOverride: { people: "all", from: "2026-09", to: "2026-10" } });
      expect(tools(1)).toEqual(expect.arrayContaining(["read_mission_cards", "read_progress", "read_reviews", "read_object_tree"]));
      expect(tools(1)).not.toContain("propose_issue");
      expect(contexts[1].systemPrompt).not.toContain("# 深聊转议题");
      expect(JSON.stringify(contexts[1].messages)).toContain("scopeOverride");

      await runtime.run({ ...base, scope: "issue:fixture-001", viewer: CEO_VIEWER, message: "接着说", piSessionId: randomUUID(),
        carriedOver: [{ role: "user", content: "首页里问的渠道预算", createdAt: "2026-10-18T01:00:00.000Z" }, { role: "assistant", content: "首页里的回答", createdAt: "2026-10-18T01:00:05.000Z" }] });
      const history = JSON.stringify(contexts[2].messages);
      expect(history).toContain("首页里问的渠道预算");
      expect(history.indexOf("首页里的回答")).toBeLessThan(history.indexOf("接着说"));
    } finally {
      await runtime.close?.();
    }
  });

  it("loads no user/coding resources, exposes only read-only CompanyMemory tools, and restores entries", async () => {
    const contexts: Context[] = [];
    const streamSimple = (_model: Model<any>, context: Context) => {
      contexts.push(context);
      if (contexts.length === 1) {
        return stream(message([
          { type: "toolCall", id: "call-1", name: "search_people", arguments: { query: "测试甲" } },
        ], "toolUse"));
      }
      const toolResult = context.messages.findLast((item) => item.role === "toolResult");
      const text = JSON.stringify(toolResult).includes("person-fixture-001") ? "MCP OK" : "MCP missing";
      return stream(message([{ type: "text", text }], "stop"));
    };

    const runtimeOptions = {
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple,
    };
    const runtime = await createPiConversationRuntime(runtimeOptions);
    let runtimeClosed = false;
    let restoredRuntime: ConversationRuntime | undefined;
    try {
      const emitted: unknown[] = [];
      const first = await runtime.run({
        scope: "issue:fixture-001",
        viewer: CEO_VIEWER,
        message: "负责人是谁？",
        currentObject: {
          cardId: "issue:fixture-001",
          version: 1,
          kind: "issue",
          title: "月球基地供应链选择",
          objectRef: { type: "issue", id: "fixture-001", version: 1 },
          payload: { summary: "供应链" },
        },
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: (event) => emitted.push(event),
      });

      expect(first.assistantMessage).toBe("MCP OK");
      expect(first.runtimeEntries.length).toBeGreaterThan(0);
      // 「负责人是谁」是快答：快答档不带外部检索（conversationPrompt.ts）。
      expect(contexts[0].tools?.map((tool) => tool.name).sort()).toEqual([
        "get_passages", "list_sections", "search_people", "search_sections",
      ]);
      expect(contexts[0].tools?.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
      expect(contexts[0].systemPrompt).toContain("不能执行任何业务写入");
      expect(JSON.stringify(contexts[0].messages)).toContain("月球基地供应链选择");
      expect(emitted).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool", phase: "started", name: "search_people" }),
        expect.objectContaining({ type: "tool", phase: "completed", name: "search_people", isError: false }),
        expect.objectContaining({ type: "message", delta: "MCP OK" }),
        expect.objectContaining({ type: "usage", totalTokens: 6 }),
      ]));

      await runtime.close?.();
      runtimeClosed = true;
      restoredRuntime = await createPiConversationRuntime(runtimeOptions);
      const restored = await restoredRuntime.run({
        scope: "issue:fixture-001",
        viewer: CEO_VIEWER,
        message: "继续",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: first.runtimeEntries,
        piSessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(restored.runtimeEntries.length).toBeGreaterThan(first.runtimeEntries.length);
      expect(JSON.stringify(contexts.at(-1)?.messages)).toContain("MCP OK");
    } finally {
      if (!runtimeClosed) await runtime.close?.();
      await restoredRuntime?.close?.();
    }
  });

  it("exposes the configured publisher feed as a one-shot read-only tool", async () => {
    const contexts: Context[] = [];
    let reads = 0;
    const streamSimple = (_model: Model<any>, context: Context) => {
      contexts.push(context);
      if (contexts.length === 1) {
        return stream(message([{ type: "toolCall", id: "outlet-1", name: "read_outlet_feed", arguments: {} }], "toolUse"));
      }
      const text = JSON.stringify(context.messages).includes("Treasury basis trade") ? "OUTLET OK" : "OUTLET missing";
      return stream(message([{ type: "text", text }], "stop"));
    };
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple,
      outletFeed: async () => {
        reads += 1;
        return [{
          sourceType: "outlet" as const,
          title: "Treasury basis trade",
          url: "https://www.bloomberg.com/news/articles/example",
          publishedAt: "2026-09-18T00:00:00.000Z",
          excerpt: "Treasury basis trade overview",
          sourceRef: { type: "outlet" as const, provider: "publisher-feed" as const, outletId: "bloomberg", outletName: "彭博" },
        }];
      },
    });
    try {
      const result = await runtime.run({
        scope: "global",
        viewer: CEO_VIEWER,
        message: "彭博最近如何报道？",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "33333333-3333-4333-8333-333333333333",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(result.assistantMessage).toBe("OUTLET OK");
      expect(reads).toBe(1);
      expect(contexts[0].tools?.map((tool) => tool.name)).toContain("read_outlet_feed");
      expect(contexts[0].systemPrompt).toContain("不得用 web_search 的 site: 语法冒充发布方来源");
    } finally {
      await runtime.close?.();
    }
  });

  it("exposes list_pending_issues only when configured and returns live board data", async () => {
    const contexts: Context[] = [];
    const streamSimple = (_model: Model<any>, context: Context) => {
      contexts.push(context);
      if (contexts.length === 1) {
        return stream(message([
          { type: "toolCall", id: "board-1", name: "list_pending_issues", arguments: {} },
        ], "toolUse"));
      }
      const toolResult = context.messages.findLast((item) => item.role === "toolResult");
      const text = JSON.stringify(toolResult).includes("月球基地供应链选择") ? "BOARD OK" : "BOARD missing";
      return stream(message([{ type: "text", text }], "stop"));
    };
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple,
      listPendingIssues: async () => [{
        id: "issue-1",
        title: "月球基地供应链选择",
        location: { level: "battlefield", battlefieldId: "growth" },
        urgency: "red",
        researchStatus: "ready",
        createdAt: "2026-09-16T00:00:00.000Z",
      }],
    });
    try {
      const result = await runtime.run({
        scope: "global",
        viewer: CEO_VIEWER,
        message: "现在公司有哪些战略议题？",
        currentObject: null,
        referencesSnapshot: [],
        runtimeEntries: [],
        piSessionId: "22222222-2222-4222-8222-222222222222",
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(result.assistantMessage).toBe("BOARD OK");
      expect(contexts[0].tools?.map((tool) => tool.name)).toContain("list_pending_issues");
      expect(contexts[0].systemPrompt).toContain("list_pending_issues");
    } finally {
      await runtime.close?.();
    }
  });

  it("gives a member the DRI Agent: no CEO decision tools, no global context, own identity", async () => {
    const contexts: Context[] = [];
    let globalContextReads = 0;
    const runtime = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-light",
      streamSimple: (_model, context) => {
        contexts.push(context);
        return stream(message([{ type: "text", text: "ok" }], "stop"));
      },
      globalContext: async () => {
        globalContextReads += 1;
        return { period: "2026-09" };
      },
      listMissions: async () => [],
      listPendingIssues: async () => [],
    });
    const userPrompt = (context: Context) => {
      const user = context.messages.findLast((item) => item.role === "user")!;
      const text = typeof user.content === "string"
        ? user.content
        : user.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      return JSON.parse(text) as { globalContext: unknown };
    };
    const turn = (viewer: typeof CEO_VIEWER | typeof MEMBER_VIEWER, piSessionId: string) => runtime.run({
      scope: "global",
      viewer,
      message: "现在该关注什么？",
      currentObject: null,
      referencesSnapshot: [],
      runtimeEntries: [],
      piSessionId,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    try {
      await turn(MEMBER_VIEWER, "44444444-4444-4444-8444-444444444444");
      const memberTools = contexts[0].tools?.map((tool) => tool.name) ?? [];
      expect(memberTools).toContain("list_missions");
      expect(memberTools).not.toContain("get_warmap_overview");
      expect(memberTools).not.toContain("list_pending_issues");
      expect(userPrompt(contexts[0]).globalContext).toBeNull();
      expect(globalContextReads).toBe(0);
      expect(contexts[0].systemPrompt).toContain("测试乙 的 DRI Agent");
      expect(contexts[0].systemPrompt).toContain("企业知识");
      expect(contexts[0].systemPrompt).toContain("不能执行任何业务写入");
      expect(contexts[0].systemPrompt).not.toContain("CEO WarMap 的只读决策对话助手");
      expect(contexts[0].systemPrompt).not.toContain("get_warmap_overview");
      expect(contexts[0].systemPrompt).not.toContain("list_pending_issues");

      // 同一个 runtime 上 CEO 的一轮不受影响
      await turn(CEO_VIEWER, "55555555-5555-4555-8555-555555555555");
      const ceoTools = contexts[1].tools?.map((tool) => tool.name) ?? [];
      expect(ceoTools).toEqual(expect.arrayContaining(["get_warmap_overview", "list_missions", "list_pending_issues"]));
      expect(userPrompt(contexts[1]).globalContext).toEqual({ period: "2026-09" });
      expect(contexts[1].systemPrompt).toContain("你是天枢里 CEO 的 Agent，负责只读决策对话");
    } finally {
      await runtime.close?.();
    }
  });
});
