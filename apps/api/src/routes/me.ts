import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { AddTaskCollaboratorsRequest, CreateMyTaskRequest, MarkNotificationsSeenRequest, MeHomeResponse, MemberBattlefieldResponse, MonthPlanResponse, PatchMyTaskRequest, PutMyTaskNoteRequest, ReturnMyTaskRequest, SaveMonthPlanRequest, TaskDetailResponse, type TTaskView, type TVoiceprintStatus } from "@warmap/contracts";
import { listMyNotifications, markNotificationsSeen } from "../notifications.js";
import { addTaskCollaborators, createMyTask, deleteMyTask, getTaskDetail, listMyTasks, putMyTaskNote, returnMyTask, updateMyTaskStatus, type TaskResult } from "../tasks.js";
import { readMonthPlan, saveMonthPlan } from "../monthPlan.js";
import { companyPeriod } from "../monthlyPlans.js";
import { personDisplayNames } from "../people.js";
import { roleOf } from "../memberAccess.js";
import { deleteVoiceprint, enrollVoiceprint, MAX_VOICEPRINT_UPLOAD_BYTES, voiceprintStatus } from "../voiceprints.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";
import { readMemberWork } from "../memberWork.js";
import { readMemberBattlefield } from "../memberBattlefields.js";
import { readMemberRadarBrief } from "../personalSignals.js";

// 成员侧（CEO 也可调用，只看到自己的）：普通视图对象，不走 Card/Action 签名（spec §3.5）。
export function registerMeRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, fail, requirePerson, companyMemory, voiceprints, materialMultipartLimitError } = ctx;

  const names = () => personDisplayNames(companyMemory);
  const invitable = () => new Set(companyMemory.searchPeople(undefined).filter((person) => roleOf(person) === "member").map((person) => person.personId));
  const respondTask = (reply: FastifyReply, result: TaskResult): TTaskView | FastifyReply => {
    if ("notFound" in result) return fail(reply, 404, "TASK_NOT_FOUND", "执行事项不存在");
    if ("conflict" in result) return fail(reply, 409, "VERSION_CONFLICT", "执行事项已被修改，请基于最新内容重试", { latestTask: result.conflict });
    if ("error" in result) return fail(reply, result.error.status, result.error.code, result.error.message);
    return result.task;
  };

  app.get("/api/me/home", { preHandler: requirePerson, schema: { response: { 200: MeHomeResponse } } }, async (req) => {
    const [myTasks, { work }, radar] = await Promise.all([
      listMyTasks(q, req.person!.personId, names()),
      readMemberWork(q, companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, ctx.now()),
      readMemberRadarBrief(q, req.person!, ctx.now()),
    ]);
    return { myTasks, work, radar };
  });

  app.get("/api/me/battlefields/:id", { preHandler: requirePerson, schema: { params: idParams, response: { 200: MemberBattlefieldResponse } } }, async (req, reply) => {
    const detail = await readMemberBattlefield(q, companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.id, ctx.now());
    return detail ?? fail(reply, 404, "BATTLEFIELD_NOT_FOUND", "战场不存在");
  });

  app.patch(
    "/api/me/tasks/:id",
    { preHandler: requirePerson, schema: { params: idParams, body: PatchMyTaskRequest } },
    async (req, reply) => respondTask(reply, await updateMyTaskStatus(pool, req.person!.personId, req.params.id, req.body, names(), ctx.now())),
  );

  app.post(
    "/api/me/tasks/:id/return",
    { preHandler: requirePerson, schema: { params: idParams, body: ReturnMyTaskRequest } },
    async (req, reply) => respondTask(reply, await returnMyTask(pool, req.person!.personId, req.params.id, req.body, names())),
  );

  app.get("/api/me/tasks/:id", { preHandler: requirePerson, schema: { params: idParams, response: { 200: TaskDetailResponse } } }, async (req, reply) =>
    await getTaskDetail(q, req.params.id, req.person!.personId, names(), ctx.now(), invitable()) ?? fail(reply, 404, "TASK_NOT_FOUND", "执行事项不存在"));
  app.post("/api/me/tasks", { preHandler: requirePerson, schema: { body: CreateMyTaskRequest } }, async (req, reply) =>
    respondTask(reply, await createMyTask(pool, req.person!.personId, names(), req.body, ctx.now())));
  app.delete("/api/me/tasks/:id", { preHandler: requirePerson, schema: { params: idParams,
    querystring: Type.Object({ version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }) } }, async (req, reply) => {
    const result = await deleteMyTask(pool, req.person!.personId, req.params.id, req.query.version, names());
    return "deleted" in result ? reply.code(204).send() : respondTask(reply, result);
  });
  app.put("/api/me/tasks/:id/note", { preHandler: requirePerson, schema: { params: idParams, body: PutMyTaskNoteRequest } }, async (req, reply) => {
    const result = await putMyTaskNote(pool, req.person!.personId, req.params.id, req.body.note);
    return "notFound" in result ? fail(reply, 404, "TASK_NOT_FOUND", "执行事项不存在") : result;
  });
  app.post("/api/me/tasks/:id/collaborators", { preHandler: requirePerson,
    schema: { params: idParams, body: AddTaskCollaboratorsRequest } }, async (req, reply) =>
    respondTask(reply, await addTaskCollaborators(pool, req.person!.personId, req.params.id, names(), req.body, invitable())));
  const planQuery = Type.Object({ period: Type.Optional(Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" })) }, { additionalProperties: false });
  app.get("/api/me/plan", { preHandler: requirePerson, schema: { querystring: planQuery, response: { 200: MonthPlanResponse } } }, async (req) =>
    readMonthPlan(q, req.person!.personId, req.query.period ?? companyPeriod(ctx.now()), names(), ctx.now()));
  app.put("/api/me/plan", { preHandler: requirePerson, schema: { body: SaveMonthPlanRequest } }, async (req, reply) => {
    const result = await saveMonthPlan(pool, req.person!.personId, names(), req.body, ctx.now());
    return "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message,
      result.error.latestTask ? { latestTask: result.error.latestTask } : undefined) : result.plan;
  });

  app.get("/api/me/notifications", { preHandler: requirePerson }, async (req) => ({
    notifications: await listMyNotifications(q, companyMemory, req.person!.personId),
  }));

  app.post(
    "/api/me/seen",
    { preHandler: requirePerson, schema: { body: MarkNotificationsSeenRequest } },
    async (req, reply) => {
      await markNotificationsSeen(q, req.person!.personId, req.body.notificationIds);
      return reply.code(204).send();
    },
  );

  // 声纹只能本人录、本人删（敏感个人信息，见 voiceprints.ts）；没有替别人录的入口。
  app.get("/api/me/voiceprint", { preHandler: requirePerson }, async (req) => voiceprintStatus(q, voiceprints, req.person!.personId));

  app.post(
    "/api/me/voiceprint",
    { preHandler: requirePerson, bodyLimit: MAX_VOICEPRINT_UPLOAD_BYTES * 2 },
    async (req, reply): Promise<TVoiceprintStatus | FastifyReply> => {
      let consent = false;
      let audio: Buffer | null = null;
      try {
        for await (const part of req.parts({ limits: { fileSize: MAX_VOICEPRINT_UPLOAD_BYTES, files: 1 } })) {
          if (part.type === "file") {
            if (part.fieldname !== "audio") return fail(reply, 400, "VOICEPRINT_AUDIO_REQUIRED", "录音必须放在 audio 字段里上传");
            audio = await part.toBuffer();
          } else if (part.fieldname === "consent") {
            consent = String(part.value) === "true";
          }
        }
      } catch (error) {
        const limited = materialMultipartLimitError(
          error,
          { status: 413, code: "VOICEPRINT_AUDIO_TOO_LARGE", message: "声纹录音超过 10 MB，录 30 秒左右即可" },
          { status: 400, code: "VOICEPRINT_AUDIO_REQUIRED", message: "一次只能上传一段声纹录音" },
          { status: 400, code: "VOICEPRINT_AUDIO_REQUIRED", message: "录音上传中断了，请重试" },
        );
        if (limited) return fail(reply, limited.status, limited.code, limited.message);
        throw error;
      }
      const result = await enrollVoiceprint(q, voiceprints, req.person!.personId, { consent, audio });
      return result.ok ? result.value : fail(reply, result.status, result.code, result.message);
    },
  );

  app.delete("/api/me/voiceprint", { preHandler: requirePerson }, async (req, reply) => {
    const result = await deleteVoiceprint(q, voiceprints, req.person!.personId);
    return result.ok ? reply.code(204).send() : fail(reply, result.status, result.code, result.message);
  });
}
