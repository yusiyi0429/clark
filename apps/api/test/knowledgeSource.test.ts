import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";

function parseSse(body: string) {
  return body.split("\n\n").map((block) => /data: (.*)/.exec(block)?.[1]).filter(Boolean).map((data) => JSON.parse(data!));
}

describe("企业知识原文直取已退役", () => {
  it("本地企业知识不再加载，原文接口不存在", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.memberCookie();
      const res = await t.app.inject({ method: "GET", url: `/api/knowledge/source?ref=${encodeURIComponent("memory:company.md#s1")}`, headers: { cookie } });
      expect(res.statusCode).toBe(404);
    } finally { await t.close(); }
  });
});

describe("对话卡住检测", () => {
  it("整轮超过卡住阈值没有任何事件（连恢复都没有进展）才停下，说明原因并在对话里留一句说明", async () => {
    const runtime: ConversationRuntime = {
      async run(input): Promise<never> {
        input.emit({ type: "tool", phase: "started", toolCallId: "1", name: "query_company" });
        input.emit({ type: "tool", phase: "completed", toolCallId: "1", name: "query_company", isError: false });
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw input.signal.reason;
      },
    };
    const t = await createTestApp({}, runtime, { conversationStallTimeoutMs: 40 });
    try {
      const cookie = await t.loginCookie();
      const started = Date.now();
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "给我看原文" } });
      expect(Date.now() - started).toBeLessThan(5_000);
      const error = parseSse(response.body).find((event) => event.type === "error");
      expect(error).toMatchObject({ code: "TURN_STALLED", resume: "retry" });
      expect(error.message).toMatch(/没有任何进展.*点「重新回答」再试一次/);
      expect((await t.conversationState("global")).messages.map((message) => message.content)).toEqual(["给我看原文", "（这次回答没有完成：长时间没有进展。）"]);
      expect(await t.agentRuns()).toEqual([expect.objectContaining({ status: "aborted", error: expect.stringContaining("stalled") })]);
    } finally { await t.close(); }
  });

  it("持续出字的长回答不会被卡住检测误停", async () => {
    const runtime: ConversationRuntime = {
      async run(input) {
        for (let i = 0; i < 8; i += 1) {
          input.emit({ type: "message", delta: `第${i}段` });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { assistantMessage: "完整回答", runtimeEntries: input.runtimeEntries };
      },
    };
    const t = await createTestApp({}, runtime, { conversationStallTimeoutMs: 60 });
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "长一点" } });
      expect(parseSse(response.body)).toContainEqual(expect.objectContaining({ type: "done", status: "completed" }));
    } finally { await t.close(); }
  });
});
