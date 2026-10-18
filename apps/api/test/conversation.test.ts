import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";
import { CONVERSATION_TURN_TIMEOUT_MS } from "../src/app.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { ConversationTurnError } from "../src/conversationRecovery.js";

function parseSse(body: string): unknown[] {
  return body
    .trim()
    .split("\n\n")
    .flatMap((block) => {
      const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
      return line ? [JSON.parse(line.slice(6))] : [];
    });
}

describe("Conversation HTTP/SSE public seam", () => {
  it("reports provider refusal in Chinese, keeps a note in the transcript and preserves business data", async () => {
    const t = await createTestApp({}, { async run() { throw Object.assign(new Error("Response incomplete: content_filter"), { code: "CONTENT_FILTER" }); } });
    try {
      const cookie = await t.loginCookie(), issue = await t.createIssue();
      const response = await t.app.inject({ method: "POST", url: `/api/conversations/issue:${issue.objectRef.id}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "请精炼左侧文字" } });
      expect(parseSse(response.body)).toEqual([expect.objectContaining({ type: "error", code: "CONTENT_FILTER",
        message: "模型服务没有受理这次请求（内容审核未通过）。问题已保留，可以换个说法后重试。", partial: false })]);
      const messages = (await t.conversationState(`issue:${issue.objectRef.id}`)).messages;
      expect(messages.map(message => message.role)).toEqual(["user", "assistant"]);
      expect(messages[1].content).toBe("（这次回答没有完成：模型服务没有受理这次请求。）");
      expect((await t.sql("SELECT title,version,status FROM issues WHERE id=$1", [issue.objectRef.id]))[0]).toEqual({ title: issue.title, version: 1, status: "pending" });
      expect((await t.sql("SELECT status,error FROM agent_runs WHERE kind='conversation'"))[0]).toEqual({ status: "failed", error: "Response incomplete: content_filter" });
    } finally { await t.close(); }
  });
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

  it("serves a real Issue Card with its own stable Conversation scope", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.loginCookie();
      const issue = await t.createIssue();
      const response = await t.app.inject({ method: "GET", url: `/api/cards/issues/${issue.objectRef.id}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().cards[0]).toMatchObject({
        id: `issue:${issue.objectRef.id}`,
        kind: "issue",
        version: 1,
        conversation: { scope: `issue:${issue.objectRef.id}` },
      });
      expect((await t.app.inject({ method: "GET", url: "/api/cards/issues/11111111-1111-4111-8111-111111111111", headers: { cookie } })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("builds reference snapshots from current Card ID/version and rejects stale or missing cards", async () => {
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
      const issue = await t.createIssue();
      const post = (references: { cardId: string; version: number }[]) => t.app.inject({
        method: "POST",
        url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "核对引用", references },
      });

      const accepted = await post([{ cardId: `issue:${issue.objectRef.id}`, version: 1 }]);
      expect(accepted.statusCode).toBe(200);
      expect(received).toMatchObject([
        { cardId: `issue:${issue.objectRef.id}`, version: 1, kind: "issue" },
      ]);

      const history = await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } });
      expect(history.json().messages[0].referencesSnapshot).toEqual(received);

      const stale = await post([{ cardId: `issue:${issue.objectRef.id}`, version: 99 }]);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "REFERENCE_VERSION_CONFLICT" });
      const missing = await post([{ cardId: "issue:11111111-1111-4111-8111-111111111111", version: 1 }]);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "REFERENCE_NOT_FOUND" });
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
        expect.objectContaining({ type: "error", code: "RUNTIME_FAILED", resume: "retry" }),
      ]));
      const state = await t.conversationState("global");
      expect(state.runtimeEntries).toEqual(compactedEntries);
      expect(state.messages.map((message) => message.content)).toEqual(["触发压缩", "（这次回答没有完成：天枢处理时出错。）"]);
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

  it("streams an honest Chinese error, keeps the written part with a note and never reports success", async () => {
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
        expect.objectContaining({ type: "error", code: "RUNTIME_FAILED", resume: "continue", partial: true,
          message: expect.stringContaining("已写出的部分保留在上方，点「继续」从断点接着写") }),
      ]));
      expect(events.some((event) => event.type === "done" && event.status === "completed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("provider failed");
      const state = await t.conversationState("global");
      expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(state.messages[1].content).toBe("partial\n\n（这次回答在这里中断了，以上是已经写出的部分。）");
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
        message: expect.stringContaining("这一轮的外部检索次数已经用完"),
      }));
    } finally {
      await t.close();
    }
  });

  it("has no 180 second hard cap: the absolute cap is 10 minutes, and hitting it keeps the partial answer with a note", async () => {
    expect(CONVERSATION_TURN_TIMEOUT_MS).toBe(600_000);
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
        expect.objectContaining({ type: "error", code: "TURN_TIMEOUT", resume: "continue", partial: true, message: expect.stringContaining("已写出的部分保留在上方") }),
      ]));
      const messages = (await t.conversationState("global")).messages;
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[1].content).toMatch(/^partial\n\n（回答持续了 \d+ 分钟仍未写完，以上是已写出的部分。）$/);
      expect(await t.agentRuns()).toEqual([expect.objectContaining({
        status: "aborted", error: expect.stringMatching(/^Conversation turn exceeded \d+ seconds$/), candidate_output: null,
      })]);
    } finally {
      await t.close();
    }
  });

  it("does not cut a long answer by the tier time limit: as long as events keep coming the turn runs to the end", async () => {
    const notice = "这个问题涉及赛道格局的战略判断，需要更深入地查证和推演。";
    const runtime: ConversationRuntime = {
      async run(input) {
        // 档位说「通常 40 毫秒」，这一轮写了 400 毫秒：不截断。
        input.emit({ type: "route", tier: "deep", source: "model", expectSeconds: 90, timeoutMs: 40, notice });
        let body = "";
        for (let index = 0; index < 20; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const delta = `第${index}段。`;
          body += delta;
          input.emit({ type: "message", delta });
        }
        return { assistantMessage: `${notice}\n\n${body}`, runtimeEntries: [] };
      },
    };
    // 卡住阈值 150 毫秒（每 20 毫秒就有新事件），绝对上限 10 秒。
    const t = await createTestApp({}, runtime, { conversationTurnTimeoutMs: 10_000, conversationStallTimeoutMs: 150 });
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "深度" } });
      const events = parseSse(response.body);
      expect(events[0]).toMatchObject({ type: "route", tier: "deep", notice, timeoutMs: 10_000 });
      expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
      expect(events.some((event) => (event as { type: string }).type === "error")).toBe(false);
      const messages = (await t.conversationState("global")).messages;
      expect(messages[1].content).toBe(`${notice}\n\n${Array.from({ length: 20 }, (_, index) => `第${index}段。`).join("")}`);
    } finally {
      await t.close();
    }
  });

  it("writes SSE heartbeats while the model is quiet so proxies and the browser keep the connection", async () => {
    const runtime: ConversationRuntime = {
      async run(input) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        input.emit({ type: "message", delta: "想完了" });
        return { assistantMessage: "想完了", runtimeEntries: [] };
      },
    };
    const t = await createTestApp({}, runtime, { conversationHeartbeatMs: 20 });
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "慢一点" } });
      expect(response.body).toMatch(/^: ping$/m);
      expect(parseSse(response.body).at(-1)).toMatchObject({ type: "done", status: "completed" });
    } finally {
      await t.close();
    }
  });

  it("explains a timeout with nothing written yet, keeps a note in the transcript and offers to answer again", async () => {
    const runtime: ConversationRuntime = {
      async run(input): Promise<never> {
        input.emit({ type: "route", tier: "deep", source: "rule", expectSeconds: 90, timeoutMs: 30, notice: "这个问题涉及集团层面的战略判断，需要更深入地查证和推演。" });
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw input.signal.reason;
      },
    };
    const t = await createTestApp({}, runtime, { conversationTurnTimeoutMs: 30 });
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "深度" } });
      expect(parseSse(response.body)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "error", code: "TURN_TIMEOUT", resume: "retry", partial: false, message: expect.stringContaining("点「重新回答」") }),
      ]));
      const messages = (await t.conversationState("global")).messages;
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[1].content).toBe("这个问题涉及集团层面的战略判断，需要更深入地查证和推演。\n\n（这次回答没有完成：持续时间超过上限。）");
    } finally {
      await t.close();
    }
  });

  it("when the SSE client disconnects (stop button or closed page) aborts Pi but keeps what was written", async () => {
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
      for (let i = 0; i < 50; i += 1) {
        runs = await t.agentRuns();
        if (aborted && runs[0]?.status === "aborted") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(aborted).toBe(true);
      expect(runs).toEqual([expect.objectContaining({ status: "aborted" })]);
      const state = await t.conversationState("global");
      expect(state.messages.map((m) => m.content)).toEqual(["disconnect", "partial\n\n（已停止，以上是停止前写出的部分。）"]);
      // 运行时没有给出这一轮的模型历史（不是它自己报的失败）：不采信它返回的东西。
      expect(state.runtimeEntries).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("persists the model history a failed turn hands back and lets 继续 resume it with the same tier", async () => {
    const seen: { message: string; resume?: unknown; entries: unknown[] }[] = [];
    let turn = 0;
    const runtime: ConversationRuntime = {
      async run(input) {
        turn += 1;
        seen.push({ message: input.message, resume: input.resume, entries: input.runtimeEntries });
        if (turn === 1) {
          input.emit({ type: "route", tier: "deep", source: "rule", expectSeconds: 90, timeoutMs: 1, notice: "这个问题涉及集团层面的战略判断，需要更深入地查证和推演。" });
          input.emit({ type: "recovery", reason: "network", action: "continue", attempt: 2, notice: "和模型服务的网络连接中断了，正在从断点接着写（第 1 次）" });
          input.emit({ type: "message", delta: "第一段判断。" });
          throw new ConversationTurnError("terminated", "network", { runtimeEntries: [{ type: "session", partial: "第一段判断。" }], recoveries: 3 });
        }
        input.emit({ type: "message", delta: "第二段接着写。" });
        return { assistantMessage: "第二段接着写。", runtimeEntries: [...input.runtimeEntries, { turn: 2 }] };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const send = (payload: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload });
      const first = parseSse((await send({ message: "集团该怎么定位？" })).body) as { type: string; runId: string; code?: string; message?: string }[];
      expect(first).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "recovery", action: "continue" }),
        expect.objectContaining({ type: "error", code: "NETWORK_INTERRUPTED", resume: "continue", partial: true }),
      ]));
      const error = first.find((event) => event.type === "error")!;
      expect(error.message).toMatch(/网络连接中断了.*已自动恢复 1 次仍未成功.*点「继续」从断点接着写/);
      expect(error.message).not.toMatch(/terminated|暂不可用/);
      let state = await t.conversationState("global");
      expect(state.runtimeEntries).toEqual([{ type: "session", partial: "第一段判断。" }]);
      expect(state.messages.map((message) => message.content)).toEqual(["集团该怎么定位？",
        "这个问题涉及集团层面的战略判断，需要更深入地查证和推演。\n\n第一段判断。\n\n（这次回答在这里中断了，以上是已经写出的部分。）"]);

      const resumed = parseSse((await send({ message: "继续", resumeRunId: error.runId })).body);
      expect(resumed.at(-1)).toMatchObject({ type: "done", status: "completed" });
      expect(seen[1].message).toBe("继续");
      expect(seen[1].entries).toEqual([{ type: "session", partial: "第一段判断。" }]);
      expect(seen[1].resume).toMatchObject({ tier: "deep", question: "集团该怎么定位？", instruction: expect.stringContaining("结尾是「这个问题涉及集团层面的战略判断，需要更深入地查证和推演。\n\n第一段判断。」") });
      expect((seen[1].resume as { instruction: string }).instruction).not.toContain("（这次回答在这里中断了");
      state = await t.conversationState("global");
      expect(state.messages.map((message) => message.content).slice(2)).toEqual(["继续", "第二段接着写。"]);
      // 那一轮的原问题记在「继续」这一轮上：再中断再点「继续」，接的仍是同一个问题。
      expect((await t.agentRuns())[1]).toMatchObject({ input_snapshot: { message: "集团该怎么定位？", resumeOf: error.runId } });

      const stranger = await send({ message: "继续", resumeRunId: "11111111-1111-4111-8111-111111111111" });
      expect(stranger.statusCode).toBe(404);
      expect(stranger.json()).toMatchObject({ code: "RESUME_NOT_FOUND" });
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
      const issue = await t.createIssue();
      const scope = `issue:${issue.objectRef.id}`;
      const send = (scope: string, message: string) => t.app.inject({
        method: "POST",
        url: `/api/conversations/${encodeURIComponent(scope)}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message },
      });

      const global1 = await send("global", "global one");
      const object1 = await send(scope, "issue one");
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
        method: "GET", url: `/api/conversations/${encodeURIComponent(scope)}/messages`, headers: { cookie },
      });
      expect(globalHistory.json().messages.map((m: { content: string }) => m.content)).toEqual([
        "global one", "reply:global:1", "global two", "reply:global:2",
      ]);
      expect(objectHistory.json().messages.map((m: { content: string }) => m.content)).toEqual([
        "issue one", `reply:${scope}:1`,
      ]);
      expect(seen).toMatchObject([
        { scope: "global", entries: [], currentObject: null },
        { scope, entries: [], currentObject: { cardId: scope } },
        { scope: "global", entries: ["global-entry-1"], currentObject: null },
      ]);
    } finally {
      await t.close();
    }
  });
});
