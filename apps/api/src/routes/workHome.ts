import type { FastifyReply } from "fastify";
import { BackgroundQuery, BackgroundResponse, RouteRequest, RouteResponse, WorkHomeResponse } from "@warmap/contracts";
import { routeMessage } from "../messageRoute.js";
import { listMissionRoundCards, type MissionRoundPerson } from "../missionRounds.js";
import { personDisplayNames } from "../people.js";
import { CardError } from "../taskCards.js";
import { readBackground, readWorkHome, treeTasks } from "../workHome.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

/**
 * 新首页（契约 workHome.ts）：GET /api/me/work-home、GET /api/me/background、POST /api/me/route。DRI 工作台的人才有。
 * 伙伴的汇总读 GET /internal/me/work-home（同一份），照现有 /internal：Authorization: Bearer <INTERNAL_CHAT_TOKEN> 加 X-Owner-Id，
 * 没配 INTERNAL_CHAT_TOKEN 时不注册，不进公开 OpenAPI。
 */
export function registerWorkHomeRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requirePerson, requireServiceToken, peopleDirectory } = ctx;
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof CardError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };
  const workHome = (person: MissionRoundPerson) => {
    const now = ctx.now();
    return readWorkHome({ q, planTasks: ctx.planTasks, now, names: personDisplayNames(peopleDirectory), chat: Boolean(ctx.chat),
      meetings: (personId) => app.meetingFollowThrough.cards.pendingFor(personId),
      missionRounds: (viewer) => listMissionRoundCards(q, peopleDirectory.searchPeople(undefined), env.sessionSecret, viewer, undefined, now) }, person);
  };

  // 飞书推送（homePush.ts，server.ts 注册后台任务）读同一份首页。
  app.decorate("readWorkHome", workHome);

  app.get("/api/me/work-home", { preHandler: requireMember, schema: { response: { 200: WorkHomeResponse } } }, async (req) => workHome(req.person!));

  app.get("/api/me/background", { preHandler: requireMember, schema: { querystring: BackgroundQuery, response: { 200: BackgroundResponse } } }, async (req, reply) =>
    handle(reply, () => readBackground({ q, now: ctx.now(), planTasks: ctx.planTasks, chat: Boolean(ctx.chat) }, req.person!.personId, req.query.scope)));

  app.post("/api/me/route", { preHandler: requireMember, schema: { body: RouteRequest, response: { 200: RouteResponse } } }, async (req) =>
    routeMessage(req.body.text, (await treeTasks(q, ctx.planTasks, req.person!.personId, ctx.now(), Boolean(ctx.chat))).tasks));

  if (!env.internalChatToken) return;
  // 伙伴读的是 DRI 工作台那一份（Mission Card 按本人这一侧看）。
  app.get("/internal/me/work-home", { onRequest: requireServiceToken(env.internalChatToken), schema: { response: { 200: WorkHomeResponse } } }, async (req, reply) => {
    const id = req.headers["x-owner-id"];
    if (typeof id !== "string" || !peopleDirectory.searchPeople(undefined).some((person) => person.personId === id)) return fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
    return workHome({ personId: id, role: "member" });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    /** 本人的新首页（和 GET /api/me/work-home 同一份）；飞书推送的后台任务读它。 */
    readWorkHome: (person: MissionRoundPerson) => ReturnType<typeof readWorkHome>;
  }
}
