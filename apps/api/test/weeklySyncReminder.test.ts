import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, executionFixture, newTask, type Fixture } from "./executionFixture.js";

const reminder = async (f: Fixture) => (await call(f, f.member, "GET", "/api/me/home")).json().weeklySync;

describe("周五兜底提醒", () => {
  it("周五 18:00 起、本周没有外部 Agent 进展才提醒，并区分有没有连接", async () => {
    const f = await executionFixture();
    try {
      f.setNow(new Date("2026-10-09T09:59:00Z")); // 周五 17:59
      expect(await reminder(f)).toBeNull();
      f.setNow(new Date("2026-10-09T10:00:00Z")); // 周五 18:00
      expect(await reminder(f)).toEqual({ reason: "no_connection" });
      const { token, view } = (await call(f, f.member, "POST", "/api/me/tokens", { name: "笔记本", client: "codex", expiresInDays: 30 })).json();
      expect(await reminder(f)).toEqual({ reason: "not_synced" });
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      expect((await call(f, f.member, "POST", `/api/me/tasks/${task.id}/progress`, { clientEventId: randomUUID(), body: "网页写的" })).statusCode).toBe(200);
      await f.t.sql("UPDATE task_progress SET created_at=$1", ["2026-10-08T00:00:00Z"]);
      expect(await reminder(f)).toEqual({ reason: "not_synced" }); // 网页来源不算同步
      const sent = await f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "append_progress", arguments: { itemId: task.id, body: "Agent 同步" } } } });
      expect(sent.json().result.isError).toBe(false);
      await f.t.sql("UPDATE task_progress SET created_at=$1 WHERE source='codex'", ["2026-10-04T15:59:00Z"]); // 上周日 23:59
      expect(await reminder(f)).toEqual({ reason: "not_synced" });
      await f.t.sql("UPDATE task_progress SET created_at=$1 WHERE source='codex'", ["2026-10-04T16:00:00Z"]); // 本周一 00:00
      expect(await reminder(f)).toBeNull();
      await f.t.sql("DELETE FROM task_progress WHERE source='codex'");
      await f.t.sql("UPDATE personal_tokens SET expires_at=$2 WHERE id=$1", [view.id, "2026-10-09T09:00:00Z"]);
      expect(await reminder(f)).toEqual({ reason: "no_connection" }); // 过期算没有连接
      f.setNow(new Date("2026-10-11T15:59:00Z")); // 周日 23:59
      expect(await reminder(f)).toEqual({ reason: "no_connection" });
      f.setNow(new Date("2026-10-11T16:00:00Z")); // 下周一 00:00
      expect(await reminder(f)).toBeNull();
    } finally { await f.t.close(); }
  });
});
