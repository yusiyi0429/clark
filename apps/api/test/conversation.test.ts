import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";
import { CONVERSATION_TURN_TIMEOUT_MS } from "../src/app.js";
import type { ConversationRuntime } from "../src/conversations.js";

function parseSse(body: string): unknown[] {
  return body
    .trim()
    .split("\n\n")
    .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
}

describe("Conversation HTTP/SSE public seam", () => {
  it("authenticates history reads and returns an empty stable global scope", async () => {
    const t = await createTestApp();
    try {
      const anonymous = await t.app.inject({ method: "GET", url: "/api/conversations/global/messages" });
      expect(anonymous.statusCode).toBe(401);

      const cookie = await t.loginCookie();
      const history = await t.app.inject({
        method: "GET",
        url: "/api/conversations/global/messages",
        headers: { cookie },
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toEqual({ scope: "global", messages: [] });
    } finally {
      await t.close();
    }
  });

  it("serves the minimal replaceable Issue Card with its own stable Conversation scope", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({ method: "GET", url: "/api/cards/issues/fixture-001", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().cards[0]).toMatchObject({
        id: "issue:fixture-001",
        kind: "issue",
        version: 1,
        conversation: { scope: "issue:fixture-001" },
      });
      expect((await t.app.inject({ method: "GET", url: "/api/cards/issues/fixture-hidden", headers: { cookie } })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("builds reference snapshots from current Card ID/version and rejects stale, missing or forbidden cards", async () => {
    let received: unknown[] = [];
    const runtime: ConversationRuntime = {
      async run(input) {
        received = input.referencesSnapshot;
        input.emit({ type: "message", delta: "已读取可信引用" });
        return { assistantMessage: "已读取可信引用", runtimeEntries: [] };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const post = (references: { cardId: string; version: number }[]) => t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "核对引用", references },
      });

      const accepted = await post([
        { cardId: "home:default", version: 1 },
        { cardId: "issue:fixture-001", version: 1 },
      ]);
      expect(accepted.statusCode).toBe(200);
      expect(received).toMatchObject([
        { cardId: "home:default", version: 1, title: "公司战况", payload: { notice: { dismissed: false } } },
        { cardId: "issue:fixture-001", version: 1, title: "月球基地供应链选择", payload: { summary: "需要比较自建与合作供应链" } },
      ]);

      const history = await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } });
      expect(history.json().messages[0].referencesSnapshot).toEqual(received);

      const stale = await post([{ cardId: "home:default", version: 99 }]);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "REFERENCE_VERSION_CONFLICT" });
      const missing = await post([{ cardId: "issue:not-found", version: 1 }]);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "REFERENCE_NOT_FOUND" });
      const forbidden = await post([{ cardId: "issue:fixture-hidden", version: 1 }]);
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ code: "REFERENCE_FORBIDDEN" });
    } finally {
      await t.close();
    }
  });

  it("recovers Pi runtime entries from PostgreSQL after an app rebuild without rewriting raw messages", async () => {
    const firstRuntime: ConversationRuntime = {
      async run(input) {
        input.emit({ type: "message", delta: "first" });
        return { assistantMessage: "first", runtimeEntries: [{ type: "session", id: input.piSessionId }, { turn: 1 }] };
      },
    };
    const restoredSeen: unknown[][] = [];
    const restoredRuntime: ConversationRuntime = {
      async run(input) {
        restoredSeen.push(input.runtimeEntries);
        input.emit({ type: "message", delta: "second" });
        return { assistantMessage: "second", runtimeEntries: [...input.runtimeEntries, { turn: 2 }] };
      },
    };
    const t = await createTestApp({}, firstRuntime);
    try {
      const cookie = await t.loginCookie();
      const request = { method: "POST" as const, url: "/api/conversations/global/messages", headers: {
        cookie, origin: t.publicOrigin, accept: "text/event-stream",
      } };
      expect((await t.app.inject({ ...request, payload: { message: "one" } })).statusCode).toBe(200);
      const before = await t.conversationState("global");
      expect(before.messages.map((m) => m.content)).toEqual(["one", "first"]);
      expect(before.runtimeEntries).toMatchObject([{ type: "session" }, { turn: 1 }]);

      await t.app.close();
      const restarted = await t.restart(restoredRuntime);
      expect((await restarted.inject({ ...request, payload: { message: "two" } })).statusCode).toBe(200);
      expect(restoredSeen).toEqual([before.runtimeEntries]);
      const after = await t.conversationState("global");
      expect(after.messages.map((m) => m.content)).toEqual(["one", "first", "two", "second"]);
      expect(after.runtimeEntries).toMatchObject([{ type: "session" }, { turn: 1 }, { turn: 2 }]);
    } finally {
      await t.close();
    }
  });

  it("checkpoints compaction entries without deleting raw messages even if the turn later fails", async () => {
    const compactedEntries = [{ type: "session", version: 3 }, { type: "compaction", summary: "摘要" }];
    const runtime: ConversationRuntime = {
      async run(input): Promise<never> {
        input.emit({ type: "compaction", phase: "started" });
        await input.checkpoint?.(compactedEntries);
        input.emit({ type: "compaction", phase: "completed" });
        throw new Error("provider failed after compaction");
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "触发压缩" },
      });
      expect(parseSse(response.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "compaction", phase: "started" }),
        expect.objectContaining({ type: "compaction", phase: "completed" }),
        expect.objectContaining({ type: "error", code: "RUNTIME_FAILED" }),
      ]));
      const state = await t.conversationState("global");
      expect(state.runtimeEntries).toEqual(compactedEntries);
      expect(state.messages.map((message) => message.content)).toEqual(["触发压缩"]);
    } finally {
      await t.close();
    }
  });

  it("publishes and persists the runtime rebuild result while retaining raw messages", async () => {
    let turn = 0;
    const replacementSessionId = "22222222-2222-4222-8222-222222222222";
    const runtime: ConversationRuntime = {
      async run(input) {
        turn += 1;
        if (turn === 1) return { assistantMessage: "first", runtimeEntries: [{ valid: true }] };
        expect(input.runtimeEntries).toEqual([{ broken: true }]);
        expect(input.recentMessages?.map((message) => message.content)).toEqual(["one", "first"]);
        input.emit({ type: "warning", code: "RUNTIME_RECREATED", message: "corrupted entries rebuilt" });
        return {
          assistantMessage: "second",
          runtimeEntries: [{ rebuilt: true }],
          piSessionId: replacementSessionId,
          recovery: { recreated: true, warning: "corrupted entries rebuilt" },
        };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const request = { method: "POST" as const, url: "/api/conversations/global/messages", headers: {
        cookie, origin: t.publicOrigin, accept: "text/event-stream",
      } };
      await t.app.inject({ ...request, payload: { message: "one" } });
      await t.setRuntimeEntries("global", [{ broken: true }]);
      const recovered = await t.app.inject({ ...request, payload: { message: "two" } });
      expect(parseSse(recovered.body)).toContainEqual(expect.objectContaining({
        type: "warning", code: "RUNTIME_RECREATED", message: "corrupted entries rebuilt",
      }));
      const state = await t.conversationState("global");
      expect(state.messages.map((message) => message.content)).toEqual(["one", "first", "two", "second"]);
      expect(state.runtimeEntries).toEqual([{ rebuilt: true }]);
      expect(state.piSessionId).toBe(replacementSessionId);
      expect(state.recreatedAt).toBeInstanceOf(Date);
      expect(state.runtimeWarning).toBe("corrupted entries rebuilt");
    } finally {
      await t.close();
    }
  });

  it("saves an observable AgentRun for the Conversation input, output, usage and timing", async () => {
    const runtime: ConversationRuntime = {
      async run(input) {
        input.emit({ type: "usage", input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 });
        return { assistantMessage: "answer", runtimeEntries: [] };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "question" },
      });
      const runs = await t.agentRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        kind: "conversation",
        status: "succeeded",
        model_slot: "light",
        input_snapshot: { scope: "global", message: "question", currentObject: null, references: [] },
        candidate_output: { assistantMessage: "answer" },
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
        error: null,
      });
      expect(runs[0].prompt_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(runs[0].started_at).toBeInstanceOf(Date);
      expect(runs[0].completed_at).toBeInstanceOf(Date);
    } finally {
      await t.close();
    }
  });

  it("streams an honest error and never persists a fake assistant success", async () => {
    const runtime: ConversationRuntime = {
      async run(input): Promise<never> {
        input.emit({ type: "message", delta: "partial" });
        throw new Error("provider failed");
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "fail" },
      });
      const events = parseSse(response.body) as { type: string; status?: string; message?: string }[];
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "message", delta: "partial" }),
        expect.objectContaining({ type: "error", message: "provider failed" }),
      ]));
      expect(events.some((event) => event.type === "done" && event.status === "completed")).toBe(false);
      const state = await t.conversationState("global");
      expect(state.messages.map((m) => m.role)).toEqual(["user"]);
      expect(state.runtimeEntries).toEqual([]);
      expect(await t.agentRuns()).toEqual([expect.objectContaining({
        status: "failed", error: "provider failed", candidate_output: null,
      })]);
    } finally {
      await t.close();
    }
  });

  it("streams autonomous Web Search lifecycle and the evidence-labelled answer", async () => {
    const runtime: ConversationRuntime = {
      async run(input) {
        input.emit({ type: "tool", phase: "started", toolCallId: "search-1", name: "web_search" });
        input.emit({ type: "tool", phase: "completed", toolCallId: "search-1", name: "web_search", isError: false });
        input.emit({ type: "message", delta: "[外部证据] fixture\n[推断] 需要关注" });
        return { assistantMessage: "[外部证据] fixture\n[推断] 需要关注", runtimeEntries: [] };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "需要最新事实" },
      });
      expect(parseSse(response.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool", phase: "started", name: "web_search" }),
        expect.objectContaining({ type: "tool", phase: "completed", name: "web_search", isError: false }),
        expect.objectContaining({ type: "message", delta: expect.stringContaining("[外部证据]") }),
        expect.objectContaining({ type: "done", status: "completed" }),
      ]));
    } finally {
      await t.close();
    }
  });

  it("returns a distinct SSE error when the eighth Search exhausts the budget", async () => {
    const runtime: ConversationRuntime = {
      async run(): Promise<never> {
        throw Object.assign(new Error("Search limit reached (8)"), { code: "SEARCH_BUDGET_EXHAUSTED" });
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "异常搜索" },
      });
      expect(parseSse(response.body)).toContainEqual(expect.objectContaining({
        type: "error",
        code: "SEARCH_BUDGET_EXHAUSTED",
        message: "Search limit reached (8)",
      }));
    } finally {
      await t.close();
    }
  });

  it("enforces the public 180 second turn timeout without persisting partial output", async () => {
    expect(CONVERSATION_TURN_TIMEOUT_MS).toBe(180_000);
    const runtime: ConversationRuntime = {
      async run(input): Promise<never> {
        input.emit({ type: "message", delta: "partial" });
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw input.signal.reason;
      },
    };
    const t = await createTestApp({}, runtime, { conversationTurnTimeoutMs: 10 });
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "timeout" },
      });
      expect(parseSse(response.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "message", delta: "partial" }),
        expect.objectContaining({ type: "error", code: "TURN_TIMEOUT" }),
      ]));
      expect((await t.conversationState("global")).messages.map((message) => message.role)).toEqual(["user"]);
      expect(await t.agentRuns()).toEqual([expect.objectContaining({
        status: "aborted", error: "Conversation turn exceeded 180 seconds", candidate_output: null,
      })]);
    } finally {
      await t.close();
    }
  });

  it("aborts Pi when the SSE client disconnects and does not save an assistant message", async () => {
    let aborted = false;
    const runtime: ConversationRuntime = {
      async run(input) {
        input.emit({ type: "message", delta: "partial" });
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true }));
        return { assistantMessage: "must not persist", runtimeEntries: [{ bad: true }] };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      await t.app.listen({ port: 0, host: "127.0.0.1" });
      const address = t.app.server.address();
      if (!address || typeof address === "string") throw new Error("server not listening");
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/conversations/global/messages`, {
        method: "POST",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ message: "disconnect" }),
        signal: controller.signal,
      });
      await response.body!.getReader().read();
      controller.abort();
      let runs: Record<string, unknown>[] = [];
      for (let i = 0; i < 20; i += 1) {
        runs = await t.agentRuns();
        if (aborted && runs[0]?.status === "aborted") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(aborted).toBe(true);
      expect(runs).toEqual([expect.objectContaining({ status: "aborted" })]);
      const state = await t.conversationState("global");
      expect(state.messages.map((m) => m.role)).toEqual(["user"]);
      expect(state.runtimeEntries).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("keeps global and object messages plus runtime entries isolated across turns", async () => {
    const seen: { scope: string; entries: unknown[]; currentObject: unknown }[] = [];
    const runtime: ConversationRuntime = {
      async run(input) {
        seen.push({ scope: input.scope, entries: input.runtimeEntries, currentObject: input.currentObject });
        const index = seen.filter((item) => item.scope === input.scope).length;
        input.emit({ type: "message", delta: `reply:${input.scope}:${index}` });
        input.emit({ type: "usage", input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 });
        return {
          assistantMessage: `reply:${input.scope}:${index}`,
          runtimeEntries: [`${input.scope}-entry-${index}`],
        };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const send = (scope: string, message: string) => t.app.inject({
        method: "POST",
        url: `/api/conversations/${encodeURIComponent(scope)}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message },
      });

      const global1 = await send("global", "global one");
      const object1 = await send("issue:fixture-001", "issue one");
      const global2 = await send("global", "global two");
      expect([global1.statusCode, object1.statusCode, global2.statusCode]).toEqual([200, 200, 200]);
      expect(parseSse(global1.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "message", scope: "global", delta: "reply:global:1" }),
        expect.objectContaining({ type: "usage", scope: "global", totalTokens: 5 }),
        expect.objectContaining({ type: "done", scope: "global", status: "completed" }),
      ]));

      const globalHistory = await t.app.inject({
        method: "GET", url: "/api/conversations/global/messages", headers: { cookie },
      });
      const objectHistory = await t.app.inject({
        method: "GET", url: `/api/conversations/${encodeURIComponent("issue:fixture-001")}/messages`, headers: { cookie },
      });
      expect(globalHistory.json().messages.map((m: { content: string }) => m.content)).toEqual([
        "global one", "reply:global:1", "global two", "reply:global:2",
      ]);
      expect(objectHistory.json().messages.map((m: { content: string }) => m.content)).toEqual([
        "issue one", "reply:issue:fixture-001:1",
      ]);
      expect(seen).toMatchObject([
        { scope: "global", entries: [], currentObject: null },
        { scope: "issue:fixture-001", entries: [], currentObject: { cardId: "issue:fixture-001" } },
        { scope: "global", entries: ["global-entry-1"], currentObject: null },
      ]);
    } finally {
      await t.close();
    }
  });
});
