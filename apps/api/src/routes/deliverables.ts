import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { DeliverableDissentRequest, DeliverableNotePatch, DeliverableVersion, TaskDeliverableResponse, type TDeliverableVersion } from "@warmap/contracts";
import { createArticleFetcher, type ArticleFetcher } from "../articleText.js";
import { createDeliverableNoteAgent, createDeliverableQueue, createDeliverableReviewAgent, type DeliverableAgents } from "../deliverableReview.js";
import { MAX_MATERIAL_FILE_BYTES } from "../materialParser.js";
import { personDisplayNames } from "../people.js";
import { planTaskViewer } from "../planTaskAccess.js";
import { agreementSnapshot, openPlanTask } from "../taskAgreements.js";
import { DeliverableError, MAX_DELIVERABLE_FILES, createDeliverableVersion, deliverVersion, deliverableItemFile, dissentCriterion,
  ownTaskNames, parseDeliverableFields, patchVersionNote, readTaskDeliverable, retryReview, withdrawVersion, type DeliverableFile, type OwnTask } from "../taskDeliverables.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const taskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });
const versionParams = Type.Object({ taskId: Type.String({ minLength: 1 }), versionId: Type.String({ format: "uuid" }) });

/**
 * Task 交付物的 8 个接口（契约 /api/plan-tasks/{taskId}/deliverable）。读（交付物、原文件）：负责人、Mission 负责人、战场负责人、CEO 和约定里的认可人，
 * 两种视角都行；改（传版本、交付、异议、重评、改说明）：负责人，要在成员工作台（11/06 约定与对表 ADR 0028）。
 * 评审和版本说明在后台队列里跑；agents、fetchArticle 可注入（测试用假实现）。
 */
export function registerDeliverableRoutes(app: AppInstance, ctx: RouteContext, deps: { agents?: Partial<DeliverableAgents>; fetchArticle?: ArticleFetcher } = {}): void {
  const { q, pool, fail, requirePerson, env } = ctx;
  // 评审模型：REVIEW_* 指向 TokenHub；没配时用现在的 PI 网关和 heavy 模型。
  const model = { query: q, baseUrl: env.review?.baseUrl ?? env.piBaseUrl, apiKey: env.review?.apiKey ?? env.piApiKey,
    modelId: env.review?.model ?? env.heavyModel, thinking: env.review?.thinking };
  const queue = createDeliverableQueue({ pool, storageDir: ctx.materialStorageDir, now: ctx.now, onError: () => app.log.error("deliverable review failed"),
    fetchArticle: deps.fetchArticle ?? createArticleFetcher(),
    otherTasks: async (personId, taskId) => (await ownTaskNames(q, ctx.planTasks, personId, ctx.now())).filter((item) => item.taskId !== taskId).map((item) => item.name),
    agents: { review: deps.agents?.review ?? createDeliverableReviewAgent(model), note: deps.agents?.note ?? createDeliverableNoteAgent(model) } });
  app.decorate("deliverables", queue);
  let recovery: ReturnType<typeof setInterval> | undefined;
  const recover = () => queue.recover().catch(() => app.log.error("deliverable review recovery failed"));
  app.addHook("onReady", async () => {
    await recover();
    recovery = setInterval(() => { void recover(); }, 60_000);
    recovery.unref();
  });
  app.addHook("onClose", async () => { clearInterval(recovery); await queue.close(); });

  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  const open = (personId: string, taskId: string) =>
    openPlanTask(q, ctx.planTasks, planTaskViewer(ctx.peopleDirectory, personId), ctx.now(), taskId, personDisplayNames(ctx.peopleDirectory));
  const own = async (personId: string, taskId: string): Promise<OwnTask> => (await open(personId, taskId)).access;
  const error = (reply: FastifyReply, cause: unknown) => {
    if (cause instanceof DeliverableError) return fail(reply, cause.status, cause.code, cause.message);
    throw cause;
  };
  /** 先认 Task 再做事；DeliverableError 换成对应的错误响应。 */
  const withTask = <T>(reply: FastifyReply, personId: string, taskId: string, work: (task: OwnTask) => Promise<T>) =>
    own(personId, taskId).then(work).catch((cause) => error(reply, cause));

  app.get("/api/plan-tasks/:taskId/deliverable", { preHandler: requirePerson, schema: { params: taskParams, response: { 200: TaskDeliverableResponse } } },
    async (req, reply) => withTask(reply, req.person!.personId, req.params.taskId, (task) => readTaskDeliverable(q, task, personDisplayNames(ctx.peopleDirectory))));

  app.post("/api/plan-tasks/:taskId/deliverable/versions", { preHandler: requireMember, schema: { params: taskParams },
    bodyLimit: MAX_DELIVERABLE_FILES * MAX_MATERIAL_FILE_BYTES + 1024 * 1024 }, async (req, reply) => {
    try {
      // 先认权限再收文件；约定的快照跟着这一版存，评审照它判。
      const { access: task, agreement } = await open(req.person!.personId, req.params.taskId);
      if (!task.canEdit) throw new DeliverableError(403, "FORBIDDEN", "这个 Task 由负责人交付");
      const fields = new Map<string, string>();
      const files: DeliverableFile[] = [];
      for await (const part of req.parts({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: MAX_DELIVERABLE_FILES, fields: 5 } })) {
        if (part.type === "file") {
          if (part.fieldname !== "files") return fail(reply, 400, "INVALID_INPUT", "文件字段叫 files");
          files.push({ filename: part.filename, buffer: await part.toBuffer() });
        } else if (typeof part.value === "string") fields.set(part.fieldname, part.value);
      }
      const version = await createDeliverableVersion(pool, task, files, parseDeliverableFields(fields), ctx.materialStorageDir, agreementSnapshot(agreement));
      void queue.enqueueReview(version.id);
      return reply.status(201).send(version);
    } catch (cause) {
      const limited = ctx.materialMultipartLimitError(cause,
        { status: 413, code: "FILE_TOO_LARGE", message: "单份文件不能超过 20 MB" },
        { status: 400, code: "TOO_MANY_FILES", message: `一版最多 ${MAX_DELIVERABLE_FILES} 份文件` },
        { status: 400, code: "INVALID_INPUT", message: "上传没有传完，请重试" });
      if (limited) return fail(reply, limited.status, limited.code, limited.message);
      return error(reply, cause);
    }
  });

  app.get("/api/plan-tasks/:taskId/deliverable/items/:itemId", {
    onRequest: async (_req, reply) => { reply.header("content-security-policy", "sandbox"); }, preHandler: requirePerson,
    schema: { params: Type.Object({ taskId: Type.String({ minLength: 1 }), itemId: Type.String({ format: "uuid" }) }) } }, async (req, reply) =>
    withTask(reply, req.person!.personId, req.params.taskId, async (task) => {
      const file = await deliverableItemFile(q, task.task.taskId, req.params.itemId);
      const data = await readFile(join(ctx.materialStorageDir, file.storageKey)).catch(() => null);
      if (!data) throw new DeliverableError(404, "NOT_FOUND", "这份文件找不到了");
      return reply.type(file.mimeType).header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
        .header("x-content-type-options", "nosniff").send(data);
    }));

  const versionRoute = (path: string, work: (task: OwnTask, versionId: string, body: never, index: number) => Promise<TDeliverableVersion>, extra: { body?: unknown; index?: boolean } = {}) =>
    app.post(path, { preHandler: requireMember, schema: { params: extra.index ? Type.Composite([versionParams, Type.Object({ index: Type.Integer({ minimum: 1 }) })]) : versionParams,
      ...(extra.body ? { body: extra.body } : {}), response: { 200: DeliverableVersion } } }, async (req, reply) => {
      const params = req.params as { taskId: string; versionId: string; index?: number };
      return withTask(reply, req.person!.personId, params.taskId, (task) => work(task, params.versionId, req.body as never, params.index ?? 0));
    });
  versionRoute("/api/plan-tasks/:taskId/deliverable/versions/:versionId/review", async (task, versionId) => {
    const version = await retryReview(q, task, versionId);
    void queue.enqueueReview(versionId);
    return version;
  });
  versionRoute("/api/plan-tasks/:taskId/deliverable/versions/:versionId/criteria/:index/dissent", async (task, versionId, body: { reason: string }, index) => {
    const version = await dissentCriterion(q, task, versionId, index, body.reason, ctx.now());
    void queue.enqueueReview(versionId);
    return version;
  }, { body: DeliverableDissentRequest, index: true });
  versionRoute("/api/plan-tasks/:taskId/deliverable/versions/:versionId/deliver", async (task, versionId) => {
    const version = await deliverVersion(q, task, versionId, ctx.now());
    if (version.note?.status === "writing") void queue.enqueueNote(versionId);
    return version;
  });
  versionRoute("/api/plan-tasks/:taskId/deliverable/versions/:versionId/withdraw", (task, versionId) => withdrawVersion(q, task, versionId));
  app.patch("/api/plan-tasks/:taskId/deliverable/versions/:versionId/note", { preHandler: requireMember,
    schema: { params: versionParams, body: DeliverableNotePatch, response: { 200: DeliverableVersion } } }, async (req, reply) =>
    withTask(reply, req.person!.personId, req.params.taskId, (task) => patchVersionNote(q, task, req.params.versionId, req.body)));
}
