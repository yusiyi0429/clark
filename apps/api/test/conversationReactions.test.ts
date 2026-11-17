import { describe, expect, it } from "vitest";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { addBuddyReaction } from "../src/conversationReactions.js";
import type { Query } from "../src/meetingStore.js";

const runtime: ConversationRuntime = {
  async run(input) {
    input.emit({ type: "message", delta: "好的" });
    return { assistantMessage: "好的", runtimeEntries: [] };
  },
};

type Row = { role: string; runId: string; reactions?: string[] };

describe("对话消息上的表情（本人自己的标记）", { timeout: 30_000 }, () => {
  it("挂上、同一个只算一个、读历史带回来、只动自己的、取消", async () => {
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
      const react = (cookie: string, body: unknown, scope = "global") => t.app.inject({
        method: "PUT", url: `/api/conversations/${encodeURIComponent(scope)}/reactions`,
        headers: { cookie, origin: t.publicOrigin }, payload: body,
      });

      const added = await react(ceo, { runId: answer.runId, role: "assistant", emojis: ["👍", "👍", "❤️"] });
      expect(added.statusCode).toBe(200);
      expect(added.json()).toEqual({ runId: answer.runId, role: "assistant", emojis: ["👍", "❤️"] });
      expect((await react(ceo, { runId: asked.runId, role: "user", emojis: ["🙏"] })).statusCode).toBe(200);

      const read = await history(ceo);
      expect(read.map((message) => message.reactions)).toEqual([["🙏"], ["👍", "❤️"]]);

      // 别人对同一个 runId 写只落在他自己名下，不动本人的。
      expect((await react(member, { runId: answer.runId, role: "assistant", emojis: ["😂"] })).statusCode).toBe(200);
      expect((await history(ceo)).at(-1)?.reactions).toEqual(["👍", "❤️"]);
      expect(await t.sql("SELECT person_id, emojis FROM conversation_reactions WHERE role = 'assistant' ORDER BY person_id")).toEqual([
        { person_id: TEST_CEO.personId, emojis: ["👍", "❤️"] },
        { person_id: TEST_MEMBER.personId, emojis: ["😂"] },
      ]);

      const cleared = await react(ceo, { runId: answer.runId, role: "assistant", emojis: [] });
      expect(cleared.json()).toEqual({ runId: answer.runId, role: "assistant", emojis: [] });
      const after = await history(ceo);
      expect(after.at(-1)).not.toHaveProperty("reactions");
      expect(after[0].reactions).toEqual(["🙏"]);
      expect(await t.sql("SELECT count(*)::int AS n FROM conversation_reactions WHERE person_id = $1 AND role = 'assistant'", [TEST_CEO.personId])).toEqual([{ n: 0 }]);
    } finally {
      await t.close();
    }
  });

  it("伙伴点的和本人点的分开存，本人改自己的不动伙伴的", async () => {
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: ceo, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "你好" } });
      const history = async (): Promise<(Row & { buddyReactions?: string[] })[]> => (await t.app.inject({
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
      await t.sql("UPDATE conversation_reactions SET emojis = ARRAY['👍'] WHERE reactor = 'buddy'");

      const react = (emojis: string[]) => t.app.inject({ method: "PUT", url: "/api/conversations/global/reactions",
        headers: { cookie: ceo, origin: t.publicOrigin }, payload: { runId: asked.runId, role: "user", emojis } });
      expect((await react(["🙏"])).statusCode).toBe(200);
      expect((await history())[0]).toMatchObject({ reactions: ["🙏"], buddyReactions: ["👍"] });

      // 本人取消自己的：伙伴的还在。
      expect((await react([])).json()).toEqual({ runId: asked.runId, role: "user", emojis: [] });
      const after = (await history())[0];
      expect(after).not.toHaveProperty("reactions");
      expect(after.buddyReactions).toEqual(["👍"]);
      expect(await t.sql("SELECT reactor, emojis FROM conversation_reactions")).toEqual([{ reactor: "buddy", emojis: ["👍"] }]);
    } finally {
      await t.close();
    }
  });

  it("超过上限不收；看不到的项目对话不能挂", async () => {
    const t = await createTestApp({}, runtime);
    try {
      const ceo = await t.loginCookie();
      const react = (body: unknown, scope = "global") => t.app.inject({
        method: "PUT", url: `/api/conversations/${encodeURIComponent(scope)}/reactions`,
        headers: { cookie: ceo, origin: t.publicOrigin }, payload: body,
      });
      expect((await react({ runId: "r1", role: "assistant", emojis: ["👍", "❤️", "😂", "😮"] })).statusCode).toBe(400);
      expect((await react({ runId: "r1", role: "assistant", emojis: ["👍"] }, "project:00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
      expect((await react({ runId: "r1", role: "assistant", emojis: ["👍"] }, "issue:x")).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
