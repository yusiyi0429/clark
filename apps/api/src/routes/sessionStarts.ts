import { Type } from "@sinclair/typebox";
import { BuddyOpenTopicRequest, BuddyOpenTopicResponse, ClaimSessionStartsRequest, ClaimSessionStartsResponse } from "@warmap/contracts";
import { createTopic, TopicError } from "../researchTopics.js";
import { ensurePresetRole, RoleError } from "../roles.js";
import { claimStarts, releaseStart, requestStarts } from "../sessionStarts.js";
import { boardTask, CardError, planTaskOpener } from "../taskCards.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

/** 伙伴开的探索子会话配的预设岗位（roles/presets/strategy_content/researcher.md，调研员）。 */
const TOPIC_PRESET = "researcher";

/**
 * 自动开工（契约 workHome.ts，第 4.4 节）：POST /api/me/session-starts/claim、POST /api/me/session-starts/:id/release、
 * 伙伴开探索子会话 POST /internal/me/topics。
 */
export function registerSessionStartRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, fail, requirePerson, requireServiceToken, env } = ctx;
  const open = planTaskOpener(q, ctx.planTasks, ctx.peopleDirectory, ctx.now);
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };

  app.post("/api/me/session-starts/claim", { preHandler: requireMember, schema: { body: ClaimSessionStartsRequest, response: { 200: ClaimSessionStartsResponse } } },
    async (req, reply) => {
      const starts = await claimStarts(q, req.person!.personId, req.body.deviceId, ctx.now());
      return starts ? { starts } : fail(reply, 404, "DEVICE_NOT_FOUND", "这台电脑没配对，或已经解除配对");
    });

  app.post("/api/me/session-starts/:id/release", { preHandler: requireMember, schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) } }, async (req, reply) =>
    await releaseStart(q, req.person!.personId, req.params.id) ? reply.status(204).send() : fail(reply, 404, "NOT_FOUND", "找不到这条要开工"));

  // 伙伴开探索子会话（工具 open_topic）：照 /internal/plan-tasks/:taskId/card-splits，INTERNAL_CHAT_TOKEN 加 X-Owner-Id；没配时不注册，不进公开 OpenAPI。
  // 建专题、配调研员、登记要开工在一个事务里，不用本人同意。
  if (env.internalChatToken) app.post("/internal/me/topics", { onRequest: requireServiceToken(env.internalChatToken),
    schema: { body: BuddyOpenTopicRequest, response: { 201: BuddyOpenTopicResponse } } }, async (req, reply) => {
    const id = req.headers["x-owner-id"];
    if (typeof id !== "string" || !ctx.peopleDirectory.searchPeople(undefined).some((person) => person.personId === id)) return fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
    try {
      const own = req.body.planTaskId ? await boardTask(open, id, req.body.planTaskId) : null;
      const now = ctx.now();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const role = await ensurePresetRole(client, id, TOPIC_PRESET, now);
        const topic = await createTopic(client.query.bind(client), id, { title: req.body.title, ...own ? { planTaskId: own.task.taskId } : {}, ...role ? { roleId: role.id } : {} },
          async () => own, now);
        const [start] = await requestStarts(client.query.bind(client), { ownerId: id, origin: "buddy", now, items: [{ kind: "topic", topicId: topic.id, planTaskId: topic.planTaskId }] });
        await client.query("COMMIT");
        return reply.status(201).send({ topicId: topic.id, start });
      } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
      finally { client.release(); }
    } catch (cause) {
      if (cause instanceof CardError || cause instanceof TopicError || cause instanceof RoleError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  });
}
