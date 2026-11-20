import { Type } from "@sinclair/typebox";
import { ChatListResponse, ChatResponse, SendChatMessageRequest } from "@warmap/contracts";
import type { FastifyReply } from "fastify";
import { askChatOwner, ChatError, listChats, markChatRead, readChat, retryChatMessage, sendChatMessage, type ChatDeps } from "../colleagueChats.js";
import { isRealPerson } from "../people.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const C = "/api/me/colleague-chats";
const uuid = Type.String({ format: "uuid" });
const personParams = Type.Object({ personId: Type.String({ minLength: 1, maxLength: 100 }) });
const chatParams = Type.Object({ chatId: uuid });
const messageParams = Type.Object({ chatId: uuid, messageId: uuid });

/** 同事对话（契约 colleagueChatsOpenapi.ts）：发一句、列对话、读一段、读过、重试、问本人；工作模式登录，CEO 一样。 */
export function registerColleagueChatRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, fail, requirePerson, peopleDirectory } = ctx;
  const deps = (): ChatDeps => ({ q, pool, now: ctx.now, directory: peopleDirectory, dispatchNow: app.jobsNow.run,
    people: new Map(peopleDirectory.searchPeople(undefined).filter(isRealPerson).map((person) => [person.personId, person.displayName])) });
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
}
