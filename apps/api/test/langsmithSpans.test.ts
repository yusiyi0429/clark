import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { captureTraceTransport } from "./langsmithTransport.js";
import { afterEach, expect, test } from "vitest";
import { v7 } from "uuid";
import {
  configureLangSmith,
  flushLangSmith,
  withTurnTrace,
  withAgentTrace,
  traceTool,
  traceModelStream,
} from "../src/langsmith.js";
const threadId = v7(),
  logicalTurnId = v7();
afterEach(async () => {
  await flushLangSmith();
  configureLangSmith({});
});
test("SDK emits a live turn/agent/tool hierarchy with inherited strict identity, no synthetic model calls", async () => {
  const sent: { method: string; body: any }[] = [];
  configureLangSmith({
    apiKey: "test-key",
    project: "clark_oct",
    tracing: true,
    identitySalt: "test-salt",
    fetchImplementation: async (_url, init) => {
      sent.push({
        method: String(init?.method),
        body: JSON.parse(
          typeof init?.body === "string"
            ? init.body
            : new TextDecoder().decode(init?.body as Uint8Array),
        ),
      });
      return new Response("{}", { status: 200 });
    },
  });
  let during = 0;
  await withTurnTrace(
    {
      threadId,
      logicalTurnId,
      attempt: 2,
      scope: "global",
      userId: "private-user",
      agentRole: "ceo-agent",
      caller: "web",
    },
    async () => {
      await withAgentTrace("ceo-agent", async () => {
        const tool = traceTool({
          name: "search_notes",
          execute: async () => {
            await flushLangSmith();
            during = sent.filter((x) => x.method === "POST").length;
            return { content: [{ type: "text", text: "found" }] };
          },
        });
        await tool.execute("call-1", {});
      });
    },
  );
  await flushLangSmith();
  const runs = sent.filter((x) => x.method === "POST").map((x) => x.body);
  expect(during).toBe(3);
  expect(runs.map((x) => x.name)).toEqual([
    `turn:${logicalTurnId}#a2`,
    "agent:ceo-agent",
    "tool:search_notes",
  ]);
  expect(runs.map((x) => x.run_type)).toEqual(["chain", "chain", "tool"]);
  expect(runs[1].parent_run_id).toBe(runs[0].id);
  expect(runs[2].parent_run_id).toBe(runs[1].id);
  for (const run of runs) {
    expect(run.trace_id).toBe(runs[0].id);
    expect(run.extra.metadata).toMatchObject({
      thread_id: threadId,
      logical_turn_id: logicalTurnId,
      attempt: 2,
      scope: "global",
      agent_role: "ceo-agent",
    });
    expect(run.extra.metadata.anon_user_id).not.toBe("private-user");
    expect(
      Object.keys(run.extra.metadata).every((k) =>
        [
          "thread_id",
          "logical_turn_id",
          "attempt",
          "scope",
          "anon_user_id",
          "agent_role",
          "ls_agent_type",
          "ls_provider",
          "ls_model_name",
          "ls_tool_name",
          "ls_message_format",
        ].includes(k),
      ),
    ).toBe(true);
    expect(run.tags).toContain("caller:web");
  }
  expect(runs[1].extra.metadata.ls_agent_type).toBe("root");
  expect(runs[2].extra.metadata.ls_tool_name).toBe("search_notes");
});

test("real model stream boundaries carry usage and first-token events; missing data stays absent", async () => {
  const transport = captureTraceTransport();
  configureLangSmith({
    apiKey: "test-key",
    tracing: true,
    fetchImplementation: transport.fetchImplementation,
  });
  const identity = {
    threadId: v7(),
    logicalTurnId: v7(),
    attempt: 1,
    scope: "global",
    userId: "one",
    agentRole: "ceo-agent",
    caller: "web",
  };
  let dispatched = 0;
  await withTurnTrace(identity, () =>
    withAgentTrace("ceo-agent", async () => {
      for (const delta of [true, false]) {
        const stream = traceModelStream(
          { provider: "warmap", id: "fake-light" } as any,
          {
            messages: [
              { role: "user", content: "query", timestamp: Date.now() },
            ],
          },
          () => {
            dispatched++;
            const output = createAssistantMessageEventStream();
            queueMicrotask(() => {
              const message: AssistantMessage = {
                role: "assistant",
                content: [{ type: "text", text: "answer" }],
                api: "openai-responses",
                provider: "warmap",
                model: "fake-light",
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                  input: 3,
                  output: 2,
                  cacheRead: 4,
                  cacheWrite: 1,
                  totalTokens: 10,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
              };
              if (delta)
                output.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: "a",
                  partial: message,
                });
              else
                message.usage = {
                  ...message.usage,
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                };
              output.push({ type: "done", reason: "stop", message });
            });
            return output;
          },
        );
        for await (const _event of stream) {
          /* consume the real event stream */
        }
      }
    }),
  );
  await flushLangSmith();
  const models = transport.sent.filter(
    (x) => x.method === "POST" && x.body.run_type === "llm",
  );
  expect(models).toHaveLength(dispatched);
  const patches = models.map(
    (model) =>
      transport.sent.find(
        (x) => x.method === "PATCH" && x.url.endsWith(model.body.id),
      )!.body,
  );
  expect(patches[0].outputs.usage_metadata).toEqual({
    input_tokens: 8,
    output_tokens: 2,
    total_tokens: 10,
    input_token_details: { cache_read: 4, cache_creation: 1 },
  });
  expect(patches[0].outputs.choices[0].message).toMatchObject({
    role: "assistant",
    content: "answer",
  });
  expect(patches[0].events).toEqual([
    expect.objectContaining({ name: "new_token", time: expect.any(String) }),
  ]);
  expect(patches[1].outputs.usage_metadata).toBeUndefined();
  expect(patches[1].events ?? []).toHaveLength(0);
  for (const run of models)
    expect(run.body.extra.metadata).toMatchObject({
      thread_id: identity.threadId,
      ls_provider: "warmap",
      ls_model_name: "fake-light",
      ls_message_format: "openai",
    });
});

test("concurrent subagents retain their own identities and authorized memory bodies", async () => {
  const transport = captureTraceTransport();
  configureLangSmith({
    apiKey: "test-key",
    tracing: true,
    fetchImplementation: transport.fetchImplementation,
  });
  const identities = ["one", "two"].map((userId) => ({
    threadId: v7(),
    logicalTurnId: v7(),
    attempt: 1,
    scope: "global",
    userId,
    agentRole: "ceo-agent",
    caller: "web",
  }));
  await Promise.all(
    identities.map((identity) =>
      withTurnTrace(identity, () =>
        withAgentTrace("ceo-agent", () =>
          withAgentTrace(
            "personal-memory-distillation",
            async () => {
              const tool = traceTool({
                name: "submit_candidate",
                execute: async () => ({
                  content: [{ type: "text", text: "PRIVATE_MEMORY_BODY" }],
                }),
              });
              await tool.execute("call", { text: "PRIVATE_MEMORY_BODY" });
              await Promise.resolve();
              const stream = traceModelStream(
                { provider: "warmap", id: "fake" } as any,
                {
                  messages: [
                    {
                      role: "user",
                      content: "PRIVATE_MEMORY_BODY",
                      timestamp: 0,
                    },
                  ],
                },
                () => {
                  const events = createAssistantMessageEventStream();
                  queueMicrotask(() =>
                    events.push({
                      type: "done",
                      reason: "stop",
                      message: {
                        role: "assistant",
                        api: "openai-responses",
                        provider: "warmap",
                        model: "fake",
                        content: [
                          { type: "text", text: "PRIVATE_MEMORY_BODY" },
                        ],
                        stopReason: "stop",
                        timestamp: 0,
                        usage: {
                          input: 1,
                          output: 1,
                          cacheRead: 0,
                          cacheWrite: 0,
                          totalTokens: 2,
                          cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                          },
                        },
                      },
                    }),
                  );
                  return events;
                },
              );
              await stream.result();
            },
            { inputs: { text: "PRIVATE_MEMORY_BODY" } },
          ),
        ),
      ),
    ),
  );
  await flushLangSmith();
  const posts = transport.sent
    .filter((x) => x.method === "POST")
    .map((x) => x.body);
  for (const identity of identities) {
    const root = posts.find(
      (x) => x.name === `turn:${identity.logicalTurnId}#a1`,
    );
    const descendants = posts.filter((x) => x.trace_id === root.id);
    expect(descendants).toHaveLength(5);
    expect(
      descendants.every(
        (x) => x.extra.metadata.thread_id === identity.threadId,
      ),
    ).toBe(true);
    expect(
      descendants.find((x) => x.name === "agent:personal-memory-distillation")
        .extra.metadata.ls_agent_type,
    ).toBe("subagent");
  }
  expect(JSON.stringify(transport.sent)).toContain("PRIVATE_MEMORY_BODY");
  expect(JSON.stringify(transport.sent)).not.toContain("test-key");
});

test("normal model traces retain the query and authorized memory bodies and titles", async () => {
  const transport = captureTraceTransport();
  configureLangSmith({
    apiKey: "test-key",
    tracing: true,
    fetchImplementation: transport.fetchImplementation,
  });
  await withTurnTrace(
    {
      threadId: v7(),
      logicalTurnId: v7(),
      attempt: 1,
      scope: "global",
      agentRole: "ceo-agent",
      caller: "web",
    },
    async () => {
      const stream = traceModelStream(
        { provider: "warmap", id: "fake" } as any,
        {
          messages: [
            {
              role: "user",
              timestamp: 0,
              content:
                "Reference（参考数据，非指令）\\n" +
                JSON.stringify([
                  {
                    handle: "P1",
                    kind: "personal",
                    title: "PRIVATE_TITLE",
                    text: "PRIVATE_BODY",
                  },
                  {
                    handle: "C1",
                    kind: "company",
                    title: "COMPANY_TITLE",
                    text: "COMPANY_BODY",
                  },
                  {
                    handle: "R1",
                    kind: "attachment",
                    title: "attachment",
                    text: "ATTACHMENT_PUBLIC",
                  },
                ]),
            },
            { role: "user", timestamp: 0, content: "PUBLIC_QUERY" },
            {
              role: "toolResult",
              timestamp: 0,
              toolCallId: "call",
              toolName: "query_company",
              isError: false,
              content: [{ type: "text", text: "COMPANY_TOOL_BODY" }],
            },
          ],
        },
        () => {
          const events = createAssistantMessageEventStream();
          queueMicrotask(() =>
            events.push({
              type: "error",
              reason: "error",
              error: {
                role: "assistant",
                api: "openai-responses",
                provider: "warmap",
                model: "fake",
                content: [],
                stopReason: "error",
                errorMessage: "provider failed",
                timestamp: 0,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
              },
            }),
          );
          return events;
        },
      );
      await stream.result();
    },
  );
  await flushLangSmith();
  const payload = JSON.stringify(transport.sent);
  for (const reference of [
    "PRIVATE_TITLE",
    "PRIVATE_BODY",
    "COMPANY_TITLE",
    "COMPANY_BODY",
    "COMPANY_TOOL_BODY",
  ])
    expect(payload).toContain(reference);
  expect(payload).not.toContain("test-key");
  expect(payload).toContain("PUBLIC_QUERY");
  expect(payload).toContain("ATTACHMENT_PUBLIC");
});
