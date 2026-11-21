import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boardFixture } from "./boardFixture.js";

/**
 * 子会话里本人说的话和回执（17.4，本机同步条目 user_message、receipt）：云端收下、存好，卡和专题详情的 runs[].messages 读得到。
 * 回执以本机序号最新的为准，回执比话先到也不丢。
 */
describe("子会话的消息回执（user_message、receipt）", { timeout: 60_000 }, () => {
  it("收下本人说的话（附件只有文件名）和回执；晚到的旧回执不覆盖新的；回执先到、话后到也对得上；卡详情按先后列出", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const card = await f.card("跑题库打分");
      await f.t.sql("UPDATE tasks SET executor='claude_code' WHERE id=$1", [card]);
      const machine = await f.local();
      const session = randomUUID();
      const sync = async (items: [number, string, unknown][]) => {
        const res = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${machine.token}` }, payload: {
          deviceId: machine.device, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 },
          items: items.map(([seq, type, data]) => ({ key: `${machine.device}:${session}:${seq}`, sessionId: session, subject: { kind: "card", cardId: card },
            occurredAt: new Date(Date.UTC(2026, 10, 6, 1, 0, seq)).toISOString(), type, data })) } });
        expect(res.statusCode).toBe(200);
        return res.json() as { rejected: unknown[] };
      };
      const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
      expect((await sync([
        [1, "status", { status: "running", title: "跑题库打分", agent: "claude-code", modelLabel: "订阅 · Sonnet" }],
        [2, "user_message", { messageId: first, text: "先跑 10 题", attachments: ["题库.xlsx"] }],
        [4, "receipt", { messageId: first, state: "read" }],
        // 第二句的回执比话先到。
        [5, "receipt", { messageId: second, state: "delivered" }],
        [6, "user_message", { messageId: second, text: "再加 5 题" }],
        [7, "user_message", { messageId: third, text: "算了先停" }],
        [8, "receipt", { messageId: third, state: "delivered" }],
        [9, "receipt", { messageId: third, state: "failed" }],
      ])).rejected).toEqual([]);
      // 晚到的旧回执（序号更小）不把「已读」改回「已送达」。
      expect((await sync([[3, "receipt", { messageId: first, state: "delivered" }]])).rejected).toEqual([]);

      const detail = (await f.call("GET", `/api/me/cards/${card}`)).json();
      expect(detail.runs[0].messages).toEqual([
        { messageId: first, text: "先跑 10 题", attachments: ["题库.xlsx"], at: "2026-11-06T01:00:02.000Z", receipt: "read" },
        { messageId: second, text: "再加 5 题", attachments: [], at: "2026-11-06T01:00:06.000Z", receipt: "delivered" },
        { messageId: third, text: "算了先停", attachments: [], at: "2026-11-06T01:00:07.000Z", receipt: "failed" },
      ]);
      // 只有回执、还没收到原话的那一句不列。
      await sync([[10, "receipt", { messageId: randomUUID(), state: "delivered" }]]);
      expect((await f.call("GET", `/api/me/cards/${card}`)).json().runs[0].messages).toHaveLength(3);
    } finally { await f.close(); }
  });
});
