import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CreateMissionCardFeedbackRequest, ExecuteMissionRoundActionRequest, MarkMissionCardReadRequest } from "@warmap/contracts";
import { actionFingerprint, verifyActionId } from "../actionToken.js";
import { executeDraftMissionRound, executeOpenMissionRound, executeReopenMissionRound, getMissionRoundCard } from "../missionRounds.js";
import type { AppInstance, RouteContext } from "./shared.js";
import { createPersonalMissionCardFeedback, getPersonalMissionCard, getPersonalMissionCardGroup, markPersonalMissionCardRead, visiblePersonalMissionCard } from "../personalMissionCards.js";

const NoInput = Type.Object({}, { additionalProperties: false });

/** 个人卡拍板动作使用登录人边界；具体对象权限由锁内的仓储再次判断。 */
export function registerMissionCardRoutes(app: AppInstance, ctx: RouteContext): void {
  const cardParams = Type.Object({ cardId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  app.get("/api/mission-cards/:cardId", { preHandler: ctx.requirePerson, schema: { params: cardParams } }, async (req, reply) => {
    const card = await getPersonalMissionCard(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.cardId, ctx.now());
    return card ? { cards: [card] } : ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "个人卡不存在或不可见");
  });
  app.post("/api/mission-cards/:cardId/feedback", { preHandler: ctx.requirePerson, schema: { params: cardParams, body: CreateMissionCardFeedbackRequest } }, async (req, reply) => {
    const result = await createPersonalMissionCardFeedback(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.cardId, req.body, ctx.now);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });
  app.get("/api/mission-cards/:cardId/group", { preHandler: ctx.requirePerson, schema: { params: cardParams,
    querystring: Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }) } }, async (req, reply) => {
    const result = await getPersonalMissionCardGroup(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.cardId, ctx.now(), req.query.after);
    return result ?? ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "个人卡不存在或不可见");
  });
  app.post("/api/mission-cards/:cardId/group/read", { preHandler: ctx.requirePerson, schema: { params: cardParams, body: MarkMissionCardReadRequest } }, async (req, reply) => {
    const result = await markPersonalMissionCardRead(ctx.q, req.person!, req.params.cardId, req.body.lastReadSeq, ctx.now());
    return result ?? ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "个人卡不存在或不可见");
  });
  app.get("/api/mission-rounds/:roundId", {
    preHandler: ctx.requirePerson,
    schema: { params: Type.Object({ roundId: Type.String({ minLength: 1 }) }, { additionalProperties: false }) },
  }, async (req, reply) => {
    const card = await getMissionRoundCard(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.roundId, ctx.now());
    return card ? { cards: [card] } : ctx.fail(reply, 404, "ROUND_NOT_FOUND", "本轮不存在或不可见");
  });

  app.post("/api/mission-rounds/actions/execute", {
    preHandler: ctx.requirePerson, schema: { body: ExecuteMissionRoundActionRequest },
  }, async (req, reply) => {
    const scope = verifyActionId(ctx.env.sessionSecret, req.body.actionId);
    const draft = scope?.actionType === "mission-round.draft";
    if (!scope || (draft
      ? scope.objectType !== "mission-round-slot" || scope.objectVersion !== 1
      : scope.objectType !== "mission-round" || !["mission-round.open", "mission-round.reopen"].includes(scope.actionType))) {
      return ctx.fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
    }
    const input = req.body.input ?? {};
    if (!Value.Check(NoInput, input)) return ctx.invalidInput(reply, NoInput, input);
    if (req.body.viewCardId !== undefined) {
      const visible = await visiblePersonalMissionCard(ctx.q, req.person!, req.body.viewCardId);
      if (!visible || draft || visible.round.id !== scope.objectId) return ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "个人卡不存在或不属于本轮");
    }
    ctx.requestContext.set(req, { actionType: scope.actionType, objectRef: `${scope.objectType}:${scope.objectId}` });
    const fingerprint = actionFingerprint(ctx.env.sessionSecret, req.body.actionId, input);
    if (draft) return ctx.respond(reply, await executeDraftMissionRound(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, scope, fingerprint, ctx.now, ctx.env.missionCardDraftsDir));
    const execute = scope.actionType === "mission-round.open" ? executeOpenMissionRound : executeReopenMissionRound;
    const outcome = await execute(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, scope, fingerprint, ctx.now);
    if (req.body.viewCardId && !("error" in outcome)) {
      const card = await getPersonalMissionCard(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.body.viewCardId, ctx.now());
      if (!card) return ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "个人卡不存在或不可见");
      return ctx.respond(reply, outcome.conflict ? { conflict: true, latestCard: card } : { ...outcome, card });
    }
    return ctx.respond(reply, outcome);
  });
}
