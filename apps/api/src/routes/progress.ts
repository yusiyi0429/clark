import { Type } from "@sinclair/typebox";
import { AttachOffPlanRequest, MyOffPlanResponse, ProgressOverviewResponse } from "@warmap/contracts";
import { personDisplayNames } from "../people.js";
import { attachOffPlan, proposeOffPlanReplan, readMyOffPlan, readProgressOverview } from "../progress.js";
import type { AppInstance, RouteContext } from "./shared.js";

const OffPlanParams = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });

/** 全局进展与本人的计划外。可见范围在仓储层（progress.ts）判：CEO 看全部，其他人看同一战场的人。 */
export function registerProgressRoutes(app: AppInstance, ctx: RouteContext): void {
  const names = () => personDisplayNames(ctx.peopleDirectory);
  const mine = (personId: string) => readMyOffPlan(ctx.q, personId, names(), ctx.now());

  app.get("/api/progress", {
    preHandler: ctx.requirePerson,
    schema: { response: { 200: ProgressOverviewResponse } },
  }, async (req) => ({ progress: await readProgressOverview(ctx.q, req.person!, ctx.peopleDirectory.searchPeople(undefined), ctx.now()) }));

  app.get("/api/me/off-plan", {
    preHandler: ctx.requirePerson,
    schema: { response: { 200: MyOffPlanResponse } },
  }, async (req) => mine(req.person!.personId));

  app.post("/api/me/off-plan/:id/attach", {
    preHandler: ctx.requirePerson,
    schema: { params: OffPlanParams, body: AttachOffPlanRequest, response: { 200: MyOffPlanResponse } },
  }, async (req, reply) => {
    const error = await attachOffPlan(ctx.pool, req.person!.personId, req.params.id, req.body.taskId, ctx.now());
    if (error) return ctx.fail(reply, error.status, error.code, error.message);
    return mine(req.person!.personId);
  });

  app.post("/api/me/off-plan/:id/replan", {
    preHandler: ctx.requirePerson,
    schema: { params: OffPlanParams, response: { 200: MyOffPlanResponse } },
  }, async (req, reply) => {
    const error = await proposeOffPlanReplan(ctx.q, req.person!.personId, req.params.id, ctx.now());
    if (error) return ctx.fail(reply, error.status, error.code, error.message);
    return mine(req.person!.personId);
  });
}
