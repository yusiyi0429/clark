import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TNotificationKind, TNotificationView } from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { personDisplayNames } from "./people.js";

/**
 * 通知只存指向哪个对象：object_type/object_id 指向执行事项或会议，
 * strategic_rejected 另用 item_id 指向会议里的战略项；文案读取时按对象当前状态组合。
 */
export async function insertNotification(
  client: PoolClient,
  input: { personId: string; kind: TNotificationKind; objectType: "task" | "meeting" | "issue"; objectId: string; itemId?: string; actorId?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO notifications (id, person_id, kind, object_type, object_id, item_id, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), input.personId, input.kind, input.objectType, input.objectId, input.itemId ?? null, input.actorId ?? null],
  );
}

type NotificationRow = {
  id: string;
  kind: TNotificationKind;
  object_type: "task" | "meeting" | "issue";
  object_id: string;
  actor_id: string | null;
  created_at: Date;
  read_at: Date | null;
  task_title: string | null;
  return_reason: string | null;
  meeting_title: string | null;
  issue_title: string | null;
  item_title: string | null;
};

function composeText(row: NotificationRow, names: Map<string, string>): string {
  switch (row.kind) {
    case "meeting_action_assigned":
      return `会议「${row.meeting_title ?? ""}」给你分配了执行事项「${row.task_title ?? ""}」`;
    case "task_returned": {
      const actor = row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "负责人";
      return `${actor} 退回了执行事项「${row.task_title ?? ""}」${row.return_reason ? `：${row.return_reason}` : ""}`;
    }
    case "strategic_rejected":
      return `CEO 不同意「${row.item_title ?? ""}」`;
    case "task_collaborator_added":
      return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"}邀请你协作「${row.task_title ?? ""}」`;
    case "thread_member_added":
      return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"} 拉你进${row.object_type === "issue" ? "议题" : "会议"}「${row.object_type === "issue" ? row.issue_title ?? "" : row.meeting_title ?? ""}」`;
  }
}

/** 我的通知：未读在前，最近 50 条。 */
export async function listMyNotifications(q: Query, companyMemory: CompanyMemoryRepository, personId: string): Promise<TNotificationView[]> {
  const result = await q(
    `SELECT n.id::text, n.kind, n.object_type, n.object_id, n.actor_id, n.created_at, n.read_at,
            t.title AS task_title, t.return_reason, m.title AS meeting_title, i.title AS issue_title,
            (SELECT item->>'title' FROM jsonb_array_elements(m.outcome->'items') AS item WHERE item->>'id' = n.item_id) AS item_title
       FROM notifications n
       LEFT JOIN tasks t ON n.object_type = 'task' AND t.id::text = n.object_id
       LEFT JOIN meetings m ON m.id::text = CASE WHEN n.object_type = 'task' THEN t.origin_meeting_id::text ELSE n.object_id END
       LEFT JOIN issues i ON n.object_type = 'issue' AND i.id::text = n.object_id
      WHERE n.person_id = $1
      ORDER BY n.read_at IS NOT NULL, n.created_at DESC
      LIMIT 50`,
    [personId],
  );
  const names = personDisplayNames(companyMemory);
  return (result.rows as NotificationRow[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    text: composeText(row, names),
    objectType: row.object_type,
    objectId: row.object_id,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  }));
}

/** 只标自己的；文本比较避免非 UUID 的 id 触发类型错误。 */
export async function markNotificationsSeen(q: Query, personId: string, notificationIds: string[]): Promise<void> {
  await q(
    "UPDATE notifications SET read_at = now() WHERE person_id = $1 AND id::text = ANY($2::text[]) AND read_at IS NULL",
    [personId, notificationIds],
  );
}
