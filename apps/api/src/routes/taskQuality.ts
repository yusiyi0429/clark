import type { FastifyRequest } from "fastify";
import { Type, type TSchema, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { TaskQualityStatus, TaskQualityId, TaskQualityOptions, TaskQualityCatalog, TaskQualityReviewList, TaskQualityReviewView,
  TaskRepairInput, TaskRepairView, TaskRepairList, TaskRepairHandoff, TaskRepairReceiptInput,
  TaskMeetingInput, TaskMeetingAnalysis, TaskMeetingRepairInput, TaskRepairRevision } from "@warmap/contracts";
import { createChatService, ChatServiceError } from "../chatService.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerTaskQualityRoutes(app: AppInstance, ctx: RouteContext): void {
  const chat = ctx.env.chatServiceUrl ? createChatService({ baseUrl: ctx.env.chatServiceUrl, token: ctx.env.internalChatToken }) : undefined;
  app.get("/api/task-quality/status", { preHandler: ctx.requirePerson, schema: { response: { 200: TaskQualityStatus } } }, async () => ({ enabled: Boolean(chat) }));
  app.register(async instance => {
    const scoped = instance.withTypeProvider<TypeBoxTypeProvider>();
    scoped.setValidatorCompiler<TSchema>(({ schema }) => data => Value.Check(schema, data) ? { value: data } : { error: new Error("请求字段或格式无效") });
    const signals = new WeakMap<FastifyRequest, AbortSignal>();
    scoped.addHook("onRequest", async (req, reply) => {
      const controller = new AbortController();
      signals.set(req, controller.signal);
      reply.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
      req.raw.once("aborted", () => controller.abort());
    });
    const relay = <S extends TSchema>(req: FastifyRequest, path: string, schema: S, body?: unknown): Promise<Static<S>> =>
      chat!.quality(req.person!, String(req.id), path, schema, body, signals.get(req));
    scoped.addHook("preHandler", ctx.requirePerson);
    scoped.addHook("preHandler", async (_req, reply) => {
      if (!chat) return ctx.fail(reply, 503, "CHAT_NOT_CONFIGURED", "数据质量服务尚未接通。");
    });
    scoped.setErrorHandler((error, _req, reply) => {
      if (error instanceof ChatServiceError) return ctx.fail(reply, error.status, error.code, error.message);
      throw error;
    });
    const taskParams = Type.Object({ taskId: TaskQualityId }, { additionalProperties: false });
    const proposalParams = Type.Object({ proposalId: TaskQualityId }, { additionalProperties: false });
    const meetingParams = Type.Object({ meetingId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
    scoped.get("/api/task-quality", { schema: { response: { 200: TaskQualityReviewList } } },
      req => relay(req, "", TaskQualityReviewList));
    scoped.get("/api/task-quality/catalog", { schema: { querystring: Type.Object({ cursor: Type.Optional(Type.String({ maxLength: 2000 })) }, { additionalProperties: false }), response: { 200: TaskQualityCatalog } } },
      req => relay(req, `/catalog${req.query.cursor ? `?cursor=${encodeURIComponent(req.query.cursor)}` : ""}`, TaskQualityCatalog));
    scoped.post("/api/task-quality/tasks/:taskId/check", { schema: { params: taskParams, body: TaskQualityOptions, response: { 200: TaskQualityReviewView } } },
      req => relay(req, `/tasks/${req.params.taskId}/check`, TaskQualityReviewView, req.body));
    scoped.post("/api/task-quality/tasks/:taskId/proposals", { schema: { params: taskParams, body: TaskRepairInput, response: { 200: TaskRepairView } } },
      req => relay(req, `/tasks/${req.params.taskId}/proposals`, TaskRepairView, req.body));
    scoped.get("/api/task-quality/proposals", { schema: { response: { 200: TaskRepairList } } },
      req => relay(req, "/proposals", TaskRepairList));
    scoped.post("/api/task-quality/proposals/:proposalId/revise", { schema: { params: proposalParams, body: TaskRepairRevision, response: { 200: TaskRepairView } } },
      req => relay(req, `/proposals/${req.params.proposalId}/revise`, TaskRepairView, req.body));
    scoped.get("/api/task-quality/proposals/:proposalId/handoff", { schema: { params: proposalParams, response: { 200: TaskRepairHandoff } } },
      req => relay(req, `/proposals/${req.params.proposalId}/handoff`, TaskRepairHandoff));
    scoped.post("/api/task-quality/proposals/:proposalId/receipts", { schema: { params: proposalParams, body: TaskRepairReceiptInput, response: { 200: TaskRepairView } } },
      req => relay(req, `/proposals/${req.params.proposalId}/receipts`, TaskRepairView, req.body));
    scoped.post("/api/task-quality/meetings/:meetingId/analyze", { schema: { params: meetingParams, body: TaskMeetingInput, response: { 200: TaskMeetingAnalysis } } },
      req => relay(req, `/meetings/${encodeURIComponent(req.params.meetingId)}/analyze`, TaskMeetingAnalysis, req.body));
    scoped.post("/api/task-quality/meetings/:meetingId/proposals", { schema: { params: meetingParams, body: TaskMeetingRepairInput, response: { 200: TaskRepairView } } },
      req => relay(req, `/meetings/${encodeURIComponent(req.params.meetingId)}/proposals`, TaskRepairView, req.body));
  });
}
