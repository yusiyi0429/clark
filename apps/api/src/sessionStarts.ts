import { randomUUID } from "node:crypto";
import type { TSessionStartView } from "@warmap/contracts";
import { UUID_PATTERN, type Query } from "./meetingStore.js";

/**
 * 自动开工（新首页第 4.4 节，契约 workHome.ts）：管线里定了计划（接受草稿带 start）或伙伴开了探索子会话，云端只记一条「要开工」，不指挥本机。
 * 配对的电脑上开着的网页认领后交给本机程序；本机报上这张卡或专题的第一条执行时了结（localSync.ts）。
 * 认领了 5 分钟还没了结的（网页认领后关掉了），别处可以再认领；本机拒了，网页放回。
 */

type StartRow = { id: string; kind: "card" | "topic"; card_id: string | null; topic_id: string | null; plan_task_id: string | null; requested_at: Date };
const startView = (row: StartRow): TSessionStartView => ({ id: row.id, kind: row.kind, cardId: row.card_id, topicId: row.topic_id, taskId: row.plan_task_id,
  requestedAt: row.requested_at.toISOString() });

export type StartRequest = { kind: "card"; cardId: string; planTaskId: string } | { kind: "topic"; topicId: string; planTaskId: string | null };

/** 登记要开工：同一张卡、同一个专题已有一条没了结的就不再插（唯一索引），返回的是那一条。顺序和 items 一样。 */
export async function requestStarts(q: Query, input: { ownerId: string; origin: "web" | "buddy"; now: Date; items: StartRequest[] }): Promise<TSessionStartView[]> {
  const views: TSessionStartView[] = [];
  for (const item of input.items) {
    const [column, subject] = item.kind === "card" ? ["card_id", item.cardId] : ["topic_id", item.topicId];
    const inserted = (await q(`INSERT INTO session_starts(id,owner_id,kind,${column},plan_task_id,origin,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING RETURNING *`, [randomUUID(), input.ownerId, item.kind, subject, item.planTaskId, input.origin, input.now])).rows[0] as StartRow | undefined;
    const row = inserted ?? (await q(`SELECT * FROM session_starts WHERE ${column}=$1 AND closed_at IS NULL`, [subject])).rows[0] as StartRow;
    views.push(startView(row));
  }
  return views;
}

/**
 * 认领（网页在本人配对的电脑上）：设备不是本人的或已吊销为 null（路由回 404）。
 * 一条 UPDATE 认领：没了结、没人认领或认领超过 5 分钟，卡没完成没退回、专题没归档的。两处同时认领同一条只有一处拿到：
 * READ COMMITTED 下后到的 UPDATE 等前一个提交后对那一行重新判 WHERE，claimed_at 已经是刚才的时间，不再满足就跳过。
 */
export async function claimStarts(q: Query, ownerId: string, deviceId: string, now: Date): Promise<TSessionStartView[] | null> {
  if (!(await q("SELECT 1 FROM local_devices WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL", [ownerId, deviceId])).rowCount) return null;
  const rows = (await q(`WITH claimed AS (UPDATE session_starts s SET claimed_at=$3,claimed_device=$2
    WHERE s.owner_id=$1 AND s.closed_at IS NULL AND (s.claimed_at IS NULL OR s.claimed_at < $3::timestamptz - interval '5 minutes')
      AND (s.kind='card' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=s.card_id AND t.status NOT IN ('done','returned'))
        OR s.kind='topic' AND EXISTS (SELECT 1 FROM research_topics r WHERE r.id=s.topic_id AND r.status='active'))
    RETURNING s.*) SELECT * FROM claimed ORDER BY requested_at,id`, [ownerId, deviceId, now])).rows as StartRow[];
  return rows.map(startView);
}

/** 放回（本机拒了）：本人的、没了结的才放回；否则 false。 */
export async function releaseStart(q: Query, ownerId: string, id: string): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;
  return Boolean((await q("UPDATE session_starts SET claimed_at=NULL,claimed_device=NULL WHERE id=$1 AND owner_id=$2 AND closed_at IS NULL", [id, ownerId])).rowCount);
}

/** 本机报上这张卡或专题的第一条执行：了结它没了结的那条。 */
export async function closeStartsFor(q: Query, subject: { cardId?: string; topicId?: string }, at: Date): Promise<void> {
  const [column, id] = subject.cardId ? ["card_id", subject.cardId] : ["topic_id", subject.topicId];
  await q(`UPDATE session_starts SET closed_at=$2 WHERE ${column}=$1 AND closed_at IS NULL`, [id, at]);
}
