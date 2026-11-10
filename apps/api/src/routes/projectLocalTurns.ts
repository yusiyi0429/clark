import { Type } from "@sinclair/typebox";
import {
  LOCAL_PROJECT_KEY_PATH, LOCAL_PROJECT_TURNS_PATH, LocalProjectKeyRequest, LocalProjectKeyResponse, LocalProjectTurnFinishRequest, LocalProjectTurnFinishResponse,
  LocalProjectTurnParams, LocalProjectTurnStartRequest, LocalProjectTurnStartResponse,
} from "@warmap/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { BuddyDeps } from "../buddyActions.js";
import { BuddyError } from "../buddyActions.js";
import { ChatServiceError } from "../chatService.js";
import { deviceOfToken } from "../localDevices.js";
import { personDisplayNames } from "../people.js";
import { authenticateLocalToken } from "../personalTokens.js";
import { LocalTurnError, finishLocalTurn, heartbeatLocalTurn, issueProjectKey, startLocalTurn, type LocalTurnDeps } from "../projectLocalTurns.js";
import type { AppInstance, RouteContext } from "./shared.js";

/**
 * 项目对话在本人电脑上跑（17.2 第 38 条，契约 projectLocalTurns.ts）：本机程序用设备令牌取项目钥匙、开始 / 心跳 / 结束一轮。不在网页的 OpenAPI 里。
 */
export function localTurnDeps(app: AppInstance, ctx: RouteContext): LocalTurnDeps {
  const buddy: BuddyDeps = { app, q: ctx.q, env: ctx.env, now: ctx.now, names: () => personDisplayNames(ctx.peopleDirectory) };
  return { pool: ctx.pool, q: ctx.q, chat: ctx.chat, now: ctx.now, pepper: ctx.env.sessionSecret, publicOrigin: ctx.env.publicOrigin, buddy };
}

export function registerProjectLocalTurnRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail } = ctx;
  const deps = localTurnDeps(app, ctx);
  const personExists = (personId: string) => ctx.peopleDirectory.searchPeople(undefined).some((person) => person.personId === personId);

  /** 设备令牌对应的人和电脑；不对 401。 */
  const device = async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticateLocalToken(q, req.headers.authorization, env.sessionSecret, ctx.now(), personExists);
    const found = identity ? await deviceOfToken(q, identity.tokenId) : null;
    if (!identity || !found) {
      fail(reply, 401, "UNAUTHORIZED", "设备令牌无效，请在天枢插件页重新配对");
      return null;
    }
    return { ownerId: identity.personId, deviceId: found.id };
  };
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof LocalTurnError) return reply.status(cause.status).send({ code: cause.code, message: cause.message, ...cause.extra });
      if (cause instanceof BuddyError || cause instanceof ChatServiceError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };

  app.post(LOCAL_PROJECT_KEY_PATH, { schema: { body: LocalProjectKeyRequest, response: { 200: LocalProjectKeyResponse } } }, async (req, reply) => {
    const who = await device(req, reply);
    if (!who) return reply;
    return handle(reply, () => issueProjectKey(deps, who.ownerId, who.deviceId, req.body.projectId));
  });
  app.post(LOCAL_PROJECT_TURNS_PATH, { schema: { body: LocalProjectTurnStartRequest, response: { 200: LocalProjectTurnStartResponse } } }, async (req, reply) => {
    const who = await device(req, reply);
    if (!who) return reply;
    return handle(reply, () => startLocalTurn(deps, who.ownerId, who.deviceId, req.body, String(req.id)));
  });
  app.post(`${LOCAL_PROJECT_TURNS_PATH}/:turnId/heartbeat`, { schema: { params: LocalProjectTurnParams, body: Type.Object({}) } }, async (req, reply) => {
    const who = await device(req, reply);
    if (!who) return reply;
    return handle(reply, async () => {
      await heartbeatLocalTurn(deps, who.ownerId, who.deviceId, req.params.turnId);
      return reply.status(204).send();
    });
  });
  app.post(`${LOCAL_PROJECT_TURNS_PATH}/:turnId/finish`, { schema: { params: LocalProjectTurnParams, body: LocalProjectTurnFinishRequest,
    response: { 200: LocalProjectTurnFinishResponse } } }, async (req, reply) => {
    const who = await device(req, reply);
    if (!who) return reply;
    return handle(reply, () => finishLocalTurn(deps, who.ownerId, who.deviceId, req.params.turnId, req.body, String(req.id)));
  });
}
