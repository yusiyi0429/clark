import type { FastifyReply } from "fastify";
import { BackgroundQuery, BackgroundResponse, RouteRequest, RouteResponse, WorkHomeResponse } from "@warmap/contracts";
import { routeMessage } from "../messageRoute.js";
import { listMissionRoundCards } from "../missionRounds.js";
import { personDisplayNames } from "../people.js";
import { CardError } from "../taskCards.js";
import { ownPlanTasks, readBackground, readWorkHome } from "../workHome.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

/**
 * 新首页（契约 workHome.ts）：GET /api/me/work-home、GET /api/me/background、POST /api/me/route。DRI 工作台的人才有。
 */
export function registerWorkHomeRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, fail, requirePerson } = ctx;
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

  app.get("/api/me/work-home", { preHandler: requireMember, schema: { response: { 200: WorkHomeResponse } } }, async (req) => {
    const now = ctx.now();
    return readWorkHome({ q, planTasks: ctx.planTasks, now, names: personDisplayNames(ctx.peopleDirectory), chat: Boolean(ctx.chat),
      meetings: (personId) => app.meetingFollowThrough.cards.pendingFor(personId),
      missionRounds: (person) => listMissionRoundCards(q, ctx.peopleDirectory.searchPeople(undefined), ctx.env.sessionSecret, person, undefined, now) }, req.person!);
  });

  app.get("/api/me/background", { preHandler: requireMember, schema: { querystring: BackgroundQuery, response: { 200: BackgroundResponse } } }, async (req, reply) =>
    handle(reply, () => readBackground({ q, now: ctx.now(), planTasks: ctx.planTasks }, req.person!.personId, req.query.scope)));

  app.post("/api/me/route", { preHandler: requireMember, schema: { body: RouteRequest, response: { 200: RouteResponse } } }, async (req) =>
    routeMessage(req.body.text, (await ownPlanTasks(q, ctx.planTasks, req.person!.personId, ctx.now())).tasks));
}
