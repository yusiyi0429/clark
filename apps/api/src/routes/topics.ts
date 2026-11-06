import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { CreateTopicRequest, PatchTopicRequest, ResearchTopicView, TopicBriefResponse, TopicDetailResponse, TopicListResponse, TopicVersionView } from "@warmap/contracts";
import { createTopic, listTopics, patchTopic, readTopic, readTopicVersion, TopicError, topicBrief } from "../researchTopics.js";
import { RoleError } from "../roles.js";
import { findOwnTask, type OwnTask } from "../taskDeliverables.js";
import type { AppInstance, RouteContext } from "./shared.js";

const idParams = Type.Object({ id: Type.String({ minLength: 1 }) });

/** 调研专题（契约 topics.ts）：本人的专题列表、新建、详情、改、某一版、开专题的交代。 */
export function registerTopicRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, fail, requirePerson } = ctx;
  const planTaskOf = (personId: string) => (taskId: string): Promise<OwnTask | null> => findOwnTask(q, ctx.planTasks, personId, ctx.now(), taskId).catch(() => null);
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof TopicError || cause instanceof RoleError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };

  app.get("/api/me/topics", { preHandler: requirePerson, schema: {
    querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("archived")])) }), response: { 200: TopicListResponse } } }, async (req) =>
    ({ topics: await listTopics(q, req.person!.personId, req.query.status ?? "active") }));

  app.post("/api/me/topics", { preHandler: requirePerson, schema: { body: CreateTopicRequest, response: { 201: ResearchTopicView } } }, async (req, reply) =>
    handle(reply, async () => reply.status(201).send(await createTopic(q, req.person!.personId, req.body, planTaskOf(req.person!.personId), ctx.now()))));

  app.get("/api/me/topics/:id", { preHandler: requirePerson, schema: { params: idParams, response: { 200: TopicDetailResponse } } }, async (req, reply) =>
    handle(reply, () => readTopic(q, req.person!.personId, req.params.id, planTaskOf(req.person!.personId))));

  app.patch("/api/me/topics/:id", { preHandler: requirePerson, schema: { params: idParams, body: PatchTopicRequest, response: { 200: ResearchTopicView } } }, async (req, reply) =>
    handle(reply, () => patchTopic(q, req.person!.personId, req.params.id, req.body, ctx.now())));

  app.get("/api/me/topics/:id/versions/:number", { preHandler: requirePerson, schema: {
    params: Type.Object({ id: Type.String({ minLength: 1 }), number: Type.Integer({ minimum: 1 }) }), response: { 200: TopicVersionView } } }, async (req, reply) =>
    handle(reply, () => readTopicVersion(q, req.person!.personId, req.params.id, req.params.number)));

  app.get("/api/me/topics/:id/brief", { preHandler: requirePerson, schema: { params: idParams,
    querystring: Type.Object({ critics: Type.Optional(Type.String({ maxLength: 200 })) }), response: { 200: TopicBriefResponse } } }, async (req, reply) =>
    handle(reply, () => topicBrief(q, req.person!.personId, req.params.id, req.query.critics?.split(",").map((item) => item.trim()).filter(Boolean),
      planTaskOf(req.person!.personId))));
}
