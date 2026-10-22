import type { FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import type { TMeetingParticipant } from "@warmap/contracts";
import { feishuConnected } from "../feishu/oauth.js";
import { listPendingIssueSummaries } from "../issues.js";
import type { Viewer } from "../meetingCard.js";
import { listConfirmedMeetings, PayloadHashMismatchError, readConfirmedMeeting } from "../meetingCardRead.js";
import { meetingHasEnded } from "../meetingStore.js";
import { canUseMemberView, roleOf, type SessionRole } from "../memberAccess.js";
import { personDisplayNames } from "../people.js";
import { readHomeSnapshots } from "./cards.js";
import type { AppInstance, RouteContext } from "./shared.js";

const catalogQuery = Type.Object({
  query: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  participantId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const meetingParams = Type.Object({ meetingId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const windowQuery = Type.Object({ from: Type.Optional(Type.String()), to: Type.Optional(Type.String()) }, { additionalProperties: false });
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
    if (role === "ceo" ? roleOf(person) !== "ceo" : !canUseMemberView(person)) {
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

  // 首页卡片：和对话 read_anchor 的首页同一份（CEO 公司首页的 Card；成员我的工作台上本人的东西），不带 Action。
  app.get("/internal/home-cards", { onRequest }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const cards = await readHomeSnapshots(ctx, view);
    return { viewerRole: view.role, scene: view.role === "ceo" ? "公司首页" : "我的工作台", cards: cards.map((card) => ({ ...card, label: "页面" })) };
  });

  // 工具清单：只说本轮这个人、这个视角能不能用；说明和 Prompt 在 chat-core。代读逐字稿要本人连着飞书且授权里有妙记读权限。
  app.get("/internal/tools", { onRequest }, async (req, reply) => {
    const view = viewOf(req, reply);
    if (!view) return reply;
    const transcript = !env.feishu ? { available: false, reason: "FEISHU_UNAVAILABLE" }
      : await feishuConnected(q, env.feishu, view.personId, ctx.now()) ? { available: true } : { available: false, reason: "FEISHU_NOT_CONNECTED" };
    return {
      viewerRole: view.role,
      tools: [
        { name: "list_confirmed_meetings", available: true },
        { name: "read_confirmed_meeting", available: true },
        { name: "read_meeting_transcript", ...transcript },
        { name: "list_pending_issues", available: true },
        { name: "list_scheduled_meetings", available: true },
        { name: "read_home_cards", available: true },
      ],
    };
  });
}
