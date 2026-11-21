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

/** 同事找他、人主动发起的推送：负责人请认可人看、信息收集、群里贴文档推送。 */
export type PeerSource = "acceptor" | "collection" | "doc_change";
/**
 * 人主动发起的推送里，哪几种也归「偏好」里的飞书通知开关管（新首页 13.2）。现在一种都不归：关了会悄悄断了同事之间的协作（11/07 主会话定），
 * 用户拍板以后把要归的加进来。天枢自己主动推的（首页的急事 homePush.ts、CEO 拍板 ceoFeishuNotices.ts）一直归开关管，在各自那里判断。
 */
export const PEER_SOURCES_MUTED_BY_SWITCH: ReadonlySet<PeerSource> = new Set<PeerSource>([]);

export type FeishuNotice = FeishuLinkCard & { personId: string; source?: PeerSource };
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
      if (notice.source && PEER_SOURCES_MUTED_BY_SWITCH.has(notice.source)
        && (await pool.query("SELECT 1 FROM person_settings WHERE person_id=$1 AND NOT feishu", [notice.personId])).rowCount) return;
      const openId = (await pool.query("SELECT open_id FROM feishu_identities WHERE person_id = $1", [notice.personId])).rows[0]?.open_id as string | undefined;
      if (!openId) return;
      await sendFeishuLinkCard(client, { type: "open_id", id: openId }, { title: notice.title, body: notice.body, links: notice.links }, publicOrigin);
    },
  };
}
