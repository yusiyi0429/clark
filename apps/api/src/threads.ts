import type { TThreadMember, TThreadMessage, TThreadObjectType, TThreadQuote } from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { personDisplayNames } from "./people.js";

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
export async function listMembers(q: Query, companyMemory: CompanyMemoryRepository, ref: ThreadRef): Promise<TThreadMember[]> {
  const people = new Map(companyMemory.searchPeople(undefined).map((person) => [person.personId, person]));
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
  companyMemory: CompanyMemoryRepository,
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
  const names = personDisplayNames(companyMemory);
  return result.rows.map((row) => projectMessage(row as MessageRow, names));
}

export async function postMessage(
  q: Query,
  companyMemory: CompanyMemoryRepository,
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
  return projectMessage(result.rows[0] as MessageRow, personDisplayNames(companyMemory));
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
