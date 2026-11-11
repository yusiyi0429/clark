import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import {
  AddReviewLinkRequest, MonthCarryoverResponse, MonthPeriod, MonthReviewResponse, PutReviewCriterionRequest, PutReviewDispositionRequest, ReviewLinkCandidatesResponse,
} from "@warmap/contracts";
import {
  addLink, confirmMission, deleteLink, linkCandidates, rateCriterion, readCarryover, readMonthReview, requestPrefill, setDisposition, type MonthReviewDeps,
} from "../monthReview.js";
import { personDisplayNames } from "../people.js";
import { CardError } from "../taskCards.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const periodParams = Type.Object({ period: MonthPeriod });
const taskParams = Type.Object({ period: MonthPeriod, taskId: Type.String({ minLength: 1 }) });
const criterionParams = Type.Object({ period: MonthPeriod, taskId: Type.String({ minLength: 1 }), index: Type.Integer({ minimum: 1 }) });
const linkParams = Type.Object({ period: MonthPeriod, linkId: Type.String({ format: "uuid" }) });
const missionParams = Type.Object({ period: MonthPeriod, missionId: Type.String({ minLength: 1 }) });

/**
 * 月底复盘第三版（契约 monthReview.ts）：DRI 工作台的人才有。谁能改、谁能确认见 monthReview.ts；写操作都回整份最新的复盘页。
 * 读复盘页时，本期验收里还有没出预评的条目就排一次预评。
 */
export function registerMonthReviewRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, fail, requirePerson } = ctx;
  const deps: MonthReviewDeps = { pool, planTasks: ctx.planTasks, names: () => personDisplayNames(ctx.peopleDirectory), now: ctx.now };
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
  const review = async (personId: string, period: string) => {
    const view = await readMonthReview({ q, planTasks: ctx.planTasks, names: deps.names() }, personId, period);
    return await requestPrefill(deps, personId, view) ? { ...view, prefill: { status: "pending" as const, error: null } } : view;
  };
  const reviewResponse = { 200: MonthReviewResponse };

  app.get("/api/me/months/:period/review", { preHandler: requireMember, schema: { params: periodParams, response: reviewResponse } }, async (req) =>
    review(req.person!.personId, req.params.period));

  app.put("/api/me/months/:period/review/tasks/:taskId/disposition", { preHandler: requireMember,
    schema: { params: taskParams, body: PutReviewDispositionRequest, response: reviewResponse } }, async (req, reply) => handle(reply, async () => {
    await setDisposition(deps, req.person!.personId, req.params.period, req.params.taskId, req.body);
    return review(req.person!.personId, req.params.period);
  }));

  app.put("/api/me/months/:period/review/tasks/:taskId/criteria/:index", { preHandler: requireMember,
    schema: { params: criterionParams, body: PutReviewCriterionRequest, response: reviewResponse } }, async (req, reply) => handle(reply, async () => {
    await rateCriterion(deps, req.person!.personId, req.params.period, req.params.taskId, req.params.index, req.body);
    return review(req.person!.personId, req.params.period);
  }));

  app.post("/api/me/months/:period/review/tasks/:taskId/criteria/:index/links", { preHandler: requireMember,
    schema: { params: criterionParams, body: AddReviewLinkRequest, response: reviewResponse } }, async (req, reply) => handle(reply, async () => {
    await addLink(deps, req.person!.personId, req.params.period, req.params.taskId, req.params.index, req.body);
    return review(req.person!.personId, req.params.period);
  }));

  app.delete("/api/me/months/:period/review/links/:linkId", { preHandler: requireMember, schema: { params: linkParams, response: reviewResponse } },
    async (req, reply) => handle(reply, async () => {
      await deleteLink(deps, req.person!.personId, req.params.period, req.params.linkId);
      return review(req.person!.personId, req.params.period);
    }));

  app.get("/api/me/months/:period/review/tasks/:taskId/link-candidates", { preHandler: requireMember,
    schema: { params: taskParams, response: { 200: ReviewLinkCandidatesResponse } } }, async (req, reply) => handle(reply, async () =>
    ({ candidates: await linkCandidates(deps, req.person!.personId, req.params.period, req.params.taskId) })));

  app.post("/api/me/months/:period/review/missions/:missionId/confirm", { preHandler: requireMember, schema: { params: missionParams, response: reviewResponse } },
    async (req, reply) => handle(reply, async () => {
      await confirmMission(deps, req.person!.personId, req.params.period, req.params.missionId);
      return review(req.person!.personId, req.params.period);
    }));

  app.get("/api/me/months/:period/carryover", { preHandler: requireMember, schema: { params: periodParams, response: { 200: MonthCarryoverResponse } } }, async (req) =>
    readCarryover(q, req.person!.personId, req.params.period));
}
