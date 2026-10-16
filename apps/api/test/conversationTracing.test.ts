import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { v7 } from "uuid";
import { createTestApp } from "./helpers.js";
import { configureLangSmith, flushLangSmith } from "../src/langsmith.js";
import { captureTraceTransport } from "./langsmithTransport.js";
import type { ConversationRuntime } from "../src/conversations.js";

test("failure, restart and retry share durable thread/turn but create separate attempt roots without duplicate messages", async () => {
  let calls = 0;
  const runtime: ConversationRuntime = {
    async run(input) {
      calls++;
      if (calls === 1) {
        await input.checkpoint?.([{ bad: "incomplete checkpoint" }]);
        throw new Error("provider unavailable");
      }
      expect(input.runtimeEntries).toEqual([]);
      expect(input.recentMessages).toEqual([]);
      input.emit({ type: "message", delta: "answer" });
      return { assistantMessage: "answer", runtimeEntries: [] };
    },
  };
  const t = await createTestApp({}, runtime);
  const transport = captureTraceTransport();
  const setup = () =>
    configureLangSmith({
      apiKey: "test-key",
      tracing: true,
      fetchImplementation: transport.fetchImplementation,
    });
  try {
    setup();
    const cookie = await t.loginCookie();
    const logicalTurnId = v7();
    const request = {
      method: "POST" as const,
      url: "/api/conversations/global/messages",
      headers: { cookie, origin: t.publicOrigin },
      payload: { message: "hello", logicalTurnId },
    };
    const first = await t.app.inject(request);
    expect(first.body).toContain("RUNTIME_FAILED");
    await flushLangSmith();
    const restarted = await t.restart(runtime);
    setup();
    const second = await restarted.inject(request);
    expect(second.body).toContain('"status":"completed"');
    const duplicate = await restarted.inject(request);
    expect(duplicate.body).toContain('"delta":"answer"');
    expect(calls).toBe(2);
    const conflict = await restarted.inject({
      ...request,
      payload: { message: "different", logicalTurnId },
    });
    expect(conflict.statusCode).toBe(409);
    await flushLangSmith();
    const roots = transport.sent
      .filter(
        (x) =>
          x.method === "POST" &&
          x.body.name.startsWith("turn:") &&
          x.body.extra.metadata.logical_turn_id === logicalTurnId,
      )
      .map((x) => x.body);
    expect(roots.map((x) => x.name)).toEqual([
      `turn:${logicalTurnId}#a1`,
      `turn:${logicalTurnId}#a2`,
    ]);
    expect(roots[0].id).not.toBe(roots[1].id);
    expect(roots[0].extra.metadata.thread_id).toBe(
      roots[1].extra.metadata.thread_id,
    );
    expect(roots[1].extra.metadata.thread_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7/,
    );
    const history = (
      await restarted.inject({
        method: "GET",
        url: request.url,
        headers: { cookie },
      })
    ).json().messages;
    expect(history.map((x: any) => x.role)).toEqual(["user", "assistant"]);
    expect(history.every((x: any) => x.logicalTurnId === logicalTurnId)).toBe(
      true,
    );
    expect(
      (await t.agentRuns()).filter((x) => x.kind === "conversation"),
    ).toEqual([
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "succeeded" }),
    ]);
  } finally {
    await t.close();
    configureLangSmith({});
  }
});

test("main HTTP/Pi tool loop posts exactly one span per dispatched model and executed tool", async () => {
  let calls = 0;
  const t = await createTestApp({}, undefined, {
    conversationStream: (model, context) => {
      calls++;
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const tool = calls === 1;
        const message: AssistantMessage = {
          role: "assistant",
          api: "openai-responses",
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: tool
            ? [
                {
                  type: "toolCall",
                  id: "anchor-1",
                  name: "read_anchor",
                  arguments: {},
                },
              ]
            : [{ type: "text", text: "answer" }],
          stopReason: tool ? "toolUse" : "stop",
          usage: {
            input: 2,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        if (!tool)
          events.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "answer",
            partial: message,
          });
        events.push({
          type: "done",
          reason: tool ? "toolUse" : "stop",
          message,
        });
      });
      return events;
    },
  });
  const transport = captureTraceTransport();
  try {
    configureLangSmith({
      apiKey: "test-key",
      tracing: true,
      fetchImplementation: transport.fetchImplementation,
    });
    const cookie = await t.loginCookie();
    const response = await t.app.inject({
      method: "POST",
      url: "/api/conversations/global/messages",
      headers: { cookie, origin: t.publicOrigin },
      payload: { message: "explain" },
    });
    expect(response.body).toContain('"status":"completed"');
    await flushLangSmith();
    const posts = transport.sent
      .filter((x) => x.method === "POST")
      .map((x) => x.body);
    const root = posts.find((x) => x.name.startsWith("turn:"));
    const agent = posts.find((x) => x.name === "agent:ceo-agent");
    expect(agent.parent_run_id).toBe(root.id);
    expect(posts.filter((x) => x.run_type === "llm")).toHaveLength(calls);
    expect(calls).toBe(2);
    const tools = posts.filter((x) => x.run_type === "tool");
    expect(tools.map((x) => x.name)).toEqual(["tool:read_anchor"]);
    for (const span of posts) {
      expect(span.trace_id).toBe(root.id);
      expect(span.extra.metadata.thread_id).toBe(root.extra.metadata.thread_id);
    }
    for (const span of posts.filter(
      (x) => x.run_type === "llm" || x.run_type === "tool",
    ))
      expect(span.parent_run_id).toBe(agent.id);
  } finally {
    await t.close();
    configureLangSmith({});
  }
});
