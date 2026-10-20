import type { FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Viewer } from "../meetingCard.js";
import { listConfirmedMeetings, PayloadHashMismatchError, readConfirmedMeeting } from "../meetingCardRead.js";
import { roleOf } from "../memberAccess.js";
import type { AppInstance, RouteContext } from "./shared.js";

const catalogQuery = Type.Object({
  query: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  participantId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const meetingParams = Type.Object({ meetingId: Type.String({ minLength: 1 }) }, { additionalProperties: false });

/**
 * 给独立 Chat 的确认会议只读接口（拍板 12）：Authorization: Bearer <INTERNAL_CHAT_TOKEN> 加可信用户 X-Owner-Id（personId）。
 * 没配 INTERNAL_CHAT_TOKEN 时不注册（一律 404）；凭据不对 401；X-Owner-Id 不在人员目录或读不了这场会 404。
 * 不走浏览器会话；不在公开 OpenAPI 里（契约包的 OpenAPI 文档按路径手列）。
 */
export function registerInternalMeetingRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requireServiceToken, peopleDirectory } = ctx;
  if (!env.internalChatToken) return;
  const onRequest = requireServiceToken(env.internalChatToken);
  const ownerOf = (req: FastifyRequest): Viewer | null => {
    const id = req.headers["x-owner-id"];
    const person = typeof id === "string" ? peopleDirectory.searchPeople(undefined).find((item) => item.personId === id) : undefined;
    return person ? { personId: person.personId, isCeo: roleOf(person) === "ceo" } : null;
  };
  const notFound = (reply: Parameters<typeof fail>[0]) => fail(reply, 404, "MEETING_NOT_FOUND", "会议不存在");

  app.get("/internal/confirmed-meetings", { onRequest, schema: { querystring: catalogQuery } }, async (req, reply) => {
    const owner = ownerOf(req);
    if (!owner) return notFound(reply);
    const { from, to } = req.query;
    if ([from, to].some((value) => value !== undefined && Number.isNaN(Date.parse(value)))) return fail(reply, 400, "INVALID_INPUT", "from / to 要是 ISO 时间");
    return { meetings: await listConfirmedMeetings(q, owner, req.query) };
  });

  app.get("/internal/confirmed-meetings/:meetingId", { onRequest, schema: { params: meetingParams } }, async (req, reply) => {
    const owner = ownerOf(req);
    if (!owner) return notFound(reply);
    try {
      return await readConfirmedMeeting(q, owner, req.params.meetingId) ?? notFound(reply);
    } catch (error) {
      if (error instanceof PayloadHashMismatchError) return fail(reply, 500, error.code, "会议确认版正文和摘要值对不上");
      throw error;
    }
  });
}
