import * as Lark from "@larksuiteoapi/node-sdk";
import type { Pool } from "pg";
import type { JobHandler } from "../jobs.js";
import type { FeishuEnv } from "./config.js";

export const FEISHU_EVENT_KIND = "feishu.event";
/** 长连接订阅的事件；开发者后台「事件与回调」里也要勾上同样的事件。业务处理留给后续，这里只接入、落库、去重。 */
export const FEISHU_SUBSCRIBED_EVENTS = ["im.message.receive_v1"] as const;

/** 至少投递一次：消息类按 message_id，其余按 event_id（1.0 版事件是 uuid）去重。 */
export function feishuEventDedupeKey(data: Record<string, unknown>): string | null {
  const messageId = (data.message as { message_id?: unknown } | undefined)?.message_id;
  if (typeof messageId === "string" && messageId) return `message:${messageId}`;
  const eventId = data.event_id ?? data.uuid;
  return typeof eventId === "string" && eventId ? `event:${eventId}` : null;
}

/**
 * 收到事件只做这一件事：落库并在同一条语句里排一个 feishu.event 任务，然后立即返回（3 秒内 ack）。
 * 重复投递撞上 dedupe_key 唯一约束，既不新建事件也不重复排任务。
 */
export async function recordFeishuEvent(pool: Pool, eventType: string, data: Record<string, unknown>): Promise<"recorded" | "duplicate" | "ignored"> {
  const dedupeKey = feishuEventDedupeKey(data);
  if (!dedupeKey) return "ignored";
  // 事件里的 token 是事件订阅的校验凭据，不进库。
  const { token: _token, ...payload } = data;
  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO feishu_events (dedupe_key, event_type, event_id, payload) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
     )
     INSERT INTO jobs (kind, dedupe_key, payload)
     SELECT $5, $5 || ':' || id, jsonb_build_object('feishuEventId', id) FROM inserted
     RETURNING id`,
    [dedupeKey, eventType, typeof data.event_id === "string" ? data.event_id : null, JSON.stringify(payload), FEISHU_EVENT_KIND],
  );
  return result.rows.length ? "recorded" : "duplicate";
}

/** 事件的后续处理：目前只标记已处理，具体业务（消息里的文档链接等）留给后续。 */
export function feishuEventJobs(pool: Pool): Record<string, JobHandler> {
  return {
    [FEISHU_EVENT_KIND]: async (payload) => {
      await pool.query("UPDATE feishu_events SET processed_at = now() WHERE id = $1 AND processed_at IS NULL", [(payload as { feishuEventId?: unknown }).feishuEventId]);
    },
  };
}

/**
 * 长连接（仅企业自建应用支持，每个应用最多 50 条）：SDK 在处理函数返回后 ack；落库失败时抛错，飞书会重新投递。
 */
export function startFeishuEventStream(pool: Pool, env: Pick<FeishuEnv, "appId" | "appSecret">): { close: () => void } {
  const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.warn });
  dispatcher.register(Object.fromEntries(FEISHU_SUBSCRIBED_EVENTS.map((eventType) => [
    eventType,
    async (data: Record<string, unknown>) => { await recordFeishuEvent(pool, eventType, data); },
  ])));
  const client = new Lark.WSClient({
    appId: env.appId,
    appSecret: env.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
    onError: (error) => console.warn(`feishu event stream stopped: ${error.message}`),
  });
  void client.start({ eventDispatcher: dispatcher }).catch((error: Error) => console.warn(`feishu event stream failed to start: ${error.message}`));
  return { close: () => client.close() };
}
