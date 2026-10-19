import { Type } from "@sinclair/typebox";
import {
  ImpactAskRequest, ImpactAskResponse, ImpactCardResponse, ImpactIrrelevantRequest, MeetingDecisionResponse, MeetingDecisionReviewRequest,
  MeetingWorldAnchorOptionsResponse, MeetingWorldAnchorsRequest, MeetingWorldExcludedRequest, MeetingWorldResponse, MyMeetingDecisionsResponse,
} from "@warmap/contracts";
import { askImpactCard, markImpactCardIrrelevant, readImpactCardByRequest } from "../impactCards.js";
import type { MeetingFollowThrough } from "../meetingFollowThrough.js";
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

  // 会议入本体：主持人和 CEO 标不写进本体、改挂点（别人一律 404）。
  app.put("/api/meetings/:id/world-excluded", {
    preHandler: ctx.requirePerson, schema: { params: idParams, body: MeetingWorldExcludedRequest, response: { 200: MeetingWorldResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting.world_excluded", objectRef: `meeting:${req.params.id}` });
    const result = await followThrough.decisions.setExcluded(req.params.id, req.person!.personId, req.body.excluded);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

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
