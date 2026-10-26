import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { settleActiveTurns } from "../src/routes/conversations.js";

function parseSse(body: string) {
  return body.split("\n\n").map((block) => /data: (.*)/.exec(block)?.[1]).filter(Boolean).map((data) => JSON.parse(data!));
}

describe("停机（部署换版本）时正在写的回答", () => {
  it("以「服务更新」收尾：已写出的部分存下、标成可继续，界面据此连上新实例后自动接着写", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const runtime: ConversationRuntime = {
      async run(input): Promise<never> {
        input.emit({ type: "message", delta: "写到一半" });
        started();
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw input.signal.reason;
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const response = t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "问题" } });
      await running;
      const began = Date.now();
      await settleActiveTurns();
      expect(Date.now() - began).toBeLessThan(2_000);
      const events = parseSse((await response).body);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "SERVER_RESTARTING", resume: "continue", partial: true }));
      expect((await t.conversationState("global")).messages.map((message) => message.content))
        .toEqual(["问题", "写到一半\n\n（这次回答在这里中断了，以上是已经写出的部分。）"]);
      // 收完尾就不再算正在写的：再停一次立刻返回。
      const again = Date.now();
      await settleActiveTurns();
      expect(Date.now() - again).toBeLessThan(100);
    } finally { await t.close(); }
  });
});
