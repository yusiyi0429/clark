import { describe, expect, it } from "vitest";
import type { Context, Model } from "@earendil-works/pi-ai";
import { conversationStreamSimple, historyFor, minimalHistory, withoutUpstreamItemIds } from "../src/conversationStream.js";

/**
 * 10/13 一号位对话「出卡一直失败」的根因（离线重放演示 12 那段历史定位）：
 * 走 Responses 的 gpt-5.6-sol 收到早先轮次里上游生成的条目身份（msg_ / fc_ id、加密推理）时，网宿网关隔 16–24 秒回 503 unknown_service_err。
 * 这些身份只回传本轮的；此前各轮只回传文字、工具调用与结果本身。
 */
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const GPT = { id: "gpt-5.6-sol", name: "gpt-5.6-sol", api: "openai-responses", provider: "warmap", baseUrl: "https://gateway.invalid/v2/llm", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 } as Model<"openai-responses">;
const CLAUDE = { ...GPT, id: "claude-opus-5-5", name: "claude-opus-5-5", api: "anthropic-messages", provider: "warmap-anthropic" } as unknown as Model<"anthropic-messages">;
const gpt = (content: unknown[], stopReason: "stop" | "toolUse" = "stop") =>
  ({ role: "assistant", api: "openai-responses", provider: "warmap", model: "gpt-5.6-sol", content, usage, stopReason, timestamp: 2 });
const reasoningItem = JSON.stringify({ type: "reasoning", id: "rs_05cbe9d9e660b789006acdec5e611881958c52f6eeb6c5ab9e", summary: [], encrypted_content: "gAAAA-old" });
const textSig = (id: string) => JSON.stringify({ v: 1, id, phase: "final_answer" });

/** 和演示 12 同形的一段历史：两轮旧的 GPT 回答（带推理、工具调用、msg id），本轮提问后已有一次工具往返。 */
const history = [
  { role: "user", content: [{ type: "text", text: "第一问" }], timestamp: 1 },
  gpt([{ type: "text", text: "第一答", textSignature: textSig("msg_00cf431ec743577c006acdfe80d7b08190a33490f837a27ea3") }]),
  { role: "user", content: [{ type: "text", text: "第二问" }], timestamp: 3 },
  gpt([{ type: "thinking", thinking: "", thinkingSignature: reasoningItem },
    { type: "toolCall", id: "call_uO5UUO9b0opmvNZgjqO393ck|fc_05cbe9d9e660b789006acdec61262c8195b5e681be821ced9d", name: "web_search", arguments: { query: "q" } }], "toolUse"),
  { role: "toolResult", toolCallId: "call_uO5UUO9b0opmvNZgjqO393ck|fc_05cbe9d9e660b789006acdec61262c8195b5e681be821ced9d", toolName: "web_search", content: [{ type: "text", text: "结果" }], isError: false, timestamp: 4 },
  gpt([{ type: "text", text: "第二答", textSignature: textSig("msg_05cbe9d9e660b789006acdec64c18c8195be41562d1545605f") }]),
  { role: "user", content: [{ type: "text", text: "你能直接将这些议题更新到战场里去吗" }], timestamp: 5 },
  gpt([{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_current", summary: [], encrypted_content: "gAAAA-now" }) },
    { type: "toolCall", id: "call_now|fc_now", name: "read_business_object", arguments: { type: "battlefield", id: "tk" } }], "toolUse"),
  { role: "toolResult", toolCallId: "call_now|fc_now", toolName: "read_business_object", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 6 },
] as Context["messages"];

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}
const completed = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_new", role: "assistant", content: [] } },
  { type: "response.output_text.delta", output_index: 0, delta: "好的。" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_new", role: "assistant", content: [{ type: "output_text", text: "好的。" }] } },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
];

describe("回传给 Responses 上游的历史不带早先轮次的条目身份", () => {
  it("此前各轮：去掉推理条目、msg_ id、fc_ id；工具调用与结果按 call_id 配对，文字原样", () => {
    const cleaned = withoutUpstreamItemIds(history, GPT);
    const text = JSON.stringify(cleaned.slice(0, 6));
    expect(text).not.toMatch(/msg_00cf|msg_05cb|rs_05cb|gAAAA-old|fc_05cb/);
    expect(cleaned[3]).toMatchObject({ content: [{ type: "toolCall", id: "call_uO5UUO9b0opmvNZgjqO393ck", name: "web_search" }] });
    expect(cleaned[4]).toMatchObject({ role: "toolResult", toolCallId: "call_uO5UUO9b0opmvNZgjqO393ck" });
    expect(cleaned[1]).toMatchObject({ content: [{ type: "text", text: "第一答" }] });
    // 本轮的工具往返原样（同一上游实例里的推理延续）。
    expect(cleaned.slice(6)).toEqual(history.slice(6));
    // 出错后的重试（sanitized）：本轮的也去掉。
    expect(JSON.stringify(withoutUpstreamItemIds(history, GPT, "sanitized"))).not.toMatch(/fc_now|rs_current|gAAAA-now/);
    // Claude 目标：normal 不动；sanitized 只去掉此前各轮的思考块（本轮最后一次工具调用的思考块必须带着）。
    expect(withoutUpstreamItemIds(history, CLAUDE)).toBe(history);
  });

  it("真实 pi 请求体（openai-responses）：发出去的 input 里没有旧的 msg_ / fc_ / rs_ 身份", async () => {
    let body: { input: Record<string, unknown>[] } | undefined;
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return sse(completed);
    };
    const stream = conversationStreamSimple(undefined)(GPT, { systemPrompt: "系统", messages: history, tools: [] },
      { apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, sessionId: "s1" });
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    const input = body!.input;
    const ids = input.map((item) => item.id).filter(Boolean);
    expect(ids.some((id) => /^msg_(00cf|05cb)/.test(String(id)))).toBe(false);
    expect(input.filter((item) => item.type === "reasoning").map((item) => item.id)).toEqual(["rs_current"]);
    expect(input.filter((item) => item.type === "function_call").map((item) => [item.call_id, item.id])).toEqual([
      ["call_uO5UUO9b0opmvNZgjqO393ck", undefined], ["call_now", "fc_now"]]);
    expect(input.filter((item) => item.type === "function_call_output").map((item) => item.call_id)).toEqual(["call_uO5UUO9b0opmvNZgjqO393ck", "call_now"]);
  });

  it("精简历史（最后一档重试）：此前各轮只留文字、最近几轮和开头的压缩摘要，本轮原样", () => {
    const summary = { role: "user", content: [{ type: "text", text: "The conversation history before this point was compacted into the following summary: …" }], timestamp: 0 };
    const minimal = minimalHistory([summary, ...history] as Context["messages"]);
    expect(minimal.map((message) => message.role)).toEqual(["user", "user", "assistant", "user", "assistant", "user", "assistant", "toolResult"]);
    expect(JSON.stringify(minimal.slice(0, 5))).not.toMatch(/toolCall|thinking|textSignature/);
    expect(historyFor(history, GPT, "minimal").at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call_now" });
  });
});
