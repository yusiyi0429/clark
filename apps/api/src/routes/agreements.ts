import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { CheckNotifyRequest, CheckNotifyResponse, PutTaskAgreementRequest, TaskAgreementResponse, TaskCheckResponse } from "@warmap/contracts";
import { personDisplayNames } from "../people.js";
import { planTaskViewer } from "../planTaskAccess.js";
import { checkTask, notifyAcceptor, openPlanTask, readAgreement, saveAgreement } from "../taskAgreements.js";
import { DeliverableError } from "../taskDeliverables.js";
import type { AppInstance, RouteContext } from "./shared.js";

const taskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });

/**
 * 约定与对表的 4 个接口（契约 /api/plan-tasks/{taskId}/agreement、/check、/check/notify，设计 v0.2 第 6 节）。
 * 两种视角都能用，谁能看、谁能改由 taskAgreements.openPlanTask 按人和 Task 的关系判。
 */
export function registerAgreementRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, fail, requirePerson, env, peopleDirectory } = ctx;
  const open = (personId: string, taskId: string) =>
    openPlanTask(q, ctx.planTasks, planTaskViewer(peopleDirectory, personId), ctx.now(), taskId, personDisplayNames(peopleDirectory));
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof DeliverableError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };

  app.get("/api/plan-tasks/:taskId/agreement", { preHandler: requirePerson, schema: { params: taskParams, response: { 200: TaskAgreementResponse } } },
    async (req, reply) => handle(reply, async () => (await open(req.person!.personId, req.params.taskId)).agreement));

  app.put("/api/plan-tasks/:taskId/agreement", { preHandler: requirePerson,
    schema: { params: taskParams, body: PutTaskAgreementRequest, response: { 200: TaskAgreementResponse } } }, async (req, reply) => handle(reply, async () => {
    const { access, agreement } = await open(req.person!.personId, req.params.taskId);
    const people = new Set(peopleDirectory.searchPeople(undefined).map((person) => person.personId));
    await saveAgreement(pool, access, agreement, req.body, (personId) => people.has(personId), ctx.now());
    return readAgreement(q, access, personDisplayNames(peopleDirectory));
  }));

  app.get("/api/plan-tasks/:taskId/check", { preHandler: requirePerson, schema: { params: taskParams, response: { 200: TaskCheckResponse } } },
    async (req, reply) => handle(reply, async () => {
      const { access, agreement } = await open(req.person!.personId, req.params.taskId);
      return checkTask(q, access, agreement, ctx.now());
    }));

  app.post("/api/plan-tasks/:taskId/check/notify", { preHandler: requirePerson,
    schema: { params: taskParams, body: CheckNotifyRequest, response: { 200: CheckNotifyResponse } } }, async (req, reply) => handle(reply, async () => {
    const { access, agreement } = await open(req.person!.personId, req.params.taskId);
    const check = await checkTask(q, access, agreement, ctx.now());
    return notifyAcceptor(q, access, check, req.body, ctx.now(), personDisplayNames(peopleDirectory), !!env.feishu);
  }));
}
