import { Type } from "@sinclair/typebox";
import { TaskFeedResponse } from "@warmap/contracts";
import { boardTask, CardError, planTaskOpener } from "../taskCards.js";
import { readTaskFeed } from "../taskFeed.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

/**
 * Task 管线的验收行（契约 workHome.ts 的 TaskFeedResponse）：GET /api/me/tasks/:taskId/feed。
 * 只给这件 Task 的负责人（同看板），DRI 工作台的人才有；看不到、找不到 404，能看不是负责人 403。
 */
export function registerTaskFeedRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, fail, requirePerson } = ctx;
  const open = planTaskOpener(q, ctx.planTasks, ctx.peopleDirectory, ctx.now);
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };

  app.get("/api/me/tasks/:taskId/feed", { preHandler: requireMember, schema: { params: Type.Object({ taskId: Type.String({ minLength: 1 }) }),
    response: { 200: TaskFeedResponse } } }, async (req, reply) => {
    try {
      const own = await boardTask(open, req.person!.personId, req.params.taskId);
      return await readTaskFeed(q, req.person!.personId, own.task.taskId, own.criteria);
    } catch (cause) {
      if (cause instanceof CardError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  });
}
