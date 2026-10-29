import { Type } from "@sinclair/typebox";
import {
  AttachFeishuMinuteRequest, FeishuCalendarEventsResponse, FeishuMinuteInboxResponse, FeishuMinuteMeetingResponse, ImpactAskRequest, ImpactAskResponse, ImpactCardResponse, ImpactIrrelevantRequest, MeetingBookingRequest, MeetingCardConfirmRequest, MeetingCardOwnerRequest, MeetingCardReviewRequest, MeetingCardReviewResponse, MeetingCardView,
  MeetingCardWorldChoiceRequest, MeetingDraftStatusResponse,
  MeetingWorldAnchorOptionsResponse, MeetingWorldAnchorsRequest, MeetingWorldResponse, MyMeetingCardsResponse, OrganizeFeishuMinuteRequest,
} from "@warmap/contracts";
import { askImpactCard, markImpactCardIrrelevant, readImpactCardByRequest } from "../impactCards.js";
import type { MeetingFollowThrough } from "../meetingFollowThrough.js";
import { bookMeeting, meetingFromDraft } from "../meetings.js";
import { projectMemberMeetingCardFromCard } from "../memberCards.js";
import { personDisplayNames } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";

const idParams = Type.Object({ id: Type.String() });
const tokenParams = Type.Object({ token: Type.String({ minLength: 1, maxLength: 200 }) });

/** 会后：会议卡（待确认清单、读、存草稿、整卡确认）、挂点与会议记录状态、已推影响卡（读、追问、和我无关）。 */
export function registerMeetingFollowThroughRoutes(app: AppInstance, ctx: RouteContext, followThrough: MeetingFollowThrough): void {
  // 通知栏：等我确认的决策和行动项（一条一条），和我主持或创建的会里写入失败的会议记录（一场会一条）。
  app.get("/api/me/meeting-cards", { preHandler: ctx.requirePerson, schema: { response: { 200: MyMeetingCardsResponse } } },
    async (req) => followThrough.cards.pendingFor(req.person!.personId));

  // 飞书里直接开的会待整理：只认本人（列表只有本人名下的，别人的妙记一律 404）。
  app.get("/api/me/feishu-minutes", { preHandler: ctx.requirePerson, schema: { response: { 200: FeishuMinuteInboxResponse } } },
    async (req) => ({ minutes: await followThrough.minuteInbox.listFor(req.person!.personId) }));

  // 本人飞书日历里接下来 7 天的日程：只读，和「会议安排」排在一起（天枢约的会不重复列）。
  app.get("/api/me/feishu-events", { preHandler: ctx.requirePerson, schema: { response: { 200: FeishuCalendarEventsResponse } } },
    async (req) => ({ events: await followThrough.calendarFeed.listFor(req.person!.personId) }));

  // 整理：建一场已开完的会，后台用所有者本人的授权读妙记；不约飞书日程。
  app.post("/api/me/feishu-minutes/:token/organize", {
    preHandler: ctx.requirePerson, schema: { params: tokenParams, body: OrganizeFeishuMinuteRequest, response: { 200: FeishuMinuteMeetingResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "feishu_minute.organize", objectRef: `feishu_minute:${req.params.token}` });
    const result = await followThrough.minuteInbox.organize(req.person!.personId, req.params.token, req.body);
    if ("error" in result) {
      return ctx.fail(reply, result.error.status, result.error.code, result.error.message, result.error.fieldErrors ? { fieldErrors: result.error.fieldErrors } : undefined);
    }
    return result;
  });

  // 记到：记到建议的那场天枢里约好的会，后台用所有者本人的授权读妙记。
  app.post("/api/me/feishu-minutes/:token/attach", {
    preHandler: ctx.requirePerson, schema: { params: tokenParams, body: AttachFeishuMinuteRequest, response: { 200: FeishuMinuteMeetingResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "feishu_minute.attach", objectRef: `feishu_minute:${req.params.token}` });
    const result = await followThrough.minuteInbox.attach(req.person!.personId, req.params.token, req.body.meetingId);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  app.post("/api/me/feishu-minutes/:token/ignore", { preHandler: ctx.requirePerson, schema: { params: tokenParams } }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "feishu_minute.ignore", objectRef: `feishu_minute:${req.params.token}` });
    const result = await followThrough.minuteInbox.ignore(req.person!.personId, req.params.token);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : reply.code(204).send();
  });

  // 会议入本体：会议页单独取挂点、会议记录状态和每条决定的落点（不进会议卡，读会议保持轻）。
  app.get("/api/meetings/:id/world", { preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: MeetingWorldResponse } } }, async (req, reply) => {
    const result = await followThrough.decisions.worldView(req.params.id, req.person!.personId);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  // 会议卡：主持人、创建人、CEO、实际参会人能读（读时目标变过就刷新差异）；只有主持人或创建人整份保存草稿，别人 404。
  app.get("/api/meetings/:id/card", { preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: MeetingCardView } } }, async (req, reply) => {
    const result = await followThrough.cards.view(req.params.id, { personId: req.person!.personId, isCeo: req.person!.role === "ceo" });
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result.view;
  });

  // body 的结构也由服务校验，fieldErrors 统一按草稿字段路径（sections[2].sourceRefs[0].sourceId）。
  app.put("/api/meetings/:id/card/draft", {
    preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: MeetingCardView } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting_card.save_draft", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.cards.saveDraft(req.params.id, { personId: req.person!.personId, isCeo: req.person!.role === "ceo" }, req.body);
    if ("view" in result) return result.view;
    const { status, code, message, fieldErrors, view } = result.error;
    return ctx.fail(reply, status, code, message, { ...(fieldErrors ? { fieldErrors } : {}), ...(view ? { view } : {}) });
  });

  // 在会议卡上指定没对上人的说话人：只有主持人或创建人（别人 404）；草稿版本过期 409 带最新视图。
  app.post("/api/meetings/:id/card/speakers", {
    preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: MeetingCardView } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting_card.assign_speaker", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.cards.assignSpeaker(req.params.id, { personId: req.person!.personId, isCeo: req.person!.role === "ceo" }, req.body);
    if ("view" in result) return result.view;
    const { status, code, message, view } = result.error;
    return ctx.fail(reply, status, code, message, view ? { view } : undefined);
  });

  // 整卡确认：只有主持人或创建人（别人 404）；草稿版本过期 409 带最新视图；确认后排写本体（选了不写入只留天枢）。
  app.post("/api/meetings/:id/card/confirm", {
    preHandler: ctx.requirePerson, schema: { params: idParams, body: MeetingCardConfirmRequest, response: { 200: MeetingCardView } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting_card.confirm", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.cardConfirm.confirm(req.params.id, { personId: req.person!.personId, isCeo: req.person!.role === "ceo" }, req.body);
    if ("view" in result) return result.view;
    const { status, code, message, view } = result.error;
    return ctx.fail(reply, status, code, message, view ? { view } : undefined);
  });

  // 逐条确认一条决策或行动项：责任人本人点（没有负责人的行动项由主持人点），别人 404；没有责任人的决策要先补归属。
  app.post("/api/meetings/:id/card/reviews", {
    preHandler: ctx.requirePerson, schema: { params: idParams, body: MeetingCardReviewRequest, response: { 200: MeetingCardReviewResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting_card.review", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.cardConfirm.review(req.params.id, { personId: req.person!.personId, isCeo: req.person!.role === "ceo" }, req.body);
    if ("view" in result) return result;
    const { status, code, message, view } = result.error;
    return ctx.fail(reply, status, code, message, view ? { view } : undefined);
  });

  // 冻结前主持人给没有责任人的决策补归属（只能选参会人），补上后由那个人确认；别人 404。
  app.post("/api/meetings/:id/card/owners", {
    preHandler: ctx.requirePerson, schema: { params: idParams, body: MeetingCardOwnerRequest, response: { 200: MeetingCardReviewResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting_card.assign_owner", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.cardConfirm.assignOwner(req.params.id, { personId: req.person!.personId, isCeo: req.person!.role === "ceo" }, req.body);
    if ("view" in result) return result;
    const { status, code, message, view } = result.error;
    return ctx.fail(reply, status, code, message, view ? { view } : undefined);
  });

  // 冻结前改「不写进本体」（主持人或创建人，别人 404）。
  app.put("/api/meetings/:id/card/world", {
    preHandler: ctx.requirePerson, schema: { params: idParams, body: MeetingCardWorldChoiceRequest, response: { 200: MeetingCardView } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting_card.world_choice", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.cards.setWorldChoice(req.params.id, { personId: req.person!.personId, isCeo: req.person!.role === "ceo" }, req.body.writeToWorld);
    if ("view" in result) return result.view;
    const { status, code, message, view } = result.error;
    return ctx.fail(reply, status, code, message, view ? { view } : undefined);
  });

  // 重试当前确认版的会议事件写入（主持人或创建人）。
  app.post("/api/meetings/:id/card/retry", {
    preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: MeetingCardView } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting_card.retry", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.cardConfirm.retry(req.params.id, { personId: req.person!.personId, isCeo: req.person!.role === "ceo" });
    return "view" in result ? result.view : ctx.fail(reply, result.error.status, result.error.code, result.error.message);
  });

  // 主持人和 CEO 改挂点（别人一律 404）；「不写入」在整卡确认时选。
  app.put("/api/meetings/:id/world-anchors", {
    preHandler: ctx.requirePerson, schema: { params: idParams, body: MeetingWorldAnchorsRequest, response: { 200: MeetingWorldResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting.world_anchors", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.decisions.setAnchors(req.params.id, req.person!.personId, req.body.anchors);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  app.get("/api/meetings/:id/world-anchor-options", {
    preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: MeetingWorldAnchorOptionsResponse } },
  }, async (req, reply) => {
    const result = await followThrough.decisions.listAnchorOptions(req.params.id, req.person!.personId);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  // 预约建会：登录的人都能建（成员只能给自己建，CEO 从 DRI 里指定主持人），带起止、挂点；只存天枢，不写本体。
  app.post("/api/meetings", { preHandler: ctx.requirePerson, schema: { body: MeetingBookingRequest } }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting.book" });
    const viewer = req.person!;
    const result = await bookMeeting({ pool: ctx.pool, peopleDirectory: ctx.peopleDirectory, preflightAgent: ctx.preflight, secret: ctx.env.sessionSecret,
      introAgent: ctx.threadIntroAgent, anchorOptions: followThrough.decisions.anchorChoicesFor }, viewer, req.body);
    if ("error" in result) {
      return ctx.fail(reply, result.error.status, result.error.code, result.error.message, result.error.fieldErrors ? { fieldErrors: result.error.fieldErrors } : undefined);
    }
    // 后台在飞书约上（建会的人本人的授权）；返回的卡不等它。同一张会议卡再约（replayed）不再约一次。
    if (!("replayed" in result)) await followThrough.feishuEvents.schedule(result.card.objectRef.id, "create");
    return { card: viewer.role === "ceo" ? result.card : projectMemberMeetingCardFromCard(result.card, viewer.personId) };
  });

  // 对话里的会议卡约好没有：只看本人用这张卡建的会（刷新、重放历史后卡按它显示已约）。
  app.get("/api/meeting-drafts/:draftId", {
    preHandler: ctx.requirePerson,
    schema: { params: Type.Object({ draftId: Type.String({ format: "uuid" }) }), response: { 200: MeetingDraftStatusResponse } },
  }, async (req) => {
    const viewer = req.person!;
    const row = await meetingFromDraft(ctx.q, viewer.personId, req.params.draftId);
    return { meeting: row ? { id: row.id, title: row.title, href: `${viewer.role === "ceo" ? "" : "/me"}/meetings/${row.id}` } : null };
  });

  // 预约时的挂点选项（还没有会议）：登录的人都能取。
  app.get("/api/world-anchor-options", {
    preHandler: ctx.requirePerson,
    schema: { querystring: Type.Object({ period: Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" }) }), response: { 200: MeetingWorldAnchorOptionsResponse } },
  }, async (req) => ({ options: await followThrough.decisions.anchorOptionsFor(req.query.period) }));

  app.get("/api/requests/:id/impact", { preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: ImpactCardResponse } } }, async (req, reply) => {
    const card = await readImpactCardByRequest(ctx.q, req.params.id, req.person!.personId);
    return card ? { card } : ctx.fail(reply, 404, "IMPACT_CARD_NOT_FOUND", "影响卡不存在或不可见");
  });

  app.post("/api/impact-cards/:id/ask", { preHandler: ctx.requirePerson, schema: { params: idParams, body: ImpactAskRequest, response: { 200: ImpactAskResponse } } }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "impact_card.ask", objectRef: `impact_card:${req.params.id}` });
    const result = await askImpactCard(ctx.q, followThrough.impact, { cardId: req.params.id, viewerId: req.person!.personId, question: req.body.question.trim(),
      now: ctx.now(), names: personDisplayNames(ctx.peopleDirectory), context: followThrough.context });
    if (!result) return ctx.fail(reply, 404, "IMPACT_CARD_NOT_FOUND", "影响卡不存在或不可见");
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  app.post("/api/impact-cards/:id/irrelevant", { preHandler: ctx.requirePerson, schema: { params: idParams, body: ImpactIrrelevantRequest, response: { 200: ImpactCardResponse } } }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "impact_card.irrelevant", objectRef: `impact_card:${req.params.id}` });
    const card = await markImpactCardIrrelevant(ctx.q, req.params.id, req.person!.personId, req.body.reason);
    return card ? { card } : ctx.fail(reply, 404, "IMPACT_CARD_NOT_FOUND", "影响卡不存在或不可见");
  });
}
