import { Type } from "@sinclair/typebox";
import { MarkThreadReadRequest, PostThreadMessageRequest, ThreadObjectId, ThreadObjectType } from "@warmap/contracts";
import { isActiveMember, listMembers, listMessages, markRead, postMessage, readState } from "../threads.js";
import type { AppInstance, RouteContext } from "./shared.js";

// 通用群组：只有未退出的成员能读能发；非成员（含 CEO）一律 404，不暴露群是否存在。加人、退出、Co-Agent 同步消息在 2b。
export function registerThreadRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, fail, requirePerson, companyMemory } = ctx;
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
}
