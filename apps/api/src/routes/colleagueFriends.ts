import { Type } from "@sinclair/typebox";
import { ColleagueSearchResponse, FriendGrant, FriendSettings, FriendView } from "@warmap/contracts";
import type { FastifyReply } from "fastify";
import { colleagueIndex, matchColleagues } from "../colleagueScope.js";
import {
  acceptFriend, FriendError, readFriend, readFriendSettings, relationOf, removeFriend, requestFriend, saveFriendGrant, saveFriendSettings, type FriendDeps,
} from "../colleagueFriends.js";
import { isRealPerson } from "../people.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const personParams = Type.Object({ personId: Type.String({ minLength: 1, maxLength: 100 }) });
const searchQuery = Type.Object({ query: Type.Optional(Type.String({ maxLength: 100 })) });

/** 同事好友、加好友设置、找同事（契约 colleagueChatsOpenapi.ts）；工作模式登录，CEO 一样。 */
export function registerColleagueFriendRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, fail, requirePerson, peopleDirectory } = ctx;
  const deps: FriendDeps = { q, pool, directory: peopleDirectory, now: ctx.now };
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof FriendError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };
  const friend = { preHandler: requireMember, schema: { params: personParams, response: { 200: FriendView } } };
  const withGrant = { preHandler: requireMember, schema: { params: personParams, body: FriendGrant, response: { 200: FriendView } } };

  app.get("/api/me/colleagues", { preHandler: requireMember, schema: { querystring: searchQuery, response: { 200: ColleagueSearchResponse } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const viewer = req.person!.personId;
    const index = (await colleagueIndex(q, peopleDirectory, viewer)).filter((entry) => isRealPerson({ personId: entry.personId, displayName: entry.name }));
    const found = matchColleagues(index, req.query.query ?? "");
    const people = [];
    for (const hit of found.people)
      people.push({ personId: hit.personId, displayName: hit.name, matched: hit.matched, relation: await relationOf(q, viewer, hit.personId) });
    return { people, more: found.more };
  });

  app.get("/api/me/friend-settings", { preHandler: requireMember, schema: { response: { 200: FriendSettings } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return readFriendSettings(q, req.person!.personId);
  });
  app.put("/api/me/friend-settings", { preHandler: requireMember, schema: { body: FriendSettings, response: { 200: FriendSettings } } }, async (req) =>
    saveFriendSettings(q, req.person!.personId, req.body, ctx.now()));

  app.get("/api/me/friends/:personId", friend, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return handle(reply, () => readFriend(deps, req.person!.personId, req.params.personId));
  });
  app.delete("/api/me/friends/:personId", friend, async (req, reply) => handle(reply, () => removeFriend(deps, req.person!.personId, req.params.personId)));
  app.post("/api/me/friends/:personId/request", friend, async (req, reply) => handle(reply, () => requestFriend(deps, req.person!.personId, req.params.personId)));
  app.post("/api/me/friends/:personId/accept", withGrant, async (req, reply) =>
    handle(reply, () => acceptFriend(deps, req.person!.personId, req.params.personId, req.body)));
  app.put("/api/me/friends/:personId/grant", withGrant, async (req, reply) =>
    handle(reply, () => saveFriendGrant(deps, req.person!.personId, req.params.personId, req.body)));
}
