import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { GLOBAL_CONTEXT_UNCHANGED, SYSTEM_PROMPT, createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { ANSWER_OPTIONS_RULES, DECISION_JUDGEMENT_RULES } from "../src/decisionJudgement.js";
import { RICH_BLOCK_RULES } from "../src/richBlocks.js";
import type { ConversationRuntimeEvent } from "../src/conversations.js";
import { conversationModelDefinition, conversationTierModels } from "../src/conversationModel.js";
import { conversationStreamSimple, withoutForeignReasoning } from "../src/conversationStream.js";
import { createThinkingRelay } from "../src/conversationThinking.js";
import { DIRECT_WRITE_TOOLS, THINK_IN_CHINESE, tierSystemPrompt, toolAllowed } from "../src/conversationPrompt.js";
import { TIER_SETTINGS, cleanPrefetch, createResponsesTriage, hasWriteIntent, parsePartialTriage, parseTriage, routeTurn, type ThinkingTranslator } from "../src/conversationRouting.js";
import { createFakeWebSearchAdapter, testEnv } from "./helpers.js";

/**
 * 10/13 按档位选主答模型（快答 GPT、检索问答 Sonnet、深度 Opus）、Claude 思考摘要实时上屏、减负（按档位裁剪提示与工具、预取、检索结果瘦身）。
 */
const CEO_VIEWER = { personId: "person-fixture-001", displayName: "测试甲", role: "ceo" as const };
const TIERS = { quick: "gpt-5.6-sol", grounded: "claude-sonnet-5-5", deep: "claude-opus-5-5" };
const DEEP_Q = "请对集团 Token 工厂的竞争格局做一次深度分析";
const GROUNDED_Q = "硅基流动最近一次融资是什么时候？";
const QUICK_Q = "这周待决策的议题有几个";
const signal = () => new AbortController().signal;
const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

type Seen = { model: Model<any>; context: Context; options?: SimpleStreamOptions };
/** 一次模型调用：按请求的模型写出带思考块（签名按模型区分）和正文的消息；thinking 可以分几段到达。 */
function reply(model: Model<any>, parts: { thinking?: string[]; text?: string; tool?: { id: string; name: string; arguments: Record<string, unknown> } }): AssistantMessageEventStream {
  const thinkingText = (parts.thinking ?? []).join("");
  const thinking = { type: "thinking" as const, thinking: thinkingText, thinkingSignature: `sig-${model.id}` };
  const tail = parts.tool ? { type: "toolCall" as const, ...parts.tool } : { type: "text" as const, text: parts.text ?? "好" };
  const final: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [thinking, tail], usage,
    stopReason: parts.tool ? "toolUse" : "stop", timestamp: Date.now() };
  const events = createAssistantMessageEventStream();
  void (async () => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    events.push({ type: "thinking_start", contentIndex: 0, partial: final });
    for (const delta of parts.thinking ?? []) events.push({ type: "thinking_delta", contentIndex: 0, delta, partial: final });
    events.push({ type: "thinking_end", contentIndex: 0, content: thinkingText, partial: final });
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

const thinkingBlocks = (context: Context) => context.messages.flatMap((message) => (message.role === "assistant"
  ? message.content.filter((block) => block.type === "thinking").map((block) => ({ model: message.model, signature: (block as { thinkingSignature?: string }).thinkingSignature }))
  : []));
const lastUserText = (context: Context) => {
  const last = [...context.messages].reverse().find((message) => message.role === "user");
  if (typeof last?.content === "string") return last.content;
  return (last?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
};

async function conversation(options: { tierModels?: Partial<typeof TIERS>; translateThinking?: ThinkingTranslator; respond?: (seen: Seen, index: number) => AssistantMessageEventStream;
  triage?: Parameters<typeof createPiConversationRuntime>[0]["triage"]; search?: ReturnType<typeof createFakeWebSearchAdapter>; globalContext?: () => Promise<Record<string, unknown>> }) {
  const seen: Seen[] = [];
  const runtime = await createPiConversationRuntime({
    companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://gw.invalid/v2/llm/responses", apiKey: "test-key",
    modelId: TIERS.quick, tierModels: options.tierModels ?? TIERS, compactionModelId: "fake-compaction",
    translateThinking: options.translateThinking, triage: options.triage, search: options.search, globalContext: options.globalContext,
    streamSimple: (model, context, streamOptions) => {
      seen.push({ model, context, options: streamOptions });
      return options.respond ? options.respond(seen.at(-1)!, seen.length - 1) : reply(model, { thinking: [`${model.id} thought.`], text: `${model.id} 的回答` });
    },
  });
  let entries: unknown[] = [];
  const events: ConversationRuntimeEvent[] = [];
  const turn = async (message: string) => {
    const start = events.length;
    const result = await runtime.run({ scope: "global", viewer: CEO_VIEWER, message, currentObject: null, referencesSnapshot: [], runtimeEntries: entries,
      piSessionId: "33333333-3333-4333-8333-333333333333", signal: signal(), emit: (event) => events.push(event) });
    entries = result.runtimeEntries;
    return { result, events: events.slice(start) };
  };
  return { seen, turn, events, runtime, entries: () => entries };
}

describe("按档位选主答模型", () => {
  it("不配 CONVERSATION_MODEL 时三档都用 HEAVY_MODEL（不额外调用 Claude）；配一个 id 三档都用它；可以按档位写", () => {
    expect(conversationTierModels({ defaultModel: "gpt-5.6-sol" })).toEqual({ quick: "gpt-5.6-sol", grounded: "gpt-5.6-sol", deep: "gpt-5.6-sol" });
    expect(conversationTierModels({ defaultModel: "gpt-5.6-sol", conversationModel: "claude-sonnet-5-5" }))
      .toEqual({ quick: "claude-sonnet-5-5", grounded: "claude-sonnet-5-5", deep: "claude-sonnet-5-5" });
    expect(conversationTierModels({ defaultModel: "gpt-5.6-sol", conversationModel: "deep=claude-sonnet-5-5" }))
      .toEqual({ quick: "gpt-5.6-sol", grounded: "gpt-5.6-sol", deep: "claude-sonnet-5-5" });
    expect(() => conversationTierModels({ defaultModel: "x", conversationModel: "slow=claude-opus-5-5" })).toThrow(/CONVERSATION_MODEL/);
  });

  it("深度档的用时估计 180 秒（只用于升级提示，不截断）；Claude 声明 40 万上下文、GPT 12.8 万（一轮里不压缩，历史太长走窗口兜底）", () => {
    expect(TIER_SETTINGS.deep.timeoutMs).toBe(180_000);
    expect(conversationModelDefinition({ modelId: "claude-opus-5-5", baseUrl: "https://gw.invalid/v2/llm" }).contextWindow).toBe(400_000);
    expect(conversationModelDefinition({ modelId: "gpt-5.6-sol", baseUrl: "https://gw.invalid/v2/llm" }).contextWindow).toBe(128_000);
  });

  it("一段对话里各档用各自的模型；历史按目标模型过滤思考：别家模型的思考块不发，同一模型的带签名原样回传；缓存键按模型分开", async () => {
    const chat = await conversation({});
    try {
      const deep = await chat.turn(DEEP_Q);
      expect(deep.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "route", tier: "deep", model: "claude-opus-5-5" })]));
      await chat.turn(GROUNDED_Q);
      await chat.turn(QUICK_Q);
      await chat.turn(DEEP_Q);
      expect(chat.seen.map((item) => item.model.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gpt-5.6-sol", "claude-opus-5-5"]);
      expect(chat.seen.map((item) => item.model.api)).toEqual(["anthropic-messages", "anthropic-messages", "openai-responses", "anthropic-messages"]);
      // Sonnet 看不到 Opus 的思考；GPT 看不到任何 Claude 的思考；Opus 再次出场时只看到自己的。
      expect(thinkingBlocks(chat.seen[1].context)).toEqual([]);
      expect(thinkingBlocks(chat.seen[2].context)).toEqual([]);
      expect(thinkingBlocks(chat.seen[3].context)).toEqual([{ model: "claude-opus-5-5", signature: "sig-claude-opus-5-5" }]);
      // 别家模型的思考也没有被改写成一段普通文字塞回历史。
      expect(JSON.stringify(chat.seen[2].context.messages)).not.toContain("thought.");
      // 正文照常保留在历史里。
      expect(JSON.stringify(chat.seen[2].context.messages)).toContain("claude-sonnet-5-5 的回答");
      const keys = chat.seen.map((item) => item.options?.sessionId);
      expect(keys[0]).toBe("33333333-3333-4333-8333-333333333333:claude-opus-5-5");
      expect(keys[1]).toBe("33333333-3333-4333-8333-333333333333:claude-sonnet-5-5");
      // GPT：按模型 + 系统提示 + 工具取键，不同对话也能共用前缀缓存
      expect(keys[2]).toMatch(/^warmap:gpt-5\.6-sol:[0-9a-f]{16}$/);
      expect(keys[3]).toBe(keys[0]);
    } finally { await chat.runtime.close?.(); }
  });

  it("同一段对话里同档位的模型保持不变：配置后来改了，这段对话的检索问答档仍用第一次的模型", async () => {
    const first = await conversation({});
    let entries: unknown[];
    try {
      await first.turn(GROUNDED_Q);
      entries = first.entries();
    } finally { await first.runtime.close?.(); }
    const seen: string[] = [];
    const later = await createPiConversationRuntime({
      companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://gw.invalid/v2/llm/responses", apiKey: "test-key", modelId: TIERS.quick,
      tierModels: { quick: TIERS.quick, grounded: "claude-opus-5-5", deep: "claude-sonnet-5-5" }, compactionModelId: "fake-compaction",
      streamSimple: (model) => { seen.push(model.id); return reply(model, { text: "好" }); },
    });
    try {
      for (const message of [GROUNDED_Q, DEEP_Q]) {
        const result = await later.run({ scope: "global", viewer: CEO_VIEWER, message, currentObject: null, referencesSnapshot: [], runtimeEntries: entries,
          piSessionId: "33333333-3333-4333-8333-333333333333", signal: signal(), emit: () => undefined });
        entries = result.runtimeEntries;
      }
      // 检索问答档沿用这段对话第一次用的 Sonnet；深度档在这段对话里第一次出现，用新配置。
      expect(seen).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    } finally { await later.close?.(); }
  });
});

describe("Claude 的思考摘要实时上屏", () => {
  it("中文段落边到边下发；英文段落写完一段就译成中文，严格按原顺序；系统提示要求思考用中文", async () => {
    const translations: string[] = [];
    const translate: ThinkingTranslator = async (paragraph, _signal, onDelta) => {
      translations.push(paragraph);
      const text = paragraph.startsWith("Check") ? "先核对两家公司的递表时间" : "再比较两笔融资";
      onDelta(text.slice(0, 3));
      onDelta(text.slice(3));
      return text;
    };
    const chat = await conversation({
      translateThinking: translate,
      respond: ({ model }) => reply(model, { thinking: ["先看企业知识里有没有", "两家公司的资料。\n\n", "Check the filing ", "dates first.\n\n", "Then compare the two rounds."], text: "判断" }),
    });
    try {
      const { events, result } = await chat.turn(DEEP_Q);
      const deltas = events.filter((event): event is Extract<ConversationRuntimeEvent, { type: "thinking" }> => event.type === "thinking" && Boolean((event as { delta?: string }).delta))
        .map((event) => event.delta).join("");
      expect(deltas).toBe("先看企业知识里有没有两家公司的资料。\n\n先核对两家公司的递表时间\n\n再比较两笔融资");
      expect(translations).toEqual(["Check the filing dates first.", "Then compare the two rounds."]);
      // 思考不进正文，也不进对话记录。
      expect(result.assistantMessage).not.toContain("核对两家");
      expect(chat.seen[0].context.systemPrompt).toContain(THINK_IN_CHINESE);
    } finally { await chat.runtime.close?.(); }
  });

  it("没配翻译时英文段落不上屏，只有「正在思考」；GPT 档不走这条路", async () => {
    const chat = await conversation({ respond: ({ model }) => reply(model, { thinking: ["Check the filing dates first."], text: "判断" }) });
    try {
      const deep = await chat.turn(DEEP_Q);
      expect(deep.events.some((event) => event.type === "thinking" && "delta" in event && event.delta)).toBe(false);
      expect(deep.events.some((event) => event.type === "thinking")).toBe(true);
      const quick = await chat.turn(QUICK_Q);
      expect(quick.events.some((event) => event.type === "thinking" && "delta" in event && event.delta)).toBe(false);
      expect(chat.seen[1].context.systemPrompt).not.toContain(THINK_IN_CHINESE);
    } finally { await chat.runtime.close?.(); }
  });

  it("下发的思考去掉称呼与运行环境字眼（整段不上屏），「用户」写成「一号位」；本轮结束后迟到的译文不再下发", async () => {
    const out: string[] = [];
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const relay = createThinkingRelay({ signal: controller.signal, emit: (delta) => out.push(delta), translate: async (paragraph, _s, onDelta) => {
      if (paragraph.startsWith("Late")) { await new Promise<void>((resolve) => { release = resolve; }); onDelta("迟到的译文"); return "迟到的译文"; }
      return null;
    } });
    relay.push("用户问的是两家公司的融资节奏，C");
    relay.push("EO 关心上市时间。\n\n");
    relay.push("这是王总关心的事，需要仔细看。\n\n");
    relay.push("Unknown paragraph that fails.\n\n");
    relay.push("Late paragraph.");
    relay.endBlock();
    relay.close();
    release?.();
    await relay.idle();
    expect(out.join("")).toBe("一号位问的是两家公司的融资节奏，一号位 关心上市时间。");
  });
});

describe("减负：按档位裁剪系统提示与工具", () => {
  // 带全部按场景裁剪段落的完整提示（决策六节、图表块、选项块），用来核对裁剪本身。
  const FULL = [SYSTEM_PROMPT, DECISION_JUDGEMENT_RULES, RICH_BLOCK_RULES, ANSWER_OPTIONS_RULES].join("\n\n");
  const trimmed = (shape: Parameters<typeof tierSystemPrompt>[1]) => tierSystemPrompt(FULL, shape);

  it("快答去掉外部检索工具与条款、决策六节、图表块与选项块；可见措辞的约束各档都在", () => {
    const quick = trimmed({ tier: "quick", writeIntent: false, anthropic: false });
    const deep = trimmed({ tier: "deep", writeIntent: false, anthropic: true });
    const write = trimmed({ tier: "quick", writeIntent: true, anthropic: false });
    expect(quick).not.toContain("`web_search`：");
    expect(quick).not.toContain("web_search 直接返回来源标题");
    expect(quick).not.toContain("# 决策判断的结构");
    expect(quick).not.toContain("# 图表块与公式");
    expect(quick).not.toContain("# 回答末尾的选项块");
    expect(deep).toContain("# 决策判断的结构");
    expect(deep).toContain("web_search 直接返回来源标题");
    expect(deep.endsWith(THINK_IN_CHINESE)).toBe(true);
    for (const prompt of [quick, deep, write]) {
      expect(prompt).toContain("不用任何头衔或姓名称呼");
      expect(prompt).toContain("不用客套开场");
      expect(prompt).toContain("对一号位不使用 LTO、PO 缩写");
      expect(prompt).not.toMatch(/演示|本场|场次|(?<![A-Za-z_/-])demo(?![A-Za-z_-])/i);
    }
    // 只有原生提示时也能裁：快答去掉检索条款
    expect(tierSystemPrompt(SYSTEM_PROMPT, { tier: "quick", writeIntent: false, anthropic: false })).not.toContain("web_search 直接返回来源标题");
  });

  it("工具：快答不带外部检索；没有修改意图时不带直接写入的工具，提议类工具照常带", () => {
    expect(toolAllowed("web_search", { tier: "quick", writeIntent: true })).toBe(false);
    expect(toolAllowed("web_search", { tier: "grounded", writeIntent: false })).toBe(true);
    for (const name of DIRECT_WRITE_TOOLS) expect(toolAllowed(name, { tier: "deep", writeIntent: false })).toBe(false);
    expect(toolAllowed("edit_material", { tier: "deep", writeIntent: true })).toBe(true);
    expect(toolAllowed("propose_material_edit", { tier: "grounded", writeIntent: false })).toBe(true);
  });

  it("修改意图宁可多判：明确改法、批准确认卡的短答、决定都算；纯提问不算", () => {
    for (const text of ["把会议改到 11 点", "好的", "同意", "就按合同版执行", "选择：维持现状", "这个变成议题", "签发本月计划"]) expect(hasWriteIntent(text), text).toBe(true);
    for (const text of ["硅基流动最近一次融资是什么时候？", "这周待决策的议题有几个", "Fireworks AI 和 Together AI 的定价有什么不同？"]) expect(hasWriteIntent(text), text).toBe(false);
  });
});

describe("减负：预取、检索结果瘦身、全局摘要不重复", () => {
  const LONG = "长".repeat(1_200);
  const results = Array.from({ length: 20 }, (_, index) => ({ title: `硅基流动融资报道 ${index}`, url: `https://example.com/${index}`, excerpt: LONG, provider: "fake", imageUrl: "https://example.com/a.png" }));

  it("深度档分诊给了检索词：主答第一轮之前并行预取，结果放进第一轮上下文，进度照常显示，公开来源计入检索额度", async () => {
    const search = createFakeWebSearchAdapter({ "硅基流动 融资 2026": results });
    const chat = await conversation({ search, triage: async () => ({ tier: "deep", topic: "硅基流动融资背后的逻辑", web: ["硅基流动 融资 2026"], memory: ["词元云集"] }) });
    try {
      const { events } = await chat.turn(GROUNDED_Q);
      expect(search.calls.map((call) => call.query)).toEqual(["硅基流动 融资 2026"]);
      const prefetchEvents = events.filter((event) => event.type === "tool" && event.toolCallId.startsWith("prefetch-"));
      expect(prefetchEvents.map((event) => event.type === "tool" && `${event.name}:${event.phase}`).sort())
        .toEqual(["search_sections:completed", "search_sections:started", "web_search:completed", "web_search:started"]);
      const firstPrompt = JSON.parse(lastUserText(chat.seen[0].context));
      expect(firstPrompt.prefetched.web[0]).toMatchObject({ query: "硅基流动 融资 2026" });
      // 检索结果瘦身：最多 8 条、每条摘要 500 字、不带图片地址
      expect(firstPrompt.prefetched.web[0].results).toHaveLength(8);
      expect(firstPrompt.prefetched.web[0].results[0].excerpt.length).toBeLessThanOrEqual(501);
      expect(firstPrompt.prefetched.web[0].results[0]).not.toHaveProperty("imageUrl");
      expect(firstPrompt.prefetched.knowledge[0]).toMatchObject({ query: "词元云集" });
    } finally { await chat.runtime.close?.(); }
  });

  it("只有深度档预取：快答、检索问答都不预取；分诊检索词不合规的丢掉", async () => {
    const route = await routeTurn({ message: QUICK_Q, signal: signal(), triage: async () => ({ tier: "grounded", web: ["x"] }) });
    expect(route.prefetch).toBeUndefined();
    // 检索问答档即使分诊给了检索词也不预取（10/13 第二轮：分诊只在深度档给检索词，第一轮由主答自己查）。
    const grounded = await routeTurn({ message: GROUNDED_Q, signal: signal(), triage: async () => ({ tier: "grounded", topic: "硅基流动最近一次融资", web: ["硅基流动 融资 2026"] }) });
    expect(grounded.tier).toBe("grounded");
    expect(grounded.prefetch).toBeUndefined();
    const deep = await routeTurn({ message: GROUNDED_Q, signal: signal(), triage: async () => ({ tier: "deep", topic: "硅基流动融资背后的逻辑", web: ["硅基流动 融资 2026"] }) });
    expect(deep.prefetch).toEqual({ memory: [], web: ["硅基流动 融资 2026"] });
    expect(cleanPrefetch({ web: ["演示用的检索", "硅基流动 融资", "硅基流动 融资", "a"], memory: [] })).toEqual({ memory: [], web: ["硅基流动 融资"] });
    expect(parseTriage('{"tier":"grounded","topic":"融资","memory":["词元云集"],"web":["硅基流动 融资 2026"]}'))
      .toEqual({ tier: "grounded", topic: "融资", memory: ["词元云集"], web: ["硅基流动 融资 2026"] });
  });

  it("模型自己调 web_search 时结果同样瘦身", async () => {
    const search = createFakeWebSearchAdapter({ "硅基流动 融资": results });
    const chat = await conversation({ search, respond: ({ model }, index) => (index === 0
      ? reply(model, { tool: { id: "call-1", name: "web_search", arguments: { query: "硅基流动 融资" } } })
      : reply(model, { text: "好" })) });
    try {
      await chat.turn(GROUNDED_Q);
      const toolResult = chat.seen[1].context.messages.find((message) => message.role === "toolResult");
      const value = JSON.parse((toolResult?.content as { text: string }[])[0].text);
      expect(value.results).toHaveLength(8);
      expect(value.results[0].excerpt.length).toBeLessThanOrEqual(501);
    } finally { await chat.runtime.close?.(); }
  });

  it("首页全局摘要和上一轮一样时只写「同上一轮」，变了再给全文", async () => {
    let version = 1;
    const chat = await conversation({ globalContext: async () => ({ period: "2026-10", version }) });
    try {
      await chat.turn(GROUNDED_Q);
      await chat.turn(GROUNDED_Q);
      version = 2;
      await chat.turn(GROUNDED_Q);
      const packs = chat.seen.map((item) => JSON.parse(lastUserText(item.context)).globalContext);
      expect(packs).toEqual([{ period: "2026-10", version: 1 }, GLOBAL_CONTEXT_UNCHANGED, { period: "2026-10", version: 2 }]);
    } finally { await chat.runtime.close?.(); }
  });
});

describe("发给网关之前的过滤", () => {
  it("只去掉别家模型的思考块，同一模型的、以及正文和工具调用都不动", () => {
    const model = { id: "claude-sonnet-5-5", api: "anthropic-messages", provider: "warmap" } as Model<any>;
    const mine = { role: "assistant", api: "anthropic-messages", provider: "warmap", model: "claude-sonnet-5-5", content: [{ type: "thinking", thinking: "a", thinkingSignature: "s" }, { type: "text", text: "甲" }], usage, stopReason: "stop", timestamp: 1 };
    const gpt = { ...mine, api: "openai-responses", model: "gpt-5.6-sol", content: [{ type: "thinking", thinking: "", thinkingSignature: "enc" }, { type: "toolCall", id: "c1", name: "x", arguments: {} }] };
    const filtered = withoutForeignReasoning([{ role: "user", content: "问", timestamp: 1 }, mine, gpt] as Context["messages"], model);
    expect(filtered[1]).toBe(mine);
    expect((filtered[2] as AssistantMessage).content).toEqual([{ type: "toolCall", id: "c1", name: "x", arguments: {} }]);
    let passed: SimpleStreamOptions | undefined;
    conversationStreamSimple((_model, _context, options) => { passed = options; return createAssistantMessageEventStream(); })(model, { messages: [] }, { sessionId: "s1" });
    expect(passed?.sessionId).toBe("s1:claude-sonnet-5-5");
  });
});

describe("分诊的软时限", () => {
  it("JSON 还没写完时先用已写出的档位与对象；连档位都没有就不用", async () => {
    expect(parsePartialTriage('{"tier":"deep","topic":"资本动作背后的逻辑","memory":["词元')).toEqual({ tier: "deep", topic: "资本动作背后的逻辑" });
    expect(parsePartialTriage('{"tier":"deep","to')).toBeNull();
    expect(parsePartialTriage('{"tier":"quick"')).toEqual({ tier: "quick" });
    const encoder = new TextEncoder();
    const fetchSlow = (async (_url: unknown, init?: { signal?: AbortSignal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: '{"tier":"grounded","topic":"硅基流动融资","web":["硅基' })}\n\n`));
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const triage = createResponsesTriage({ baseUrl: "https://gw.invalid/v2/llm", apiKey: "k", modelId: "fast", fetch: fetchSlow, softDeadlineMs: 30 });
    expect(await triage({ message: "硅基流动最近一次融资？", signal: new AbortController().signal })).toEqual({ tier: "grounded", topic: "硅基流动融资" });
  });
});
