import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

const NOW = "2026-11-06T02:00:00.000Z";

describe("同事对话、好友的表", { timeout: 60_000 }, () => {
  it("同一对只有一段；伙伴句不带作答状态；好友一对一行", async () => {
    const t = await createTestApp();
    try {
      const chat = () => t.sql("INSERT INTO colleague_chats (id, asker_id, owner_id, created_at, last_message_at) VALUES ($1, 'a', 'b', $2, $2) RETURNING id",
        [randomUUID(), NOW]);
      const [{ id: chatId }] = await chat();
      await expect(chat()).rejects.toMatchObject({ code: "23505" });
      await expect(t.sql(
        "INSERT INTO colleague_chat_messages (id, chat_id, author, body, client_id, created_at, answer_state) VALUES ($1, $2, 'buddy', '按拆分手册拆四件', $3, $4, 'answering')",
        [randomUUID(), chatId, randomUUID(), NOW],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(t.sql(
        "INSERT INTO colleague_friendships (low_id, high_id, status, requested_by, requested_at) VALUES ('b', 'a', 'pending', 'a', $1)", [NOW],
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await t.close();
    }
  });
});
