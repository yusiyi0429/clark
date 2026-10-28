import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { segmentDateLabel, startsNewSegment } from "../src/conversationSegments.js";
import { createConversationDigests, recordChatSegment } from "../src/conversationDigests.js";
import { createConversationRecall, type ConversationCatalog } from "../src/conversationRecall.js";

const HOUR = 60 * 60 * 1000;
const bj = (text: string) => new Date(`${text}+08:00`);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

type RunInput = Parameters<ConversationRuntime["run"]>[0];
/** 假运行时：记下每一轮的输入；回答「答：<问题>」，模型历史每轮追加一条。 */
function recordingRuntime(): ConversationRuntime & { inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  return {
    inputs,
    async run(input) {
      inputs.push(input);
      const answer = `答：${input.message}`;
      input.emit({ type: "message", delta: answer });
      return { assistantMessage: answer, runtimeEntries: [...input.runtimeEntries, { turn: input.message }] };
    },
  };
}

/** 假纪要模型：标题写页面，正文写这次交来的第一句（增量时带上已有纪要），记下每次交来的输入。 */
function digestModel() {
  const inputs: { page: string; earlierDigest: string; messages: { role: string; text: string }[] }[] = [];
  const stream = (_model: unknown, context: Context) => {
    const first = context.messages[0];
    const input = JSON.parse(typeof first.content === "string" ? first.content : (first.content[0] as { text: string }).text).input as (typeof inputs)[number];
    inputs.push(input);
    const digest = [input.earlierDigest, ...input.messages.map((message) => `- ${message.role === "user" ? "本人" : "天枢"}：${message.text}`)].filter(Boolean).join("\n");
    const call = { type: "toolCall" as const, id: randomUUID(), name: "submit_candidate", arguments: { title: `聊${input.page}`, digest, keywords: [input.page] } };
    const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "warmap", model: "test", content: [call], usage, stopReason: "toolUse", timestamp: Date.now() };
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => events.push({ type: "done", reason: "toolUse", message }));
    return events;
  };
  return { inputs, stream };
}

const digestsOf = (t: TestApp, model = digestModel(), chat?: Parameters<typeof createConversationDigests>[0]["chat"]) =>
  createConversationDigests({ pool: t.pool, chat, baseUrl: "https://provider.invalid/v1", apiKey: "test", modelId: "test-digest", streamSimple: model.stream as never });

const send = (t: TestApp, cookie: string, scope: string, message: string, extra: Record<string, unknown> = {}) => t.app.inject({
  method: "POST", url: `/api/conversations/${encodeURIComponent(scope)}/messages`,
  headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message, ...extra } });
const history = async (t: TestApp, cookie: string, scope: string) =>
  (await t.app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(scope)}/messages`, headers: { cookie } })).json() as { messages: { role: string; content: string; kind?: string }[] };
/** 把已有的发言往前挪（模拟过了一段时间）。 */
const shiftBack = (t: TestApp, ms: number) => t.sql("UPDATE conversation_messages SET created_at = created_at - make_interval(secs => $1)", [ms / 1000]);
/** 最近一次北京时间凌晨 4 点。 */
const lastFourAm = () => new Date(`${new Date(Date.now() + 4 * HOUR).toISOString().slice(0, 10)}T04:00:00+08:00`);

async function issuePage(t: TestApp) {
  return `issue:${(await t.createIssue()).objectRef.id}`;
}

describe("换段规则（北京时间）", () => {
  it("间隔短不换；闲置满 12 小时换；跨过凌晨 4 点换；凌晨 4 点前后的边界", () => {
    expect(startsNewSegment(bj("2026-10-28T10:00:00"), bj("2026-10-28T11:00:00"))).toBe(false);
    expect(startsNewSegment(bj("2026-10-27T23:30:00"), bj("2026-10-28T04:30:00"))).toBe(true);
    expect(startsNewSegment(bj("2026-10-28T03:59:00"), bj("2026-10-28T04:01:00"))).toBe(true);
    expect(startsNewSegment(bj("2026-10-28T04:01:00"), bj("2026-10-28T15:59:00"))).toBe(false);
    expect(startsNewSegment(bj("2026-10-28T04:30:00"), bj("2026-10-28T16:30:00"))).toBe(true);
    expect(startsNewSegment(bj("2026-10-28T00:30:00"), bj("2026-10-28T03:30:00"))).toBe(false);
    expect(segmentDateLabel(bj("2026-10-28T01:00:00"))).toBe("10月28日");
  });
});

describe("天枢页面分段（CONVERSATION_SEGMENTS，缺省开）", () => {
  it("同一段带着上一轮；闲置满 12 小时换段：模型侧开新会话、不带上一段原文，历史里一行日期，运行记录标 segmentStart", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const scope = await issuePage(t);
      await send(t, cookie, scope, "第一问");
      await send(t, cookie, scope, "第二问");
      expect(runtime.inputs[1].segmentStart).toBeUndefined();
      expect(runtime.inputs[1].recentMessages!.map((item) => item.content)).toEqual(["第一问", "答：第一问"]);

      await shiftBack(t, 12 * HOUR + 60_000);
      await send(t, cookie, scope, "隔天再问");
      const input = runtime.inputs[2];
      expect(input.segmentStart).toBe(true);
      expect(input.idleRestart).toBeUndefined();
      expect(input.recentMessages).toEqual([]);
      expect((await history(t, cookie, scope)).messages.map((item) => [item.role, item.content, item.kind ?? null])).toEqual([
        ["user", "第一问", null], ["assistant", "答：第一问", null], ["user", "第二问", null], ["assistant", "答：第二问", null],
        ["assistant", segmentDateLabel(new Date()), "trace"], ["user", "隔天再问", null], ["assistant", "答：隔天再问", null]]);
      const runs = await t.sql("SELECT input_snapshot FROM agent_runs WHERE kind = 'conversation' ORDER BY started_at");
      expect((runs.at(-1)!.input_snapshot as { segmentStart?: boolean }).segmentStart).toBe(true);

      await send(t, cookie, scope, "紧接着");
      expect(runtime.inputs[3].segmentStart).toBeUndefined();
      expect(runtime.inputs[3].recentMessages!.map((item) => item.content)).toEqual(["隔天再问", "答：隔天再问"]);
    } finally {
      await t.close();
    }
  });

  it("上一轮在今天凌晨 4 点之前（不到 12 小时）也换段", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      await send(t, cookie, "global", "凌晨前");
      await t.sql("UPDATE conversation_messages SET created_at = $1", [new Date(lastFourAm().getTime() - 60_000)]);
      await send(t, cookie, "global", "凌晨后");
      expect(runtime.inputs[1].segmentStart).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("换段后点「继续」：续写进原来那一段的模型会话，不换段、不插日期行", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const scope = await issuePage(t);
      await send(t, cookie, scope, "写长一点");
      const [run] = await t.sql("SELECT id FROM agent_runs WHERE kind = 'conversation'");
      await shiftBack(t, 13 * HOUR);
      await send(t, cookie, scope, "继续", { resumeRunId: run.id });
      const input = runtime.inputs[1];
      expect(input.segmentStart).toBeUndefined();
      expect(input.resume?.question).toBe("写长一点");
      expect(input.runtimeEntries).toEqual([{ turn: "写长一点" }]);
      expect((await history(t, cookie, scope)).messages.some((item) => item.kind === "trace")).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("开关关着：照旧闲置 12 小时重开（idleRestart），不插日期行，没有会话目录，照旧给原话检索", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({ conversationSegments: false }, runtime);
    try {
      const cookie = await t.loginCookie();
      await send(t, cookie, "global", "第一问");
      await shiftBack(t, 13 * HOUR);
      await send(t, cookie, "global", "隔天");
      const input = runtime.inputs[1];
      expect([input.idleRestart, input.segmentStart, input.pastConversations]).toEqual([true, undefined, undefined]);
      expect(typeof input.searchHistory).toBe("function");
      expect((await history(t, cookie, "global")).messages.some((item) => item.kind === "trace")).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("新段第一轮的会话目录：本页面上一段的完整纪要 + 近 14 天其他段；两个工具查得到、读得到原文；没聊过的如实说没有；没有旧段时目录为空", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const scope = await issuePage(t);
      await send(t, cookie, scope, "定价先按县城样板试");
      expect(runtime.inputs[0].pastConversations?.catalog).toBeNull();
      await send(t, cookie, "global", "首页聊招聘节奏");
      await shiftBack(t, 26 * HOUR);
      const model = digestModel();
      await digestsOf(t, model).runOnce();
      expect(model.inputs.map((input) => input.page).sort()).toEqual(["首页", expect.stringMatching(/^议题：/)].sort());

      await send(t, cookie, scope, "接着昨天的说");
      const input = runtime.inputs.at(-1)!;
      expect(input.segmentStart).toBe(true);
      const catalog = input.pastConversations!.catalog as ConversationCatalog;
      expect(catalog.previous).toMatchObject({ page: expect.stringMatching(/^议题：/), digest: expect.stringMatching(/^截至 .*\n- 本人：定价先按县城样板试/) });
      expect(catalog.recent).toEqual([expect.objectContaining({ page: "首页", title: "聊首页" })]);

      const found = await input.pastConversations!.search({ query: "首页" }) as { segments: { segmentId: string; page: string }[] };
      expect(found.segments.map((item) => item.page)).toEqual(["首页"]);
      const digest = await input.pastConversations!.read({ segmentId: catalog.previous!.segmentId }) as { digest: string; rawCursor: string };
      expect(digest.digest).toContain("定价先按县城样板试");
      const raw = await input.pastConversations!.read({ segmentId: catalog.previous!.segmentId, cursor: digest.rawCursor }) as { messages: { who: string; text: string }[]; nextCursor: string | null };
      expect(raw.messages.map((item) => [item.who, item.text])).toEqual([["本人", "定价先按县城样板试"], ["天枢", "答：定价先按县城样板试"]]);
      expect(raw.nextCursor).toBeNull();
      // 纪要里没有、原话里也没有：如实说没找到。原话里有的退回按原话查。
      expect(await input.pastConversations!.search({ query: "火星殖民" })).toEqual({ segments: [], message: "本人以前的对话里没有找到相关内容。" });
      await send(t, cookie, "global", "预算上限再议");
      const byWords = await input.pastConversations!.search({ query: "预算上限" }) as { hits: { who: string; snippet: string; segmentId?: string; page?: string }[] };
      expect(byWords.hits).toContainEqual(expect.objectContaining({ who: "本人", snippet: "预算上限再议", segmentId: expect.any(String), page: "首页" }));
      expect(await input.pastConversations!.read({ segmentId: randomUUID() })).toMatchObject({ error: "SEGMENT_NOT_FOUND" });

      // 新人第一次对话：没有旧段，目录为空，对话照常。
      await send(t, await t.memberCookie(), "global", "第一次来");
      expect(runtime.inputs.at(-1)!.pastConversations?.catalog).toBeNull();
    } finally {
      await t.close();
    }
  });
});

describe("会话纪要（后台）", () => {
  it("最后一次发言过了 15 分钟才写；这段又有新话时增量更新；回答过程中不调纪要模型", async () => {
    let appDigestCalls = 0;
    const t = await createTestApp({}, recordingRuntime(), { conversationDigestStream: () => { appDigestCalls++; throw new Error("不该调用"); } });
    try {
      const cookie = await t.loginCookie();
      await send(t, cookie, "global", "第一问");
      expect(appDigestCalls).toBe(0);
      const model = digestModel();
      const digests = digestsOf(t, model);
      await digests.runOnce();
      expect(model.inputs).toEqual([]);
      expect(await t.sql("SELECT status, digest FROM conversation_digests")).toEqual([{ status: "stale", digest: "" }]);

      await shiftBack(t, 16 * 60_000);
      await digests.runOnce();
      const [first] = await t.sql("SELECT status, covered_to, digest, model FROM conversation_digests");
      expect(first).toMatchObject({ status: "ready", covered_to: "2", model: "test-digest" });
      expect(first.digest).toMatch(/^截至 \d+月\d+日 \d\d:\d\d\n- 本人：第一问\n- 天枢：答：第一问$/);

      await send(t, cookie, "global", "第二问");
      await digests.runOnce();
      expect(model.inputs).toHaveLength(1);
      expect((await t.sql("SELECT status FROM conversation_digests"))[0].status).toBe("stale");
      await shiftBack(t, 16 * 60_000);
      await digests.runOnce();
      expect(model.inputs[1].earlierDigest).toBe("- 本人：第一问\n- 天枢：答：第一问");
      expect(model.inputs[1].messages.map((item) => item.text)).toEqual(["第二问", "答：第二问"]);
      expect(await t.sql("SELECT status, covered_to FROM conversation_digests")).toEqual([{ status: "ready", covered_to: "4" }]);
      expect(appDigestCalls).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("原对话被隐藏的段标 hidden：目录里没有、查不到、读不到（天枢对话被删；Chat 段从本人的会话列表里消失）", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const scope = await issuePage(t);
      await send(t, cookie, scope, "议题里聊过的方案");
      await shiftBack(t, 26 * HOUR);
      const chatId = randomUUID();
      await recordChatSegment(t.pool.query.bind(t.pool), { personId: TEST_CEO.personId, role: "ceo" }, { conversationId: chatId, startedAt: new Date(Date.now() - 26 * HOUR) });
      await t.sql("UPDATE conversation_digests SET ended_at = now() - interval '25 hours' WHERE source = 'chat'");
      const chat = { conversations: async () => [], messagesPage: async () => ({ messages: [{ position: "1", role: "user" as const, text: "首页聊过的方案", runId: randomUUID() }], runs: [], nextCursor: null }) };
      const digests = digestsOf(t, digestModel(), chat);
      await digests.runOnce();
      expect((await t.sql("SELECT source, status FROM conversation_digests ORDER BY source"))).toEqual([{ source: "chat", status: "hidden" }, { source: "tianshu", status: "ready" }]);

      await t.sql("UPDATE conversations SET deleted_at = now() WHERE scope = $1", [scope]);
      await digests.runOnce();
      expect((await t.sql("SELECT status FROM conversation_digests WHERE source = 'tianshu'"))[0].status).toBe("hidden");
      const recall = createConversationRecall({ q: t.pool.query.bind(t.pool) });
      const viewer = { personId: TEST_CEO.personId, role: "ceo" as const };
      expect(await recall.homeCatalog(viewer)).toBeNull();
      expect(await recall.search(viewer, { query: "方案" })).toMatchObject({ segments: [], message: "本人以前的对话里没有找到相关内容。" });
      const [hidden] = await t.sql("SELECT id FROM conversation_digests WHERE source = 'tianshu'");
      expect(await recall.read(viewer, { segmentId: hidden.id as string })).toMatchObject({ error: "SEGMENT_NOT_FOUND" });
    } finally {
      await t.close();
    }
  });

  it("隔离：别人的查不到；首页 Chat 段按视角隔离；天枢页面的段本人两种视角都能查到", async () => {
    const t = await createTestApp({});
    try {
      const [page, ceoPage] = [randomUUID(), randomUUID()];
      await t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, 'issue:x', $3), ($4, $5, 'issue:x', $6)",
        [page, TEST_MEMBER.personId, randomUUID(), ceoPage, TEST_CEO.personId, randomUUID()]);
      const insert =(owner: string, role: string | null, source: string, ref: string, title: string) => t.sql(`INSERT INTO conversation_digests
          (id, owner_id, viewer_role, source, source_ref, scope, scope_label, started_at, ended_at, title, digest, keywords, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'global', '首页', now() - interval '30 hours', now() - interval '29 hours', $5, $5, '{}', 'ready')`, [owner, role, source, ref, title]);
      await insert(TEST_MEMBER.personId, "ceo", "chat", randomUUID(), "CEO 视角的首页段");
      await insert(TEST_MEMBER.personId, "member", "chat", randomUUID(), "成员视角的首页段");
      await insert(TEST_MEMBER.personId, null, "tianshu", page, "议题页的段");
      await insert(TEST_CEO.personId, null, "tianshu", ceoPage, "测试甲的段");
      const recall = createConversationRecall({ q: t.pool.query.bind(t.pool) });
      const titles = async (role: "ceo" | "member", personId: string = TEST_MEMBER.personId) =>
        ((await recall.search({ personId, role }, {})) as { segments?: { title: string }[] }).segments?.map((item) => item.title).sort() ?? [];
      expect(await titles("member")).toEqual(["成员视角的首页段", "议题页的段"].sort());
      expect(await titles("ceo")).toEqual(["CEO 视角的首页段", "议题页的段"].sort());
      expect(await titles("ceo", TEST_CEO.personId)).toEqual(["测试甲的段"]);
    } finally {
      await t.close();
    }
  });
});

describe("运行时（piConversationRuntime）", () => {
  it("分段时给两个回看工具、不给 search_conversation_history；目录只在发给模型的那条消息里；换段开新会话、不带上一段", async () => {
    const { createPiConversationRuntime } = await import("../src/piConversationRuntime.js");
    const { loadPeopleDirectory } = await import("../src/peopleDirectory.js");
    const { testEnv } = await import("./helpers.js");
    const contexts: Context[] = [];
    const runtime = await createPiConversationRuntime({ peopleDirectory: loadPeopleDirectory(testEnv), baseUrl: "https://provider.invalid/v1", apiKey: "test-key", modelId: "fake-light",
      streamSimple: (_model, context) => {
        contexts.push({ systemPrompt: context.systemPrompt, tools: context.tools?.map((tool) => ({ ...tool, execute: undefined })) as Context["tools"],
          messages: JSON.parse(JSON.stringify(context.messages)) });
        const message = { role: "assistant" as const, api: "openai-responses" as const, provider: "warmap", model: "fake-light", content: [{ type: "text" as const, text: "好的" }],
          stopReason: "stop" as const, usage, timestamp: Date.now() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message } as never));
        return stream;
      } });
    const base = { viewer: { personId: "alice", displayName: "甲", role: "ceo" as const }, scope: "global" as const, currentObject: null, referencesSnapshot: [],
      signal: new AbortController().signal, emit: () => {} };
    try {
      const first = await runtime.run({ ...base, message: "昨天的问题", runtimeEntries: [], piSessionId: randomUUID() });
      const catalog: ConversationCatalog = { previous: { segmentId: randomUUID(), date: "10月27日", page: "议题：渠道", title: "渠道", digest: "截至 10月27日 18:20\n- 本人确认先做县城样板" }, recent: [] };
      const second = await runtime.run({ ...base, message: "接着昨天的说", runtimeEntries: first.runtimeEntries, piSessionId: first.piSessionId!, segmentStart: true,
        pastConversations: { catalog, search: async () => ({ segments: [] }), read: async () => ({}) } });
      const context = contexts.at(-1)!;
      const tools = context.tools?.map((tool) => tool.name) ?? [];
      expect(tools).toEqual(expect.arrayContaining(["search_past_conversations", "read_past_conversation"]));
      expect(tools).not.toContain("search_conversation_history");
      expect(context.systemPrompt).toContain("# 以前的对话");
      expect(context.systemPrompt).not.toContain("search_conversation_history");
      const text = JSON.stringify(context.messages);
      expect(text).toContain("本人确认先做县城样板");
      expect(text).not.toContain("昨天的问题");
      expect(second.piSessionId).not.toBe(first.piSessionId);
      expect(JSON.stringify(second.runtimeEntries)).not.toContain("本人确认先做县城样板");
    } finally {
      await runtime.close?.();
    }
  });
});
