import { Type } from "@sinclair/typebox";
import { AnswerMissionCardAnnotationRequest, CreateMissionCardAnnotationRequest, CreateMissionCardAnnotationResponse,
  MissionCardAnnotationsResponse, MissionCardRevisionsResponse, RetryMissionCardAnnotationRequest } from "@warmap/contracts";
import { createMissionCardAnnotation, listMissionCardAnnotations, listMissionCardRevisions, respondMissionCardAnnotation } from "../missionCardAnnotations.js";
import { createMissionCardAnnotationAgent, type MissionCardAnnotationAgent } from "../missionCardAnnotationAgent.js";
import { createMissionCardAnnotationQueue } from "../missionCardAnnotationQueue.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerMissionCardAnnotationRoutes(app: AppInstance, ctx: RouteContext, agent?: MissionCardAnnotationAgent): void {
  const params = Type.Object({ cardId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  const annotationParams = Type.Object({ cardId: Type.String({ minLength: 1 }), annotationId: Type.String({ format: "uuid" }) }, { additionalProperties: false });
  const queue = createMissionCardAnnotationQueue({ pool: ctx.pool,
    agent: agent ?? createMissionCardAnnotationAgent({ baseUrl: ctx.env.piBaseUrl, apiKey: ctx.env.piApiKey, modelId: ctx.env.heavyModel }),
    people: () => ctx.companyMemory.searchPeople(undefined), secret: ctx.env.sessionSecret, now: ctx.now,
    onError: () => app.log.error("mission card annotation queue failed"),
  });
  let recovery: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    await queue.recover().catch(() => app.log.error("mission annotation recovery failed"));
    recovery = setInterval(() => { void queue.recover().catch(() => app.log.error("mission annotation recovery failed")); }, 60_000);
    recovery.unref();
  });
  app.addHook("onClose", async () => { clearInterval(recovery); await queue.close(); });
  app.get("/api/mission-cards/:cardId/annotations", { preHandler: ctx.requirePerson,
    schema: { params, response: { 200: MissionCardAnnotationsResponse } } }, async (req, reply) => {
    const result = await listMissionCardAnnotations(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret,
      req.person!, req.params.cardId, ctx.now());
    return result ?? ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
  });
  app.post("/api/mission-cards/:cardId/annotations", { preHandler: ctx.requirePerson,
    schema: { params, body: CreateMissionCardAnnotationRequest, response: { 200: CreateMissionCardAnnotationResponse } } }, async (req, reply) => {
    const result = await createMissionCardAnnotation(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret,
      req.person!, req.params.cardId, req.body, ctx.now);
    if (!("error" in result) && result.annotation.status === "queued") void queue.enqueue(req.params.cardId);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });
  app.post("/api/mission-cards/:cardId/annotations/:annotationId/answer", { preHandler: ctx.requirePerson,
    schema: { params: annotationParams, body: AnswerMissionCardAnnotationRequest, response: { 200: CreateMissionCardAnnotationResponse } } }, async (req, reply) => {
    const result = await respondMissionCardAnnotation(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret,
      req.person!, req.params.cardId, req.params.annotationId, req.body.answer, ctx.now);
    if (!("error" in result) && result.annotation.status === "queued") void queue.enqueue(req.params.cardId);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });
  app.post("/api/mission-cards/:cardId/annotations/:annotationId/retry", { preHandler: ctx.requirePerson,
    schema: { params: annotationParams, body: RetryMissionCardAnnotationRequest, response: { 200: CreateMissionCardAnnotationResponse } } }, async (req, reply) => {
    const result = await respondMissionCardAnnotation(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret,
      req.person!, req.params.cardId, req.params.annotationId, null, ctx.now);
    if (!("error" in result) && result.annotation.status === "queued") void queue.enqueue(req.params.cardId);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });
  app.get("/api/mission-cards/:cardId/revisions", { preHandler: ctx.requirePerson,
    schema: { params, response: { 200: MissionCardRevisionsResponse } } }, async (req, reply) => {
    const revisions = await listMissionCardRevisions(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret,
      req.person!, req.params.cardId, ctx.now());
    return revisions ? { revisions } : ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
  });
}
