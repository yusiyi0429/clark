import { Type } from "@sinclair/typebox";
import { AddThreadMembersRequest, MarkThreadReadRequest, PostThreadMessageRequest, ThreadObjectId, ThreadObjectType } from "@warmap/contracts";
import { insertNotification } from "../notifications.js";
import { canUseMemberView } from "../memberAccess.js";
import { postThreadIntro } from "../threadIntro.js";
import { isActiveMember, listMembers, listMessages, markRead, postMessage, readState, threadIntroInput } from "../threads.js";
import { isRealPerson } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";

// 通用群组：只有未退出的成员能读能发；非成员（含 CEO）一律 404，不暴露群是否存在。加人、退出、Co-Agent 同步消息在 2b。
export function registerThreadRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, fail, requirePerson, companyMemory, pool } = ctx;
  const threadParams = Type.Object({ objectType: ThreadObjectType, objectId: ThreadObjectId }, { additionalProperties: false });
  const afterQuery = Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });

  app.get(
    "/api/threads/:objectType/:objectId",
    { preHandler: requirePerson, schema: { params: threadParams } },
    async (req, reply) => {
      const me = req.person!.personId;
      if (!await isActiveMember(q, req.params, me)) return fail(reply, 404, "THREAD_NOT_FOUND", "群组不存在");
      const [members, messages, read] = await Promise.all([
        listMembers(q, companyMemory, req.params),
        listMessages(q, companyMemory, req.params),
        readState(q, req.params, me),
      ]);
      return { members, messages, ...read };
    },
  );

  // 群聊打开时每 3 秒取 after 之后的新消息。
  app.get(
    "/api/threads/:objectType/:objectId/messages",
    { preHandler: requirePerson, schema: { params: threadParams, querystring: afterQuery } },
    async (req, reply) => {
      if (!await isActiveMember(q, req.params, req.person!.personId)) return fail(reply, 404, "THREAD_NOT_FOUND", "群组不存在");
      return { messages: await listMessages(q, companyMemory, req.params, req.query.after) };
    },
  );

  app.post(
    "/api/threads/:objectType/:objectId/messages",
    { preHandler: requirePerson, schema: { params: threadParams, body: PostThreadMessageRequest } },
    async (req, reply) => {
      const me = req.person!.personId;
      if (!await isActiveMember(q, req.params, me)) return fail(reply, 404, "THREAD_NOT_FOUND", "群组不存在");
      return reply.code(201).send(await postMessage(q, companyMemory, req.params, me, req.body));
    },
  );

  app.post(
    "/api/threads/:objectType/:objectId/read",
    { preHandler: requirePerson, schema: { params: threadParams, body: MarkThreadReadRequest } },
    async (req, reply) => {
      const me = req.person!.personId;
      if (!await isActiveMember(q, req.params, me)) return fail(reply, 404, "THREAD_NOT_FOUND", "群组不存在");
      await markRead(q, req.params, me, req.body.lastReadId);
      return readState(q, req.params, me);
    },
  );

  const canManage = async (ref: { objectType: "issue" | "meeting" | "task" | "signal"; objectId: string }, personId: string) => {
    if (await isActiveMember(q, ref, personId)) return true;
    if (ref.objectType !== "issue") return false;
    const ceo = companyMemory.searchPeople(undefined).some((person) => person.personId === personId && person.roles.includes("ceo"));
    if (!ceo) return false;
    return (await q("SELECT 1 FROM issues WHERE id::text=$1", [ref.objectId])).rowCount === 1;
  };

  app.get("/api/threads/:objectType/:objectId/candidates", { preHandler: requirePerson, schema: { params: threadParams } }, async (req, reply) => {
    if (!await canManage(req.params, req.person!.personId)) return fail(reply, 404, "THREAD_NOT_FOUND", "群组不存在");
    if (req.params.objectType === "signal") return fail(reply, 404, "THREAD_NOT_FOUND", "群组不存在");
    const current = new Set((await listMembers(q, companyMemory, req.params)).map((person) => person.personId));
    if (req.params.objectType === "issue") current.add(req.person!.personId);
    return { people: companyMemory.searchPeople(undefined).filter((person) => isRealPerson(person) && !current.has(person.personId)
      && (req.params.objectType !== "task" || canUseMemberView(person)))
      .map((person) => ({ personId: person.personId, displayName: person.displayName })) };
  });

  app.post("/api/threads/:objectType/:objectId/members", { preHandler: requirePerson, schema: { params: threadParams, body: AddThreadMembersRequest } }, async (req, reply) => {
    const ref = req.params;
    const inviterId = req.person!.personId;
    if (ref.objectType === "signal" || !await canManage(ref, inviterId)) return fail(reply, 404, "THREAD_NOT_FOUND", "群组不存在");
    const directory = new Map(companyMemory.searchPeople(undefined).map((person) => [person.personId, person]));
    const ids = [...new Set(req.body.personIds)];
    if (ref.objectType === "issue" && ids.every((id) => id === inviterId))
      return fail(reply, 400, "PERSON_NOT_AVAILABLE", "请选择其他人加入议题群");
    // 执行事项只能拉能用 DRI 工作台的人（工单 07）；议题群、会议群可以拉任何人。
    if (ids.some((id) => !directory.has(id) || (ref.objectType === "task" && !canUseMemberView(directory.get(id)!))))
      return fail(reply, 400, "PERSON_NOT_AVAILABLE", "有人不在可邀请名单中");
    const client = await pool.connect();
    let added: string[] = [];
    let existing: string[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`thread:${ref.objectType}:${ref.objectId}`]);
      existing = (await client.query<{ person_id: string }>("SELECT person_id FROM thread_members WHERE object_type=$1 AND object_id=$2 AND left_at IS NULL", [ref.objectType, ref.objectId])).rows.map((row) => row.person_id);
      if (ref.objectType === "issue" && !existing.length) {
        await client.query("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('issue',$1,$2,$2) ON CONFLICT DO NOTHING", [ref.objectId, inviterId]);
        existing.push(inviterId);
      }
      added = ids.filter((id) => !existing.includes(id));
      if (ref.objectType === "task") {
        const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM task_members WHERE task_id::text=$1 AND role='collaborator' AND left_at IS NULL", [ref.objectId]);
        if (count.rows[0].count + added.length > 10) {
          await client.query("ROLLBACK");
          return fail(reply, 400, "COLLABORATOR_LIMIT", "一件事项最多 10 位协作者");
        }
      }
      for (const id of added) {
        await client.query(`INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES($1,$2,$3,$4)
          ON CONFLICT(object_type,object_id,person_id) DO UPDATE SET left_at=NULL,joined_at=now(),added_by=EXCLUDED.added_by`,
        [ref.objectType, ref.objectId, id, inviterId]);
        if (ref.objectType === "task") {
          await client.query(`INSERT INTO task_members(task_id,person_id,role,added_by) VALUES($1,$2,'collaborator',$3)
            ON CONFLICT(task_id,person_id) DO UPDATE SET role='collaborator',left_at=NULL,added_by=EXCLUDED.added_by`, [ref.objectId, id, inviterId]);
          await insertNotification(client, { personId: id, kind: "task_collaborator_added", objectType: "task", objectId: ref.objectId, actorId: inviterId });
        } else await insertNotification(client, { personId: id, kind: "thread_member_added", objectType: ref.objectType, objectId: ref.objectId, actorId: inviterId });
        if (ref.objectType === "meeting") {
          const person = directory.get(id)!;
          await client.query(`UPDATE meetings SET participants=participants || $2::jsonb,version=version+1,updated_at=now()
            WHERE id::text=$1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(participants) p WHERE p->>'personId'=$3)`,
          [ref.objectId, JSON.stringify([{ personId: person.personId, displayName: person.displayName, roles: person.roles, sourceRef: person.sourceRef, updatedAt: person.updatedAt }]), id]);
        }
        await client.query(`INSERT INTO thread_reads(object_type,object_id,person_id,last_read_id)
          SELECT $1,$2,$3,COALESCE(MAX(id),0) FROM thread_messages WHERE object_type=$1 AND object_id=$2
          ON CONFLICT(object_type,object_id,person_id) DO UPDATE SET last_read_id=GREATEST(thread_reads.last_read_id,EXCLUDED.last_read_id),updated_at=now()`,
        [ref.objectType, ref.objectId, id]);
      }
      if (ref.objectType === "task" && added.length) await client.query("UPDATE tasks SET version=version+1,updated_at=now() WHERE id::text=$1", [ref.objectId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
    if (added.length) {
      setImmediate(() => { void (async () => {
        const input = await threadIntroInput(q, companyMemory, ref, inviterId, added, req.body.note);
        await postThreadIntro(pool, ctx.threadIntroAgent, input, existing);
      })().catch((error) => app.log.error(error)); });
    }
    return { members: await listMembers(q, companyMemory, ref) };
  });

  app.post("/api/threads/:objectType/:objectId/leave", { preHandler: requirePerson, schema: { params: threadParams } }, async (req, reply) => {
    const ref = req.params;
    const me = req.person!.personId;
    if (!await isActiveMember(q, ref, me)) return fail(reply, 404, "THREAD_NOT_FOUND", "群组不存在");
    const owner = ref.objectType === "issue"
      ? companyMemory.searchPeople(undefined).some((person) => person.personId === me && person.roles.includes("ceo"))
      : ref.objectType === "meeting" ? (await q("SELECT lead_dri_id FROM meetings WHERE id::text=$1", [ref.objectId])).rows[0]?.lead_dri_id === me
      : ref.objectType === "task" ? (await q("SELECT owner_id FROM tasks WHERE id::text=$1", [ref.objectId])).rows[0]?.owner_id === me : false;
    if (owner) return fail(reply, 409, "THREAD_OWNER_CANNOT_LEAVE", "群主不能退出");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`thread:${ref.objectType}:${ref.objectId}`]);
      await client.query("UPDATE thread_members SET left_at=now() WHERE object_type=$1 AND object_id=$2 AND person_id=$3", [ref.objectType, ref.objectId, me]);
      if (ref.objectType === "task") {
        await client.query("UPDATE task_members SET left_at=now() WHERE task_id::text=$1 AND person_id=$2", [ref.objectId, me]);
        await client.query("UPDATE tasks SET version=version+1,updated_at=now() WHERE id::text=$1", [ref.objectId]);
      }
      if (ref.objectType === "meeting") await client.query(`UPDATE meetings SET participants=(SELECT COALESCE(jsonb_agg(p),'[]'::jsonb) FROM jsonb_array_elements(participants) p WHERE p->>'personId'<>$2),version=version+1,updated_at=now() WHERE id::text=$1`, [ref.objectId, me]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
    return reply.code(204).send();
  });
}
