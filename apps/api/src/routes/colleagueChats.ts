import { Type } from "@sinclair/typebox";
import { ChatListResponse, ChatResponse, CorrectChatMessageRequest, MainLinesResponse, OwnerChatMessageRequest, SendChatMessageRequest } from "@warmap/contracts";
import type { FastifyReply } from "fastify";
import { correctChatMessage, retractChatMessage, sendOwnerMessage } from "../colleagueChatOwner.js";
import { askChatOwner, ChatError, listChats, listMainLines, markChatRead, readChat, retryChatMessage, sendChatMessage, type ChatDeps } from "../colleagueChats.js";
import { isRealPerson } from "../people.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const C = "/api/me/colleague-chats";
const uuid = Type.String({ format: "uuid" });
const personParams = Type.Object({ personId: Type.String({ minLength: 1, maxLength: 100 }) });
const chatParams = Type.Object({ chatId: uuid });
const messageParams = Type.Object({ chatId: uuid, messageId: uuid });

/** 同事对话的依赖，每次用时现取（jobs 的 runNow 在 server.ts 启动后才挂上）；伙伴替本人去问（buddyActions.ts）也用它。 */
export const colleagueChatDeps = (app: AppInstance, ctx: RouteContext): ChatDeps => ({ q: ctx.q, pool: ctx.pool, now: ctx.now, directory: ctx.peopleDirectory,
  dispatchNow: app.jobsNow.run,
  people: new Map(ctx.peopleDirectory.searchPeople(undefined).filter(isRealPerson).map((person) => [person.personId, person.displayName])) });

/** 同事对话（契约 colleagueChatsOpenapi.ts）：发一句、列对话、主线留痕、读一段、读过、重试、问本人；主人回一句、改、收回。工作模式登录，CEO 一样。 */
export function registerColleagueChatRoutes(app: AppInstance, ctx: RouteContext): void {
  const { fail, requirePerson } = ctx;
  const deps = () => colleagueChatDeps(app, ctx);
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof ChatError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };
  const byPerson = { preHandler: requireMember, schema: { params: personParams, response: { 200: ChatResponse } } };
  const byMessage = { preHandler: requireMember, schema: { params: messageParams, response: { 200: ChatResponse } } };

  app.get(C, { preHandler: requireMember, schema: { response: { 200: ChatListResponse } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return listChats(deps(), req.person!.personId);
  });
  app.get(`${C}/main-lines`, { preHandler: requireMember, schema: { response: { 200: MainLinesResponse } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { items: await listMainLines(deps(), req.person!.personId) };
  });
  for (const side of ["with", "from"] as const) app.get(`${C}/${side}/:personId`, byPerson, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return handle(reply, async () => ({ chat: await readChat(deps(), req.person!.personId, side, req.params.personId) }));
  });
  app.post(`${C}/with/:personId/messages`, { preHandler: requireMember, schema: { params: personParams, body: SendChatMessageRequest, response: { 200: ChatResponse } } },
    async (req, reply) => handle(reply, async () => {
      const viewer = req.person!.personId;
      await sendChatMessage(deps(), viewer, req.params.personId, req.body);
      return { chat: await readChat(deps(), viewer, "with", req.params.personId) };
    }));
  app.post(`${C}/:chatId/read`, { preHandler: requireMember, schema: { params: chatParams } }, async (req, reply) => handle(reply, async () => {
    await markChatRead(deps(), req.person!.personId, req.params.chatId);
    return reply.status(204).send();
  }));
  app.post(`${C}/:chatId/messages/:messageId/retry`, byMessage, async (req, reply) =>
    handle(reply, async () => ({ chat: await retryChatMessage(deps(), req.person!.personId, req.params.chatId, req.params.messageId) })));
  app.post(`${C}/:chatId/messages/:messageId/ask-owner`, byMessage, async (req, reply) =>
    handle(reply, async () => ({ chat: await askChatOwner(deps(), req.person!.personId, req.params.chatId, req.params.messageId) })));
  app.post(`${C}/:chatId/owner-messages`, { preHandler: requireMember, schema: { params: chatParams, body: OwnerChatMessageRequest, response: { 200: ChatResponse } } },
    async (req, reply) => handle(reply, async () => ({ chat: await sendOwnerMessage(deps(), req.person!.personId, req.params.chatId, req.body) })));
  app.post(`${C}/:chatId/messages/:messageId/correct`,
    { preHandler: requireMember, schema: { params: messageParams, body: CorrectChatMessageRequest, response: { 200: ChatResponse } } }, async (req, reply) =>
      handle(reply, async () => ({ chat: await correctChatMessage(deps(), req.person!.personId, req.params.chatId, req.params.messageId, req.body) })));
  app.post(`${C}/:chatId/messages/:messageId/retract`, byMessage, async (req, reply) =>
    handle(reply, async () => ({ chat: await retractChatMessage(deps(), req.person!.personId, req.params.chatId, req.params.messageId) })));
}
