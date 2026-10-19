import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { IDLE_RESTART_MESSAGE_CHARS, createPiConversationRuntime, latestAnswerIsClaude, latestCompactionSummary, seedIdleRestart } from "../src/piConversationRuntime.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ConversationRuntimeEvent } from "../src/conversations.js";
import { CONTINUE_AFTER_BREAK, ConversationTurnError } from "../src/conversationRecovery.js";
import { testEnv } from "./helpers.js";

/**
 * 10/13 P0「对话进行到一半整条回答消失」：pi 运行时这一层的端到端行为（假模型，真 pi 会话与工具循环）。
 * - 正文写到一半断网（undici terminated）：从断点续写，一号位看到的字一个不少，存下的是完整回答；
 * - 网关 503 还没出字：同档重试，再换备用模型；
 * - 恢复用尽：抛出带分类和模型历史的错误（已写出的正文作为一条回答进历史），下一轮接得上；
 * - 卡住的工具不让一轮失败；历史再长，一轮里也不当场压缩（压缩只在后台做）。
 */
const CEO_VIEWER = { personId: "person-fixture-001", displayName: "测试甲", role: "ceo" as const };
const TIERS = { quick: "gpt-5.6-sol", grounded: "claude-sonnet-5-5", deep: "claude-opus-5-5" };
const QUICK_Q = "这周待决策的议题有几个";
const GROUNDED_Q = "硅基流动最近一次融资是什么时候？";
const usage = (input = 4) => ({ input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

type Step = { text?: string[]; error?: string; tool?: { id: string; name: string; arguments: Record<string, unknown> }; input?: number };
function scripted(model: Model<any>, step: Step) {
  const out = createAssistantMessageEventStream();
  void (async () => {
    const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: usage(step.input), timestamp: Date.now() };
    const partial: AssistantMessage = { ...base, content: [], stopReason: "pending" };
    out.push({ type: "start", partial });
    let text = "";
    for (const delta of step.text ?? []) {
      text += delta;
      out.push({ type: "text_delta", contentIndex: 0, delta, partial });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const content: AssistantMessage["content"] = [...(text ? [{ type: "text" as const, text }] : []), ...(step.tool ? [{ type: "toolCall" as const, ...step.tool }] : [])];
    if (step.error) out.push({ type: "error", reason: "error", error: { ...base, content, stopReason: "error", errorMessage: step.error } });
    else out.push({ type: "done", reason: step.tool ? "toolUse" : "stop", message: { ...base, content, stopReason: step.tool ? "toolUse" : "stop" } });
    out.end();
  })();
  return out;
}

type Seen = { model: string; context: Context; options?: SimpleStreamOptions };
async function harness(respond: (seen: Seen, index: number) => Step, extra: Partial<Parameters<typeof createPiConversationRuntime>[0]> = {}) {
  const seen: Seen[] = [];
  const runtime = await createPiConversationRuntime({
    peopleDirectory: loadPeopleDirectory(testEnv), baseUrl: "https://gw.invalid/v2/llm/responses", apiKey: "test-key",
    modelId: TIERS.quick, tierModels: TIERS, compactionModelId: "fake-compaction", recoverySleep: async () => undefined,
    streamSimple: (model, context, options) => {
      seen.push({ model: model.id, context, options });
      return scripted(model, respond(seen.at(-1)!, seen.length - 1));
    },
    ...extra,
  });
  let entries: unknown[] = [];
  let sessionId = "33333333-3333-4333-8333-333333333333";
  const turn = async (message: string, input: Partial<Parameters<typeof runtime.run>[0]> = {}) => {
    const events: ConversationRuntimeEvent[] = [];
    try {
      const result = await runtime.run({ scope: "global", viewer: CEO_VIEWER, message, currentObject: null, referencesSnapshot: [], runtimeEntries: entries,
        piSessionId: sessionId, signal: new AbortController().signal, emit: (event) => events.push(event), ...input });
      entries = result.runtimeEntries;
      if (result.piSessionId) sessionId = result.piSessionId;
      return { result, events, error: undefined };
    } catch (error) {
      const failed = error as ConversationTurnError;
      if (failed.runtimeEntries) entries = failed.runtimeEntries;
      return { result: undefined, events, error: failed };
    }
  };
  return { seen, turn, runtime, entries: () => entries, setEntries: (next: unknown[]) => { entries = next; }, sessionId: () => sessionId };
}
const streamed = (events: ConversationRuntimeEvent[]) => events.flatMap((event) => (event.type === "message" ? [event.delta] : [])).join("");
const lastUserText = (context: Context) => {
  const last = [...context.messages].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : (last?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
};

/** pi 的压缩请求：系统提示是它自带的摘要助手。 */
const isCompaction = (seen: Seen) => Boolean(seen.context.systemPrompt?.includes("context summarization assistant"));

describe("对话主答出错时不丢字、自动恢复", () => {
  it("检索问答档（Sonnet）正文写到一半连接被掐断（terminated）：从断点续写，存下完整回答", async () => {
    const t = await harness((seen) => (lastUserText(seen.context) === CONTINUE_AFTER_BREAK
      ? { text: ["，结论是继续观察。"] }
      : { text: ["硅基流动 9 月完成融资", "，金额未披露"], error: "terminated" }));
    try {
      const { result, events } = await t.turn(GROUNDED_Q);
      expect(t.seen.map((call) => call.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
      expect(t.seen[1].options?.toolChoice).toBe("none");
      expect(streamed(events)).toBe("硅基流动 9 月完成融资，金额未披露，结论是继续观察。");
      expect(result?.assistantMessage).toBe("硅基流动 9 月完成融资，金额未披露，结论是继续观察。");
      expect(events).toContainEqual(expect.objectContaining({ type: "recovery", reason: "network", action: "continue" }));
      // 存进模型历史的是一条完整回答，没有续写用的那句系统说明。
      expect(JSON.stringify(result?.runtimeEntries)).not.toContain("上面这条回答在输出途中因为连接中断");
    } finally { await t.runtime.close?.(); }
  });

  it("快答档（GPT）网关 503 还没出字：同档净化历史重试一次，仍失败就换备用模型（Sonnet），本轮答完", async () => {
    const t = await harness((seen) => (seen.model === "gpt-5.6-sol"
      ? { error: 'OpenAI API error (503): {"message":"Unknown service error","type":"aigateway_error","code":"unknown_service_err"}' }
      : { text: ["待决策议题 3 个。"] }));
    try {
      const { result, events } = await t.turn(QUICK_Q);
      expect(t.seen.map((call) => call.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol", "claude-sonnet-5-5"]);
      expect(result?.assistantMessage).toBe("待决策议题 3 个。");
      expect(events.filter((event) => event.type === "recovery").map((event) => (event as { action: string }).action)).toEqual(["retry", "fallback"]);
      // 档位记录不变：下一轮快答仍先用 GPT。
      expect(JSON.stringify(result?.runtimeEntries)).toContain('"tier":"quick","modelId":"gpt-5.6-sol"');
    } finally { await t.runtime.close?.(); }
  });

  it("恢复用尽仍失败：抛出带分类的错误，已写出的正文作为一条回答进模型历史，下一轮照常接上", async () => {
    let fail = true;
    const t = await harness(() => (fail ? { text: ["写了半句"], error: "fetch failed" } : { text: ["接着说。"] }));
    try {
      const failed = await t.turn(QUICK_Q);
      expect(failed.error).toBeInstanceOf(ConversationTurnError);
      expect(failed.error).toMatchObject({ kind: "network" });
      expect(streamed(failed.events)).toBe("写了半句".repeat(t.seen.length));
      const entries = failed.error!.runtimeEntries as { type: string; message?: { role: string; content: { type: string; text?: string }[]; stopReason?: string } }[];
      const last = entries.at(-1)!;
      expect(last).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "stop" } });
      expect(last.message!.content).toEqual([{ type: "text", text: "写了半句".repeat(t.seen.length) }]);
      fail = false;
      const calls = t.seen.length;
      const next = await t.turn("然后呢");
      expect(next.error).toBeUndefined();
      expect(next.events.some((event) => event.type === "warning")).toBe(false);
      // 下一轮的模型看得到上一轮提问和已写出的部分。
      const history = t.seen[calls].context.messages;
      expect(history.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.startsWith("写了半句")))).toBe(true);
    } finally { await t.runtime.close?.(); }
  });

  it("一个工具卡住：超过时限按工具出错交还模型，一轮照常答完", async () => {
    const t = await harness((_seen, index) => (index === 0
      ? { tool: { id: "call_1|fc_1", name: "list_pending_issues", arguments: {} } }
      : { text: ["待决策议题这次没读到。"] }), {
      toolTimeoutMs: 30,
      listPendingIssues: () => new Promise(() => undefined),
    });
    try {
      const { result, events } = await t.turn(QUICK_Q);
      expect(result?.assistantMessage).toBe("待决策议题这次没读到。");
      expect(events).toContainEqual(expect.objectContaining({ type: "tool", phase: "completed", name: "list_pending_issues", isError: true }));
      const toolResult = t.seen[1].context.messages.find((message) => message.role === "toolResult");
      expect(JSON.stringify(toolResult)).toContain("超过 0 秒没有返回，已跳过");
    } finally { await t.runtime.close?.(); }
  });

  it("历史很长（用量接近 12.8 万）：这一轮不当场压缩、不调用压缩模型、不告诉界面任何压缩，走窗口兜底照常回答", async () => {
    let turn = 0;
    const t = await harness((seen) => {
      if (isCompaction(seen)) return { error: "不该调用" };
      turn += 1;
      // 前两轮（检索问答档，Sonnet）用量接近 12.8 万；以前第三轮开头会先压缩 20 秒，现在压缩只在后台做（conversationCompaction.ts）。
      return turn <= 2 ? { text: [`第${turn}轮。${"很长的内容".repeat(2_000)}`], input: 125_000 } : { text: ["第三轮照常回答。"] };
    });
    try {
      await t.turn(GROUNDED_Q);
      await t.turn("再说说");
      const { result, events } = await t.turn("还有呢");
      expect(result?.assistantMessage).toBe("第三轮照常回答。");
      expect(t.seen.some(isCompaction)).toBe(false);
      expect(t.seen.some((call) => call.model === "fake-compaction")).toBe(false);
      expect(events.some((event) => event.type === "compaction" || (event.type === "recovery" && event.reason === "compaction"))).toBe(false);
      // 存下来的历史不变（两轮原文都在），只多一条窗口标记，没有压缩记录。
      expect(JSON.stringify(result?.runtimeEntries)).toContain("第1轮。");
      expect(JSON.stringify(result?.runtimeEntries)).toContain("warmap.history-window");
      expect(JSON.stringify(result?.runtimeEntries)).not.toContain('"type":"compaction"');
    } finally { await t.runtime.close?.(); }
  });

  it("「继续」：沿用那一轮的档位、不分诊、不给开场说明，续写说明放进上下文包", async () => {
    let triaged = 0;
    const t = await harness(() => ({ text: ["接着写完。"] }), { triage: async () => { triaged += 1; return { tier: "deep" as const, topic: "不该用到" }; } });
    try {
      const events: ConversationRuntimeEvent[] = [];
      const result = await t.runtime.run({ scope: "global", viewer: CEO_VIEWER, message: "继续", currentObject: null, referencesSnapshot: [], runtimeEntries: [],
        piSessionId: "33333333-3333-4333-8333-333333333333", signal: new AbortController().signal, emit: (event) => events.push(event),
        resume: { tier: "grounded", question: GROUNDED_Q, instruction: "上一轮回答在中途中断了，请接着写。" } });
      expect(triaged).toBe(0);
      expect(events[0]).toMatchObject({ type: "route", tier: "grounded" });
      expect((events[0] as { notice?: string }).notice).toBeUndefined();
      expect(t.seen[0].model).toBe("claude-sonnet-5-5");
      expect(JSON.parse(lastUserText(t.seen[0].context))).toMatchObject({ resume: "上一轮回答在中途中断了，请接着写。", message: "继续" });
      expect(result.assistantMessage).toBe("接着写完。");
    } finally { await t.runtime.close?.(); }
  });
});

describe("后台压缩写摘要用的模型（不在任何一轮里）", () => {
  const summaryCall = (t: Awaited<ReturnType<typeof harness>>) => t.runtime.summarizeHistory!({ systemPrompt: "整理对话记忆", prompt: "对话记录", signal: new AbortController().signal });

  it("用 COMPACTION_MODEL，不开缓存写入；不额外调用 Claude", async () => {
    const t = await harness(() => ({ text: ["## 一号位的决定与表态\n- 无"] }));
    try {
      const result = await summaryCall(t);
      expect(result).toMatchObject({ model: "fake-compaction", text: expect.stringContaining("一号位的决定") });
      expect(t.seen).toHaveLength(1);
      expect(t.seen[0]).toMatchObject({ model: "fake-compaction", options: expect.objectContaining({ cacheRetention: "none" }) });
    } finally { await t.runtime.close?.(); }
  });
});

describe("最近一轮主答是不是 Claude", () => {
  const answer = (model: string, api: string) => ({ type: "message", message: { role: "assistant", model, api, content: [], usage: usage(), stopReason: "stop", timestamp: 0 } });
  const asked = { type: "message", message: { role: "user", content: "问题", timestamp: 0 } };
  const branch = (...entries: unknown[]) => entries as Parameters<typeof latestAnswerIsClaude>[0];

  it("混着几个档位时按最近那一轮算", () => {
    expect(latestAnswerIsClaude(branch(asked, answer("gpt-5.6-sol", "openai-responses"), asked, answer("claude-sonnet-5-5", "anthropic-messages")))).toBe(true);
    expect(latestAnswerIsClaude(branch(asked, answer("claude-opus-5-5", "anthropic-messages"), asked, answer("gpt-5.6-sol", "openai-responses"), asked))).toBe(false);
    expect(latestAnswerIsClaude(branch(asked))).toBe(false);
  });
});

describe("恢复汇总与闲置重开（真 pi 会话）", () => {
  it("换了备用模型答完：结果带恢复汇总（原模型、备用模型、原因、各类次数）", async () => {
    const t = await harness((seen) => (seen.model === "gpt-5.6-sol" ? { error: "OpenAI API error (503)" } : { text: ["待决策议题 3 个。"] }));
    try {
      const { result } = await t.turn(QUICK_Q);
      expect(result?.recoverySummary).toEqual({ originalModel: "gpt-5.6-sol", fallbackModel: "claude-sonnet-5-5", reasons: ["upstream"],
        actions: { retry: 1, fallback: 1 }, retries: 2 });
      const clean = await harness(() => ({ text: ["好。"] }));
      try { expect((await clean.turn(QUICK_Q)).result?.recoverySummary).toBeUndefined(); } finally { await clean.runtime.close?.(); }
    } finally { await t.runtime.close?.(); }
  });

  it("闲置重开：新会话只带压缩摘要和最近几轮问答的文字，不回放之前的工具往返；会话 id 换新", async () => {
    const t = await harness((seen, index) => (index === 0
      ? { tool: { id: "call-old-1", name: "search_people", arguments: {} } }
      : { text: [index === 1 ? "旧回答。" : "新回答。"] }));
    try {
      await t.turn(QUICK_Q);
      expect(JSON.stringify(t.entries())).toContain("call-old-1");
      const oldSession = t.sessionId();
      // 上一段会话压缩过：最近一次压缩摘要会带进新会话。
      const manager = SessionManager.inMemory(process.cwd(), { id: oldSession }, structuredClone(t.entries()) as Parameters<typeof SessionManager.inMemory>[2]);
      manager.appendCompaction("此前讨论的重点是增长战场本月目标。", "", 1000);
      t.setEntries([manager.getHeader(), ...manager.getEntries()]);
      expect(latestCompactionSummary(t.entries(), oldSession)).toBe("此前讨论的重点是增长战场本月目标。");

      const long = "很长的回答".repeat(400);
      const recentMessages = [
        { role: "user" as const, content: QUICK_Q, createdAt: "2026-10-12T09:00:00.000Z" },
        { role: "assistant" as const, content: long, createdAt: "2026-10-12T09:00:05.000Z" },
      ];
      const { result } = await t.turn("隔天再问一个", { idleRestart: true, recentMessages });
      expect(result?.assistantMessage).toBe("新回答。");
      expect(result?.piSessionId).not.toBe(oldSession);
      const sent = JSON.stringify(t.seen.at(-1)!.context.messages);
      expect(sent).not.toContain("call-old-1");
      expect(sent).toContain("此前讨论的重点是增长战场本月目标。");
      expect(sent).toContain(QUICK_Q);
      expect(sent).not.toContain(long);
      expect(sent).toContain(`${long.slice(0, IDLE_RESTART_MESSAGE_CHARS)}…`);
      // 存下的是新会话：旧的工具往返不在里面，之后的轮次接着新会话走。
      expect(JSON.stringify(result?.runtimeEntries)).not.toContain("call-old-1");
    } finally { await t.runtime.close?.(); }
  });

  it("没有压缩过：只带最近几轮问答的文字；从一条提问开始", () => {
    const manager = SessionManager.inMemory(process.cwd(), { id: "44444444-4444-4444-8444-444444444444" });
    const at = "2026-10-12T09:00:00.000Z";
    seedIdleRestart(manager, undefined, [
      { role: "assistant", content: "更早的回答", createdAt: at },
      ...Array.from({ length: 4 }, (_, index) => [
        { role: "user" as const, content: `问${index}`, createdAt: at },
        { role: "assistant" as const, content: `答${index}`, createdAt: at },
      ]).flat(),
    ], "gpt-5.6-sol", "openai-responses", "warmap");
    const messages = manager.buildSessionContext().messages as { role: string; content: unknown }[];
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(messages)).toContain("问1");
    expect(JSON.stringify(messages)).not.toContain("问0");
    expect(latestCompactionSummary([], "44444444-4444-4444-8444-444444444444")).toBeUndefined();
  });
});
