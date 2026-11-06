import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { CardBoardResponse, CardBriefResponse, CardDetailResponse, CardTaskView, PatchCardRequest } from "@warmap/contracts";
import { personDisplayNames } from "../people.js";
import { findOwnTask, type OwnTask } from "../taskDeliverables.js";
import { boardTask, CardError, cardBrief, patchCard, readBoard, readCardDetail } from "../taskCards.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const taskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });
const cardParams = Type.Object({ id: Type.String({ minLength: 1 }) });

/**
 * 执行看板（契约 taskCards.ts）：Task 页看板、卡的详情、改卡、开工交代。成员工作台的人才有。
 */
export function registerTaskCardRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, fail, requirePerson } = ctx;
  const names = () => personDisplayNames(ctx.peopleDirectory);
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  /** CardError 换成对应的错误响应。 */
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof CardError) return fail(reply, cause.status, cause.code, cause.message, cause.latestTask ? { latestTask: cause.latestTask } : undefined);
      throw cause;
    }
  };
  /** 卡挂的 Task（推进人自己 Mission 下的），读不到为 null。 */
  const planTaskOf = (personId: string) => (planTaskId: string): Promise<OwnTask | null> =>
    findOwnTask(q, ctx.planTasks, personId, ctx.now(), planTaskId).catch(() => null);

  app.get("/api/plan-tasks/:taskId/cards", { preHandler: requireMember, schema: { params: taskParams, response: { 200: CardBoardResponse } } }, async (req, reply) =>
    handle(reply, async () => readBoard(q, await boardTask(q, ctx.planTasks, req.person!.personId, ctx.now(), req.params.taskId), names())));

  app.get("/api/me/cards/:id", { preHandler: requireMember, schema: { params: cardParams, response: { 200: CardDetailResponse } } }, async (req, reply) =>
    handle(reply, () => readCardDetail(q, req.person!.personId, req.params.id, names())));

  app.patch("/api/me/cards/:id", { preHandler: requireMember, schema: { params: cardParams, body: PatchCardRequest, response: { 200: CardTaskView } } }, async (req, reply) =>
    handle(reply, () => patchCard(pool, req.person!.personId, req.params.id, req.body, names(), planTaskOf(req.person!.personId))));

  app.get("/api/me/cards/:id/brief", { preHandler: requireMember, schema: { params: cardParams, response: { 200: CardBriefResponse } } }, async (req, reply) =>
    handle(reply, () => cardBrief(q, req.person!.personId, req.params.id, planTaskOf(req.person!.personId))));
}
