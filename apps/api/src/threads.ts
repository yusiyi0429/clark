import type { TThreadMember, TThreadMessage, TThreadObjectType, TThreadQuote } from "@warmap/contracts";
import type { PeopleDirectory } from "./peopleDirectory.js";
import type { Query } from "./meetingStore.js";
import type { PoolClient } from "pg";
import { personDisplayNames } from "./people.js";
import type { IntroInput } from "./threadIntro.js";

/** 群组挂在对象上：一个对象一个群。 */
export type ThreadRef = { objectType: TThreadObjectType; objectId: string };

type MessageRow = {
  id: string;
  kind: "member" | "co-agent";
  author_id: string | null;
  content: string;
  quote: TThreadQuote | null;
  created_at: Date;
};

const MESSAGE_COLUMNS = "id, kind, author_id, content, quote, created_at";

/** 名单上的一句话身份：人员目录只有 roles，没有头衔。 */
function titleOf(roles: string[]): string | null {
  if (roles.includes("ceo")) return "CEO";
  if (roles.includes("dri")) return "DRI";
  return null;
}

function projectMessage(row: MessageRow, names: Map<string, string>): TThreadMessage {
  return {
    id: Number(row.id),
    kind: row.kind,
    authorId: row.author_id,
    authorName: row.author_id ? (names.get(row.author_id) ?? row.author_id) : null,
    content: row.content,
    quote: row.quote,
    createdAt: row.created_at.toISOString(),
  };
}

/** 只有未退出的成员能读能发。 */
export async function isActiveMember(q: Query, ref: ThreadRef, personId: string): Promise<boolean> {
  const result = await q(
    "SELECT 1 FROM thread_members WHERE object_type = $1 AND object_id = $2 AND person_id = $3 AND left_at IS NULL",
    [ref.objectType, ref.objectId, personId],
  );
  return result.rows.length > 0;
}

/** 在群里的人，按加入先后；名字与身份现查人员目录。 */
export async function listMembers(q: Query, peopleDirectory: PeopleDirectory, ref: ThreadRef): Promise<TThreadMember[]> {
  const people = new Map(peopleDirectory.searchPeople(undefined).map((person) => [person.personId, person]));
  const result = await q(
    "SELECT person_id FROM thread_members WHERE object_type = $1 AND object_id = $2 AND left_at IS NULL ORDER BY joined_at, person_id",
    [ref.objectType, ref.objectId],
  );
  return result.rows.map((row) => {
    const person = people.get(row.person_id as string);
    return {
      personId: row.person_id as string,
      displayName: person?.displayName ?? (row.person_id as string),
      title: person ? titleOf(person.roles) : null,
    };
  });
}

/** 不给 after 取最近 limit 条（打开群组）；给了取 after 之后的 limit 条（轮询）。都按 id 升序。 */
export async function listMessages(
  q: Query,
  peopleDirectory: PeopleDirectory,
  ref: ThreadRef,
  after?: number,
  limit = 200,
): Promise<TThreadMessage[]> {
  const result = after === undefined
    ? await q(
      `SELECT * FROM (
         SELECT ${MESSAGE_COLUMNS} FROM thread_messages WHERE object_type = $1 AND object_id = $2 ORDER BY id DESC LIMIT $3
       ) recent ORDER BY id`,
      [ref.objectType, ref.objectId, limit],
    )
    : await q(
      `SELECT ${MESSAGE_COLUMNS} FROM thread_messages
        WHERE object_type = $1 AND object_id = $2 AND id > $3 ORDER BY id LIMIT $4`,
      [ref.objectType, ref.objectId, after, limit],
    );
  const names = personDisplayNames(peopleDirectory);
  return result.rows.map((row) => projectMessage(row as MessageRow, names));
}

export async function postMessage(
  q: Query,
  peopleDirectory: PeopleDirectory,
  ref: ThreadRef,
  authorId: string,
  input: { content: string; quote?: TThreadQuote },
): Promise<TThreadMessage> {
  const result = await q(
    `INSERT INTO thread_messages (object_type, object_id, author_id, kind, content, quote)
     VALUES ($1, $2, $3, 'member', $4, $5::jsonb)
     RETURNING ${MESSAGE_COLUMNS}`,
    [ref.objectType, ref.objectId, authorId, input.content, input.quote ? JSON.stringify(input.quote) : null],
  );
  return projectMessage(result.rows[0] as MessageRow, personDisplayNames(peopleDirectory));
}

/** Co-Agent 的群消息；指定已知情的人读到这条，其余在群成员保留未读。 */
export async function postCoAgentMessage(q: Query, ref: ThreadRef, content: string, readBy: string[] = []): Promise<number> {
  const result = await q(
    "INSERT INTO thread_messages (object_type, object_id, kind, content) VALUES ($1, $2, 'co-agent', $3) RETURNING id",
    [ref.objectType, ref.objectId, content],
  );
  const id = Number(result.rows[0].id);
  for (const personId of readBy) await markRead(q, ref, personId, id);
  return id;
}

/** 读到哪条：只增不减，也不超过群里已有的最后一条（否则之后的新消息会被当成已读）。 */
export async function markRead(q: Query, ref: ThreadRef, personId: string, lastReadId: number): Promise<void> {
  await q(
    `INSERT INTO thread_reads (object_type, object_id, person_id, last_read_id)
     VALUES ($1, $2, $3, LEAST($4::bigint, (SELECT COALESCE(MAX(id), 0) FROM thread_messages WHERE object_type = $1 AND object_id = $2)))
     ON CONFLICT (object_type, object_id, person_id) DO UPDATE
       SET last_read_id = GREATEST(thread_reads.last_read_id, EXCLUDED.last_read_id), updated_at = now()`,
    [ref.objectType, ref.objectId, personId, lastReadId],
  );
}

/** 读到的位置与未读数；未读只计别人发的（含 Co-Agent）。 */
export async function readState(q: Query, ref: ThreadRef, personId: string): Promise<{ lastReadId: number; unread: number }> {
  const read = await q(
    "SELECT last_read_id FROM thread_reads WHERE object_type = $1 AND object_id = $2 AND person_id = $3",
    [ref.objectType, ref.objectId, personId],
  );
  const lastReadId = read.rows[0] ? Number(read.rows[0].last_read_id) : 0;
  const unread = await q(
    `SELECT count(*)::int AS n FROM thread_messages
      WHERE object_type = $1 AND object_id = $2 AND id > $3 AND author_id IS DISTINCT FROM $4`,
    [ref.objectType, ref.objectId, lastReadId, personId],
  );
  return { lastReadId, unread: unread.rows[0].n as number };
}

/** 公司时间（上海）的会议时段，例如「10/2 周五 10:00–11:00」。 */
function meetingSlot(start: Date, end: Date): string {
  const part = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...options }).format(date);
  const day = `${part(start, { month: "numeric" }).replace("月", "")}/${part(start, { day: "numeric" }).replace("日", "")}`;
  const time = (date: Date) => part(date, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${part(start, { weekday: "short" })} ${time(start)}–${time(end)}`;
}

export async function threadIntroInput(q: Query, peopleDirectory: PeopleDirectory, ref: ThreadRef, inviterId: string, newcomers: string[], note?: string): Promise<IntroInput> {
  const names = personDisplayNames(peopleDirectory);
  let title = "";
  let description = "";
  if (ref.objectType === "issue") {
    const row = (await q("SELECT title, origin_ref FROM issues WHERE id::text=$1", [ref.objectId])).rows[0];
    title = row?.title ?? "议题";
    description = typeof row?.origin_ref?.whyNow === "string" ? row.origin_ref.whyNow : "议题的研究与判断在页面左边";
  } else if (ref.objectType === "meeting") {
    const row = (await q("SELECT title, scheduled_at, ends_at, preflight FROM meetings WHERE id::text=$1", [ref.objectId])).rows[0];
    title = row?.title ?? "会议";
    const purpose = row?.preflight?.decision ?? row?.preflight?.taskDefinition?.reviewPurpose;
    description = row ? `会议时间 ${meetingSlot(new Date(row.scheduled_at), new Date(row.ends_at))}${purpose ? `，目的是${purpose}` : ""}` : "会议安排在页面左边";
  } else if (ref.objectType === "task") {
    const row = (await q("SELECT t.title,t.due_date::text AS due_date,m.title AS mission_title FROM tasks t LEFT JOIN missions m ON m.id=t.mission_id WHERE t.id::text=$1", [ref.objectId])).rows[0];
    title = row?.title ?? "执行事项";
    const due = typeof row?.due_date === "string" ? `${Number(row.due_date.slice(5, 7))}/${Number(row.due_date.slice(8, 10))}` : "待定";
    description = `${row?.mission_title ? `属于个人任务「${row.mission_title}」` : "这是一件独立事项"}，截止 ${due}`;
  }
  const history = (await q("SELECT content FROM thread_messages WHERE object_type=$1 AND object_id=$2 ORDER BY id DESC LIMIT 20", [ref.objectType, ref.objectId])).rows
    .reverse().map((row) => String(row.content));
  return { objectType: ref.objectType, objectId: ref.objectId, title, description,
    inviter: names.get(inviterId) ?? inviterId, newcomers: newcomers.map((id) => names.get(id) ?? id), note, history };
}

export async function unreadThreads(q: Query, personId: string) {
  const rows = (await q(`SELECT tm.object_type,tm.object_id,
    count(msg.id)::int AS unread,
    COALESCE(i.title,m.title,t.title,'群聊') AS title
    FROM thread_members tm
    LEFT JOIN thread_reads rd ON rd.object_type=tm.object_type AND rd.object_id=tm.object_id AND rd.person_id=tm.person_id
    JOIN thread_messages msg ON msg.object_type=tm.object_type AND msg.object_id=tm.object_id
      AND msg.id>COALESCE(rd.last_read_id,0) AND msg.author_id IS DISTINCT FROM tm.person_id
    LEFT JOIN issues i ON tm.object_type='issue' AND i.id::text=tm.object_id
    LEFT JOIN meetings m ON tm.object_type='meeting' AND m.id::text=tm.object_id
    LEFT JOIN tasks t ON tm.object_type='task' AND t.id::text=tm.object_id
    WHERE tm.person_id=$1 AND tm.left_at IS NULL AND tm.object_type IN ('issue','meeting','task')
    GROUP BY tm.object_type,tm.object_id,i.title,m.title,t.title ORDER BY max(msg.id) DESC`, [personId])).rows;
  return { threads: rows.map((row) => ({ objectType: row.object_type, objectId: row.object_id, title: row.title,
    unread: row.unread, href: row.object_type === "task" ? `/me/tasks/${row.object_id}` : `/me/${row.object_type === "issue" ? "issues" : "meetings"}/${row.object_id}` })) };
}

/** 参会名单是真相源；保留离群历史，新增或重新列入参会人时恢复群资格。 */
export async function syncMeetingMembers(client: PoolClient, meetingId: string, participantIds: string[]): Promise<void> {
  await client.query(`UPDATE thread_members SET left_at=now() WHERE object_type='meeting' AND object_id=$1
    AND person_id <> ALL($2::text[]) AND left_at IS NULL`, [meetingId, participantIds]);
  for (const id of new Set(participantIds)) await client.query(`INSERT INTO thread_members(object_type,object_id,person_id,added_by)
    VALUES('meeting',$1,$2,'meeting') ON CONFLICT(object_type,object_id,person_id) DO UPDATE SET left_at=NULL`, [meetingId, id]);
}
