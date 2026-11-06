import { Type } from "@sinclair/typebox";
import { TaskPipelineResponse } from "@warmap/contracts";
import { ChatServiceError } from "../chatService.js";
import { boardTask, CardError, planTaskOpener } from "../taskCards.js";
import { ensureTaskPipeline, pipelineScope } from "../taskPipelines.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const taskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });

/**
 * Task 管线（契约 workHome.ts）：POST /api/me/tasks/:taskId/pipeline。只给这件 Task 的负责人，DRI 工作台的人才有。
 * 第一次打开时建（201），以后都返回同一条（200）；收发消息走现有的对话接口，scope 是 plan-task:<taskId>。
 */
export function registerTaskPipelineRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, fail, requirePerson } = ctx;
  const open = planTaskOpener(ctx.q, ctx.planTasks, ctx.peopleDirectory, ctx.now);
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };

  app.post("/api/me/tasks/:taskId/pipeline", { preHandler: requireMember, schema: { params: taskParams,
    response: { 200: TaskPipelineResponse, 201: TaskPipelineResponse } } }, async (req, reply) => {
    const { taskId } = req.params;
    try {
      await boardTask(open, req.person!.personId, taskId);
      const { conversationId, created } = await ensureTaskPipeline({ pool, chat: ctx.chat }, req.person!, taskId, String(req.id));
      return reply.status(created ? 201 : 200).send({ taskId, conversationId, scope: pipelineScope(taskId) });
    } catch (cause) {
      if (cause instanceof CardError || cause instanceof ChatServiceError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  });
}
