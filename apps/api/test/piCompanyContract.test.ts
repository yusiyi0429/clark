import { afterEach, expect, test } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import type { CompanyRequest } from "../src/company.js";
import { configureLangSmith, flushLangSmith, withTurnTrace } from "../src/langsmith.js";
import { captureTraceTransport } from "./langsmithTransport.js";

const viewer = { personId: "contract-ceo", displayName: "契约测试", role: "ceo" as const };
const body = "本轮授权公司参考正文";

function stream(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
  const events = createAssistantMessageEventStream();
  const final: AssistantMessage = {
    role: "assistant", api: "openai-responses", provider: "warmap", model: "controlled", content, stopReason, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    const block = content[0];
    if (block.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: 0, partial: final });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: final });
      events.push({ type: "done", reason: "toolUse", message: final });
    } else events.push({ type: "done", reason: "stop", message: final });
  });
  return events;
}

async function runCalls(args: Record<string, string>[]) {
  const contexts: Context[] = [];
  const reads: CompanyRequest[] = [];
  const runtime = await createPiConversationRuntime({
    peopleDirectory: { searchPeople: () => [] },
    company: { read: async (_viewer, request) => {
      reads.push(request);
      return { status: "ready", entries: [{ handle: "world-reference", title: "合成对象", text: body }], ...(!request.cursor ? { nextCursor: "world-page-two" } : {}) };
    } },
    baseUrl: "https://provider.invalid", apiKey: "test-key", modelId: "controlled",
    streamSimple: (_model, context) => {
      contexts.push({ ...context, messages: structuredClone(context.messages) });
      const index = contexts.length - 1;
      return index < args.length
        ? stream([{ type: "toolCall", id: `company-call-${index}`, name: "query_company", arguments: args[index] }], "toolUse")
        : stream([{ type: "text", text: "完成" }], "stop");
    },
  });
  try {
    const result = await runtime.run({ scope: "global", viewer, message: "查询公司参考", currentObject: null,
      referencesSnapshot: [], runtimeEntries: [], recentMessages: [], piSessionId: "11111111-1111-4111-8111-111111111111",
      signal: AbortSignal.timeout(20_000), emit: () => undefined });
    return { result, contexts, reads };
  } finally { await runtime.close?.(); }
}

afterEach(async () => { await flushLangSmith(); configureLangSmith({}); });

test("company query and continuation are exclusive and continuation preserves the original query", async () => {
  const { contexts, reads } = await runCalls([{ query: "original" }, { cursor: "CP1" }]);
  const schema = contexts[0].tools!.find(tool => tool.name === "query_company")!.parameters;
  expect(Value.Check(schema, {})).toBe(true);
  expect(Value.Check(schema, { query: "original" })).toBe(true);
  expect(Value.Check(schema, { cursor: "CP1" })).toBe(true);
  expect(Value.Check(schema, { query: "changed", cursor: "CP1" })).toBe(false);
  expect(reads).toEqual([{ query: "original", cursor: undefined }, { query: "original", cursor: "world-page-two" }]);
});

test("mixed query and cursor is rejected before reaching Company", async () => {
  const { contexts, reads } = await runCalls([{ query: "original" }, { query: "changed", cursor: "CP1" }]);
  expect(reads).toHaveLength(1);
  const rejected = contexts.at(-1)!.messages.findLast(item => item.role === "toolResult");
  expect(rejected).toMatchObject({ role: "toolResult", toolCallId: "company-call-1", isError: true });
});

test("Company tool trace records the actual result once while Pi history retains only its marker", async () => {
  const transport = captureTraceTransport();
  configureLangSmith({ apiKey: "test-key", tracing: true, fetchImplementation: transport.fetchImplementation });
  const { result, contexts } = await withTurnTrace({ threadId: "11111111-1111-4111-8111-111111111111",
    logicalTurnId: "contract-test", attempt: 1, scope: "global", userId: viewer.personId, agentRole: "ceo", caller: "web" },
  () => runCalls([{ query: "original" }]));
  await flushLangSmith();
  const tools = transport.sent.filter(item => item.method === "POST" && item.body.name === "tool:query_company");
  expect(tools).toHaveLength(1);
  expect(tools[0].body.inputs).toEqual({ query: "original" });
  const completion = transport.sent.find(item => item.method === "PATCH" && item.url.endsWith(`/runs/${tools[0].body.id}`));
  expect(JSON.stringify(completion!.body.outputs)).toContain(body);
  expect(JSON.stringify(completion!.body.outputs)).toContain('"nextCursor":"CP1"');
  expect(JSON.stringify(contexts.at(-1)!.messages)).toContain(body);
  expect(JSON.stringify(result.runtimeEntries)).not.toContain(body);
  expect(JSON.stringify(result.runtimeEntries)).toContain("本轮临时参考已读取");
});
