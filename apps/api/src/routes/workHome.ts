import { markWorkSeen } from "../workSeen.js";
import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { ArchivedSubSessionListResponse, BackgroundQuery, BackgroundResponse, MarkWorkSeenRequest, RouteRequest, RouteResponse, SubSessionKind, UpdateSubSessionRequest,
  WorkHomeResponse } from "@warmap/contracts";
import { deleteSubSession, listArchivedSubSessions, updateSubSession } from "../subSessionAdmin.js";
import { routeMessage } from "../messageRoute.js";
import { listMissionRoundCards, type MissionRoundPerson } from "../missionRounds.js";
import { personDisplayNames } from "../people.js";
import { goalsOf } from "../projects.js";
import { CardError } from "../taskCards.js";
import { readBackground, readWorkHome, treeTasks } from "../workHome.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

/**
 * 新首页（契约 workHome.ts）：GET /api/me/work-home、GET /api/me/background、POST /api/me/route。DRI 工作台的人才有。
 * 伙伴的汇总读 GET /internal/me/work-home（同一份），照现有 /internal：Authorization: Bearer <INTERNAL_CHAT_TOKEN> 加 X-Owner-Id，
 * 没配 INTERNAL_CHAT_TOKEN 时不注册，不进公开 OpenAPI。
 */
export function registerWorkHomeRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, env, fail, requirePerson, requireServiceToken, peopleDirectory } = ctx;
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
    return readWorkHome({ q, pool, planTasks: ctx.planTasks, now, names: personDisplayNames(peopleDirectory), chat: Boolean(ctx.chat),
      meetings: (personId) => app.meetingFollowThrough.cards.pendingFor(personId),
      nexusConfirmations: (personId) => app.nexusDri.listFor(personId),
      missionRounds: (viewer) => listMissionRoundCards(q, peopleDirectory.searchPeople(undefined), env.sessionSecret, viewer, undefined, now) }, person);
  };

  // 飞书推送（homePush.ts，server.ts 注册后台任务）读同一份首页。
  app.decorate("readWorkHome", workHome);

  app.get("/api/me/work-home", { preHandler: requireMember, schema: { response: { 200: WorkHomeResponse } } }, async (req) => workHome(req.person!));

  // 蓝点（17.2 第 25 条）：本人打开了一个子会话或项目对话。
  app.post("/api/me/work-seen", { preHandler: requireMember, schema: { body: MarkWorkSeenRequest } }, async (req, reply) => {
    await markWorkSeen(q, req.person!.personId, req.body.kind, req.body.id, ctx.now());
    return reply.status(204).send();
  });

  // 子会话那一行的「…」菜单（17.2 第 35 条）：改名、归档、恢复、删进回收站，和归档列表。
  const subParams = Type.Object({ kind: SubSessionKind, id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  app.get("/api/me/sub-sessions/archived", { preHandler: requireMember, schema: { response: { 200: ArchivedSubSessionListResponse } } }, async (req) =>
    ({ items: await listArchivedSubSessions(q, req.person!.personId) }));
  app.patch("/api/me/sub-sessions/:kind/:id", { preHandler: requireMember, schema: { params: subParams, body: UpdateSubSessionRequest } }, async (req, reply) =>
    handle(reply, async () => {
      await updateSubSession(q, req.person!.personId, req.params.kind, req.params.id, req.body, ctx.now());
      return reply.status(204).send();
    }));
  app.delete("/api/me/sub-sessions/:kind/:id", { preHandler: requireMember, schema: { params: subParams } }, async (req, reply) =>
    handle(reply, async () => {
      await deleteSubSession(q, req.person!.personId, req.params.kind, req.params.id, ctx.now());
      return reply.status(204).send();
    }));

  app.get("/api/me/background", { preHandler: requireMember, schema: { querystring: BackgroundQuery, response: { 200: BackgroundResponse } } }, async (req, reply) =>
    handle(reply, () => readBackground({ q, now: ctx.now(), planTasks: ctx.planTasks }, req.person!.personId, req.query.scope)));

  // 「自动」发给谁：没归档的项目，带它的名字和挂着的 Task（名字、完成定义、标准）。
  app.post("/api/me/route", { preHandler: requireMember, schema: { body: RouteRequest, response: { 200: RouteResponse } } }, async (req) => {
    const personId = req.person!.personId;
    const { tasks } = await treeTasks(q, ctx.planTasks, personId, ctx.now());
    const goals = await goalsOf(q, personId);
    const projects = (await q("SELECT id::text,name FROM projects WHERE owner_id=$1 AND archived_at IS NULL", [personId])).rows as { id: string; name: string }[];
    return routeMessage(req.body.text, projects.map((project) => {
      const linked = tasks.filter((task) => goals.get(task.taskId)?.project_id === project.id);
      return { projectId: project.id, names: [project.name, ...linked.map((task) => task.name)],
        text: linked.flatMap((task) => [task.doneDefinition ?? "", ...task.criteria]) };
    }));
  });

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
