import { Type } from "@sinclair/typebox";
import {
  BuddyActionListResponse, BuddyActionRequest, BuddyActionResult, BuddyAuditEntry, BuddyAuditListResponse, BuddyAuthority, BuddyMessageDraft, ClaimSessionCommandsRequest,
  ClaimSessionCommandsResponse, ClaimSessionStopsRequest, ClaimSessionStopsResponse, SessionCommandDoneRequest, SessionStopDoneRequest, TrashListResponse,
  UpdateBuddyAuthorityRequest,
} from "@warmap/contracts";
import type { FastifyReply } from "fastify";
import {
  BuddyError, actionList, cancelMessage, claimCommands, claimStops, conversationScope, finishCommand, finishStop, listAudit, listTrash, readAuthority, readMessage, restoreTrash, runAction, sendMessage, undoAction,
  writeAuthority, type BuddyDeps,
} from "../buddyActions.js";
import type { FeishuClient } from "../feishu/client.js";
import { sendFeishuText } from "../feishu/messages.js";
import { colleagueIndex, dbScopeSource, scopeReader } from "../colleagueScope.js";
import { isRealPerson, personDisplayNames } from "../people.js";
import { projectHistoryReader, turnWordsReader } from "../sourceWords.js";
import { colleagueChatDeps } from "./colleagueChats.js";
import { idParams, type AppInstance, type Guard, type RouteContext } from "./shared.js";

/**
 * 伙伴代本人做事（新首页 17.4，契约 buddyActions.ts）：本人的授权、审计和撤销、转达、回收站、「请这台电脑停掉」；
 * Chat 的通用入口（/internal/me/buddy-actions）照现有 /internal：Authorization: Bearer <INTERNAL_CHAT_TOKEN> 加 X-Owner-Id，没配时不注册。
 */
export function registerBuddyActionRoutes(app: AppInstance, ctx: RouteContext, options: { feishu?: FeishuClient } = {}): void {
  const { q, env, fail, requirePerson, requireServiceToken, peopleDirectory } = ctx;
  const names = () => personDisplayNames(peopleDirectory);
  /** 真实成员的名字（同 routes/teamDeliveries.ts，不含「会议纪要」这类记录账号）。 */
  const people = () => new Map(peopleDirectory.searchPeople(undefined).filter(isRealPerson).map((person) => [person.personId, person.displayName]));
  const deps: BuddyDeps = { app, q, env, now: ctx.now, names, stream: ctx.chat ? (runId, event) => ctx.chat!.inject(runId, event) : undefined,
    history: projectHistoryReader(ctx), colleagues: {
      directory: peopleDirectory,
      reader: (ownerId) => scopeReader(dbScopeSource({ q, planTasks: ctx.planTasks, names: people(), now: ctx.now() }, ownerId)),
      index: async (viewerId) => (await colleagueIndex(q, peopleDirectory, viewerId)).filter((entry) => isRealPerson({ personId: entry.personId, displayName: entry.name })),
    },
    // 每次用时现取：jobs 的 runNow 在 server.ts 启动后才挂上。
    get chats() { return colleagueChatDeps(app, ctx); },
    turnWords: ctx.turnWords ?? turnWordsReader(ctx) };
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof BuddyError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };
  /** 天枢机器人发到对方和机器人的单聊；对方没关联飞书、发送失败都算收不到。 */
  const deliver = async (personId: string, text: string) => {
    const openId = (await q("SELECT open_id FROM feishu_identities WHERE person_id=$1", [personId])).rows[0]?.open_id as string | undefined;
    if (!openId || !options.feishu) return false;
    await sendFeishuText(options.feishu, { type: "open_id", id: openId }, text);
    return true;
  };

  app.get("/api/me/buddy-authority", { preHandler: requirePerson, schema: { response: { 200: BuddyAuthority } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return readAuthority(q, req.person!.personId);
  });
  app.put("/api/me/buddy-authority", { preHandler: requirePerson, schema: { body: UpdateBuddyAuthorityRequest, response: { 200: BuddyAuthority } } }, async (req) =>
    writeAuthority(q, req.person!.personId, req.body.authority, ctx.now()));

  app.get("/api/me/buddy-actions/log", { preHandler: requirePerson, schema: { response: { 200: BuddyAuditListResponse } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { entries: await listAudit(q, req.person!.personId) };
  });
  app.post("/api/me/buddy-actions/log/:id/undo", { preHandler: requirePerson, schema: { params: idParams, response: { 200: BuddyAuditEntry } } }, async (req, reply) =>
    handle(reply, () => undoAction(deps, req.person!.personId, req.params.id)));

  app.get("/api/me/buddy-messages/:id", { preHandler: requirePerson, schema: { params: idParams, response: { 200: BuddyMessageDraft } } }, async (req, reply) =>
    handle(reply, () => readMessage(q, req.person!.personId, req.params.id, names())));
  app.post("/api/me/buddy-messages/:id/send", { preHandler: requirePerson, schema: { params: idParams, response: { 200: BuddyMessageDraft } } }, async (req, reply) =>
    handle(reply, async () => {
      if (!options.feishu) throw new BuddyError(503, "FEISHU_UNAVAILABLE", "天枢机器人没接上飞书，现在发不了");
      return sendMessage(q, req.person!.personId, req.params.id, names(), ctx.now(), deliver);
    }));
  app.post("/api/me/buddy-messages/:id/cancel", { preHandler: requirePerson, schema: { params: idParams, response: { 200: BuddyMessageDraft } } }, async (req, reply) =>
    handle(reply, () => cancelMessage(q, req.person!.personId, req.params.id, names())));

  app.get("/api/me/trash", { preHandler: requirePerson, schema: { response: { 200: TrashListResponse } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { items: await listTrash(q, req.person!.personId, ctx.now()) };
  });
  app.post("/api/me/trash/:kind/:id/restore", { preHandler: requirePerson, schema: { params: Type.Object({
    kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }) } }, async (req, reply) =>
    (await restoreTrash(q, req.person!.personId, req.params.kind, req.params.id, ctx.now())) ? reply.status(204).send()
      : fail(reply, 404, "NOT_FOUND", "回收站里没有它"));

  app.post("/api/me/session-stops/claim", { preHandler: requireMember, schema: { body: ClaimSessionStopsRequest, response: { 200: ClaimSessionStopsResponse } } },
    async (req, reply) => {
      const stops = await claimStops(q, req.person!.personId, req.body.deviceId, ctx.now());
      return stops ? { stops } : fail(reply, 404, "DEVICE_NOT_FOUND", "这台电脑没有配对或已经吊销");
    });
  app.post("/api/me/session-stops/:id/done", { preHandler: requireMember, schema: { params: idParams, body: SessionStopDoneRequest } }, async (req, reply) =>
    (await finishStop(q, req.person!.personId, req.params.id, req.body.deviceId, req.body.result, ctx.now())) ? reply.status(204).send()
      : fail(reply, 404, "NOT_FOUND", "没有这台电脑认领的这一条"));

  // 18 节第 10 条：项目主管线按字母转话、重开、回答、批准，网页在会话所在的电脑上认领后交给本机。
  app.post("/api/me/session-commands/claim", { preHandler: requireMember, schema: { body: ClaimSessionCommandsRequest, response: { 200: ClaimSessionCommandsResponse } } },
    async (req, reply) => {
      const commands = await claimCommands(q, req.person!.personId, req.body.deviceId, ctx.now());
      return commands ? { commands } : fail(reply, 404, "DEVICE_NOT_FOUND", "这台电脑没有配对或已经吊销");
    });
  app.post("/api/me/session-commands/:id/done", { preHandler: requireMember, schema: { params: idParams, body: SessionCommandDoneRequest } }, async (req, reply) =>
    (await finishCommand(q, req.person!.personId, req.params.id, req.body.deviceId, req.body.result, req.body.message, ctx.now())) ? reply.status(204).send()
      : fail(reply, 404, "NOT_FOUND", "没有这台电脑认领的这一条"));

  if (!env.internalChatToken) return;
  const owner = (header: unknown) =>
    typeof header === "string" && peopleDirectory.searchPeople(undefined).some((person) => person.personId === header) ? header : null;
  app.get("/internal/me/buddy-actions", { onRequest: requireServiceToken(env.internalChatToken), schema: {
    querystring: Type.Object({ conversationId: Type.Optional(Type.String({ minLength: 1 })) }), response: { 200: BuddyActionListResponse } } },
  async (req, reply) => {
    const id = owner(req.headers["x-owner-id"]);
    if (!id) return fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
    const authority = await readAuthority(q, id);
    // 带了对话：不是项目对话就不列只给项目对话的那几个（18 节第 10 条）；不带全列，执行时再拦。
    const inProject = req.query.conversationId ? (await conversationScope(q, id, req.query.conversationId)).startsWith("project:") : undefined;
    return { authority, actions: actionList(authority, inProject) };
  });
  app.post("/internal/me/buddy-actions/:name", { onRequest: requireServiceToken(env.internalChatToken), schema: {
    params: Type.Object({ name: Type.String({ minLength: 1 }) }, { additionalProperties: false }), body: BuddyActionRequest, response: { 200: BuddyActionResult } } },
  async (req, reply) => {
    const id = owner(req.headers["x-owner-id"]);
    if (!id) return fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
    return handle(reply, () => runAction(deps, { personId: id, conversationId: req.body.conversationId ?? null, runId: req.body.runId ?? null },
      req.params.name, req.body.args));
  });
}
