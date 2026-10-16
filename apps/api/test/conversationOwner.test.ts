import { describe, expect, it } from "vitest";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";
import { createCompanyContext } from "../src/companyContext.js";
import { assignLegacyConversations, type ConversationRuntime } from "../src/conversations.js";

type Viewer = Parameters<ConversationRuntime["run"]>[0]["viewer"];

/** 假 runtime：记下每一轮是谁在问，回答里带上提问人，便于断言会话归属。 */
function recordingRuntime(): ConversationRuntime & { viewers: Viewer[] } {
  const viewers: Viewer[] = [];
  return {
    viewers,
    async run(input) {
      viewers.push(input.viewer);
      input.emit({ type: "message", delta: `reply:${input.viewer.personId}` });
      return { assistantMessage: `reply:${input.viewer.personId}`, runtimeEntries: [] };
    },
  };
}

describe("我的 Agent 按人私有", () => {
  it("CEO 与成员各自的 global 会话互不可见，runtime 收到各自的 viewer", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      const member = await t.memberCookie();
      const send = (cookie: string, message: string) => t.app.inject({
        method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message },
      });
      expect((await send(ceo, "ceo question")).statusCode).toBe(200);
      expect((await send(member, "member question")).statusCode).toBe(200);

      const history = async (cookie: string) => (await t.app.inject({
        method: "GET", url: "/api/conversations/global/messages", headers: { cookie },
      })).json().messages.map((message: { content: string }) => message.content);
      expect(await history(ceo)).toEqual(["ceo question", `reply:${TEST_CEO.personId}`]);
      expect(await history(member)).toEqual(["member question", `reply:${TEST_MEMBER.personId}`]);

      // 两人各自一条主对话
      expect(await t.sql("SELECT owner_id FROM conversations WHERE scope = 'global' AND deleted_at IS NULL ORDER BY owner_id")).toEqual([
        { owner_id: TEST_CEO.personId },
        { owner_id: TEST_MEMBER.personId },
      ]);

      expect(runtime.viewers).toEqual([
        { personId: TEST_CEO.personId, displayName: "测试甲", role: "ceo" },
        { personId: TEST_MEMBER.personId, displayName: "测试乙", role: "member" },
      ]);
      const runs = (await t.agentRuns()).filter(run => run.kind === "conversation");
      expect(runs.map((run) => (run.input_snapshot as { viewerId: string }).viewerId)).toEqual([TEST_CEO.personId, TEST_MEMBER.personId]);
    } finally {
      await t.close();
    }
  });

  it("成员在 2a 只能用 global：议题 scope 一律 404，显式引用 Card 也 404", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      const member = await t.memberCookie();
      const issue = await t.createIssue();
      const scope = encodeURIComponent(`issue:${issue.objectRef.id}`);

      const attempts = [
        await t.app.inject({ method: "GET", url: `/api/conversations/${scope}/messages`, headers: { cookie: member } }),
        await t.app.inject({
          method: "POST", url: `/api/conversations/${scope}/messages`,
          headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "看议题" },
        }),
        await t.app.inject({
          method: "POST", url: `/api/conversations/${scope}/attachments`,
          headers: { cookie: member, origin: t.publicOrigin, "content-type": "multipart/form-data; boundary=x" }, payload: "",
        }),
      ];
      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(attempt.json()).toMatchObject({ code: "CONVERSATION_SCOPE_NOT_FOUND" });
      }
      expect((await t.app.inject({ method: "GET", url: `/api/conversations/${scope}/messages`, headers: { cookie: ceo } })).statusCode).toBe(200);

      // 成员看不到议题 Card，也不能借引用把它带进自己的 Agent
      const referenced = await t.app.inject({
        method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "引用议题", references: [{ cardId: issue.id, version: issue.version }] },
      });
      expect(referenced.statusCode).toBe(404);
      expect(referenced.json()).toMatchObject({ code: "REFERENCE_NOT_FOUND" });
      expect(runtime.viewers).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("两个人同时在同一 scope 发消息不会互相返回 409；同一个人仍互斥", async () => {
    let releaseCeo!: () => void;
    let ceoEntered!: () => void;
    const entered = new Promise<void>((resolve) => { ceoEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseCeo = resolve; });
    const runtime: ConversationRuntime = {
      async run(input) {
        if (input.viewer.role === "ceo") {
          ceoEntered();
          await gate;
        }
        input.emit({ type: "message", delta: "ok" });
        return { assistantMessage: "ok", runtimeEntries: [] };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      const member = await t.memberCookie();
      const send = (cookie: string, message: string) => t.app.inject({
        method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message },
      });
      const ceoTurn = send(ceo, "ceo long turn");
      await entered;
      const sameCeo = await send(ceo, "ceo again");
      expect(sameCeo.statusCode).toBe(409);
      expect(sameCeo.json()).toMatchObject({ code: "TURN_IN_PROGRESS" });
      expect((await send(member, "member turn")).statusCode).toBe(200);
      releaseCeo();
      expect((await ceoTurn).statusCode).toBe(200);
    } finally {
      releaseCeo?.();
      await t.close();
    }
  });

  it("旧会话（owner_id 为空）归到人员目录里的 CEO", async () => {
    const t = await createTestApp({}, recordingRuntime());
    try {
      await t.sql(
        "INSERT INTO conversations (id, scope, pi_session_id) VALUES ('44444444-4444-4444-8444-444444444444', 'global', '55555555-5555-4555-8555-555555555555')",
      );
      await t.sql(
        "INSERT INTO conversation_messages (conversation_id, sequence, role, content, run_id) VALUES ('44444444-4444-4444-8444-444444444444', 1, 'user', '旧问题', '66666666-6666-4666-8666-666666666666')",
      );
      await assignLegacyConversations((text, params) => t.sql(text, params) as never, createCompanyContext(t.env));
      expect(await t.sql("SELECT owner_id FROM conversations")).toEqual([{ owner_id: TEST_CEO.personId }]);

      const history = async (cookie: string) => (await t.app.inject({
        method: "GET", url: "/api/conversations/global/messages", headers: { cookie },
      })).json().messages.map((message: { content: string }) => message.content);
      expect(await history(await t.loginCookie())).toEqual(["旧问题"]);
      expect(await history(await t.memberCookie())).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
