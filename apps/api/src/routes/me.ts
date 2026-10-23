import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { AcceptMyTaskRequest, AddTaskCollaboratorsRequest, AppendTaskProgressRequest, Card, CreateMyTaskRequest, CreatePersonalTokenRequest, CreatePersonalTokenResponse, ListPersonalTokensResponse, MarkNotificationsSeenRequest, MeHomeResponse, MemberBattlefieldResponse, MemberMeetingsResponse, MonthPlanResponse, PatchMyTaskRequest, PutMyTaskNoteRequest, ReopenMyTaskRequest, ReturnMyTaskRequest, SaveMonthPlanRequest, TaskAcceptanceDraft, TaskDetailResponse, TaskProgressEntry, UnreadThreadsResponse, DictationSessionResponse, DictationPolishRequest, DictationPolishResponse, HomePlanResponse, HomePlanMark, BattlefieldProgressResponse, CreatePlanMarkRequest, PatchPlanMarkRequest, type TDictationResult, type TTaskView, type TVoiceprintStatus } from "@warmap/contracts";
import { listMyNotifications, markNotificationsSeen } from "../notifications.js";
import { acceptMyTask, addTaskCollaborators, clearMyTaskSubmission, createMyTask, deleteMyTask, getTaskDetail, listMyTasks, putMyTaskNote, reopenMyTask, returnMyTask, updateMyTaskStatus, type TaskResult } from "../tasks.js";
import { draftTaskAcceptance } from "../taskAcceptanceDraft.js";
import { readMonthPlan, saveMonthPlan } from "../monthPlan.js";
import { readHomePlan } from "../homePlan.js";
import { readBattlefieldProgress } from "../battlefieldProgress.js";
import { createPlanMark, deletePlanMark, patchPlanMark, type PlanMarkError } from "../planMarks.js";
import { companyPeriod } from "../monthlyPlans.js";
import { personDisplayNames } from "../people.js";
import { canUseMemberView } from "../memberAccess.js";
import { deleteVoiceprint, enrollVoiceprint, MAX_VOICEPRINT_UPLOAD_BYTES, voiceprintStatus } from "../voiceprints.js";
import { dictate, MAX_DICTATION_UPLOAD_BYTES } from "../dictation.js";
import { createSessionRateLimiter, issueRealtimeSession } from "../tencentAsrRealtime.js";
import { MAX_POLISH_TEXT_CHARS, polishDictation } from "../dictationPolish.js";
import { idParams, type AppInstance, type Guard, type RouteContext } from "./shared.js";
import { readMemberWork } from "../memberWork.js";
import { readMemberBattlefield } from "../memberBattlefields.js";
import { readMemberRadarBrief } from "../personalSignals.js";
import { readWeeklySyncReminder } from "../weeklySyncReminder.js";
import { appendTaskProgress } from "../taskProgress.js";
import { createPersonalToken, listPersonalTokens, revokePersonalToken } from "../personalTokens.js";
import { getIssueRow } from "../issues.js";
import { getMeetingRow } from "../meetingStore.js";
import { projectMemberIssueCard, projectMemberMeetingCard } from "../memberCards.js";
import { isActiveMember, unreadThreads } from "../threads.js";
import { AGENT_ROLES, anonUserId, randomTurnSuffix, stableThreadId, tracedTurn, withAgent } from "../tracing.js";

// 成员工作台：普通视图对象，不走 Card/Action 签名（spec §3.5）。
export function registerMeRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, fail, requirePerson, peopleDirectory, voiceprints, dictation, dictationRealtime, dictationPolish, materialMultipartLimitError } = ctx;
  // 实时听写签发的每人每分钟上限：每个 app 实例一份计数
  const realtimeSessionLimiter = createSessionRateLimiter();

  const names = () => personDisplayNames(peopleDirectory);
  const invitable = () => new Set(peopleDirectory.searchPeople(undefined).filter(canUseMemberView).map((person) => person.personId));
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  const respondTask = (reply: FastifyReply, result: TaskResult): TTaskView | FastifyReply => {
    if ("notFound" in result) return fail(reply, 404, "TASK_NOT_FOUND", "执行事项不存在");
    if ("conflict" in result) return fail(reply, 409, "VERSION_CONFLICT", "执行事项已被修改，请基于最新内容重试", { latestTask: result.conflict });
    if ("error" in result) return fail(reply, result.error.status, result.error.code, result.error.message);
    return result.task;
  };

  app.get("/api/me/home", { preHandler: requireMember, schema: { response: { 200: MeHomeResponse } } }, async (req) => {
    const [myTasks, { work }, radar, weeklySync] = await Promise.all([
      listMyTasks(q, req.person!.personId, names()),
      readMemberWork(q, peopleDirectory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, ctx.now()),
      readMemberRadarBrief(q, req.person!, ctx.now()),
      readWeeklySyncReminder(q, req.person!.personId, ctx.now()),
    ]);
    return { myTasks, work, radar, weeklySync };
  });
  app.get("/api/me/home-plan", { preHandler: requireMember, schema: { response: { 200: HomePlanResponse } } }, async (req) =>
    readHomePlan(q, req.person!, ctx.now(), { planTasks: ctx.planTasks, names: names() }));
  // 战场进展：可见范围在 battlefieldProgress.ts 判（同战场；没有战场时同业务域，只这一页）。
  app.get("/api/me/battlefield-progress", { preHandler: requireMember, schema: { response: { 200: BattlefieldProgressResponse } } }, async (req) =>
    readBattlefieldProgress(q, req.person!.personId, peopleDirectory.searchPeople(undefined), ctx.now()));
  // 计划点只存天枢本地，不写本体。
  const respondMark = <T extends object>(reply: FastifyReply, result: T | PlanMarkError): T | FastifyReply =>
    "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message) : result;
  app.post("/api/me/plan-marks", { preHandler: requireMember, schema: { body: CreatePlanMarkRequest, response: { 200: HomePlanMark } } }, async (req, reply) =>
    respondMark(reply, await createPlanMark(q, req.person!.personId, req.body)));
  app.patch("/api/me/plan-marks/:id", { preHandler: requireMember, schema: { params: idParams, body: PatchPlanMarkRequest, response: { 200: HomePlanMark } } }, async (req, reply) => {
    const result = await patchPlanMark(q, req.person!.personId, req.params.id, req.body);
    return result ? respondMark(reply, result) : fail(reply, 404, "MARK_NOT_FOUND", "计划点不存在");
  });
  app.delete("/api/me/plan-marks/:id", { preHandler: requireMember, schema: { params: idParams } }, async (req, reply) =>
    await deletePlanMark(q, req.person!.personId, req.params.id) ? reply.code(204).send() : fail(reply, 404, "MARK_NOT_FOUND", "计划点不存在"));

  app.get("/api/me/tokens", { preHandler: requirePerson, schema: { response: { 200: ListPersonalTokensResponse } } }, async (req) => ({
    tokens: await listPersonalTokens(q, req.person!.personId), mcpPath: "/mcp/me" as const, mcpUrl: `${ctx.env.publicOrigin.replace(/\/$/, "")}/mcp/me`,
  }));
  app.post("/api/me/tokens", { preHandler: requirePerson, schema: { body: CreatePersonalTokenRequest, response: { 200: CreatePersonalTokenResponse } } }, async (req, reply) => {
    if (!req.body.name.trim()) return fail(reply, 400, "INVALID_INPUT", "请填写令牌名称");
    const created = await createPersonalToken(pool, req.person!.personId, req.body, ctx.env.sessionSecret, ctx.now());
    reply.header("Cache-Control", "no-store");
    return created ?? fail(reply, 409, "TOKEN_LIMIT", "最多保留 5 个有效令牌");
  });
  app.delete("/api/me/tokens/:id", { preHandler: requirePerson, schema: { params: idParams } }, async (req, reply) =>
    await revokePersonalToken(q, req.person!.personId, req.params.id) ? reply.code(204).send() : fail(reply, 404, "TOKEN_NOT_FOUND", "令牌不存在"));

  app.get("/api/me/battlefields/:id", { preHandler: requireMember, schema: { params: idParams, response: { 200: MemberBattlefieldResponse } } }, async (req, reply) => {
    const detail = await readMemberBattlefield(q, peopleDirectory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.id, ctx.now());
    return detail ?? fail(reply, 404, "BATTLEFIELD_NOT_FOUND", "战场不存在");
  });

  app.patch(
    "/api/me/tasks/:id",
    { preHandler: requireMember, schema: { params: idParams, body: PatchMyTaskRequest } },
    async (req, reply) => respondTask(reply, await updateMyTaskStatus(pool, req.person!.personId, req.params.id, req.body, names(), ctx.now())),
  );

  app.post(
    "/api/me/tasks/:id/return",
    { preHandler: requireMember, schema: { params: idParams, body: ReturnMyTaskRequest } },
    async (req, reply) => respondTask(reply, await returnMyTask(pool, req.person!.personId, req.params.id, req.body, names())),
  );

  // 完成只能经推进人验收（design-12）；外部工具的提交走 MCP。
  app.post(
    "/api/me/tasks/:id/accept",
    { preHandler: requireMember, schema: { params: idParams, body: AcceptMyTaskRequest } },
    async (req, reply) => respondTask(reply, await acceptMyTask(pool, req.person!.personId, req.params.id, req.body, names(), ctx.now())),
  );
  app.post("/api/me/tasks/:id/acceptance-draft", { preHandler: requireMember, schema: { params: idParams, response: { 200: TaskAcceptanceDraft } } }, async (req, reply) => {
    const draft = await draftTaskAcceptance(pool, ctx.taskAcceptanceAgent, req.params.id, req.person!.personId, names());
    if (draft === "not_found") return fail(reply, 404, "TASK_NOT_FOUND", "执行事项不存在");
    if (draft === "closed") return fail(reply, 409, "TASK_NOT_ACCEPTABLE", "这件事已经完成或已退回");
    return draft ?? fail(reply, 503, "ACCEPTANCE_DRAFT_UNAVAILABLE", "我的 Agent 这次没起草出来，可以直接手填");
  });
  app.delete("/api/me/tasks/:id/submission", { preHandler: requireMember, schema: { params: idParams,
    querystring: Type.Object({ version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }) } }, async (req, reply) =>
    respondTask(reply, await clearMyTaskSubmission(pool, req.person!.personId, req.params.id, req.query.version, names())));
  app.post(
    "/api/me/tasks/:id/reopen",
    { preHandler: requireMember, schema: { params: idParams, body: ReopenMyTaskRequest } },
    async (req, reply) => respondTask(reply, await reopenMyTask(pool, req.person!.personId, req.params.id, req.body.version, names())),
  );

  app.get("/api/me/tasks/:id", { preHandler: requireMember, schema: { params: idParams, response: { 200: TaskDetailResponse } } }, async (req, reply) =>
    await getTaskDetail(q, req.params.id, req.person!.personId, names(), ctx.now(), invitable()) ?? fail(reply, 404, "TASK_NOT_FOUND", "执行事项不存在"));
  app.post("/api/me/tasks/:id/progress", { preHandler: requireMember, schema: { params: idParams, body: AppendTaskProgressRequest, response: { 200: TaskProgressEntry } } }, async (req, reply) => {
    if (!req.body.body.trim()) return fail(reply, 400, "INVALID_INPUT", "请填写进展正文");
    const saved = await appendTaskProgress(pool, req.params.id, req.person!.personId, "web", req.body, names());
    return "entry" in saved ? saved.entry : fail(reply, saved.error.status, saved.error.code, saved.error.message);
  });
  app.post("/api/me/tasks", { preHandler: requireMember, schema: { body: CreateMyTaskRequest } }, async (req, reply) =>
    respondTask(reply, await createMyTask(pool, req.person!.personId, names(), req.body, ctx.now())));
  app.delete("/api/me/tasks/:id", { preHandler: requireMember, schema: { params: idParams,
    querystring: Type.Object({ version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }) } }, async (req, reply) => {
    const result = await deleteMyTask(pool, req.person!.personId, req.params.id, req.query.version, names());
    return "deleted" in result ? reply.code(204).send() : respondTask(reply, result);
  });
  app.put("/api/me/tasks/:id/note", { preHandler: requireMember, schema: { params: idParams, body: PutMyTaskNoteRequest } }, async (req, reply) => {
    const result = await putMyTaskNote(pool, req.person!.personId, req.params.id, req.body.note);
    return "notFound" in result ? fail(reply, 404, "TASK_NOT_FOUND", "执行事项不存在") : result;
  });
  app.post("/api/me/tasks/:id/collaborators", { preHandler: requireMember,
    schema: { params: idParams, body: AddTaskCollaboratorsRequest } }, async (req, reply) =>
    respondTask(reply, await addTaskCollaborators(pool, req.person!.personId, req.params.id, names(), req.body, invitable(), { agent: ctx.threadIntroAgent, peopleDirectory })));
  const planQuery = Type.Object({ period: Type.Optional(Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" })) }, { additionalProperties: false });
  app.get("/api/me/plan", { preHandler: requireMember, schema: { querystring: planQuery, response: { 200: MonthPlanResponse } } }, async (req) =>
    readMonthPlan(q, req.person!.personId, req.query.period ?? companyPeriod(ctx.now()), names(), ctx.now()));
  app.put("/api/me/plan", { preHandler: requireMember, schema: { body: SaveMonthPlanRequest } }, async (req, reply) => {
    const result = await saveMonthPlan(pool, req.person!.personId, names(), req.body, ctx.now());
    return "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message,
      result.error.latestTask ? { latestTask: result.error.latestTask } : undefined) : result.plan;
  });

  app.get("/api/me/notifications", { preHandler: requireMember }, async (req) => ({
    notifications: await listMyNotifications(q, peopleDirectory, req.person!.personId),
  }));

  app.get("/api/me/threads/unread", { preHandler: requireMember, schema: { response: { 200: UnreadThreadsResponse } } }, async (req) =>
    unreadThreads(q, req.person!.personId));

  app.get("/api/me/meetings", { preHandler: requireMember, schema: { response: { 200: MemberMeetingsResponse } } }, async (req) => {
    const at = ctx.now();
    const rows = (await q(`SELECT m.id::text,m.title,m.scheduled_at,m.ends_at,m.ended_at,m.lead_dri_id FROM meetings m
      JOIN thread_members tm ON tm.object_type='meeting' AND tm.object_id=m.id::text
      WHERE tm.person_id=$1 AND tm.left_at IS NULL AND m.status='scheduled'
        AND ((m.ended_at IS NULL AND m.ends_at > $2) OR m.lead_dri_id=$1)
      ORDER BY m.scheduled_at,m.id`, [req.person!.personId, at])).rows;
    const displayNames = names();
    return { meetings: rows.map((row) => ({ meetingId: row.id, title: row.title,
      startsAt: row.scheduled_at.toISOString(), endsAt: row.ends_at?.toISOString() ?? null,
      followUp: row.ended_at !== null || row.ends_at.getTime() <= at.getTime(),
      hostName: displayNames.get(row.lead_dri_id) ?? row.lead_dri_id, href: `/me/meetings/${row.id}` })) };
  });

  app.get("/api/me/cards/issues/:id", { preHandler: requireMember, schema: { params: idParams, response: { 200: Card } } }, async (req, reply) => {
    if (!await isActiveMember(q, { objectType: "issue", objectId: req.params.id }, req.person!.personId))
      return fail(reply, 404, "CARD_NOT_FOUND", "议题不存在");
    const row = await getIssueRow(q, req.params.id);
    if (!row) return fail(reply, 404, "CARD_NOT_FOUND", "议题不存在");
    const location = row.location as { level: string; battlefieldId?: string; capabilityId?: string };
    const name = location.level === "battlefield" ? (await q("SELECT name FROM battlefield_config WHERE id=$1", [location.battlefieldId])).rows[0]?.name
      : location.level === "capability" ? (await q("SELECT name FROM capability_config WHERE id=$1", [location.capabilityId])).rows[0]?.name : null;
    return projectMemberIssueCard(row, ctx.env.sessionSecret, typeof name === "string" ? name : null);
  });

  app.get("/api/me/cards/meetings/:id", { preHandler: requireMember, schema: { params: idParams, response: { 200: Card } } }, async (req, reply) => {
    if (!await isActiveMember(q, { objectType: "meeting", objectId: req.params.id }, req.person!.personId))
      return fail(reply, 404, "CARD_NOT_FOUND", "会议不存在");
    const row = await getMeetingRow(q, req.params.id);
    if (!row) return fail(reply, 404, "CARD_NOT_FOUND", "会议不存在");
    return projectMemberMeetingCard(row, ctx.env.sessionSecret, req.person!.personId);
  });

  app.post(
    "/api/me/seen",
    { preHandler: requireMember, schema: { body: MarkNotificationsSeenRequest } },
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

  // 输入框语音转文字：CEO 与成员都能用，录音不落库（见 dictation.ts）。
  app.post(
    "/api/me/dictation",
    { preHandler: requirePerson, bodyLimit: MAX_DICTATION_UPLOAD_BYTES * 2 },
    async (req, reply): Promise<TDictationResult | FastifyReply> => {
      let audio: Buffer | null = null;
      try {
        for await (const part of req.parts({ limits: { fileSize: MAX_DICTATION_UPLOAD_BYTES, files: 1 } })) {
          if (part.type !== "file") continue;
          if (part.fieldname !== "audio") return fail(reply, 400, "DICTATION_AUDIO_REQUIRED", "录音必须放在 audio 字段里上传");
          audio = await part.toBuffer();
        }
      } catch (error) {
        const limited = materialMultipartLimitError(
          error,
          { status: 413, code: "DICTATION_AUDIO_TOO_LARGE", message: "这段录音超过 10 MB 了，分几次说吧" },
          { status: 400, code: "DICTATION_AUDIO_REQUIRED", message: "一次只能上传一段录音" },
          { status: 400, code: "DICTATION_AUDIO_REQUIRED", message: "录音上传中断了，请重试" },
        );
        if (limited) return fail(reply, limited.status, limited.code, limited.message);
        throw error;
      }
      const result = await dictate(dictation, audio);
      return result.ok ? { text: result.text } : fail(reply, result.status, result.code, result.message);
    },
  );

  // 实时听写：签一个 30 秒内有效的腾讯实时识别地址，浏览器直连腾讯。地址与签名不进日志（请求日志只记路径）。
  app.post(
    "/api/me/dictation/session",
    { preHandler: requirePerson, schema: { response: { 200: DictationSessionResponse } } },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const result = issueRealtimeSession(dictationRealtime, realtimeSessionLimiter, req.person!.personId);
      if (result.ok) return result.value;
      if (result.retryAfterSeconds) reply.header("retry-after", String(result.retryAfterSeconds));
      return fail(reply, result.status, result.code, result.message);
    },
  );

  // 听写后的轻度整理（mode：sentence 逐句 / full 整段含分点）：失败 / 超时 / 未配置都回原文（polished:false），不报错。
  app.post(
    "/api/me/dictation/polish",
    { preHandler: requirePerson, schema: { body: DictationPolishRequest, response: { 200: DictationPolishResponse } } },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (Array.from(req.body.text).length > MAX_POLISH_TEXT_CHARS) {
        return fail(reply, 413, "DICTATION_TEXT_TOO_LONG", `一次最多整理 ${MAX_POLISH_TEXT_CHARS} 字`);
      }
      const mode = req.body.mode ?? "sentence";
      const personId = req.person!.personId;
      // LangSmith：一次整理 = 一个 Turn（dict-<随机>），Thread = 这个人的听写整理会话；不需要整理的句子不调用模型，也不留轨迹。
      return tracedTurn({
        resolve: async () => ({
          agentRole: AGENT_ROLES.dictationPolish,
          logicalTurnId: `dict-${randomTurnSuffix()}`,
          attempt: 1,
          threadId: await stableThreadId(q, `dictation|${anonUserId(personId)}`),
          scope: "global",
          anonUserId: anonUserId(personId),
        }),
        outputs: (result) => ({ polished: result.polished }),
      }, () => withAgent(AGENT_ROLES.dictationPolish, () => polishDictation(dictationPolish, req.body.text, mode),
        { inputs: { mode, chars: Array.from(req.body.text).length }, outputs: (result) => ({ polished: result.polished }) }));
    },
  );

  app.delete("/api/me/voiceprint", { preHandler: requirePerson }, async (req, reply) => {
    const result = await deleteVoiceprint(q, voiceprints, req.person!.personId);
    return result.ok ? reply.code(204).send() : fail(reply, result.status, result.code, result.message);
  });
}
