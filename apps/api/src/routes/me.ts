import type { FastifyReply } from "fastify";
import { MarkNotificationsSeenRequest, MeHomeResponse, MemberBattlefieldResponse, PatchMyTaskRequest, ReturnMyTaskRequest, type TTaskView, type TVoiceprintStatus } from "@warmap/contracts";
import { listMyNotifications, markNotificationsSeen } from "../notifications.js";
import { listMyTasks, returnMyTask, updateMyTaskStatus, type TaskMutation } from "../tasks.js";
import { deleteVoiceprint, enrollVoiceprint, MAX_VOICEPRINT_UPLOAD_BYTES, voiceprintStatus } from "../voiceprints.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";
import { readMemberWork } from "../memberWork.js";
import { readMemberBattlefield } from "../memberBattlefields.js";

// 成员侧（CEO 也可调用，只看到自己的）：普通视图对象，不走 Card/Action 签名（spec §3.5）。
export function registerMeRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, fail, requirePerson, companyMemory, voiceprints, materialMultipartLimitError } = ctx;

  const respondTask = (reply: FastifyReply, result: TaskMutation): TTaskView | FastifyReply => {
    if ("notFound" in result) return fail(reply, 404, "TASK_NOT_FOUND", "执行事项不存在");
    if ("conflict" in result) return fail(reply, 409, "VERSION_CONFLICT", "执行事项已被修改，请基于最新内容重试", { latestTask: result.conflict });
    return result.task;
  };

  app.get("/api/me/home", { preHandler: requirePerson, schema: { response: { 200: MeHomeResponse } } }, async (req) => {
    const [myTasks, { work }] = await Promise.all([
      listMyTasks(q, req.person!.personId),
      readMemberWork(q, companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, ctx.now()),
    ]);
    return { myTasks, work };
  });

  app.get("/api/me/battlefields/:id", { preHandler: requirePerson, schema: { params: idParams, response: { 200: MemberBattlefieldResponse } } }, async (req, reply) => {
    const detail = await readMemberBattlefield(q, companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.id, ctx.now());
    return detail ?? fail(reply, 404, "BATTLEFIELD_NOT_FOUND", "战场不存在");
  });

  app.patch(
    "/api/me/tasks/:id",
    { preHandler: requirePerson, schema: { params: idParams, body: PatchMyTaskRequest } },
    async (req, reply) => respondTask(reply, await updateMyTaskStatus(pool, req.person!.personId, req.params.id, req.body)),
  );

  app.post(
    "/api/me/tasks/:id/return",
    { preHandler: requirePerson, schema: { params: idParams, body: ReturnMyTaskRequest } },
    async (req, reply) => respondTask(reply, await returnMyTask(pool, req.person!.personId, req.params.id, req.body)),
  );

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
