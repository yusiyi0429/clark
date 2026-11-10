import type { FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import type { TMeetingParticipant } from "@warmap/contracts";
import { readBuddy } from "../buddy.js";
import { buddyPersona } from "../buddyPersona.js";
import { ChatServiceError } from "../chatService.js";
import { afterIssueDraftCreated, ChatDecideIssueBody, ChatProposeIssueBody, decideChatIssueDraft, proposeChatIssueDraft } from "../issueDrafts.js";
import { listPendingIssueSummaries } from "../issues.js";
import { logEvent } from "../observability.js";
import type { Viewer } from "../meetingCard.js";
import { listConfirmedMeetings, PayloadHashMismatchError, readConfirmedMeeting } from "../meetingCardRead.js";
import { DraftMeetingParams, draftMeeting, draftTimeLabel, type DraftMeetingArgs } from "../meetingDraft.js";
import { meetingHasEnded } from "../meetingStore.js";
import { canEnterMemberView, roleOf, type SessionRole } from "../memberAccess.js";
import { MISSION_PLAN_TIMEOUT_MS, readMissionPlans, type MissionPlanWorld, type MissionPlanWorldOff } from "../missionPlanRead.js";
import { companyPeriod } from "../monthlyPlans.js";
import { isRealPerson, personDisplayNames } from "../people.js";
import { WorldClient, worldConfigured } from "../worldClient.js";
import { planTaskViewer } from "../planTaskAccess.js";
import { checkTask, openPlanTask } from "../taskAgreements.js";
import { DeliverableError } from "../taskDeliverables.js";
import { readHomeSnapshots } from "./cards.js";
import type { AppInstance, RouteContext } from "./shared.js";

const catalogQuery = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 200 })),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  participantId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const meetingParams = Type.Object({ meetingId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const windowQuery = Type.Object({ from: Type.Optional(Type.String()), to: Type.Optional(Type.String()) }, { additionalProperties: false });
const catalogOfQuery = Type.Object({ conversationId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) }, { additionalProperties: false });
const recallSearchQuery = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  from: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  to: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, { additionalProperties: false });
const segmentParams = Type.Object({ segmentId: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
const recallReadQuery = Type.Object({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 24 })) }, { additionalProperties: false });
const planTaskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const DAY_MS = 24 * 60 * 60 * 1000;

type View = { personId: string; role: SessionRole };
type ScheduledRow = { id: string; title: string; scheduled_at: Date; ends_at: Date; ended_at: Date | null; lead_dri_id: string;
  participants: TMeetingParticipant[]; issue_ids: string[]; has_transcript: boolean };

/**
 * 给独立 Chat 的宿主只读接口（拍板 12；10/22 与人豪定稿）：Authorization: Bearer <INTERNAL_CHAT_TOKEN> 加可信用户 X-Owner-Id（personId）
 * 和本轮视角 X-Viewer-Role（ceo | member，必填）。视角按人员目录核对：ceo 要本人是 CEO，member 要本人有成员工作台。
 * 没配 INTERNAL_CHAT_TOKEN 时不注册（一律 404）；凭据不对 401；没带视角 400 VIEW_REQUIRED；本人用不了这个视角 403 VIEW_NOT_ALLOWED；
 * X-Owner-Id 不在人员目录：会议接口 404 MEETING_NOT_FOUND（已对接的错误码不变），其余 404 OWNER_NOT_FOUND。
 * 都不带签名的 Action。/:meetingId/transcript 用提问人本人的飞书授权读妙记全文（Chat 不拿飞书凭据）。
 * 不走浏览器会话；不在公开 OpenAPI 里（契约包的 OpenAPI 文档按路径手列）。
 */
export function registerInternalMeetingRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requireServiceToken, peopleDirectory } = ctx;
  if (!env.internalChatToken) return;
  const onRequest = requireServiceToken(env.internalChatToken);
  /** 核对本轮视角；不合格时已回错误，返回 null。 */
  const viewOf = (req: FastifyRequest, reply: FastifyReply, ownerMissing = { code: "OWNER_NOT_FOUND", message: "提问人不在人员目录" }): View | null => {
    const role = req.headers["x-viewer-role"];
    if (role !== "ceo" && role !== "member") {
      fail(reply, 400, "VIEW_REQUIRED", "X-Viewer-Role 要是 ceo 或 member");
      return null;
    }
    const id = req.headers["x-owner-id"];
    const person = typeof id === "string" ? peopleDirectory.searchPeople(undefined).find((item) => item.personId === id) : undefined;
    if (!person) {
      fail(reply, 404, ownerMissing.code, ownerMissing.message);
      return null;
    }
    if (role === "ceo" ? roleOf(person) !== "ceo" : !canEnterMemberView(person)) {
      fail(reply, 403, "VIEW_NOT_ALLOWED", "本人用不了这个视角");
      return null;
    }
    return { personId: person.personId, role };
  };
  const meetingNotFound = { code: "MEETING_NOT_FOUND", message: "会议不存在" };
  const notFound = (reply: FastifyReply) => fail(reply, 404, meetingNotFound.code, meetingNotFound.message);
  const meetingViewer = (view: View): Viewer => ({ personId: view.personId, isCeo: view.role === "ceo" });
  /** 成员视角的对象页在 /me 下。 */
  const hrefOf = (view: View, path: string) => `${view.role === "ceo" ? "" : "/me"}${path}`;

  app.get("/internal/confirmed-meetings", { onRequest, schema: { querystring: catalogQuery } }, async (req, reply) => {
    const view = viewOf(req, reply, meetingNotFound);
    if (!view) return reply;
    const { from, to } = req.query;
    if ([from, to].some((value) => value !== undefined && Number.isNaN(Date.parse(value)))) return fail(reply, 400, "INVALID_INPUT", "from / to 要是 ISO 时间");
    return { meetings: await listConfirmedMeetings(q, meetingViewer(view), req.query) };
  });

  app.get("/internal/confirmed-meetings/:meetingId", { onRequest, schema: { params: meetingParams } }, async (req, reply) => {
    const view = viewOf(req, reply, meetingNotFound);
    if (!view) return reply;
    try {
      return await readConfirmedMeeting(q, meetingViewer(view), req.params.meetingId) ?? notFound(reply);
    } catch (error) {
      if (error instanceof PayloadHashMismatchError) return fail(reply, 500, error.code, "会议确认版正文和摘要值对不上");
      throw error;
    }
  });

  // 逐字稿全文：只读有确认版的会，用提问人本人的飞书授权现读妙记（meetingMinutes.transcriptFor），读不到不退回天枢存的。
  app.get("/internal/confirmed-meetings/:meetingId/transcript", { onRequest, schema: { params: meetingParams } }, async (req, reply) => {
    const view = viewOf(req, reply, meetingNotFound);
    if (!view) return reply;
    try {
      if ((await readConfirmedMeeting(q, meetingViewer(view), req.params.meetingId))?.status !== "confirmed") return notFound(reply);
    } catch (error) {
      if (error instanceof PayloadHashMismatchError) return fail(reply, 500, error.code, "会议确认版正文和摘要值对不上");
      throw error;
    }
    const result = await app.meetingFollowThrough.minutes.transcriptFor(req.params.meetingId, view.personId);
    return "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  // 待决议题：CEO 视角全部，成员视角只列本人在议题群里的。
  app.get("/internal/pending-issues", { onRequest }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const issues = await listPendingIssueSummaries(q, view.role === "ceo" ? undefined : view.personId);
    return { viewerRole: view.role, issues: issues.map(({ id, ...issue }) => ({ issueId: id, label: "待决", ...issue, href: hrefOf(view, `/issues/${id}`) })) };
  });

  // 首页对话转议题（11/02，Chat 的 propose_issue 调这里）：拦法和天枢自己的首页对话一样（issueDrafts.ts），explicit=本人明说要转，不看轮数。
  // 只有 CEO 视角；建议卡不写进 Chat，天枢读首页历史时补在这一轮回答末尾。
  app.post("/internal/issue-drafts", { onRequest, schema: { body: ChatProposeIssueBody } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    if (view.role !== "ceo") return fail(reply, 403, "VIEW_NOT_ALLOWED", "只有一号位视角能转议题");
    return proposeChatIssueDraft(q, view.personId, req.body, ctx.now());
  });

  // 一号位打字或说话确认 / 不用（11/02，Chat 的 decide_issue_draft 调这里）：处理这段 Chat 对话里最近的那条建议，和卡上点的同一条路；
  // 接受后卡自己画成「已转到议题」。错误码同网页的接受 / 不用；相关那段从 Chat 读不到时按 Chat 的错误回。
  app.post("/internal/issue-drafts/decide", { onRequest, schema: { body: ChatDecideIssueBody } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    if (view.role !== "ceo") return fail(reply, 403, "VIEW_NOT_ALLOWED", "只有一号位视角能转议题");
    let result: Awaited<ReturnType<typeof decideChatIssueDraft>>;
    try {
      result = await decideChatIssueDraft(ctx.pool, env.sessionSecret, view.personId, req.body, ctx.now(), ctx.chat);
    } catch (error) {
      if (error instanceof ChatServiceError) return fail(reply, error.status, error.code, error.message);
      throw error;
    }
    if ("error" in result) return fail(reply, result.error.status, result.error.code, result.error.message);
    if (result.decision !== "accepted") return result;
    const { created, ...answer } = result;
    if (created) await afterIssueDraftCreated(ctx.pool, ctx.research, { personId: view.personId, displayName: personDisplayNames(peopleDirectory).get(view.personId) ?? view.personId }, created);
    return answer;
  });

  // 预约会议：本人在会里、还没整卡确认的会（整卡确认过的走 /internal/confirmed-meetings）；按预约开始时间落在窗口里，默认前 7 天到后 30 天，最多 90 天。
  app.get("/internal/scheduled-meetings", { onRequest, schema: { querystring: windowQuery } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const now = ctx.now();
    const from = req.query.from === undefined ? now.getTime() - 7 * DAY_MS : Date.parse(req.query.from);
    const to = req.query.to === undefined ? now.getTime() + 30 * DAY_MS : Date.parse(req.query.to);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from || to - from > 90 * DAY_MS) {
      return fail(reply, 400, "INVALID_INPUT", "from / to 要是 ISO 时间，窗口不超过 90 天");
    }
    const rows = (await q(
      `SELECT m.id, m.title, m.scheduled_at, m.ends_at, m.ended_at, m.lead_dri_id, m.participants, m.issue_ids, m.transcript IS NOT NULL AS has_transcript
         FROM meetings m
         JOIN thread_members tm ON tm.object_type = 'meeting' AND tm.object_id = m.id::text AND tm.person_id = $1 AND tm.left_at IS NULL
        WHERE m.status IN ('scheduled', 'held') AND m.scheduled_at BETWEEN $2 AND $3
          AND NOT EXISTS (SELECT 1 FROM meeting_cards k WHERE k.meeting_id = m.id AND k.current_revision IS NOT NULL)
        ORDER BY m.scheduled_at, m.id`,
      [view.personId, new Date(from), new Date(to)],
    )).rows as ScheduledRow[];
    const names = personDisplayNames(peopleDirectory);
    const person = (personId: string) => ({ personId, name: names.get(personId) ?? personId });
    return {
      viewerRole: view.role,
      meetings: rows.map((row) => ({
        meetingId: row.id, title: row.title, label: "预约",
        stage: row.has_transcript ? "awaiting_confirm"
          : now < row.scheduled_at ? "upcoming"
          : !meetingHasEnded(row, now) ? "in_progress" : "awaiting_record",
        startsAt: row.scheduled_at.toISOString(), endsAt: row.ends_at.toISOString(), endedAt: row.ended_at?.toISOString() ?? null,
        host: person(row.lead_dri_id), participants: row.participants.map((item) => person(item.personId)),
        issueIds: row.issue_ids, href: hrefOf(view, `/meetings/${row.id}`),
      })),
    };
  });

  // 伙伴：名字、性格和接在角色提示后面的人设（和天枢本地对话同一段，buddyPersona.ts）；没选伙伴时是 null。
  app.get("/internal/buddy", { onRequest }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    reply.header("Cache-Control", "no-store");
    const buddy = await readBuddy(q, view.personId);
    if (!buddy) return null;
    const owner = view.role === "ceo" ? null : personDisplayNames(peopleDirectory).get(view.personId) ?? view.personId;
    return { name: buddy.name, personality: buddy.personality, persona: buddyPersona(buddy, owner) };
  });

  // 首页卡片：和对话 read_anchor 的首页同一份（CEO 公司首页的 Card；成员我的工作台上本人的东西），不带 Action。
  app.get("/internal/home-cards", { onRequest }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const cards = await readHomeSnapshots(ctx, view);
    // 首页分段开着时多给一张「以前的对话」（第一版回看：Chat 还没接会话目录和两个工具，借首页卡交给模型）；读不到不影响首页卡。
    const past = env.chatSessionRotation === true ? await ctx.conversationRecall.homeCard(view).catch((error: unknown) => {
      logEvent({ event: "conversation.catalog_card_unavailable", error: (error as Error)?.message });
      return null;
    }) : null;
    return { viewerRole: view.role, scene: view.role === "ceo" ? "公司首页" : "我的工作台",
      cards: [...cards.map((card) => ({ ...card, label: "页面" })), ...(past ? [{ ...past, label: "以前的对话" }] : [])] };
  });

  // 回看以前的对话（10/28，conversationRecall.ts；字段见 docs/guides/chat-conversation-recall.md）：首页每轮的会话目录和两个回看工具转调这三个接口。
  // 只看本人的；首页的段按视角隔离，天枢页面的段两种视角都能查；隐藏了的段查不到。
  app.get("/internal/conversation-catalog", { onRequest, schema: { querystring: catalogOfQuery } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const catalog = await ctx.conversationRecall.homeCatalog(view, req.query.conversationId);
    return { viewerRole: view.role, previous: catalog?.previous ?? null, recent: catalog?.recent ?? [] };
  });
  app.get("/internal/conversation-recall/search", { onRequest, schema: { querystring: recallSearchQuery } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const result = await ctx.conversationRecall.search(view, req.query) as { error?: string; message?: string };
    return result.error ? fail(reply, 400, "INVALID_INPUT", result.message ?? "参数不对") : { viewerRole: view.role, ...result };
  });
  app.get("/internal/conversation-recall/:segmentId", { onRequest, schema: { params: segmentParams, querystring: recallReadQuery } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const result = await ctx.conversationRecall.read(view, { segmentId: req.params.segmentId, cursor: req.query.cursor }) as { error?: string; message?: string };
    if (result.error === "SEGMENT_NOT_FOUND") return fail(reply, 404, result.error, result.message ?? "没有这一段");
    return result.error ? fail(reply, 400, "INVALID_INPUT", result.message ?? "参数不对") : { viewerRole: view.role, ...result };
  });

  // 本人本月 Mission 的本体计划（10/23 诊断方案二）：两种视角都是本人的；本体配了、实例也开了读才读（只读，每次请求 2.5 秒、整次 5 秒），否则 plan 为 null。
  const planWorld: MissionPlanWorld | MissionPlanWorldOff = ctx.world?.enabled
    ? new WorldClient(q, env, undefined, { timeoutMs: MISSION_PLAN_TIMEOUT_MS })
    : worldConfigured(env) ? "world_reads_off" : "world_not_configured";
  app.get("/internal/mission-plans", { onRequest }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const period = companyPeriod(ctx.now());
    return { viewerRole: view.role, period, missions: await readMissionPlans(q, view.personId, period, planWorld) };
  });

  // 约定与对表（V1 设计第 6、10 节）：给伙伴只读，和网页 GET /api/plan-tasks/:taskId/agreement、/check 同一份，看得到的人也一样
  // （负责人、Mission 负责人、战场负责人、CEO、约定里的认可人；CEO 按人员目录认，不看视角）。看不到的当找不到（404 NOT_FOUND）。
  const openTask = async (reply: FastifyReply, view: View, taskId: string) => {
    try {
      return await openPlanTask(q, ctx.planTasks, planTaskViewer(peopleDirectory, view.personId), ctx.now(), taskId, personDisplayNames(peopleDirectory));
    } catch (error) {
      if (error instanceof DeliverableError) { fail(reply, error.status, error.code, error.message); return null; }
      throw error;
    }
  };
  app.get("/internal/plan-tasks/:taskId/agreement", { onRequest, schema: { params: planTaskParams } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const opened = await openTask(reply, view, req.params.taskId);
    return opened ? opened.agreement : reply;
  });
  app.get("/internal/plan-tasks/:taskId/check", { onRequest, schema: { params: planTaskParams } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const opened = await openTask(reply, view, req.params.taskId);
    return opened ? checkTask(q, opened.access, opened.agreement, ctx.now()) : reply;
  });

  // 首页对话里约会议（10/28 与人豪定：Chat 的 book_meeting 工具调这里）：把本人一句话里的时间、人名换成一张会议卡，只读不写库；
  // 本人在卡上点「约好」才建会（同天枢自己对话里的 draft_meeting）。认不出时 drafted=false 带原因，由 Chat 追问后再调。
  app.post("/internal/meeting-drafts", { onRequest, schema: { body: DraftMeetingParams } }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const people = peopleDirectory.searchPeople(undefined).filter(isRealPerson).map(({ personId, displayName }) => ({ personId, displayName }));
    const result = await draftMeeting({ q, viewer: view, people, now: ctx.now() }, req.body as DraftMeetingArgs);
    if ("reason" in result) return { drafted: false, reason: result.reason };
    const { card } = result;
    const summary = { title: card.title, time: draftTimeLabel(new Date(card.scheduledAt), new Date(card.endsAt)),
      host: card.host?.displayName ?? null, participants: card.participants.map((person) => person.displayName),
      unresolved: card.unresolved, anchor: card.anchor?.title ?? null, ...(result.hostNote ? { hostNote: result.hostNote } : {}) };
    return { drafted: true, card, summary };
  });
}
