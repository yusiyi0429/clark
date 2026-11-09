import type { Query } from "./meetingStore.js";

/**
 * 左栏蓝点（17.2 第 25 条，契约 SubSession.unseen、HomeProject.unseen）：本人看过子会话、项目对话的时间，按人记。
 * 子会话停下的时间晚于看过的时间、项目对话里新的回复或汇报晚于看过的时间，就是没看过。
 */

/** 本人打开了一个子会话或项目对话：记下时间（幂等，只往后走）。 */
export async function markWorkSeen(q: Query, personId: string, kind: "sub" | "project", id: string, now: Date): Promise<void> {
  await q(`INSERT INTO work_seen(person_id,kind,object_id,seen_at) VALUES($1,$2,$3,$4)
    ON CONFLICT (person_id,kind,object_id) DO UPDATE SET seen_at=GREATEST(work_seen.seen_at,EXCLUDED.seen_at)`, [personId, kind, id, now]);
}

/** 本人看过的时间：key 是 kind:id。 */
export async function seenTimes(q: Query, personId: string): Promise<Map<string, Date>> {
  return new Map(((await q("SELECT kind,object_id::text AS id,seen_at FROM work_seen WHERE person_id=$1", [personId])).rows as
    { kind: string; id: string; seen_at: Date }[]).map((row) => [`${row.kind}:${row.id}`, row.seen_at]));
}

/** 有了新情况的时间晚于看过的时间（没看过算没看过）。没有新情况为 false。 */
export const unseenSince = (happenedAt: string | Date | null, seenAt: Date | undefined) =>
  happenedAt !== null && (!seenAt || new Date(happenedAt).getTime() > seenAt.getTime());

/** 项目对话最近一次有新的回复或汇报：Chat 那边回完一轮记的时间、天枢自己的对话里最后一条回答、子会话最近一条报告，取最晚的。 */
export async function projectNewsAt(q: Query, ownerId: string, projectIds: string[]): Promise<Map<string, Date>> {
  if (!projectIds.length) return new Map();
  const rows = (await q(`SELECT p.id::text,GREATEST(p.pipeline_reply_at,
      (SELECT max(r.created_at) FROM sub_session_reports r WHERE r.project_id=p.id),
      (SELECT max(m.created_at) FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE c.owner_id=$1 AND c.scope='project:'||p.id::text AND m.role='assistant')) AS at
    FROM projects p WHERE p.id=ANY($2::uuid[])`, [ownerId, projectIds])).rows as { id: string; at: Date | null }[];
  return new Map(rows.flatMap((row) => row.at ? [[row.id, row.at] as const] : []));
}

/** 接了 Chat 的项目对话回完了一轮。 */
export async function recordProjectReply(q: Query, projectId: string, now: Date): Promise<void> {
  await q("UPDATE projects SET pipeline_reply_at=$2 WHERE id=$1", [projectId, now]);
}
