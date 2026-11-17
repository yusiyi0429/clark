import { describe, expect, it } from "vitest";
import { TEST_CEO, createTestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { addBuddyReaction } from "../src/conversationReactions.js";
import type { Query } from "../src/meetingStore.js";

const runtime: ConversationRuntime = {
  async run(input) {
    input.emit({ type: "message", delta: "好的" });
    return { assistantMessage: "好的", runtimeEntries: [] };
  },
};

type Row = { role: string; runId: string; reactions?: { part: number; emoji: string }[]; buddyReactions?: string[] };

describe("对话消息上的表情（本人自己的标记，按块一人一个）", { timeout: 30_000 }, () => {
  it("按块各记各的、同一块再点换掉、null 取消、只动自己的", async () => {
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      const member = await t.memberCookie();
      const send = await t.app.inject({
        method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: ceo, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "你好" },
      });
      expect(send.statusCode).toBe(200);
      const history = async (cookie: string): Promise<Row[]> => (await t.app.inject({
        method: "GET", url: "/api/conversations/global/messages", headers: { cookie },
      })).json().messages;
      const [asked, answer] = await history(ceo);
      expect(answer.role).toBe("assistant");
      const react = (cookie: string, body: unknown) => t.app.inject({
        method: "PUT", url: "/api/conversations/global/reactions", headers: { cookie, origin: t.publicOrigin }, payload: body,
      });

      const added = await react(ceo, { runId: answer.runId, role: "assistant", part: 0, emoji: "👍" });
      expect(added.statusCode).toBe(200);
      expect(added.json()).toEqual({ runId: answer.runId, role: "assistant", part: 0, emoji: "👍" });
      expect((await react(ceo, { runId: answer.runId, role: "assistant", part: 2, emoji: "❤️" })).statusCode).toBe(200);
      expect((await react(ceo, { runId: asked.runId, role: "user", part: 0, emoji: "🙏" })).statusCode).toBe(200);

      const read = await history(ceo);
      expect(read.map((message) => message.reactions)).toEqual([[{ part: 0, emoji: "🙏" }], [{ part: 0, emoji: "👍" }, { part: 2, emoji: "❤️" }]]);

      // 同一块再点另一个：换掉，不加第二个。
      expect((await react(ceo, { runId: answer.runId, role: "assistant", part: 0, emoji: "😂" })).statusCode).toBe(200);
      expect((await history(ceo)).at(-1)?.reactions).toEqual([{ part: 0, emoji: "😂" }, { part: 2, emoji: "❤️" }]);

      // 别人对同一个 runId 写只落在他自己名下，不动本人的。
      expect((await react(member, { runId: answer.runId, role: "assistant", part: 0, emoji: "😮" })).statusCode).toBe(200);
      expect((await history(ceo)).at(-1)?.reactions).toEqual([{ part: 0, emoji: "😂" }, { part: 2, emoji: "❤️" }]);

      // null 是取消这一块的，别的块还在。
      const cleared = await react(ceo, { runId: answer.runId, role: "assistant", part: 0, emoji: null });
      expect(cleared.json()).toEqual({ runId: answer.runId, role: "assistant", part: 0, emoji: null });
      expect((await history(ceo)).at(-1)?.reactions).toEqual([{ part: 2, emoji: "❤️" }]);
      await react(ceo, { runId: answer.runId, role: "assistant", part: 2, emoji: null });
      const after = await history(ceo);
      expect(after.at(-1)).not.toHaveProperty("reactions");
      expect(after[0].reactions).toEqual([{ part: 0, emoji: "🙏" }]);
      expect(await t.sql("SELECT count(*)::int AS n FROM conversation_reactions WHERE person_id = $1 AND role = 'assistant'", [TEST_CEO.personId])).toEqual([{ n: 0 }]);
    } finally {
      await t.close();
    }
  });

  it("老数据（part = -1，这条消息的最后一块）原样读出来，也能按 -1 换掉、取消", async () => {
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: ceo, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "你好" } });
      const history = async (): Promise<Row[]> => (await t.app.inject({
        method: "GET", url: "/api/conversations/global/messages", headers: { cookie: ceo },
      })).json().messages;
      const answer = (await history())[1];
      await t.sql("INSERT INTO conversation_reactions (person_id, scope, run_id, role, emojis, reactor, part) VALUES ($1, 'global', $2, 'assistant', ARRAY['🎉'], 'person', -1)",
        [TEST_CEO.personId, answer.runId]);
      expect((await history())[1].reactions).toEqual([{ part: -1, emoji: "🎉" }]);
      const react = (emoji: string | null) => t.app.inject({ method: "PUT", url: "/api/conversations/global/reactions",
        headers: { cookie: ceo, origin: t.publicOrigin }, payload: { runId: answer.runId, role: "assistant", part: -1, emoji } });
      expect((await react("👍")).statusCode).toBe(200);
      expect((await history())[1].reactions).toEqual([{ part: -1, emoji: "👍" }]);
      expect((await react(null)).statusCode).toBe(200);
      expect((await history())[1]).not.toHaveProperty("reactions");
    } finally {
      await t.close();
    }
  });

  it("伙伴的 👍 在第 0 块、和本人点的分开存，本人改自己的不动伙伴的", async () => {
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: ceo, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "你好" } });
      const history = async (): Promise<Row[]> => (await t.app.inject({
        method: "GET", url: "/api/conversations/global/messages", headers: { cookie: ceo },
      })).json().messages;
      const [asked] = await history();
      const q = t.pool.query.bind(t.pool) as Query;
      const buddy = (emoji: string) => addBuddyReaction(q, { personId: TEST_CEO.personId, scope: "global", runId: asked.runId, role: "user", emoji });
      // 伙伴点的同一个只算一个、最多 3 个，回整组。
      expect(await buddy("👍")).toEqual(["👍"]);
      expect(await buddy("👍")).toEqual(["👍"]);
      await buddy("❤️");
      await buddy("😂");
      expect(await buddy("😮")).toEqual(["👍", "❤️", "😂"]);
      expect(await t.sql("SELECT reactor, part FROM conversation_reactions")).toEqual([{ reactor: "buddy", part: 0 }]);
      await t.sql("UPDATE conversation_reactions SET emojis = ARRAY['👍'] WHERE reactor = 'buddy'");

      const react = (emoji: string | null) => t.app.inject({ method: "PUT", url: "/api/conversations/global/reactions",
        headers: { cookie: ceo, origin: t.publicOrigin }, payload: { runId: asked.runId, role: "user", part: 0, emoji } });
      expect((await react("🙏")).statusCode).toBe(200);
      expect((await history())[0]).toMatchObject({ reactions: [{ part: 0, emoji: "🙏" }], buddyReactions: ["👍"] });

      // 本人取消自己的：伙伴的还在。
      expect((await react(null)).json()).toEqual({ runId: asked.runId, role: "user", part: 0, emoji: null });
      const after = (await history())[0];
      expect(after).not.toHaveProperty("reactions");
      expect(after.buddyReactions).toEqual(["👍"]);
      expect(await t.sql("SELECT reactor, part, emojis FROM conversation_reactions")).toEqual([{ reactor: "buddy", part: 0, emojis: ["👍"] }]);
    } finally {
      await t.close();
    }
  });

  it("不合规的不收；看不到的项目对话不能挂", async () => {
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      const react = (body: unknown, scope = "global") => t.app.inject({
        method: "PUT", url: `/api/conversations/${encodeURIComponent(scope)}/reactions`,
        headers: { cookie: ceo, origin: t.publicOrigin }, payload: body,
      });
      expect((await react({ runId: "r1", role: "assistant", part: 0, emoji: "x".repeat(17) })).statusCode).toBe(400);
      expect((await react({ runId: "r1", role: "assistant", part: -2, emoji: "👍" })).statusCode).toBe(400);
      expect((await react({ runId: "r1", role: "assistant", emoji: "👍" })).statusCode).toBe(400);
      expect((await react({ runId: "r1", role: "assistant", part: 0, emoji: "👍" }, "project:00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
      expect((await react({ runId: "r1", role: "assistant", part: 0, emoji: "👍" }, "issue:x")).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
