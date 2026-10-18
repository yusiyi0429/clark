import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import type { ConversationRuntimeEvent } from "../src/conversations.js";
import {
  ESCALATION, THOUGHT_TRANSLATE_PROMPT, cleanThought, createEscalationWatch, createResponsesThoughtTranslator, escalationNotice, escalationSeconds, TIER_GUIDANCE,
  latestSummaryHeading, routeTurn, thinkingHeadline, toolResultDetail, type ThoughtTranslator,
} from "../src/conversationRouting.js";
import { createFakeWebSearchAdapter, testEnv } from "./helpers.js";

/**
 * 分段输出（spec 2026-10-13-model-routing.md §5.1）：① 开场 → ② 查证进度（系统生成）与思考状态 → ③ 正文 → ④ 选项块。
 * 任何一档都不该让一号位干等、不知道系统在做什么。
 */
const CEO_VIEWER = { personId: "person-fixture-001", displayName: "测试甲", role: "ceo" as const };
const FORBIDDEN = /王总|您好|领导|演示|本场|场次|(?<![A-Za-z])demo(?![A-Za-z])/i;
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content, usage, stopReason, timestamp: Date.now() };
}

/** 一次模型调用：先思考（可带推理摘要），再调工具或写正文；delayMs 模拟思考耗时。 */
function modelCall(options: { summary?: string; tool?: { id: string; name: string; arguments: Record<string, unknown> }; text?: string; delayMs?: number }): AssistantMessageEventStream {
  const thinking = { type: "thinking" as const, thinking: options.summary ?? "" };
  const tail = options.tool ? { type: "toolCall" as const, ...options.tool } : { type: "text" as const, text: options.text ?? "" };
  const final = message([thinking, tail], options.tool ? "toolUse" : "stop");
  const events = createAssistantMessageEventStream();
  void (async () => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    events.push({ type: "thinking_start", contentIndex: 0, partial: final });
    if (options.summary) events.push({ type: "thinking_delta", contentIndex: 0, delta: options.summary, partial: final });
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    events.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: final });
    if (tail.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: 1, partial: final });
      events.push({ type: "toolcall_end", contentIndex: 1, toolCall: tail, partial: final });
      events.push({ type: "done", reason: "toolUse", message: final });
    } else {
      events.push({ type: "text_start", contentIndex: 1, partial: final });
      events.push({ type: "text_delta", contentIndex: 1, delta: tail.text, partial: final });
      events.push({ type: "text_end", contentIndex: 1, content: tail.text, partial: final });
      events.push({ type: "done", reason: "stop", message: final });
    }
  })();
  return events;
}

const SEARCH_RESULT = { title: "硅基流动完成新一轮融资", url: "https://example.com/siliconflow", publishedAt: "2026-09-01T00:00:00.000Z", excerpt: "融资消息。", provider: "fake-search" };

async function runTurn(options: { message: string; calls: Parameters<typeof modelCall>[0][]; triageTier?: "quick" | "grounded" | "deep"; topic?: string; escalateAfterMs?: number;
  translateThought?: ThoughtTranslator }) {
  let call = 0;
  const runtime = await createPiConversationRuntime({
    companyMemory: loadCompanyMemory(testEnv),
    baseUrl: "https://provider.invalid/v1/responses",
    apiKey: "test-key",
    modelId: "fake-light",
    search: createFakeWebSearchAdapter({ "硅基流动 融资": [SEARCH_RESULT] }),
    triage: options.triageTier ? async () => ({ tier: options.triageTier!, ...(options.topic ? { topic: options.topic } : {}) }) : undefined,
    escalateAfterMs: options.escalateAfterMs,
    translateThought: options.translateThought,
    streamSimple: () => modelCall(options.calls[Math.min(call++, options.calls.length - 1)]),
  });
  const events: ConversationRuntimeEvent[] = [];
  try {
    const result = await runtime.run({
      scope: "global", viewer: CEO_VIEWER, message: options.message, currentObject: null, referencesSnapshot: [], runtimeEntries: [],
      piSessionId: "11111111-1111-4111-8111-111111111111", signal: signal(), emit: (event) => events.push(event),
    });
    return { events: events.filter((event) => event.type !== "usage"), result };
  } finally {
    await runtime.close?.();
  }
}

/** 事件顺序的简写：route:grounded、thinking、tool:started、tool:completed、message、escalation。 */
const shape = (events: ConversationRuntimeEvent[]) => events.map((event) =>
  event.type === "route" ? `route:${event.tier}` : event.type === "tool" ? `tool:${event.phase}` : event.type).filter((item, index, all) => item !== "message" || all[index - 1] !== "message");

describe("各档的分段事件顺序", () => {
  it("检索问答档：思考 → 查证（开始在查什么、结束读到了什么）→ 思考 → 正文，没有开场白", async () => {
    const { events, result } = await runTurn({
      message: "硅基流动最近一次融资是什么时候、融了多少？", triageTier: "grounded", topic: "硅基流动最近一次融资",
      calls: [{ tool: { id: "s1", name: "web_search", arguments: { query: "硅基流动 融资" } } }, { text: "九月完成新一轮融资。" }],
    });
    expect(shape(events)).toEqual(["route:grounded", "thinking", "tool:started", "tool:completed", "thinking", "message"]);
    const route = events[0] as Extract<ConversationRuntimeEvent, { type: "route" }>;
    // 检索问答档不加开场白：回答直接给结论。
    expect(route.notice).toBeUndefined();
    const [started, completed] = events.filter((event) => event.type === "tool") as Extract<ConversationRuntimeEvent, { type: "tool" }>[];
    expect(started.label).toBe("检索公开来源「硅基流动 融资」");
    expect(completed.detail).toBe("「硅基流动 融资」找到 1 条公开来源，如《硅基流动完成新一轮融资》");
    // 回答就是正文，开头没有「先查……」。
    expect(result.assistantMessage).toBe("九月完成新一轮融资。");
    expect(events.some((event) => event.type === "escalation")).toBe(false);
  });

  it("快答档：没有开场说明，思考状态后直接出正文", async () => {
    const { events, result } = await runTurn({ message: "谢谢", calls: [{ text: "不客气。" }] });
    expect(shape(events)).toEqual(["route:quick", "thinking", "message"]);
    expect((events[0] as { notice?: string }).notice).toBeUndefined();
    expect(result.assistantMessage).toBe("不客气。");
  });

  it("深度档：开场说明带预计用时，查证进度照常；不做中途升级提示", async () => {
    const { events } = await runTurn({
      message: "硅基流动和无问芯穹都已经递表了，为什么还要连续大额融资？背后的逻辑是什么？", triageTier: "deep", topic: "资本动作背后的逻辑", escalateAfterMs: 1,
      calls: [{ tool: { id: "s1", name: "web_search", arguments: { query: "硅基流动 融资" } }, delayMs: 20 }, { text: "判断如下。", delayMs: 20 }],
    });
    expect(shape(events)).toEqual(["route:deep", "thinking", "tool:started", "tool:completed", "thinking", "message"]);
    expect((events[0] as { notice?: string }).notice).toMatch(/需要更深入地查证和推演。$/);
    expect((events[0] as { notice?: string }).notice).not.toMatch(/预计|分钟/);
  });

  it("推理摘要：中文要点随思考事件带上；英文摘要不上屏，只报状态", async () => {
    const chinese = await runTurn({ message: "谢谢", calls: [{ summary: "**核对两家递表时间**\n\n先看公告。", text: "好的。" }] });
    expect(chinese.events.find((event) => event.type === "thinking" && event.summary)).toMatchObject({ summary: "核对两家递表时间" });
    const english = await runTurn({ message: "谢谢", calls: [{ summary: "**Explaining pre-IPO rounds**\n\nI need to provide a clear answer.", text: "好的。" }] });
    const thinking = english.events.filter((event) => event.type === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.every((event) => !("summary" in event) || event.summary === undefined)).toBe(true);
  });
});

describe("英文推理摘要的回退", () => {
  const ENGLISH = "**Explaining pre-IPO rounds**\n\nI need to provide a clear answer.";

  it("配了快模型翻译：英文小标题译成一句中文要点，在正文之前随思考事件下发", async () => {
    const asked: string[] = [];
    const { events } = await runTurn({ message: "谢谢", translateThought: async (heading) => { asked.push(heading); return "梳理上市前融资的逻辑。"; },
      calls: [{ summary: ENGLISH, text: "好的。", delayMs: 30 }] });
    expect(asked).toEqual(["Explaining pre-IPO rounds"]);
    const thought = events.findIndex((event) => event.type === "thinking" && event.summary === "梳理上市前融资的逻辑");
    expect(thought).toBeGreaterThan(-1);
    expect(thought).toBeLessThan(events.findIndex((event) => event.type === "message"));
  });

  it("翻译失败、译文不合规、或正文已经开始：不显示要点，只保留思考状态", async () => {
    for (const translateThought of [async () => null, async () => { throw new Error("gateway 500"); }, async () => "王总关心的问题", async () => "Explaining"] as ThoughtTranslator[]) {
      const { events } = await runTurn({ message: "谢谢", translateThought, calls: [{ summary: ENGLISH, text: "好的。", delayMs: 20 }] });
      expect(events.some((event) => event.type === "thinking")).toBe(true);
      expect(events.filter((event) => event.type === "thinking" && event.summary)).toEqual([]);
    }
    const late = await runTurn({ message: "谢谢", translateThought: () => new Promise((resolve) => setTimeout(() => resolve("梳理融资逻辑"), 40)),
      calls: [{ summary: ENGLISH, text: "好的。" }] });
    expect(late.events.filter((event) => event.type === "thinking" && event.summary)).toEqual([]);
  });

  it("翻译请求：快模型、关思考、只发小标题，key 只在请求头", async () => {
    const seen: { body: Record<string, unknown>; auth: string | null }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seen.push({ body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return new Response('data: {"type":"response.output_text.delta","delta":"梳理融资逻辑"}\n\n', { status: 200 });
    }) as unknown as typeof fetch;
    const translate = createResponsesThoughtTranslator({ baseUrl: "https://gateway.test/v2/llm", apiKey: "test-key", modelId: "fast-model", fetch: fakeFetch });
    expect(await translate("Explaining pre-IPO rounds", signal())).toBe("梳理融资逻辑");
    expect(seen[0].body).toMatchObject({ model: "fast-model", reasoning: { effort: "none" }, instructions: THOUGHT_TRANSLATE_PROMPT, input: [{ role: "user", content: "Explaining pre-IPO rounds" }] });
    expect(JSON.stringify(seen[0].body)).not.toContain("test-key");
    expect(seen[0].auth).toBe("Bearer test-key");
  });

  it("小标题与译文的清洗", () => {
    expect(latestSummaryHeading("**A first**\n\ntext **Second step**\n\nmore")).toBe("Second step");
    expect(latestSummaryHeading("**unfinished")).toBeUndefined();
    expect(cleanThought("「评估 CoreWeave 与 Nebius 的定位」。")).toBe("评估 CoreWeave 与 Nebius 的定位");
    expect(cleanThought("澄清用户的问题")).toBeUndefined();
    expect(cleanThought("OK")).toBeUndefined();
  });
});

describe("中途升级提示", () => {
  it("非深度档迟迟不出正文：提示「需要更深入的分析，预计还需约 X 秒」，只提示一次，在正文之前", async () => {
    const { events } = await runTurn({
      message: "Fireworks 和 Together 的产品和定价有什么区别？", triageTier: "grounded", escalateAfterMs: 5,
      calls: [{ text: "区别如下。", delayMs: 60 }],
    });
    const escalations = events.filter((event) => event.type === "escalation");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ type: "escalation", reason: "slow" });
    expect((escalations[0] as { notice: string }).notice).toMatch(/^这个问题需要更深入的分析，预计还需约 \d+ 秒。$/);
    expect(shape(events).indexOf("escalation")).toBeLessThan(shape(events).indexOf("message"));
  });

  it("模型连续多轮检索：检索问答档第 3 轮检索时提示", () => {
    const fired: unknown[] = [];
    const watch = createEscalationWatch({ tier: "grounded", timeoutMs: 120_000, startedAt: Date.now(), afterMs: 60_000, onEscalate: (event) => fired.push(event) });
    watch.assistantToolCalls(["web_search", "web_search", "web_search"]);
    watch.assistantToolCalls(["get_warmap_overview"]);
    expect(fired).toHaveLength(0);
    watch.assistantToolCalls(["search_sections"]);
    expect(fired).toHaveLength(0);
    watch.assistantToolCalls(["get_passages"]);
    expect(fired).toEqual([expect.objectContaining({ reason: "retrieval" })]);
    watch.assistantToolCalls(["web_search"]);
    expect(fired).toHaveLength(1);
    watch.dispose();
  });

  it("正文开始后、深度档、结束后都不再提示", () => {
    vi.useFakeTimers();
    const fired: unknown[] = [];
    const onEscalate = (event: unknown) => fired.push(event);
    const started = createEscalationWatch({ tier: "grounded", timeoutMs: 120_000, startedAt: Date.now(), onEscalate });
    started.textStarted();
    const deep = createEscalationWatch({ tier: "deep", timeoutMs: 150_000, startedAt: Date.now(), onEscalate });
    deep.assistantToolCalls(["web_search"]); deep.assistantToolCalls(["web_search"]); deep.assistantToolCalls(["web_search"]);
    const disposed = createEscalationWatch({ tier: "quick", timeoutMs: 90_000, startedAt: Date.now(), onEscalate });
    disposed.dispose();
    vi.advanceTimersByTime(ESCALATION.afterMs + 1_000);
    expect(fired).toHaveLength(0);
    const slow = createEscalationWatch({ tier: "quick", timeoutMs: 90_000, startedAt: Date.now(), onEscalate });
    vi.advanceTimersByTime(ESCALATION.afterMs);
    expect(fired).toEqual([expect.objectContaining({ reason: "slow", expectSeconds: 20 })]);
    slow.dispose();
  });

  it("预计秒数：按升级后的整轮估计减已用时间，取整到 10 秒，不少于 20 秒，不超过时限剩余", () => {
    expect(escalationSeconds("grounded", 20_000, 120_000)).toBe(20);
    expect(escalationSeconds("grounded", 8_000, 120_000)).toBe(40);
    expect(escalationSeconds("grounded", 70_000, 120_000)).toBe(20);
    expect(escalationSeconds("quick", 20_000, 90_000)).toBe(20);
    expect(escalationSeconds("grounded", 100_000, 120_000)).toBe(15);
  });

  it("提示措辞正式克制：不称呼、不出现运行环境字眼", () => {
    for (const text of [escalationNotice(40)]) expect(text).not.toMatch(FORBIDDEN);
  });
});

describe("检索问答档没有开场白", () => {
  it("分诊给了对象、失败、给了不合规的对象，检索问答档都不在回答开头加「先查企业知识」这类话；快答档也没有", async () => {
    const withTopic = await routeTurn({ message: "Fireworks 和 Together 的定价有什么区别？", signal: signal(), triage: async () => ({ tier: "grounded", topic: "Fireworks与Together的定价" }) });
    expect(withTopic).toMatchObject({ tier: "grounded", source: "model" });
    expect(withTopic.notice).toBeUndefined();
    const fallback = await routeTurn({ message: "Fireworks 和 Together 的定价有什么区别？", signal: signal(), triage: async () => { throw new Error("gateway 500"); } });
    expect(fallback).toMatchObject({ tier: "grounded", source: "fallback" });
    expect(fallback.notice).toBeUndefined();
    const bad = await routeTurn({ message: "Fireworks 和 Together 的定价有什么区别？", signal: signal(), triage: async () => ({ tier: "grounded", topic: "王总关心的定价" }) });
    expect(bad.notice).toBeUndefined();
    expect(TIER_GUIDANCE.grounded).toContain("不写开场白");
    expect((await routeTurn({ message: "好的", signal: signal() })).notice).toBeUndefined();
    // 没配分诊（没有网关的环境）：只按规则分档，检索问答档不加开场句，回答与原来一致。
    expect(await routeTurn({ message: "Fireworks 和 Together 的定价有什么区别？", signal: signal() })).toMatchObject({ tier: "grounded", source: "fallback" });
    expect((await routeTurn({ message: "Fireworks 和 Together 的定价有什么区别？", signal: signal() })).notice).toBeUndefined();
  });
});

describe("查证进度与思考要点（系统生成）", () => {
  it("按工具结果写这一步读到了什么", () => {
    expect(toolResultDetail("web_search", { query: "硅基流动 融资" }, { details: { results: [] } })).toBe("「硅基流动 融资」没有找到公开结果");
    // 看不懂的外文标题跳过，取第一个中文或拉丁字母标题。
    expect(toolResultDetail("web_search", { query: "Fireworks pricing" }, { details: { results: [{ title: "قیمت گذاری را درک" }, { title: "Fireworks AI 定价说明" }] } }))
      .toBe("「Fireworks pricing」找到 2 条公开来源，如《Fireworks AI 定价说明》");
    expect(toolResultDetail("get_passages", { sectionId: "a.md#s1" }, { content: [{ type: "text", text: JSON.stringify({ section: { id: "a.md#s1", title: "集团经营上下文" }, passages: [] }) }], details: {} }))
      .toBe("已读企业知识《集团经营上下文》");
    expect(toolResultDetail("search_sections", { query: "融资" }, { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "资本动作" }, { title: "赛道" }, { title: "资本动作" }] }) }] }))
      .toBe("企业知识里找到 3 处相关：《资本动作》《赛道》");
    expect(toolResultDetail("list_pending_issues", {}, { details: { issues: [{}, {}] } })).toBe("待决策议题 2 项");
    expect(toolResultDetail("get_passages", {}, { content: [{ type: "text", text: "不是 JSON" }] })).toBeUndefined();
    expect(toolResultDetail("edit_material", {}, { details: { ok: true } })).toBeUndefined();
  });

  it("推理摘要只取中文要点；英文、称呼、空内容都不上屏", () => {
    expect(thinkingHeadline("**核对两家递表时间**\n\n先看公告。**比较现金消耗**\n\n")).toBe("比较现金消耗");
    expect(thinkingHeadline("**Explaining pre-IPO rounds**\n\nI need to answer.")).toBeUndefined();
    expect(thinkingHeadline("**王总关心的问题**")).toBeUndefined();
    expect(thinkingHeadline("")).toBeUndefined();
  });
});
