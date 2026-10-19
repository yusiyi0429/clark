import type { Pool } from "pg";
import { enqueueJob, type JobHandler } from "../jobs.js";
import type { Query } from "../meetingStore.js";
import type { FeishuClient } from "./client.js";
import { sendFeishuLinkCard, type FeishuLinkCard } from "./messages.js";

/**
 * 飞书通知（送达通道的飞书那一半）：按人发一张带「跳回天枢」按钮的消息卡片，不接卡片回调。
 * 走 jobs：入队按 dedupeKey 去重（同一件事只发一次），发送失败按 jobs 的退避重试；这个人没有关联飞书账号时直接算完成。
 */
export const FEISHU_NOTIFY_KIND = "feishu.notify";

export type FeishuNotice = FeishuLinkCard & { personId: string };
export type FeishuNotify = (notice: FeishuNotice, dedupeKey: string) => Promise<void>;

/** 飞书配了才有；没配时调用方拿到 undefined，不入队。 */
export function feishuNotifier(q: Query): FeishuNotify {
  return async (notice, dedupeKey) => {
    await enqueueJob(q, { kind: FEISHU_NOTIFY_KIND, dedupeKey: `${FEISHU_NOTIFY_KIND}:${dedupeKey}`, payload: notice });
  };
}

export function feishuNotifyJobs({ pool, client, publicOrigin }: { pool: Pool; client: Pick<FeishuClient, "sendMessage">; publicOrigin: string }): Record<string, JobHandler> {
  return {
    [FEISHU_NOTIFY_KIND]: async (payload) => {
      const notice = payload as FeishuNotice;
      const openId = (await pool.query("SELECT open_id FROM feishu_identities WHERE person_id = $1", [notice.personId])).rows[0]?.open_id as string | undefined;
      if (!openId) return;
      await sendFeishuLinkCard(client, { type: "open_id", id: openId }, { title: notice.title, body: notice.body, links: notice.links }, publicOrigin);
    },
  };
}
