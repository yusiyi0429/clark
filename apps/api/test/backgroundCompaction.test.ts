import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { loadCompanyMemory } from "../src/companyMemory.js";
import {
  COMPACTION_SYSTEM_PROMPT, HISTORY_WINDOW_ENTRY, applySnapshot, branchOf, coverageNote, estimateTextTokens, historyTokens, lastTurnWindowed, planCompaction,
  summaryPromptFor, transcriptForSummary, withoutCoverageNote, type CompactionPlan, type StoredSnapshot,
} from "../src/conversationCompaction.js";
import { briefQuestion, historyFor, windowHistory, withoutPreCompactionThinking, WINDOW_HISTORY_TOKENS } from "../src/conversationStream.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import type { ConversationRuntimeEvent } from "../src/conversations.js";
import { createTestApp, testEnv } from "./helpers.js";

/**
 * 后台滚动压缩（conversationCompaction.ts）：
 * - 任何一轮都不当场压缩：压缩模型只在后台被调用，一轮的 done 不等它；
 * - 后台压缩进行中发下一问照常回答；快照好了之后下一轮无缝换入，压缩期间新增的那几轮按原文补在摘要后面；
 * - 快照持久化、带「覆盖到哪一条」，重启后照样换入；失败退避重试；租约过期视为失败；
 * - 历史超过硬阈值又没有快照：这一轮走窗口兜底，存下来的历史不变；
 * - 和「新建对话」「闲置重开」配合：快照归属这一条会话，闲置重开用的就是最新快照。
 */
const SID = "55555555-5555-4555-8555-555555555555";
const CEO_VIEWER = { personId: "person-fixture-001", displayName: "测试甲", role: "ceo" as const };
const TIERS = { quick: "gpt-5.6-sol", grounded: "claude-sonnet-5-5", deep: "claude-opus-5-5" };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const usageOf = (input: number) => ({ ...zero, input, output: 20, totalTokens: input + 20 });
const pack = (message: string, extra: Record<string, unknown> = {}) => JSON.stringify({ currentObject: null, references: [],
  globalContext: { battlefields: [{ id: "tk", name: "词元云集", sixMonthOutcome: "页面摘要".repeat(200) }] }, answerMode: "检索问答", message, ...extra });

type Turn = { q: string; a: string; tool?: { name: string; args?: Record<string, unknown>; result: string }; usage?: number; model?: string; thinking?: string };
function session(turns: Turn[], at = Date.parse("2026-10-13T08:00:00Z")) {
  const manager = SessionManager.inMemory(process.cwd(), { id: SID });
  let clock = at;
  const tick = () => (clock += 60_000);
  turns.forEach((turn, index) => {
    const model = turn.model ?? "claude-sonnet-5-5";
    const api = /^claude/.test(model) ? "anthropic-messages" : "openai-responses";
    const base = { role: "assistant" as const, api, provider: "warmap", model, stopReason: "stop" as const };
    manager.appendMessage({ role: "user", content: pack(turn.q), timestamp: tick() });
    if (turn.tool) {
      const id = `call-${index}`;
      manager.appendMessage({ ...base, content: [{ type: "toolCall", id, name: turn.tool.name, arguments: turn.tool.args ?? {} }], usage: usageOf(turn.usage ?? 1000), stopReason: "toolUse", timestamp: tick() });
      manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: turn.tool.name, content: [{ type: "text", text: turn.tool.result }], isError: false, timestamp: tick() });
    }
    manager.appendMessage({ ...base, content: [...(turn.thinking ? [{ type: "thinking" as const, thinking: turn.thinking, thinkingSignature: "sig" }] : []), { type: "text", text: turn.a }],
      usage: usageOf(turn.usage ?? 1000), timestamp: tick() });
  });
  return { manager, entries: () => [manager.getHeader(), ...manager.getEntries()] as unknown[] };
}
const turns = (count: number, size = 400, usage = 70_000): Turn[] => Array.from({ length: count }, (_, index) => ({
  q: `第${index + 1}问：${index === 0 ? "记住我偏好结论先行，统一成一段话说。" : "继续讨论词元云集。"}`,
  a: `第${index + 1}答。${"词元云集的判断与依据。".repeat(size / 10)}`,
  usage,
}));
const planOf = (entries: unknown[], options: Parameters<typeof planCompaction>[2] = {}) => {
  const plan = planCompaction(entries, SID, { keepRecentTokens: 600, minFoldTokens: 100, ...options });
  if ("skip" in plan) throw new Error(`skipped: ${plan.skip}`);
  return plan;
};
const snapshotFrom = (plan: CompactionPlan, summary = "## 一号位的决定与表态\n- 偏好结论先行。", id = "aaaaaaaa-0000-4000-8000-000000000001"): StoredSnapshot => ({
  id, summary, baseCompactionId: plan.baseCompactionId, firstKeptEntryId: plan.firstKeptEntryId, coveredEntryId: plan.coveredEntryId,
  leafEntryId: plan.leafEntryId, coveredTurns: plan.coveredTurns, tokensBefore: plan.tokensBefore,
});
const contextOf = (entries: unknown[]) => SessionManager.inMemory(process.cwd(), { id: SID }, structuredClone(entries) as Parameters<typeof SessionManager.inMemory>[2]).buildSessionContext().messages;
const textOf = (value: unknown) => JSON.stringify(value);

describe("压缩计划：滚动增量、切点落在提问上、带「覆盖到哪一条」", () => {
  it("历史没超过软阈值不压缩；超过后折进较早的轮次，最近的轮次原样保留，至少留最后一整轮", () => {
    const small = session(turns(4, 400, 20_000));
    expect(planCompaction(small.entries(), SID)).toMatchObject({ skip: "below_threshold", tokensBefore: 20_020 });
    const s = session(turns(4));
    const plan = planOf(s.entries());
    const branch = s.manager.getBranch();
    const cut = branch.findIndex((entry) => entry.id === plan.firstKeptEntryId);
    expect(branch[cut]).toMatchObject({ type: "message", message: { role: "user" } });
    expect(plan.keptTurns).toBeGreaterThanOrEqual(1);
    expect(plan.coveredTurns + plan.keptTurns).toBe(4);
    expect(plan.coveredEntryId).toBe(branch[cut - 1].id);
    expect(plan.leafEntryId).toBe(branch.at(-1)!.id);
    expect(plan.tokensBefore).toBe(70_020);
    expect(plan.tokensSource).toBe("usage");
    expect(plan.previousSummary).toBeUndefined();
    expect(plan.baseCompactionId).toBeNull();
  });

  it("滚动：在上一份快照之上只折新增的部分，切点在上一份压缩记录之后（旧摘要不会夹在中间）", () => {
    const s = session(turns(4));
    const first = planOf(s.entries());
    const applied = applySnapshot(s.entries(), SID, snapshotFrom(first, "旧摘要：偏好结论先行。"));
    if (!applied.applied) throw new Error("not applied");
    const manager = SessionManager.inMemory(process.cwd(), { id: SID }, structuredClone(applied.runtimeEntries) as Parameters<typeof SessionManager.inMemory>[2]);
    for (const turn of turns(3)) {
      manager.appendMessage({ role: "user", content: pack(turn.q), timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "warmap", model: "claude-sonnet-5-5", content: [{ type: "text", text: turn.a }],
        usage: usageOf(80_000), stopReason: "stop", timestamp: Date.now() });
    }
    const entries = [manager.getHeader(), ...manager.getEntries()];
    const second = planOf(entries);
    expect(second.baseCompactionId).toBe(applied.entryId);
    expect(second.previousSummary).toBe("旧摘要：偏好结论先行。");
    const branch = manager.getBranch();
    const compactionAt = branch.findIndex((entry) => entry.id === applied.entryId);
    expect(branch.findIndex((entry) => entry.id === second.firstKeptEntryId)).toBeGreaterThan(compactionAt);
    // 旧快照原样保留下来的那几轮，这次折进新摘要；旧摘要只作为 previousSummary，不在要折的消息里。
    expect(textOf(second.foldMessages)).toContain(`第${first.coveredTurns + 1}问`);
    expect(textOf(second.foldMessages)).not.toContain("旧摘要");
  });

  it("交给压缩模型的文字：提问只留原话与页面，检索原文不进，确认卡这类状态工具的结果留一小段，思考不进", () => {
    const s = session([
      { q: "【页面】正在讨论战场「词元云集」（TK，战场id=tk）\n\n硅基流动最近一轮融资是什么时候", a: "9 月完成 C 轮。", tool: { name: "web_search", args: { query: "硅基流动 融资" }, result: "检索原文".repeat(500) }, thinking: "内部推理" },
      { q: "把这个做成议题", a: "已生成确认卡。", tool: { name: "propose_business_change", args: { type: "issue", values: { title: "自建 Token 工厂的条件" } }, result: JSON.stringify({ proposalId: "prop-42", status: "pending" }) } },
      { q: "下一问", a: "好。" },
    ]);
    const text = transcriptForSummary(s.manager.buildSessionContext().messages.slice(0, 7));
    expect(text).toContain("硅基流动最近一轮融资是什么时候");
    expect(text).toContain("战场id=tk");
    expect(text).not.toContain("页面摘要");
    expect(text).not.toContain("检索原文");
    expect(text).toContain('web_search({"query":"硅基流动 融资"})');
    expect(text).toContain("prop-42");
    expect(text).not.toContain("内部推理");
    expect(text).toMatch(/\[一号位 · 10\/13 16:0\d/);
  });
});

describe("压缩提示与覆盖范围", () => {
  it("原样保留那几轮的一号位原话也交给压缩模型（记偏好与决定）；记忆末尾系统加一行覆盖范围，滚动时旧的那行先去掉", () => {
    const s = session([...turns(3), { q: "统一成一段话来说，不要分开说", a: "好的，一段话：……", usage: 70_000 }]);
    const plan = planOf(s.entries(), { keepRecentTokens: 10 });
    expect(plan.keptQuestions.map((item) => item.text)).toEqual(["统一成一段话来说，不要分开说"]);
    const prompt = summaryPromptFor({ ...plan, previousSummary: `旧记忆。\n\n${coverageNote({ coveredTurns: 1, lastCoveredAt: Date.parse("2026-10-13T08:00:00Z") })}` });
    expect(prompt).toContain("<之后几轮一号位的原话>");
    expect(prompt).toContain("统一成一段话来说，不要分开说");
    expect(prompt).toContain("<之前的对话记忆>\n旧记忆。\n</之前的对话记忆>");
    expect(coverageNote(plan)).toMatch(/^（这份对话记忆覆盖到第 3 轮（最后一问在 10\/13 16:\d\d）；之后的对话以原文为准/);
    expect(withoutCoverageNote(`记忆正文\n\n${coverageNote(plan)}`)).toBe("记忆正文");
  });
});

describe("换入快照", () => {
  it("在会话末尾追加一条压缩记录：模型看到「新摘要 + 切点之后的原文」，快照之后新增的轮次按原文接在后面", () => {
    const s = session(turns(4));
    const plan = planOf(s.entries());
    // 后台压缩期间又答了一轮。
    s.manager.appendMessage({ role: "user", content: pack("压缩期间的新问题"), timestamp: Date.now() });
    s.manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "warmap", model: "claude-sonnet-5-5", content: [{ type: "text", text: "压缩期间的回答" }],
      usage: usageOf(90_000), stopReason: "stop", timestamp: Date.now() });
    const applied = applySnapshot(s.entries(), SID, snapshotFrom(plan));
    expect(applied.applied).toBe(true);
    if (!applied.applied) return;
    const messages = contextOf(applied.runtimeEntries);
    expect(messages[0]).toMatchObject({ role: "compactionSummary", summary: expect.stringContaining("偏好结论先行") });
    const sent = textOf(messages);
    expect(sent).not.toContain("第1问");
    expect(sent).toContain("压缩期间的新问题");
    expect(sent).toContain(`第${plan.coveredTurns + 1}问`);
    // 同一份快照不会换入两次；基础变了的快照作废。
    expect(applySnapshot(applied.runtimeEntries, SID, snapshotFrom(plan))).toEqual({ applied: false, reason: "already_applied" });
    expect(applySnapshot(applied.runtimeEntries, SID, snapshotFrom(plan, "另一份", "aaaaaaaa-0000-4000-8000-000000000002"))).toEqual({ applied: false, reason: "stale" });
    // 换入后历史长度按字数估算（没有新的用量），远小于压缩前。
    const branch = branchOf(applied.runtimeEntries, SID)!.branch;
    expect(historyTokens(branch).source).toBe("estimate");
    expect(historyTokens(branch).tokens).toBeLessThan(plan.tokensBefore);
  });

  it("切点或做快照时的最后一条已经不在分支上：不换入（stale）", () => {
    const s = session(turns(4));
    const plan = planOf(s.entries());
    expect(applySnapshot(s.entries(), SID, { ...snapshotFrom(plan), leafEntryId: "deadbeef" })).toEqual({ applied: false, reason: "stale" });
    expect(applySnapshot([], SID, snapshotFrom(plan))).toEqual({ applied: false, reason: "unreadable" });
  });
});

describe("历史怎么交给模型", () => {
  const summary = (at: number) => ({ role: "user" as const, content: [{ type: "text" as const, text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\n摘要\n</summary>" }], timestamp: at });
  const claude = { id: "claude-sonnet-5-5", api: "anthropic-messages", provider: "warmap-anthropic" } as Model<any>;
  const answer = (text: string, at: number, thinking = true): Context["messages"][number] => ({ role: "assistant", api: "anthropic-messages", provider: "warmap-anthropic", model: "claude-sonnet-5-5",
    content: [...(thinking ? [{ type: "thinking" as const, thinking: "思考", thinkingSignature: "sig" }] : []), { type: "text", text }], usage: zero, stopReason: "stop", timestamp: at });

  it("摘要换入之前生成的 Claude 思考块不再回传；摘要之后的轮次、本轮自己的思考块不动", () => {
    const messages: Context["messages"] = [
      summary(1_000), { role: "user", content: pack("保留下来的一问"), timestamp: 500 }, answer("保留下来的回答", 600),
      { role: "user", content: pack("换入之后的一问"), timestamp: 1_100 }, answer("换入之后的回答", 1_200),
      { role: "user", content: pack("本轮"), timestamp: 1_300 }, answer("本轮回答", 1_400),
    ];
    const result = withoutPreCompactionThinking(messages, claude);
    expect(textOf(result[2])).not.toContain("thinking");
    expect(textOf(result[4])).toContain("thinking");
    expect(textOf(result[6])).toContain("thinking");
    expect(withoutPreCompactionThinking(messages, { api: "openai-responses" } as Model<any>)).toBe(messages);
    expect(historyFor(messages, claude).length).toBe(messages.length);
  });

  it("窗口兜底：摘要 + 最近若干轮文字（按预算），此前各轮的提问只留原话；本轮原样", () => {
    const long = "很长的回答".repeat(4_000);
    const messages: Context["messages"] = [summary(1_000)];
    for (let index = 0; index < 10; index += 1) {
      messages.push({ role: "user", content: pack(`第${index}问`), timestamp: 2_000 + index });
      messages.push({ role: "assistant", api: "anthropic-messages", provider: "warmap-anthropic", model: "claude-sonnet-5-5",
        content: [{ type: "toolCall", id: `c${index}`, name: "web_search", arguments: {} }], usage: zero, stopReason: "toolUse", timestamp: 2_000 + index });
      messages.push({ role: "toolResult", toolCallId: `c${index}`, toolName: "web_search", content: [{ type: "text", text: "检索原文" }], isError: false, timestamp: 2_000 + index });
      messages.push(answer(index >= 8 ? "短回答" : long, 2_000 + index, false));
    }
    messages.push({ role: "user", content: pack("本轮的问题"), timestamp: 3_000 });
    const windowed = windowHistory(messages);
    const sent = textOf(windowed);
    expect(windowed[0]).toBe(messages[0]);
    expect(windowed.at(-1)).toBe(messages.at(-1));
    expect(sent).toContain("第9问");
    expect(sent).toContain("第8问");
    expect(sent).not.toContain("第0问");
    expect(sent).not.toContain("检索原文");
    // 只有本轮的上下文包是完整的；此前各轮的提问只剩原话。
    expect(textOf(windowed.slice(0, -1))).not.toContain("页面摘要");
    expect(textOf(windowed.at(-1))).toContain("页面摘要");
    expect(estimateTextTokens(sent)).toBeLessThan(WINDOW_HISTORY_TOKENS + estimateTextTokens(long) + 2_000);
    expect(JSON.parse((briefQuestion(messages[1]).content as { text: string }[])[0].text)).toEqual({ message: "第0问" });
  });

  it("窗口里工具往返不带了，但这一轮生成了几张确认卡、改了什么，作为一行系统记录接在回答后面（10/14 重放第 9 轮）", () => {
    const call = (id: string, title: string) => ({ type: "toolCall" as const, id, name: "propose_business_change", arguments: { operation: "create", type: "issue", values: { title } } });
    const messages: Context["messages"] = [
      summary(1_000),
      { role: "user", content: pack("建议生成哪些议题"), timestamp: 1_100 },
      { role: "assistant", api: "anthropic-messages", provider: "warmap-anthropic", model: "claude-opus-5-5", content: [call("c1", "集团是否自建 Token 产能"), call("c2", "资本投放顺序"),
        { type: "toolCall", id: "c3", name: "propose__business_change", arguments: {} }], usage: zero, stopReason: "toolUse", timestamp: 1_200 },
      { role: "toolResult", toolCallId: "c1", toolName: "propose_business_change", content: [{ type: "text", text: "{\"proposalId\":\"p1\"}" }], isError: false, timestamp: 1_210 },
      { role: "toolResult", toolCallId: "c2", toolName: "propose_business_change", content: [{ type: "text", text: "版本冲突" }], isError: true, timestamp: 1_210 },
      { role: "toolResult", toolCallId: "c3", toolName: "propose__business_change", content: [{ type: "text", text: "Tool not found" }], isError: true, timestamp: 1_210 },
      answer("已做成确认卡。", 1_300, false),
      { role: "user", content: pack("这些卡生成了吗"), timestamp: 1_400 },
    ];
    const text = textOf(windowHistory(messages));
    expect(text).toContain("系统记录：这一轮实际执行了生成确认卡：成功 1 次、失败 1 次（集团是否自建 Token 产能）");
    expect(text).not.toContain("propose__business_change");
  });

  it("窗口与精简历史里拷出来的回答不带原来的用量：GPT 的输出上限不会被压到十几个 token（10/14 重放第 8 轮）", () => {
    const gpt = { id: "gpt-5.6-sol", api: "openai-responses", provider: "warmap", contextWindow: 128_000, maxTokens: 16_384 } as Model<any>;
    // 摘要换入之后的一轮深度档：最后一次调用带着全部工具往返，用量 14 万。
    const deep = { role: "assistant" as const, api: "anthropic-messages", provider: "warmap-anthropic", model: "claude-opus-5-5",
      content: [{ type: "text" as const, text: "深度档的长回答" }], usage: usageOf(140_000), stopReason: "stop" as const, timestamp: 1_200 };
    const messages: Context["messages"] = [summary(1_000), { role: "user", content: pack("换入之后的深度问题"), timestamp: 1_100 }, deep, { role: "user", content: pack("统一成一段话来说"), timestamp: 1_300 }];
    // 原样交出去时，pi-ai 按这条回答的用量估算上下文，输出上限只剩 1（真实请求里网关给了 16）。
    expect(clampMaxTokensToContext(gpt, { systemPrompt: "系统", messages }, 16_384)).toBeLessThan(100);
    // 窗口和精简历史里只留文字，用量不跟着拷：输出上限照常。
    expect(clampMaxTokensToContext(gpt, { systemPrompt: "系统", messages: historyFor(messages, gpt, "window") }, 16_384)).toBe(16_384);
    expect(clampMaxTokensToContext(gpt, { systemPrompt: "系统", messages: historyFor(messages, gpt, "minimal") }, 16_384)).toBe(16_384);
  });

  it("窗口那一轮记在会话里：下一轮按字数估算历史（窗口里的用量不算数）", () => {
    const s = session(turns(3));
    s.manager.appendCustomEntry(HISTORY_WINDOW_ENTRY, { tokens: 120_000 });
    s.manager.appendMessage({ role: "user", content: pack("窗口那一轮"), timestamp: Date.now() });
    s.manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "warmap", model: "claude-sonnet-5-5", content: [{ type: "text", text: "答" }],
      usage: usageOf(9_000), stopReason: "stop", timestamp: Date.now() });
    const branch = s.manager.getBranch();
    expect(lastTurnWindowed(branch)).toBe(true);
    expect(historyTokens(branch).source).toBe("estimate");
    s.manager.appendMessage({ role: "user", content: pack("下一轮"), timestamp: Date.now() });
    s.manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "warmap", model: "claude-sonnet-5-5", content: [{ type: "text", text: "答" }],
      usage: usageOf(50_000), stopReason: "stop", timestamp: Date.now() });
    expect(lastTurnWindowed(s.manager.getBranch())).toBe(false);
    expect(historyTokens(s.manager.getBranch())).toEqual({ tokens: 50_020, source: "usage" });
  });
});

// ───────────────────────────── 真 pi 运行时 + 假模型 ─────────────────────────────

type Seen = { model: string; context: Context; options?: SimpleStreamOptions };
type Reply = { text: string; usage?: number; error?: string; gate?: Promise<void> };
function scripted(model: Model<any>, reply: Reply) {
  const out = createAssistantMessageEventStream();
  void (async () => {
    await reply.gate;
    const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: usageOf(reply.usage ?? 1_000), timestamp: Date.now() };
    const partial: AssistantMessage = { ...base, content: [], stopReason: "pending" };
    out.push({ type: "start", partial });
    if (reply.error) {
      out.push({ type: "error", reason: "error", error: { ...base, content: [], stopReason: "error", errorMessage: reply.error } });
    } else {
      out.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial });
      out.push({ type: "done", reason: "stop", message: { ...base, content: [{ type: "text", text: reply.text }], stopReason: "stop" } });
    }
    out.end();
  })();
  return out;
}
const isSummary = (seen: Seen) => seen.context.systemPrompt === COMPACTION_SYSTEM_PROMPT;

async function piRuntime(answer: (seen: Seen) => Reply, extra: Partial<Parameters<typeof createPiConversationRuntime>[0]> = {}) {
  const seen: Seen[] = [];
  const runtime = await createPiConversationRuntime({
    companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://gw.invalid/v2/llm/responses", apiKey: "test-key",
    modelId: TIERS.quick, tierModels: TIERS, compactionModelId: "fake-compaction", recoverySleep: async () => undefined,
    streamSimple: (model, context, options) => {
      const call = { model: model.id, context, options };
      seen.push(call);
      return scripted(model, answer(call));
    },
    ...extra,
  });
  return { runtime, seen };
}

describe("运行时：一轮里永远不压缩", () => {
  it("历史很长（上一轮用量超过硬阈值）：不调用压缩模型、不发压缩事件，这一轮走窗口兜底；存下来的历史不变", async () => {
    const { runtime, seen } = await piRuntime(() => ({ text: "照常回答。", usage: 1_000 }));
    try {
      const s = session([
        { q: "最早的一问：记住我偏好结论先行", a: "好的。", tool: { name: "web_search", result: "检索原文".repeat(100) }, usage: 30_000 },
        ...turns(3, 200, 120_000),
      ]);
      const events: ConversationRuntimeEvent[] = [];
      const result = await runtime.run({ scope: "global", viewer: CEO_VIEWER, message: "现在怎么看？", currentObject: null, referencesSnapshot: [],
        runtimeEntries: s.entries(), piSessionId: SID, signal: new AbortController().signal, emit: (event) => events.push(event) });
      expect(result.assistantMessage).toBe("照常回答。");
      expect(seen.some(isSummary)).toBe(false);
      expect(events.some((event) => event.type === "compaction" || (event.type === "recovery" && event.reason === "compaction"))).toBe(false);
      const sent = textOf(seen[0].context.messages);
      expect(sent).not.toContain("检索原文");
      expect(sent).not.toContain("页面摘要页面摘要");
      expect(sent).toContain("第3问");
      // 存下来的是完整历史（原文和工具结果都在），外加窗口标记；没有压缩记录。
      const stored = textOf(result.runtimeEntries);
      expect(stored).toContain("检索原文");
      expect(stored).toContain(HISTORY_WINDOW_ENTRY);
      expect(stored).not.toContain('"type":"compaction"');
    } finally { await runtime.close?.(); }
  });

  it("后台写摘要用 COMPACTION_MODEL，不开缓存写入（不额外调用 Claude）", async () => {
    const { runtime, seen } = await piRuntime(() => ({ text: "## 一号位的决定与表态\n- 无" }));
    try {
      const result = await runtime.summarizeHistory!({ systemPrompt: COMPACTION_SYSTEM_PROMPT, prompt: "对话", signal: new AbortController().signal });
      expect(result).toMatchObject({ model: "fake-compaction", text: expect.stringContaining("一号位的决定") });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ model: "fake-compaction", options: expect.objectContaining({ cacheRetention: "none" }) });
    } finally { await runtime.close?.(); }
  });
});

// ───────────────────────────── 路由 + 库 + 后台任务 ─────────────────────────────

function parseSse(body: string): { type: string; [key: string]: unknown }[] {
  return body.trim().split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6))] : [];
  });
}
const SMALL = { softTokens: 2_000, keepRecentTokens: 40, minFoldTokens: 10 };
async function waitFor<T>(probe: () => Promise<T | undefined>, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const lastUser = (context: Context) => textOf([...context.messages].reverse().find((message) => message.role === "user"));

describe("后台压缩的生命周期（真路由、真库）", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("一轮答完才在后台压缩；压缩进行中新问照常答；快照好了下一轮无缝换入，压缩期间那一轮按原文补上", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const logs: Record<string, unknown>[] = [];
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      const text = String(chunk);
      if (text.includes("conversation.compaction")) logs.push(JSON.parse(text));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    const { runtime, seen } = await piRuntime((call) => (isSummary(call)
      ? { text: "## 一号位的决定与表态\n- 一号位要求结论先行、统一成一段话说。", gate }
      : { text: `回答：${"词元云集的判断。".repeat(20)}`, usage: 5_000 }));
    const t = await createTestApp({}, runtime, { conversationCompactionOptions: SMALL });
    try {
      const cookie = await t.loginCookie();
      const ask = async (message: string) => {
        const started = Date.now();
        const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message } });
        return { events: parseSse(response.body), ms: Date.now() - started };
      };
      const first = await ask("第一问：记住我偏好结论先行，统一成一段话说。");
      expect(first.events.at(-1)).toMatchObject({ type: "done", status: "completed" });
      const second = await ask("第二问：词元云集现在卡在哪？");
      expect(second.events.at(-1)).toMatchObject({ type: "done", status: "completed" });
      // 第二轮答完后后台开始压缩（压缩模型被叫到，但还没返回）。
      const running = await waitFor(async () => (await t.sql("SELECT * FROM conversation_compactions"))[0] as Record<string, unknown> | undefined);
      expect(running).toMatchObject({ status: "running", trigger_kind: "after_turn", covered_turns: 1, kept_turns: 1 });
      expect(seen.filter(isSummary)).toHaveLength(1);
      // 压缩进行中：第三问照常回答，用的还是原来的历史，没有任何压缩相关的事件。
      const third = await ask("第三问：那下一步呢？");
      expect(third.events.at(-1)).toMatchObject({ type: "done", status: "completed" });
      expect(third.events.some((event) => event.type === "compaction" || event.type === "recovery")).toBe(false);
      const thirdCall = seen.filter((call) => !isSummary(call)).at(-1)!;
      expect(textOf(thirdCall.context.messages)).toContain("第一问");
      expect((await t.sql("SELECT status FROM conversation_compactions"))[0]).toEqual({ status: "running" });
      // 压缩完成：快照就绪，记着覆盖到哪一条。
      release();
      const ready = await waitFor(async () => {
        const row = (await t.sql("SELECT * FROM conversation_compactions WHERE status = 'ready'"))[0];
        return row as Record<string, unknown> | undefined;
      });
      expect(ready).toMatchObject({ covered_turns: 1, summary: expect.stringContaining("结论先行"), model: "fake-compaction" });
      expect(String(ready.summary)).toMatch(/（这份对话记忆覆盖到第 1 轮（最后一问在 [^）]+）；之后的对话以原文为准/);
      expect(Number(ready.duration_ms)).toBeGreaterThanOrEqual(0);
      // 第四问：开头换入快照（不调模型），模型看到「摘要 + 第二、第三问原文」，第一问的原文不在了。
      const callsBefore = seen.length;
      const fourth = await ask("第四问：总结一下我的偏好");
      expect(fourth.events.at(-1)).toMatchObject({ type: "done", status: "completed" });
      const fourthCall = seen.slice(callsBefore).find((call) => !isSummary(call))!;
      const sent = textOf(fourthCall.context.messages);
      expect(sent).toContain("compacted into the following summary");
      expect(sent).toContain("一号位要求结论先行");
      expect(sent).not.toContain("第一问");
      expect(sent).toContain("第二问");
      expect(sent).toContain("第三问");
      expect(lastUser(fourthCall.context)).toContain("第四问");
      expect((await t.sql("SELECT status, applied_at IS NOT NULL AS applied FROM conversation_compactions WHERE id = $1", [ready.id]))[0]).toEqual({ status: "applied", applied: true });
      const state = await t.conversationState("global");
      expect(textOf(state.runtimeEntries)).toContain(String(ready.id));
      // 界面上的历史一条不少。
      expect(state.messages.filter((message) => message.role === "user").map((message) => String(message.content).slice(0, 3))).toEqual(["第一问", "第二问", "第三问", "第四问"]);
      expect(logs.map((entry) => entry.status)).toEqual(expect.arrayContaining(["started", "ready", "applied"]));
      const readyLog = logs.find((entry) => entry.status === "ready")!;
      expect(readyLog).toMatchObject({ trigger: "after_turn", tokensBefore: 5_020, model: "fake-compaction" });
      expect(Number(readyLog.historyTokensAfter)).toBeLessThan(Number(readyLog.historyTokensBefore));
    } finally { release(); await t.close(); }
  });

  it("压缩失败：下一轮照常回答；按退避再试；租约过期的 running 视为失败重新做", async () => {
    let failing = true;
    const { runtime, seen } = await piRuntime((call) => (isSummary(call)
      ? (failing ? { text: "", error: "fetch failed" } : { text: "## 一号位的决定与表态\n- 偏好结论先行（重试后写出的摘要）。" })
      : { text: `回答：${"内容".repeat(40)}`, usage: 5_000 }));
    const t = await createTestApp({}, runtime, { conversationCompactionOptions: { ...SMALL, retryDelaysMs: [60_000] } });
    try {
      const cookie = await t.loginCookie();
      const ask = (message: string) => t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message } })
        .then((response) => parseSse(response.body));
      await ask("第一问");
      await ask("第二问");
      // 主模型（Sonnet）失败、备用模型（fake-compaction）也失败：这次压缩失败。
      const failed = await waitFor(async () => (await t.sql("SELECT status, error, attempt FROM conversation_compactions WHERE status = 'failed'"))[0] as Record<string, unknown> | undefined);
      expect(failed).toMatchObject({ attempt: 1, error: expect.stringContaining("background summary failed") });
      expect((await ask("第三问")).at(-1)).toMatchObject({ type: "done", status: "completed" });
      // 退避期内不再试。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await t.sql("SELECT count(*)::int AS n FROM conversation_compactions"))[0]).toEqual({ n: 1 });
      // 退避过了（把失败时间往前挪）：下一轮之后重试，这次写出来了。
      failing = false;
      await t.sql("UPDATE conversation_compactions SET completed_at = now() - interval '2 minutes'");
      await ask("第四问");
      const ready = await waitFor(async () => (await t.sql("SELECT attempt, summary FROM conversation_compactions WHERE status = 'ready'"))[0] as Record<string, unknown> | undefined);
      expect(ready).toMatchObject({ attempt: 2, summary: expect.stringContaining("重试后写出") });
      // 进程在压缩中途挂掉留下的 running（租约已过期）：下次触发时算失败，重新做一份。
      const conversation = (await t.sql("SELECT id, pi_session_id FROM conversations"))[0] as { id: string; pi_session_id: string };
      await t.sql("UPDATE conversation_compactions SET status = 'applied'");
      await t.sql(`INSERT INTO conversation_compactions (id, conversation_id, pi_session_id, status, trigger_kind, first_kept_entry_id, covered_entry_id, leaf_entry_id,
        covered_entries, covered_turns, kept_turns, tokens_before, tokens_source, history_tokens_folded, history_tokens_kept, lease_until, started_at)
        VALUES ('bbbbbbbb-0000-4000-8000-000000000001', $1, $2, 'running', 'after_turn', 'x', 'x', 'x', 1, 1, 1, 1, 'usage', 1, 1, now() - interval '1 minute', now() - interval '10 minutes')`,
      [conversation.id, conversation.pi_session_id]);
      const summariesBefore = seen.filter(isSummary).length;
      await ask("第五问");
      await waitFor(async () => (seen.filter(isSummary).length > summariesBefore ? true : undefined));
      expect((await t.sql("SELECT status, error FROM conversation_compactions WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001'"))[0]).toEqual({ status: "failed", error: "lease expired" });
    } finally { await t.close(); }
  });

  it("快照持久化：服务重启后照样换入；闲置重开用的就是最新快照；新建对话后快照只归原来那一条", async () => {
    const { runtime, seen } = await piRuntime((call) => (isSummary(call)
      ? { text: "## 一号位的决定与表态\n- 一号位否决了自建 Token 工厂（快照里的记忆）。" }
      : { text: `回答：${"内容".repeat(40)}`, usage: 5_000 }));
    const t = await createTestApp({}, runtime, { conversationCompactionOptions: SMALL });
    try {
      const cookie = await t.loginCookie();
      let app = t.app;
      const ask = (message: string) => app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message } })
        .then((response) => parseSse(response.body));
      await ask("第一问");
      await ask("第二问");
      await waitFor(async () => (await t.sql("SELECT id FROM conversation_compactions WHERE status = 'ready'"))[0]);
      // 上一个进程挂掉时正在做的一份（租约还没过期）：新进程启动时记为失败。
      const conversation = (await t.sql("SELECT id, pi_session_id FROM conversations"))[0] as { id: string; pi_session_id: string };
      await t.sql(`INSERT INTO conversation_compactions (id, conversation_id, pi_session_id, status, trigger_kind, first_kept_entry_id, covered_entry_id, leaf_entry_id,
        covered_entries, covered_turns, kept_turns, tokens_before, tokens_source, history_tokens_folded, history_tokens_kept, lease_until, started_at)
        VALUES ('cccccccc-0000-4000-8000-000000000001', $1, $2, 'running', 'after_turn', 'x', 'x', 'x', 1, 1, 1, 1, 'usage', 1, 1, now() + interval '4 minutes', now() - interval '1 minute')`,
      [conversation.id, conversation.pi_session_id]);
      // 重启（同一个库、新进程里的后台任务表是空的）：就绪的快照还在库里，下一轮换入。
      app = await t.restart(runtime);
      await app.ready();
      await waitFor(async () => {
        const row = (await t.sql("SELECT status, error FROM conversation_compactions WHERE id = 'cccccccc-0000-4000-8000-000000000001'"))[0];
        return row?.status === "failed" ? row : undefined;
      }).then((row) => expect(row).toEqual({ status: "failed", error: "interrupted by restart" }));
      // 闲置超过 12 小时：模型侧换新会话，带上的摘要就是刚换入的这份快照。
      await t.sql("UPDATE conversation_messages SET created_at = created_at - interval '13 hours'");
      const before = seen.length;
      const answered = await ask("隔天再问");
      expect(answered.at(-1)).toMatchObject({ type: "done", status: "completed" });
      const call = seen.slice(before).find((item) => !isSummary(item))!;
      expect(textOf(call.context.messages)).toContain("否决了自建 Token 工厂");
      expect((await t.sql("SELECT status FROM conversation_compactions WHERE id <> 'cccccccc-0000-4000-8000-000000000001' ORDER BY started_at LIMIT 1"))[0]).toEqual({ status: "applied" });
      // 新建对话：旧对话归档，新对话里没有旧快照。
      const created = await app.inject({ method: "POST", url: "/api/conversations/global/new", headers: { cookie, origin: t.publicOrigin } });
      expect(created.statusCode).toBe(200);
      const fresh = seen.length;
      await ask("新对话的第一问");
      const freshCall = seen.slice(fresh).find((item) => !isSummary(item))!;
      expect(textOf(freshCall.context.messages)).not.toContain("否决了自建 Token 工厂");
      const rows = await t.sql("SELECT DISTINCT conversation_id FROM conversation_compactions");
      const archived = await t.sql("SELECT id FROM conversations WHERE archived_at IS NOT NULL");
      expect(rows.map((row) => row.conversation_id)).toEqual(archived.map((row) => row.id));
    } finally { await t.close(); }
  });
});
