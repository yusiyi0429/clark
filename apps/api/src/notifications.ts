import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TNotificationKind, TNotificationView } from "@warmap/contracts";
import type { PeopleDirectory } from "./peopleDirectory.js";
import type { Query } from "./meetingStore.js";
import { personDisplayNames } from "./people.js";

/**
 * 通知只存指向哪个对象：object_type/object_id 指向执行事项、会议、议题或请求，
 * strategic_rejected（旧会议的战略项，已不再发）另用 item_id 指向会议里的战略项；文案读取时按对象当前状态组合。
 * 有唯一约束的（meeting_card_pending 一人一场会一条）重复时不插，返回 false。
 */
export async function insertNotification(
  client: PoolClient,
  input: { personId: string; kind: TNotificationKind; objectType: "task" | "meeting" | "issue" | "request"; objectId: string; itemId?: string; actorId?: string },
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO notifications (id, person_id, kind, object_type, object_id, item_id, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [randomUUID(), input.personId, input.kind, input.objectType, input.objectId, input.itemId ?? null, input.actorId ?? null],
  );
  return inserted.rowCount === 1;
}

/**
 * 有人在执行事项上写了进展：推进人和在场协作者（不含作者）各一条「协作进展」；
 * 那人这件事已有没看过的，就把它顶到最前、记下最新的作者（文案读取时按最新进展组）。
 */
export async function notifyTaskProgress(client: PoolClient, taskId: string, authorId: string): Promise<void> {
  await client.query(
    `INSERT INTO notifications (id, person_id, kind, object_type, object_id, actor_id)
     SELECT gen_random_uuid(), p.person_id, 'task_progress_added', 'task', $1, $2
       FROM (SELECT owner_id AS person_id FROM tasks WHERE id = $1::uuid
             UNION SELECT person_id FROM task_members WHERE task_id = $1::uuid AND role = 'collaborator' AND left_at IS NULL) p
      WHERE p.person_id <> $2
     ON CONFLICT (person_id, object_id) WHERE kind = 'task_progress_added' AND read_at IS NULL
     DO UPDATE SET created_at = clock_timestamp(), actor_id = EXCLUDED.actor_id`,
    [taskId, authorId],
  );
}

type NotificationRow = {
  id: string;
  kind: TNotificationKind;
  object_type: "task" | "meeting" | "issue" | "request";
  object_id: string;
  actor_id: string | null;
  created_at: Date;
  read_at: Date | null;
  task_title: string | null;
  return_reason: string | null;
  meeting_title: string | null;
  issue_title: string | null;
  item_title: string | null;
  item_id: string | null;
  issue_assignments: { assignedAt: string; note: string | null }[] | null;
  request_title: string | null;
  request_kind: string | null;
  impact_trigger: string | null;
  progress_author: string | null;
  progress_body: string | null;
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
    case "task_submitted":
      return `「${row.task_title ?? ""}」等你验收`;
    case "issue_assigned": {
      // item_id 是这次指派的时间：改派过也能找回当时那句说明。
      const note = row.issue_assignments?.find((entry) => entry.assignedAt === row.item_id)?.note;
      return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"} 请你主责议题「${row.issue_title ?? ""}」${note ? `：${note}` : ""}`;
    }
    case "request_received":
      // 影响卡：会上定的事影响到你手上的事。
      if (row.request_kind === "impact") return `${row.impact_trigger === "doc_change" ? "文档变更影响你" : "会后影响你"}：${row.request_title ?? ""}`;
      // 文档变更：作者确认新文档修订或取代了哪份，或旧文档负责人被问「还有效吗」。
      if (row.request_kind === "doc_change") return `文档变更：${row.request_title ?? ""}`;
      if (row.request_kind === "collection") return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"}请你填：${row.request_title ?? ""}`;
      return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"}请你：${row.request_title ?? ""}`;
    case "request_answered":
      return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"}回答了你的问题：${row.request_title ?? ""}`;
    case "request_asked":
      return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"}问你：${row.request_title ?? ""}`;
    case "request_done":
      if (row.request_kind === "collection") return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"}确认了：${row.request_title ?? ""}`;
      return `${row.actor_id ? (names.get(row.actor_id) ?? row.actor_id) : "同事"}完成了：${row.request_title ?? ""}`;
    case "collection_reminder":
      return `截止前提醒：${row.request_title ?? ""}`;
    case "meeting_card_pending":
      return `${row.meeting_title ?? ""} · 会议记录待确认`;
    case "task_progress_added": {
      const author = row.progress_author ?? row.actor_id;
      const line = row.progress_body?.split(/\r?\n/).map((text) => text.trim()).find(Boolean);
      return `${author ? (names.get(author) ?? author) : "同事"} 在「${row.task_title ?? ""}」写了进展${line ? `：${line}` : ""}`;
    }
  }
}

/** 我的通知：未读在前，最近 50 条。 */
export async function listMyNotifications(q: Query, peopleDirectory: PeopleDirectory, personId: string): Promise<TNotificationView[]> {
  const result = await q(
    `SELECT n.id::text, n.kind, n.object_type, n.object_id, n.item_id, n.actor_id, n.created_at, n.read_at,
            t.title AS task_title, t.return_reason, m.title AS meeting_title, i.title AS issue_title, i.assignments AS issue_assignments, r.title AS request_title, r.kind AS request_kind,
            (SELECT ic.trigger_kind FROM impact_cards ic WHERE ic.request_id = r.id) AS impact_trigger,
            (SELECT item->>'title' FROM jsonb_array_elements(m.outcome->'items') AS item WHERE item->>'id' = n.item_id) AS item_title,
            lp.author_id AS progress_author, lp.body AS progress_body
       FROM notifications n
       LEFT JOIN tasks t ON n.object_type = 'task' AND t.id::text = n.object_id
       LEFT JOIN meetings m ON m.id::text = CASE WHEN n.object_type = 'task' THEN t.origin_meeting_id::text ELSE n.object_id END
       LEFT JOIN issues i ON n.object_type = 'issue' AND i.id::text = n.object_id
       LEFT JOIN requests r ON n.object_type = 'request' AND r.id::text = n.object_id
       LEFT JOIN LATERAL (SELECT tp.author_id, tp.body FROM task_progress tp
                           WHERE n.kind = 'task_progress_added' AND tp.task_id = t.id AND tp.author_id <> n.person_id
                           ORDER BY tp.created_at DESC, tp.id DESC LIMIT 1) lp ON true
      WHERE n.person_id = $1
      ORDER BY n.read_at IS NOT NULL, n.created_at DESC
      LIMIT 50`,
    [personId],
  );
  const names = personDisplayNames(peopleDirectory);
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
