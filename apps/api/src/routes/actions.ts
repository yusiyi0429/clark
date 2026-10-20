import type { FastifyReply } from "fastify";
import { Value } from "@sinclair/typebox/value";
import {
  ConfirmTranscriptCandidateRequest,
  CreateMeetingRequest,
  DiscardTranscriptCandidateRequest,
  EditMeetingDetailsRequest,
  ExecuteActionRequest,
  JoinMeetingRequest,
  MissionEditInput,
  ReplaceTranscriptRequest,
  RequestSupplementRequest,
  SignMonthlyPlanRequest,
  UpdateMeetingDraftRequest,
  UpdateMonthlyPlanDraftRequest,
  type TCardCollection,
  type TUpdateMonthlyPlanDraftRequest,
} from "@warmap/contracts";
import { actionFingerprint, verifyActionId } from "../actionToken.js";
import { executeIssueAction } from "../issues.js";
import { executeCancelMeeting, executeCreateMeeting, executeEditMeetingDetails, executeEndMeeting, executeJoinMeeting, executeRequestSupplement, executeUpdateDraft } from "../meetings.js";
import { executeEditMaterials } from "../meetingMaterials.js";
import { executeRegeneratePreflight, executeRetryPreflight, executeRunPreflight } from "../meetingPreflight.js";
import { executeEditMission } from "../missions.js";
import { isRealPerson, personDisplayNames } from "../people.js";
import { executeRetryMonthlyPlanDraft, executeSignMonthlyPlan, executeUpdateMonthlyPlanDraft } from "../monthlyPlans.js";
import { startSignedMissionDrafts } from "../missionRounds.js";
import { executeReplaceTranscript, executeRetryOutcome } from "../outcome.js";
import { executeConfirmTranscriptCandidate, executeDiscardTranscriptCandidate } from "../transcriptCandidate.js";
import { getMeetingRow, type MeetingActionOutcome } from "../meetingStore.js";
import { projectMemberMeetingCardFromCard } from "../memberCards.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerActionRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, env, fail, requirePerson, requestContext, peopleDirectory, preflight, driExporter, outcome, monthlyPlanService, research, invalidInput, respond } = ctx;

  app.post(
    "/api/actions/execute",
    { preHandler: requirePerson, schema: { body: ExecuteActionRequest } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const scope = verifyActionId(env.sessionSecret, req.body.actionId);
      if (!scope) {
        return fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
      }
      if (req.person!.role !== "ceo") {
        if (!["meeting.end", "meeting.reschedule", "meeting.confirm_transcript_candidate", "meeting.discard_transcript_candidate"].includes(scope.actionType) || scope.objectType !== "meeting")
          return fail(reply, 403, "FORBIDDEN", "只有 CEO 可以访问");
        const meeting = await getMeetingRow(q, scope.objectId);
        if (!meeting || meeting.lead_dri_id !== req.person!.personId)
          return fail(reply, 404, "MEETING_NOT_FOUND", "Meeting 不存在");
      }
      requestContext.set(req, { actionType: scope.actionType, objectRef: `${scope.objectType}:${scope.objectId}` });
      const fingerprint = actionFingerprint(env.sessionSecret, req.body.actionId, req.body.input);
      const input = req.body.input;
      const hostId = req.person!.role === "ceo" ? undefined : req.person!.personId;
      const respondMeeting = (result: MeetingActionOutcome) => {
        if (hostId === undefined || "error" in result) return respond(reply, result);
        return respond(reply, "card" in result
          ? { ...result, card: projectMemberMeetingCardFromCard(result.card, hostId) }
          : { ...result, latestCard: projectMemberMeetingCardFromCard(result.latestCard, hostId) });
      };

      // Ticket 09：Issue 侧 Meeting Action 先于 Ticket 08 的通用 Issue Action 分派
      if (scope.actionType === "issue.create_meeting") {
        if (!Value.Check(CreateMeetingRequest, input)) return invalidInput(reply, CreateMeetingRequest, input);
        return respond(reply, await executeCreateMeeting(pool, peopleDirectory, preflight, env.sessionSecret, scope, input, fingerprint, ctx.threadIntroAgent));
      }
      if (scope.actionType === "issue.join_meeting") {
        if (!Value.Check(JoinMeetingRequest, input)) return invalidInput(reply, JoinMeetingRequest, input);
        return respond(reply, await executeJoinMeeting(pool, peopleDirectory, preflight, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "meeting.update_draft") {
        if (!Value.Check(UpdateMeetingDraftRequest, input)) return invalidInput(reply, UpdateMeetingDraftRequest, input);
        return respond(reply, await executeUpdateDraft(pool, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "meeting.edit_details") {
        if (!Value.Check(EditMeetingDetailsRequest, input)) return invalidInput(reply, EditMeetingDetailsRequest, input);
        return respond(reply, await executeEditMeetingDetails(pool, peopleDirectory, env.sessionSecret, scope, input, fingerprint, ctx.threadIntroAgent));
      }
      if (scope.actionType === "meeting.reschedule") {
        if (!Value.Check(EditMeetingDetailsRequest, input)) return invalidInput(reply, EditMeetingDetailsRequest, input);
        if (!input.scheduledAt || Object.keys(input).some((key) => key !== "scheduledAt" && key !== "endsAt"))
          return fail(reply, 400, "INVALID_INPUT", "重新安排只接受开始和结束时间，且必须填写开始时间");
        return respondMeeting(await executeEditMeetingDetails(pool, peopleDirectory, env.sessionSecret, scope, input, fingerprint, undefined, { hostId, futureOnly: true, now: ctx.now() }));
      }
      if (scope.actionType === "meeting.request_supplement") {
        if (!Value.Check(RequestSupplementRequest, input)) return invalidInput(reply, RequestSupplementRequest, input);
        return respond(reply, await executeRequestSupplement(pool, peopleDirectory, driExporter, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "meeting.edit_materials") {
        return respond(reply, await executeEditMaterials(pool, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.run_preflight") {
        return respond(reply, await executeRunPreflight(pool, peopleDirectory, preflight, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.cancel") {
        return respond(reply, await executeCancelMeeting(pool, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.end") {
        const result = await executeEndMeeting(pool, env.sessionSecret, scope, fingerprint, hostId);
        if (req.person!.role === "ceo" || "error" in result) return respond(reply, result);
        const viewerId = req.person!.personId;
        return respond(reply, "card" in result
          ? { ...result, card: projectMemberMeetingCardFromCard(result.card, viewerId) }
          : { ...result, latestCard: projectMemberMeetingCardFromCard(result.latestCard, viewerId) });
      }
      if (scope.actionType === "meeting.retry_preflight") {
        return respond(reply, await executeRetryPreflight(pool, peopleDirectory, preflight, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.regenerate_preflight") {
        return respond(reply, await executeRegeneratePreflight(pool, peopleDirectory, preflight, env.sessionSecret, scope, fingerprint));
      }
      // Ticket 10：Transcript 替换是危险 Action，要求二次确认
      if (scope.actionType === "meeting.replace_transcript") {
        if (!Value.Check(ReplaceTranscriptRequest, input)) return invalidInput(reply, ReplaceTranscriptRequest, input);
        return respond(reply, await executeReplaceTranscript(pool, outcome, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "meeting.retry_outcome") {
        return respond(reply, await executeRetryOutcome(pool, outcome, env.sessionSecret, scope, fingerprint));
      }
      // Ticket 27：妙记 Markdown 候选确认/清除；speakerMappings 是确认 Action 的全部输入
      if (scope.actionType === "meeting.confirm_transcript_candidate") {
        if (!Value.Check(ConfirmTranscriptCandidateRequest, input)) return invalidInput(reply, ConfirmTranscriptCandidateRequest, input);
        return respondMeeting(await executeConfirmTranscriptCandidate(pool, peopleDirectory, outcome, env.sessionSecret, scope, input, fingerprint, hostId));
      }
      if (scope.actionType === "meeting.discard_transcript_candidate") {
        const discardInput = input ?? {};
        if (!Value.Check(DiscardTranscriptCandidateRequest, discardInput)) return invalidInput(reply, DiscardTranscriptCandidateRequest, discardInput);
        return respondMeeting(await executeDiscardTranscriptCandidate(pool, env.sessionSecret, scope, fingerprint, hostId));
      }
      // 会后逐条确认 / 忽略 / 撤回已停（会后只有会议卡一个入口）：旧的签名动作落到下面的 UNKNOWN_ACTION。

      if (scope.actionType === "monthly-plan.update_draft") {
        const monthlyInput = input ?? {};
        if (!Value.Check(UpdateMonthlyPlanDraftRequest, monthlyInput)) {
          return invalidInput(reply, UpdateMonthlyPlanDraftRequest, monthlyInput);
        }
        return respond(reply, await executeUpdateMonthlyPlanDraft(pool, peopleDirectory, env.sessionSecret, scope, monthlyInput as TUpdateMonthlyPlanDraftRequest, fingerprint));
      }
      if (scope.actionType === "monthly-plan.retry_draft") {
        const result = await executeRetryMonthlyPlanDraft(pool, env.sessionSecret, scope, fingerprint);
        // 重跑已进入 running：提交后异步执行，不阻塞返回
        if ("startDraft" in result && result.startDraft) {
          const { planId, runId } = result.startDraft;
          monthlyPlanService?.executeRun(planId, runId).catch((err) => console.error("monthly draft run failed", err));
        }
        return respond(reply, result);
      }
      if (scope.actionType === "monthly-plan.sign") {
        const signInput = input ?? {};
        if (!Value.Check(SignMonthlyPlanRequest, signInput)) return invalidInput(reply, SignMonthlyPlanRequest, signInput);
        const result = await executeSignMonthlyPlan(pool, peopleDirectory, env.sessionSecret, scope, fingerprint);
        // 签发已提交：由系统为各战场参与者起草任务卡；重放不再启动，已有轮次的战场跳过。起草没能开始也不影响签发结果。
        if ("card" in result && !result.replayed) await startSignedMissionDrafts(pool, peopleDirectory.searchPeople(undefined), (result.card.payload as { period: string }).period,
          ctx.now, ctx.missionCardDraftAgent, ctx.company, env.missionCardKnownMissionsFile).catch((error) => console.error("mission card drafts did not start", error));
        // 签发即代 CEO 确认本体同周期的周期目标；后台发送，不影响签发结果。
        if ("card" in result && !result.replayed) ctx.worldPeriodGoals?.schedule();
        return respond(reply, result);
      }

      if (scope.actionType === "mission.edit") {
        if (!Value.Check(MissionEditInput, input)) return invalidInput(reply, MissionEditInput, input);
        return respond(reply, await executeEditMission(pool, env.sessionSecret, personDisplayNames(peopleDirectory), scope, input, fingerprint, req.person!));
      }

      if (scope.objectType === "issue") {
        // 指派主责只能指给公司名单里的真人；操作人的显示名也从同一份名单取。
        const people = scope.actionType === "issue.assign"
          ? { actorId: req.person!.personId, people: new Map(peopleDirectory.searchPeople(undefined)
            .filter((person) => isRealPerson(person) || person.personId === req.person!.personId).map((person) => [person.personId, person.displayName])) }
          : undefined;
        const result = await executeIssueAction(pool, env.sessionSecret, scope, fingerprint, req.body.input, people);
        if (!result.ok) {
          return fail(reply, result.status, result.code, result.message, result.latestCard ? { latestCard: result.latestCard } : undefined);
        }
        // 重跑已进入 running：提交后异步执行，不阻塞返回
        if (result.startResearch) {
          research.executeRun(result.startResearch.issueId, result.startResearch.runId)
            .catch((err) => console.error("research run failed", err));
        }
        return { cards: [result.card] };
      }
      return fail(reply, 404, "UNKNOWN_ACTION", "未注册的 actionType");
    },
  );
}
