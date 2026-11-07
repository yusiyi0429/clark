import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { Budget, TaskBudgetResponse } from "@warmap/contracts";
import { readTaskBudget, writeTaskBudget } from "../budgets.js";
import { boardTask, CardError, planTaskOpener } from "../taskCards.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const taskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });

/** 这件 Task 的预算（设计 11.3，契约 budget.ts）：GET / PUT /api/me/tasks/:taskId/budget，只给负责人，DRI 工作台的人才有。 */
export function registerTaskPipelineRoutes(app: AppInstance, ctx: RouteContext): void {
  const { fail, requirePerson } = ctx;
  const open = planTaskOpener(ctx.q, ctx.planTasks, ctx.peopleDirectory, ctx.now);
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };

  // 这件 Task 的预算（设计 11.3，契约 budget.ts）：只给负责人；没单独设过是本人的缺省（inherited）。
  const ownTask = async <T>(reply: FastifyReply, personId: string, taskId: string, work: () => Promise<T>) => {
    try {
      await boardTask(open, personId, taskId);
      return await work();
    } catch (cause) {
      if (cause instanceof CardError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };
  app.get("/api/me/tasks/:taskId/budget", { preHandler: requireMember, schema: { params: taskParams, response: { 200: TaskBudgetResponse } } }, async (req, reply) =>
    ownTask(reply, req.person!.personId, req.params.taskId, () => readTaskBudget(ctx.q, req.person!.personId, req.params.taskId)));
  app.put("/api/me/tasks/:taskId/budget", { preHandler: requireMember, schema: { params: taskParams, body: Budget, response: { 200: TaskBudgetResponse } } },
    async (req, reply) => ownTask(reply, req.person!.personId, req.params.taskId, () => writeTaskBudget(ctx.q, req.person!.personId, req.params.taskId, req.body, ctx.now())));
}
