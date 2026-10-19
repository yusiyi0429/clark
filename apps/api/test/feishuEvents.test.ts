import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { createJobWorker } from "../src/jobs.js";
import { feishuEventDedupeKey, feishuEventJobs, recordFeishuEvent } from "../src/feishu/events.js";
import { createTestDb } from "./helpers.js";

/** SDK 交给处理函数的是拍平后的事件：header 字段与 event 字段在同一层。 */
const messageEvent = (eventId: string, messageId: string) => ({
  schema: "2.0", event_id: eventId, event_type: "im.message.receive_v1", token: "verification-token", app_id: "cli_test",
  sender: { sender_id: { open_id: "ou_sender" } },
  message: { message_id: messageId, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "你好" }) },
});

describe("飞书长连接事件", () => {
  it("去重键：消息按 message_id，其他按 event_id", () => {
    expect(feishuEventDedupeKey(messageEvent("ev1", "om_1"))).toBe("message:om_1");
    expect(feishuEventDedupeKey({ event_id: "ev2", chat_id: "oc_1" })).toBe("event:ev2");
    expect(feishuEventDedupeKey({ uuid: "legacy" })).toBe("event:legacy");
    expect(feishuEventDedupeKey({})).toBeNull();
  });

  it("重复投递只落一次库、只排一个任务；校验 token 不进库；任务处理后标记已处理", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      expect(await recordFeishuEvent(pool, "im.message.receive_v1", messageEvent("ev1", "om_1"))).toBe("recorded");
      // 同一条消息以新的 event_id 重投、并发重投
      const again = await Promise.all([
        recordFeishuEvent(pool, "im.message.receive_v1", messageEvent("ev1-retry", "om_1")),
        recordFeishuEvent(pool, "im.message.receive_v1", messageEvent("ev1", "om_1")),
      ]);
      expect(again).toEqual(["duplicate", "duplicate"]);
      expect(await recordFeishuEvent(pool, "im.message.receive_v1", messageEvent("ev2", "om_2"))).toBe("recorded");

      const events = (await db.query("SELECT dedupe_key, event_id, payload, processed_at FROM feishu_events ORDER BY id")).rows;
      expect(events.map((e) => e.dedupe_key)).toEqual(["message:om_1", "message:om_2"]);
      expect(events[0].event_id).toBe("ev1");
      expect(events[0].payload).not.toHaveProperty("token");
      expect(events[0].payload.message.message_id).toBe("om_1");
      expect((await db.query("SELECT kind, count(*)::int AS n FROM jobs GROUP BY kind")).rows).toEqual([{ kind: "feishu.event", n: 2 }]);

      const worker = createJobWorker({ pool, handlers: feishuEventJobs(pool) });
      expect(await worker.tick()).toBe(2);
      expect((await db.query("SELECT count(*)::int AS n FROM feishu_events WHERE processed_at IS NOT NULL")).rows[0].n).toBe(2);
    });
  });

  it("按事件类型交给注册的处理函数（妙记生成 → 会议链路）；处理失败不标记、交给 jobs 重试", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const minuteEvent = { schema: "2.0", event_id: "ev-minute", event_type: "minutes.minute.generated_v1", minute_token: "obcn1" };
      expect(await recordFeishuEvent(pool, "minutes.minute.generated_v1", minuteEvent)).toBe("recorded");
      const seen: unknown[] = [];
      let fail = true;
      const handlers = { "minutes.minute.generated_v1": async (payload: Record<string, unknown>) => { seen.push(payload.minute_token); if (fail) throw new Error("not ready"); } };
      let at = new Date();
      const worker = createJobWorker({ pool, handlers: feishuEventJobs(pool, handlers), now: () => at });
      await worker.tick();
      expect((await db.query("SELECT processed_at FROM feishu_events")).rows[0].processed_at).toBeNull();
      fail = false;
      at = new Date(at.getTime() + 2 * 60_000);
      await worker.tick();
      expect(seen).toEqual(["obcn1", "obcn1"]);
      expect((await db.query("SELECT processed_at FROM feishu_events")).rows[0].processed_at).not.toBeNull();
    });
  });
});
