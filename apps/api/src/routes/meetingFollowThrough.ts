import { Type } from "@sinclair/typebox";
import {
  ImpactAskRequest, ImpactAskResponse, ImpactCardResponse, ImpactIrrelevantRequest, MeetingBookingRequest, MeetingDecisionResponse, MeetingDecisionReviewRequest,
  MeetingWorldAnchorOptionsResponse, MeetingWorldAnchorsRequest, MeetingWorldResponse, MyMeetingDecisionsResponse,
} from "@warmap/contracts";
import { askImpactCard, markImpactCardIrrelevant, readImpactCardByRequest } from "../impactCards.js";
import type { MeetingFollowThrough } from "../meetingFollowThrough.js";
import { bookMeeting } from "../meetings.js";
import { projectMemberMeetingCardFromCard } from "../memberCards.js";
import { personDisplayNames } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";

const idParams = Type.Object({ id: Type.String() });

/** 会后分层确认（主持人的「会上定了 X」）与影响卡（读、追问、和我无关）。 */
export function registerMeetingFollowThroughRoutes(app: AppInstance, ctx: RouteContext, followThrough: MeetingFollowThrough): void {
  app.get("/api/me/meeting-decisions", { preHandler: ctx.requirePerson, schema: { response: { 200: MyMeetingDecisionsResponse } } },
    async (req) => ({ groups: await followThrough.decisions.listMine(req.person!.personId) }));

  app.post("/api/meetings/:id/decisions/:decisionId/review", {
    preHandler: ctx.requirePerson,
    schema: { params: Type.Object({ id: Type.String(), decisionId: Type.String() }), body: MeetingDecisionReviewRequest, response: { 200: MeetingDecisionResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting_decision.review", objectRef: `meeting_decision:${req.params.decisionId}` });
    const result = await followThrough.decisions.review(req.params.id, req.params.decisionId, req.person!.personId, req.body);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  // 会议入本体：会议页单独取挂点、会议记录状态和每条决定的落点（不进会议卡，读会议保持轻）。
  app.get("/api/meetings/:id/world", { preHandler: ctx.requirePerson, schema: { params: idParams, response: { 200: MeetingWorldResponse } } }, async (req, reply) => {
    const result = await followThrough.decisions.worldView(req.params.id, req.person!.personId);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
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
      introAgent: ctx.threadIntroAgent, anchorOptions: followThrough.decisions.anchorOptionsFor }, viewer, req.body);
    if ("error" in result) {
      return ctx.fail(reply, result.error.status, result.error.code, result.error.message, result.error.fieldErrors ? { fieldErrors: result.error.fieldErrors } : undefined);
    }
    return { card: viewer.role === "ceo" ? result.card : projectMemberMeetingCardFromCard(result.card, viewer.personId) };
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
