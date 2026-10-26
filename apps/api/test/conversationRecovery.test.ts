import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import {
  CONTINUE_AFTER_BREAK, ConversationTurnError, captureStreamErrors, classifyFailure, createTurnRecovery, recoveringStream, recoveryNote, recoveryNotice, resumeInstruction,
  summarizeRecovery, turnFailureCopy, turnRecovery, type RecoveryEvent,
} from "../src/conversationRecovery.js";
import type { HistoryMode } from "../src/conversationStream.js";

/**
 * 自动恢复（10/13 P0）：上游出什么错，已经流出的正文都不丢；能自动恢复的就地恢复，agent 看到的是一次成功的调用。
 */
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = (id: string, api: "openai-responses" | "anthropic-messages" = "openai-responses") =>
  ({ id, name: id, api, provider: api === "anthropic-messages" ? "warmap-anthropic" : "warmap", baseUrl: "https://gateway.invalid", reasoning: true,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 }) as Model<any>;
const GPT = model("gpt-5.6-sol");
const SONNET = model("claude-sonnet-5-5", "anthropic-messages");
const context: Context = { systemPrompt: "系统", messages: [{ role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }], tools: [] };

type Script = { text?: string[]; thinking?: string[]; error?: string; stop?: AssistantMessage["stopReason"]; hang?: boolean };
function message(target: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return { role: "assistant", api: target.api, provider: target.provider, model: target.id, content: text ? [{ type: "text", text }] : [],
    usage, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now() };
}
/** 按脚本流出：先思考、再正文，然后成功 / 出错 / 一直挂着（直到被中止）。 */
function scripted(target: Model<any>, script: Script, signal?: AbortSignal) {
  const out = createAssistantMessageEventStream();
  void (async () => {
    const partial = message(target, "", "pending");
    out.push({ type: "start", partial });
    let text = "";
    for (const delta of script.thinking ?? []) {
      out.push({ type: "thinking_start", contentIndex: 0, partial });
      out.push({ type: "thinking_delta", contentIndex: 0, delta, partial });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (const delta of script.text ?? []) {
      text += delta;
      out.push({ type: "text_delta", contentIndex: 0, delta, partial });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (script.hang) {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      out.push({ type: "error", reason: "aborted", error: message(target, text, "aborted", "Request was aborted") });
      out.end();
      return;
    }
    if (script.error) out.push({ type: "error", reason: "error", error: message(target, text, "error", script.error) });
    else out.push({ type: "done", reason: (script.stop ?? "stop") as "stop", message: message(target, text, script.stop ?? "stop") });
    out.end();
  })();
  return out;
}

type Call = { model: string; mode?: HistoryMode; messages: Context["messages"]; toolChoice?: string; reasoning?: string };
function harness(scripts: Script[]) {
  const calls: Call[] = [];
  const stream = recoveringStream((target, ctx, options, mode) => {
    calls.push({ model: target.id, mode, messages: ctx.messages, toolChoice: options?.toolChoice, reasoning: options?.reasoning });
    return scripted(target, scripts[calls.length - 1] ?? { error: "no more scripts" }, options?.signal);
  }, { sleep: async () => undefined });
  return { calls, stream };
}
async function drain(stream: ReturnType<typeof createAssistantMessageEventStream>) {
  const events: string[] = [];
  let text = "";
  for await (const event of stream) {
    events.push(event.type);
    if (event.type === "text_delta") text += event.delta;
  }
  return { events, text, result: await stream.result() };
}
function turn(candidates: Model<any>[], extra: Partial<Parameters<typeof createTurnRecovery>[0]> = {}) {
  const emitted: RecoveryEvent[] = [];
  const state = createTurnRecovery({ emit: (event) => emitted.push(event), candidates, mainModelIds: new Set(candidates.map((item) => item.id)), ...extra });
  return { state, emitted };
}

describe("一次模型调用出错时就地恢复", () => {
  it("还没写出正文（例如网关 503）：同一个模型净化历史重试，成功后 agent 只看到一次成功的调用", async () => {
    const { calls, stream } = harness([{ error: 'OpenAI API error (503): {"code":"unknown_service_err"}' }, { text: ["结论。"] }]);
    const { state, emitted } = turn([GPT, SONNET]);
    const { events, text, result } = await turnRecovery.run(state, () => drain(stream(GPT, context, {})));
    expect(calls.map((call) => [call.model, call.mode])).toEqual([["gpt-5.6-sol", "normal"], ["gpt-5.6-sol", "sanitized"]]);
    expect(events.filter((type) => type === "start")).toHaveLength(1);
    expect(events.at(-1)).toBe("done");
    expect(text).toBe("结论。");
    expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "结论。" }] });
    expect(emitted).toEqual([expect.objectContaining({ type: "recovery", reason: "upstream", action: "retry", attempt: 2 })]);
    expect(state.history).toBe("sanitized");
  });

  it("同一个模型连着失败：换备用模型（另一家），本轮后面的调用直接从它开始", async () => {
    const { calls, stream } = harness([{ error: "OpenAI API error (503)" }, { error: "OpenAI API error (503)" }, { text: ["备用模型的回答。"] }, { text: ["下一步。"] }]);
    const { state, emitted } = turn([GPT, SONNET]);
    const first = await turnRecovery.run(state, () => drain(stream(GPT, context, {})));
    expect(first.result.model).toBe("claude-sonnet-5-5");
    expect(calls.map((call) => call.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol", "claude-sonnet-5-5"]);
    // 快答档没有思考强度，换到 Claude 时给 low（Claude 5.5 不接受关思考）。
    expect(calls[2].reasoning).toBe("low");
    expect(emitted.map((event) => event.action)).toEqual(["retry", "fallback"]);
    expect(emitted[1].notice).toBe("模型服务这次没有响应，换用备用模型继续（第 2 次）");
    await turnRecovery.run(state, () => drain(stream(GPT, context, {})));
    expect(calls.at(-1)?.model).toBe("claude-sonnet-5-5");
  });

  it("已经写出正文后连接断了（terminated）：不重来，从断点续写，合成一条完整回答，界面上的字一个不少", async () => {
    const { calls, stream } = harness([{ thinking: ["想一想"], text: ["第一段，", "写到一半"], error: "terminated" }, { text: ["，接着写完。"] }]);
    const { state, emitted } = turn([SONNET, GPT]);
    const { text, result } = await turnRecovery.run(state, () => drain(stream(SONNET, context, { reasoning: "low" })));
    expect(text).toBe("第一段，写到一半，接着写完。");
    expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "第一段，写到一半，接着写完。" }] });
    // 续写请求：原历史 + 已写出的部分（助手）+ 续写说明（用户），不带工具。
    const resumed = calls[1];
    expect(resumed.toolChoice).toBe("none");
    expect(resumed.messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "第一段，写到一半" }], stopReason: "stop" }),
      expect.objectContaining({ role: "user", content: [{ type: "text", text: CONTINUE_AFTER_BREAK }] }),
    ]);
    expect(emitted).toEqual([expect.objectContaining({ reason: "network", action: "continue", notice: "和模型服务的网络连接中断了，正在从断点接着写（第 1 次）" })]);
  });

  it("连续 90 秒（这里 30 毫秒）没有任何新事件才算卡住：中止这一次请求再来；持续有思考流入不打断", async () => {
    const { calls, stream } = harness([{ thinking: ["想", "想", "想"], hang: true }, { text: ["好了。"] }]);
    const { state, emitted } = turn([GPT], { idleMs: 30 });
    const { text } = await turnRecovery.run(state, () => drain(stream(GPT, context, {})));
    expect(text).toBe("好了。");
    expect(calls).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ reason: "stalled", action: "retry" });
  });

  it("写到单次输出上限：自动接着写", async () => {
    const { calls, stream } = harness([{ text: ["很长的前半段"], stop: "length" }, { text: ["后半段。"] }]);
    const { state } = turn([GPT]);
    const { text, result } = await turnRecovery.run(state, () => drain(stream(GPT, context, {})));
    expect(text).toBe("很长的前半段后半段。");
    expect(result.stopReason).toBe("stop");
    expect(calls[1].toolChoice).toBe("none");
  });

  it("一号位停止、凭证失效不重试；放弃时已写出的正文留在失败消息里", async () => {
    const controller = new AbortController();
    const { calls, stream } = harness([{ text: ["写了一点"], hang: true }]);
    const { state } = turn([GPT, SONNET]);
    const running = turnRecovery.run(state, () => drain(stream(GPT, context, { signal: controller.signal })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const { result } = await running;
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ stopReason: "aborted", content: [{ type: "text", text: "写了一点" }] });

    const auth = harness([{ error: "401 Unauthorized: invalid api key" }]);
    const second = turn([GPT, SONNET]);
    const failed = await turnRecovery.run(second.state, () => drain(auth.stream(GPT, context, {})));
    expect(auth.calls).toHaveLength(1);
    expect(failed.result).toMatchObject({ stopReason: "error" });
  });

  it("恢复用尽仍失败：给 agent 一个出错的结束事件（带已写出的正文），一轮不会卡住", async () => {
    const { calls, stream } = harness(Array.from({ length: 8 }, () => ({ text: ["半句"], error: "fetch failed" })));
    const { state } = turn([GPT, SONNET]);
    const { result, text } = await turnRecovery.run(state, () => drain(stream(GPT, context, {})));
    expect(calls.length).toBe(5);
    expect(text).toBe("半句".repeat(5));
    expect(result).toMatchObject({ stopReason: "error", content: [{ type: "text", text: "半句".repeat(5) }] });
    expect(state.failures.map((failure) => failure.kind)).toEqual(["network", "network", "network", "network", "network"]);
  });

  it("模型服务拒收内容（content_filter）：只换一次备用模型，不在同一个模型上重试", async () => {
    const { calls, stream } = harness([{ error: "Response incomplete: content_filter" }, { text: ["换个模型答了。"] }]);
    const { state } = turn([GPT, SONNET]);
    const { text } = await turnRecovery.run(state, () => drain(stream(GPT, context, {})));
    expect(calls.map((call) => call.model)).toEqual(["gpt-5.6-sol", "claude-sonnet-5-5"]);
    expect(text).toBe("换个模型答了。");
    const single = harness([{ error: "Response incomplete: content_filter" }]);
    const alone = turn([GPT]);
    await turnRecovery.run(alone.state, () => drain(single.stream(GPT, context, {})));
    expect(single.calls).toHaveLength(1);
  });

  it("没有本轮状态（压缩摘要等辅助调用）：只做同模型重试，最多三次", async () => {
    const { calls, stream } = harness([{ error: "fetch failed" }, { error: "fetch failed" }, { error: "fetch failed" }, { text: ["不会走到这里"] }]);
    const { result } = await drain(stream(GPT, context, {}));
    expect(calls.map((call) => call.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-sol"]);
    expect(result.stopReason).toBe("error");
  });
});

describe("出错的分类与给一号位的说明", () => {
  it("把 SDK 的英文报错归成几类", () => {
    expect(classifyFailure("terminated")).toBe("network");
    expect(classifyFailure("fetch failed")).toBe("network");
    expect(classifyFailure('OpenAI API error (503): {"message":"Unknown service error","type":"aigateway_error","code":"unknown_service_err"}')).toBe("upstream");
    expect(classifyFailure("429 Too Many Requests")).toBe("rate_limited");
    expect(classifyFailure("overloaded_error")).toBe("rate_limited");
    expect(classifyFailure("400 prompt is too long: 230000 tokens > 200000 maximum")).toBe("context");
    expect(classifyFailure("401 invalid x-api-key")).toBe("auth");
    expect(classifyFailure("400 messages.1.content.0: Invalid signature in thinking block")).toBe("rejected");
    expect(classifyFailure("Response incomplete: content_filter")).toBe("content_filter");
    expect(classifyFailure("whatever", { stalled: true })).toBe("stalled");
    // 网关流里只回一个空的错误事件（10/26）：按上游异常；错误事件里说清了原因的照原因归类。
    expect(classifyFailure("Error Code undefined: undefined")).toBe("upstream");
    expect(classifyFailure('Error Code undefined: undefined {"type":"error","sequence_number":3}')).toBe("upstream");
    expect(classifyFailure("Error Code context_length_exceeded: Your input exceeds the context window")).toBe("context");
    expect(classifyFailure("Error Code undefined: undefined")).not.toBe("unknown");
  });

  it("网关流里的错误事件原文留下来：回包一个字节不改地交给 pi，事件跨数据块也认得出", async () => {
    const encoder = new TextEncoder();
    const chunks = ['data: {"type":"response.created"}\n\n', 'data: {"type":"err', 'or","error":{"type":"server_error","message":"upstream busy"}}\n\n'];
    const base = async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } });
    const capture = captureStreamErrors(base as typeof fetch);
    const response = await capture.fetch("https://gateway.invalid/responses");
    expect(await response.text()).toBe(chunks.join(""));
    expect(capture.event()).toBe('{"type":"error","error":{"type":"server_error","message":"upstream busy"}}');
    // 不是流式回包（例如 4xx 的 JSON）原样返回，不留事件。
    const plain = captureStreamErrors(async () => new Response("{}", { status: 400, headers: { "content-type": "application/json" } }));
    expect((await plain.fetch("https://gateway.invalid/responses")).status).toBe(400);
    expect(plain.event()).toBeUndefined();
  });

  it("恢复日志带上网关的错误事件原文，并按上游异常换备用模型", async () => {
    const encoder = new TextEncoder();
    const logged: Record<string, unknown>[] = [];
    const sse = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"type":"error"}\n\n')); controller.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } });
    let calls = 0;
    const stream = recoveringStream((target, _ctx, options) => {
      calls += 1;
      const out = createAssistantMessageEventStream();
      void (async () => {
        // 像 pi 一样经 options.fetch 发请求、读完回包，再报出它那句只有 code、message 的错误。
        if (calls <= 2) await (await options!.fetch!("https://gateway.invalid/responses")).text();
        const failed = calls <= 2;
        out.push(failed
          ? { type: "error", reason: "error", error: message(target, "", "error", "Error Code undefined: undefined") }
          : { type: "done", reason: "stop", message: message(target, "备用模型的回答。", "stop") });
        out.end();
      })();
      return out;
    }, { sleep: async () => undefined });
    const { state } = turn([GPT, model("gpt-5.6-terra")], { log: (entry) => logged.push(entry) });
    const { result } = await turnRecovery.run(state, () => drain(stream(GPT, context, { fetch: sse as typeof fetch })));
    expect(result.model).toBe("gpt-5.6-terra");
    expect(logged[0]).toMatchObject({ event: "conversation.recovery", kind: "upstream", error: "Error Code undefined: undefined", upstreamEvent: '{"type":"error"}' });
  });

  it("说明具体、可操作，不出现英文原文，也没有笼统的「暂不可用」", () => {
    const kinds = ["network", "upstream", "stalled", "rate_limited", "context", "rejected", "auth", "content_filter", "length", "search_budget", "turn_timeout", "turn_stalled", "internal", "unknown"] as const;
    for (const kind of kinds) for (const partial of [true, false]) {
      const copy = turnFailureCopy(kind, { partial, recoveries: 2 });
      expect(copy.message).not.toMatch(/暂不可用|[A-Za-z]{4,}/);
      expect(copy.code).toMatch(/^[A-Z_]+$/);
      if (copy.resume === "continue") expect(copy.message).toContain("点「继续」");
      if (copy.resume === "retry") expect(copy.message).toContain("点「重新回答」");
    }
    expect(turnFailureCopy("network", { partial: true, recoveries: 3 })).toEqual({ code: "NETWORK_INTERRUPTED", resume: "continue",
      message: "和模型服务的网络连接中断了，已自动恢复 3 次仍未成功（多半是本机网络或代理切换）。已写出的部分保留在上方，点「继续」从断点接着写。" });
    expect(turnFailureCopy("auth", { partial: false }).resume).toBeUndefined();
    expect(recoveryNotice("upstream", "retry", 1)).toBe("模型服务这次没有响应，正在重试（第 1 次）");
  });

  it("「继续」的说明：有已写出的部分就从结尾接着写（不把末尾的说明行算进正文），没有就完整重答", () => {
    const resumed = resumeInstruction("集团该怎么定位？", "开场。\n\n已经写到这里\n\n（这次回答在这里中断了，以上是已经写出的部分。）", "deep");
    expect(resumed).toMatchObject({ tier: "deep", question: "集团该怎么定位？" });
    expect(resumed.instruction).toContain("结尾是「开场。\n\n已经写到这里」");
    expect(resumed.instruction).toContain("不要重复已经写出的内容");
    const retry = resumeInstruction("集团该怎么定位？", undefined, "nonsense");
    expect(retry.tier).toBeUndefined();
    expect(retry.instruction).toContain("请完整回答这个问题");
  });

  it("运行时放弃时抛出的错误带着分类和要存的模型历史", () => {
    const error = new ConversationTurnError("terminated", "network", { runtimeEntries: [{ type: "session" }], code: "X" });
    expect(error).toMatchObject({ kind: "network", code: "X", runtimeEntries: [{ type: "session" }], message: "terminated" });
  });
});

describe("一轮走过恢复的汇总与回答末尾那行说明", () => {
  it("换了备用模型：汇总记下原模型、备用模型、原因与次数；说明不写模型名", async () => {
    const { stream } = harness([{ error: "OpenAI API error (503)" }, { error: "OpenAI API error (503)" }, { text: ["备用模型的回答。"] }]);
    const { state } = turn([GPT, SONNET]);
    await turnRecovery.run(state, () => drain(stream(GPT, context, {})));
    const summary = summarizeRecovery(state);
    expect(summary).toEqual({ originalModel: "gpt-5.6-sol", fallbackModel: "claude-sonnet-5-5", reasons: ["upstream"], actions: { retry: 1, fallback: 1 }, retries: 2 });
    const note = recoveryNote(summary)!;
    expect(note.text).toBe("本轮因上游异常改由备用模型完成");
    expect(note.detail).toBe("原因：模型服务这次没有响应。处理：换用备用模型 1 次，自动重试 1 次。");
    expect(`${note.text}${note.detail}`).not.toMatch(/gpt|claude|sonnet|503/i);
  });

  it("正文中途断了、从断点续写：同一个模型完成，说明写「中途重连一次，已续写」", async () => {
    const { stream } = harness([{ text: ["写到一半"], error: "terminated" }, { text: ["，写完。"] }]);
    const { state } = turn([SONNET, GPT]);
    await turnRecovery.run(state, () => drain(stream(SONNET, context, { reasoning: "low" })));
    const summary = summarizeRecovery(state)!;
    expect(summary).toMatchObject({ originalModel: "claude-sonnet-5-5", reasons: ["network"], actions: { continue: 1 }, retries: 1 });
    expect(summary.fallbackModel).toBeUndefined();
    expect(recoveryNote(summary)).toEqual({ text: "本轮中途重连一次，已续写", detail: "原因：和模型服务的网络连接中断了。处理：从断点续写 1 次。" });
  });

  it("没有恢复过就没有汇总也没有说明；只是回答太长续写、精简历史、多次续写各有各的写法", () => {
    expect(summarizeRecovery({ candidates: [GPT], recoveries: 0, steps: [], failures: [] })).toBeUndefined();
    expect(recoveryNote(undefined)).toBeUndefined();
    const base = { originalModel: "gpt-5.6-sol", retries: 1 };
    expect(recoveryNote({ ...base, reasons: ["length"], actions: { continue: 1 } })?.text).toBe("本轮回答较长，已自动续写完成");
    expect(recoveryNote({ ...base, reasons: ["context"], actions: { trim: 1 } })?.text).toBe("本轮精简了较早的对话历史后完成");
    expect(recoveryNote({ ...base, reasons: ["network"], actions: { continue: 2 }, retries: 2 })?.text).toBe("本轮中途重连 2 次，已续写");
    expect(recoveryNote({ ...base, reasons: ["upstream"], actions: { retry: 1 } })?.text).toBe("本轮遇到上游异常，已自动重试完成");
  });
});
