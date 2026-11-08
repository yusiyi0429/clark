import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { ConversationHistory, CreateProjectTransferRequest, HandoverNote, HandoverSecretsResponse, ProjectTransfer, UpdateProjectTransferRequest } from "@warmap/contracts";
import { ChatServiceError } from "../chatService.js";
import { projectHistoryReader } from "../sourceWords.js";
import type { HandoverNoteAgent } from "../handoverNoteAgent.js";
import { personDisplayNames } from "../people.js";
import { acceptTransfer, declineTransfer, readTransfer, SecretsInNote, sendTransfer, startTransfer, updateTransfer, withdrawTransfer, writeNote,
  type TransferDeps } from "../projectTransfers.js";
import { CardError } from "../taskCards.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const idParams = Type.Object({ id: Type.String({ minLength: 1 }) });
const projectParams = Type.Object({ projectId: Type.String({ minLength: 1 }) });

/**
 * 项目转交（契约 projectTransfers.ts，设计《新首页》16.7）：发起、改、发出、撤回（原负责人），接手、不接（接手人），预览（两边），
 * 带上了对话记录时接手人读原来那段。DRI 工作台的人才有。伙伴改交接说明走 /internal（INTERNAL_CHAT_TOKEN 加 X-Owner-Id，不进公开 OpenAPI）。
 */
export function registerProjectTransferRoutes(app: AppInstance, ctx: RouteContext, options: { handoverAgent: HandoverNoteAgent }): void {
  const { q, pool, env, fail, requirePerson, requireServiceToken } = ctx;
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  /** 原负责人那段项目对话。 */
  const projectHistory = projectHistoryReader(ctx);
  const deps = (requestId = "handover"): TransferDeps => ({ q, pool, names: personDisplayNames(ctx.peopleDirectory), now: ctx.now(),
    handover: { agent: options.handoverAgent, conversation: async (projectId, fromId) => (await projectHistory(projectId, fromId, requestId)).messages
      .map((message) => ({ role: message.role, at: message.createdAt, text: message.content })) },
    lastSequence: async (projectId, fromId) => (await projectHistory(projectId, fromId, requestId)).messages.at(-1)?.sequence ?? null });
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof SecretsInNote) return reply.status(422).send({ code: "SECRET_IN_NOTE", message: cause.message, findings: cause.findings });
      if (cause instanceof CardError || cause instanceof ChatServiceError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };

  app.post("/api/me/projects/:projectId/transfers", { preHandler: requireMember, schema: { params: projectParams, body: CreateProjectTransferRequest,
    response: { 201: ProjectTransfer } } }, async (req, reply) => handle(reply, async () =>
    reply.status(201).send(await startTransfer(deps(String(req.id)), req.person!.personId, req.params.projectId, req.body.toPersonId,
      req.body.afterSequence))));

  app.get("/api/me/project-transfers/:id", { preHandler: requireMember, schema: { params: idParams, response: { 200: ProjectTransfer } } }, async (req, reply) =>
    handle(reply, () => readTransfer(deps(), req.person!.personId, req.params.id)));

  app.patch("/api/me/project-transfers/:id", { preHandler: requireMember, schema: { params: idParams, body: UpdateProjectTransferRequest,
    response: { 200: ProjectTransfer } } }, async (req, reply) => handle(reply, () => updateTransfer(deps(String(req.id)), req.person!.personId, req.params.id, req.body)));

  app.post("/api/me/project-transfers/:id/send", { preHandler: requireMember, schema: { params: idParams,
    response: { 200: ProjectTransfer, 422: HandoverSecretsResponse } } }, async (req, reply) => handle(reply, () => sendTransfer(deps(), req.person!.personId, req.params.id)));

  for (const [action, work] of [["withdraw", withdrawTransfer], ["accept", acceptTransfer], ["decline", declineTransfer]] as const)
    app.post(`/api/me/project-transfers/:id/${action}`, { preHandler: requireMember, schema: { params: idParams, response: { 200: ProjectTransfer } } },
      async (req, reply) => handle(reply, () => work(deps(), req.person!.personId, (req.params as { id: string }).id)));

  // 带上了对话记录：接手人读原负责人那段项目对话（只读；管线不读它）。没带、还没接手、不是接手人都 404。
  app.get("/api/me/project-transfers/:id/history", { preHandler: requireMember, schema: { params: idParams, response: { 200: ConversationHistory } } },
    async (req, reply) => handle(reply, async () => {
      const transfer = await readTransfer(deps(), req.person!.personId, req.params.id);
      if (transfer.to.personId !== req.person!.personId || transfer.status !== "accepted" || !transfer.includeHistory)
        throw new CardError(404, "NOT_FOUND", "没有带上对话记录");
      return projectHistory(transfer.projectId, transfer.from.personId, String(req.id));
    }));

  if (!env.internalChatToken) return;
  // 伙伴改交接说明，以原负责人的身份，准备中才能改。
  const owner = (req: { headers: Record<string, unknown> }) => {
    const id = req.headers["x-owner-id"];
    return typeof id === "string" && ctx.peopleDirectory.searchPeople(undefined).some((person) => person.personId === id) ? id : null;
  };
  app.get("/internal/me/project-transfers/:id", { onRequest: requireServiceToken(env.internalChatToken), schema: { params: idParams, response: { 200: ProjectTransfer } } },
    async (req, reply) => {
      const id = owner(req);
      return id ? handle(reply, () => readTransfer(deps(), id, req.params.id)) : fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
    });
  app.put("/internal/me/project-transfers/:id/note", { onRequest: requireServiceToken(env.internalChatToken),
    schema: { params: idParams, body: Type.Object({ note: HandoverNote }, { additionalProperties: false }), response: { 200: ProjectTransfer } } }, async (req, reply) => {
    const id = owner(req);
    return id ? handle(reply, () => writeNote(deps(), id, req.params.id, req.body.note)) : fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
  });
}
