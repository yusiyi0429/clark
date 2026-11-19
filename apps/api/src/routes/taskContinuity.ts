import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { AddMonthTaskRequest, AddMonthTaskResponse, ContinueTaskRequest, ContinueTaskResponse, MonthPageResponse, MonthPeriod, PutTaskGoalRequest, SetTaskDueDateRequest, StopTaskRequest, TaskDueDateResponse, TaskGoalResponse, TaskSettlementResponse } from "@warmap/contracts";
import { readMonthPage } from "../monthPage.js";
import { continueTask, stopTask, unstopTask } from "../taskContinuity.js";
import { setTaskDueDate } from "../taskDueDates.js";
import { addTask, assertOpenPeriod, setTaskGoal, taskPeriod } from "../taskGoalEdits.js";
import { boardTask, CardError, planTaskOpener } from "../taskCards.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const taskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });
const monthParams = Type.Object({ period: MonthPeriod });

/**
 * 跨月延续与月份页（契约 taskContinuity.ts）：DRI 工作台的人才有。
 * 延续、到此为止、撤销只给那件 Task 的负责人（看板同一个口径：看不到 404，能看不是负责人 403）；延续到的新 Task 也要是本人负责的。
 */
export function registerTaskContinuityRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, fail, requirePerson } = ctx;
  const open = planTaskOpener(q, ctx.planTasks, ctx.peopleDirectory, ctx.now);
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

  app.post("/api/me/tasks/:taskId/continuation", { preHandler: requireMember, schema: { params: taskParams, body: ContinueTaskRequest,
    response: { 200: ContinueTaskResponse } } }, async (req, reply) => handle(reply, async () => {
    const personId = req.person!.personId;
    const from = await boardTask(open, personId, req.params.taskId);
    const to = await boardTask(open, personId, req.body.toTaskId);
    return continueTask(pool, { from, to, source: "owner", decidedBy: personId, now: ctx.now() });
  }));

  app.post("/api/me/tasks/:taskId/stop", { preHandler: requireMember, schema: { params: taskParams, body: StopTaskRequest,
    response: { 200: TaskSettlementResponse } } }, async (req, reply) => handle(reply, async () => {
    const own = await boardTask(open, req.person!.personId, req.params.taskId);
    return { taskId: own.task.taskId, settlement: await stopTask(q, own.task.taskId, req.person!.personId, req.body.note?.trim() || null, ctx.now()) };
  }));

  app.delete("/api/me/tasks/:taskId/stop", { preHandler: requireMember, schema: { params: taskParams } }, async (req, reply) => handle(reply, async () => {
    const own = await boardTask(open, req.person!.personId, req.params.taskId);
    await unstopTask(q, own.task.taskId);
    return reply.status(204).send();
  }));

  // 验收时间点（本月页就地改）：按 Task 存，不要求挂项目；只有这件 Task 的负责人能改（同到此为止）。
  app.put("/api/me/tasks/:taskId/due-date", { preHandler: requireMember, schema: { params: taskParams, body: SetTaskDueDateRequest,
    response: { 200: TaskDueDateResponse } } }, async (req, reply) => handle(reply, async () => {
    const own = await boardTask(open, req.person!.personId, req.params.taskId);
    const period = await taskPeriod(q, own.task.missionId);
    if (period) assertOpenPeriod(period, ctx.now());
    await setTaskDueDate(q, own.task.taskId, req.body.dueDate);
    return { taskId: own.task.taskId, name: own.task.name, dueDate: req.body.dueDate };
  }));

  // 名字和完成标准（本月页就地改）：天枢里先生效、标未进本体，不写本体；只有这件 Task 的负责人能改。
  app.put("/api/me/tasks/:taskId/goal", { preHandler: requireMember, schema: { params: taskParams, body: PutTaskGoalRequest,
    response: { 200: TaskGoalResponse } } }, async (req, reply) => handle(reply, async () => {
    const own = await boardTask(open, req.person!.personId, req.params.taskId);
    const period = await taskPeriod(q, own.task.missionId);
    if (period) assertOpenPeriod(period, ctx.now());
    return setTaskGoal(q, own.task, req.body, req.person!.personId, ctx.now());
  }));

  // 「+ 添一件」：在本人这个月的 Mission 下新建一件天枢里的 Task（不写本体）。
  app.post("/api/me/months/:period/tasks", { preHandler: requireMember, schema: { params: monthParams, body: AddMonthTaskRequest,
    response: { 201: AddMonthTaskResponse } } }, async (req, reply) => handle(reply, async () =>
    reply.status(201).send(await addTask(q, req.person!.personId, req.params.period, req.body, ctx.now()))));

  app.get("/api/me/months/:period", { preHandler: requireMember, schema: { params: monthParams, response: { 200: MonthPageResponse } } }, async (req) =>
    readMonthPage(q, ctx.planTasks, req.person!.personId, req.params.period, ctx.now()));
}
