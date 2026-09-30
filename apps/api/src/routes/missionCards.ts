import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CreateMissionCardCorrectionRequest, CreateMissionCardFeedbackRequest, DecideMissionCardCorrectionRequest, ExecuteMissionRoundActionRequest, MarkMissionCardReadRequest, MissionRoundConfirmInput, MissionRoundDecideInput, MyMissionRoundsResponse, type TMissionRoundConfirmInput, type TMissionRoundDecideInput, type TMissionRoundSummary } from "@warmap/contracts";
import { actionFingerprint, verifyActionId } from "../actionToken.js";
import { createMissionCardDraftAgent } from "../missionCardDraftAgent.js";
import { createMissionCardCorrection, decideMissionCardCorrection } from "../missionCardCorrections.js";
import { executeCloseMissionRound, executeConfirmMissionRound, executeDecideMissionRound, executeDraftMissionRound, executeOpenMissionRound, executeReopenMissionRound, getMissionRoundCard, listMissionRoundCards } from "../missionRounds.js";
import type { AppInstance, RouteContext } from "./shared.js";
import { createPersonalMissionCardFeedback, getPersonalMissionCard, getPersonalMissionCardGroup, markPersonalMissionCardRead, visiblePersonalMissionCard } from "../personalMissionCards.js";
import { MissionCardItemsResponse } from "@warmap/contracts";
import { canApprove } from "../missionRounds.js";
import { listMissionItems } from "../tasks.js";
import { personDisplayNames } from "../people.js";
import { registerMissionCardAnnotationRoutes } from "./missionCardAnnotations.js";
import type { MissionCardAnnotationAgent } from "../missionCardAnnotationAgent.js";

const NoInput = Type.Object({}, { additionalProperties: false });

/** 任务卡拍板动作使用登录人边界；具体对象权限由锁内的仓储再次判断。 */
export function registerMissionCardRoutes(app: AppInstance, ctx: RouteContext, annotationAgent?: MissionCardAnnotationAgent): void {
  registerMissionCardAnnotationRoutes(app, ctx, annotationAgent);
  app.get("/api/me/mission-cards", { preHandler: ctx.requirePerson, schema: { response: { 200: MyMissionRoundsResponse } } }, async (req) => {
    const at = ctx.now();
    const cards = await listMissionRoundCards(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, undefined, at);
    const rounds = cards.map((card) => card.payload as TMissionRoundSummary)
      .map((round) => ({ ...round, cards: round.cards.filter((card) => round.approver || card.mine) }))
      .filter((round) => round.cards.length > 0);
    return { rounds };
  });
  const cardParams = Type.Object({ cardId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  app.get("/api/mission-cards/:cardId", { preHandler: ctx.requirePerson, schema: { params: cardParams } }, async (req, reply) => {
    const card = await getPersonalMissionCard(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.cardId, ctx.now());
    return card ? { cards: [card] } : ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
  });
  app.get("/api/mission-cards/:cardId/items", { preHandler: ctx.requirePerson, schema: { params: cardParams, response: { 200: MissionCardItemsResponse } } }, async (req, reply) => {
    const visible = await visiblePersonalMissionCard(ctx.q, req.person!, req.params.cardId);
    if (!visible || visible.card.owner_id !== req.person!.personId && !canApprove(req.person!, visible.round))
      return ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
    const missionRows = (await ctx.q("SELECT id FROM missions WHERE personal_mission_card_id=$1 ORDER BY code,id", [req.params.cardId])).rows as { id: string }[];
    const names = personDisplayNames(ctx.companyMemory);
    return { missions: await Promise.all(missionRows.map(async ({ id }) => ({ missionId: id, items: await listMissionItems(ctx.q, id, names) }))) };
  });
  app.post("/api/mission-cards/:cardId/feedback", { preHandler: ctx.requirePerson, schema: { params: cardParams, body: CreateMissionCardFeedbackRequest } }, async (req, reply) => {
    const result = await createPersonalMissionCardFeedback(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.cardId, req.body, ctx.now);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });
  // 已确定任务卡的更正（GAP-04）：拍板权与卡可见性在事务内判断。
  app.post("/api/mission-cards/:cardId/corrections", { preHandler: ctx.requirePerson, schema: { params: cardParams, body: CreateMissionCardCorrectionRequest } }, async (req, reply) => {
    const result = await createMissionCardCorrection(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.cardId, req.body, ctx.now);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });
  const correctionParams = Type.Object({ cardId: Type.String({ minLength: 1 }), correctionId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  app.post("/api/mission-cards/:cardId/corrections/:correctionId/decision", { preHandler: ctx.requirePerson, schema: { params: correctionParams, body: DecideMissionCardCorrectionRequest } }, async (req, reply) => {
    const result = await decideMissionCardCorrection(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.cardId, req.params.correctionId, req.body, ctx.now);
    return "error" in result ? ctx.fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });
  app.get("/api/mission-cards/:cardId/group", { preHandler: ctx.requirePerson, schema: { params: cardParams,
    querystring: Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }) } }, async (req, reply) => {
    const result = await getPersonalMissionCardGroup(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.params.cardId, ctx.now(), req.query.after);
    return result ?? ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
  });
  app.post("/api/mission-cards/:cardId/group/read", { preHandler: ctx.requirePerson, schema: { params: cardParams, body: MarkMissionCardReadRequest } }, async (req, reply) => {
    const result = await markPersonalMissionCardRead(ctx.q, req.person!, req.params.cardId, req.body.lastReadSeq, ctx.now());
    return result ?? ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
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
      : scope.objectType !== "mission-round" || !["mission-round.open", "mission-round.close", "mission-round.reopen", "mission-round.decide", "mission-round.confirm"].includes(scope.actionType))) {
      return ctx.fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
    }
    const input = req.body.input ?? {};
    const inputSchema = scope.actionType === "mission-round.decide" ? MissionRoundDecideInput
      : scope.actionType === "mission-round.confirm" ? MissionRoundConfirmInput : NoInput;
    if (!Value.Check(inputSchema, input)) return ctx.invalidInput(reply, inputSchema, input);
    if (req.body.viewCardId !== undefined) {
      const visible = await visiblePersonalMissionCard(ctx.q, req.person!, req.body.viewCardId);
      if (!visible || draft || visible.round.id !== scope.objectId) return ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不属于本轮");
    }
    ctx.requestContext.set(req, { actionType: scope.actionType, objectRef: `${scope.objectType}:${scope.objectId}` });
    const fingerprint = actionFingerprint(ctx.env.sessionSecret, req.body.actionId, input);
    if (draft) return ctx.respond(reply, await executeDraftMissionRound(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, scope, fingerprint, ctx.now, ctx.env.missionCardDraftsDir,
      createMissionCardDraftAgent({ query: ctx.q, baseUrl: ctx.env.piBaseUrl, apiKey: ctx.env.piApiKey, modelId: ctx.env.heavyModel }), ctx.companyMemory));
    const args = [ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, scope, fingerprint, ctx.now] as const;
    const outcome = scope.actionType === "mission-round.decide" ? await executeDecideMissionRound(...args, input as TMissionRoundDecideInput)
      : scope.actionType === "mission-round.confirm" ? await executeConfirmMissionRound(...args, input as TMissionRoundConfirmInput)
      : scope.actionType === "mission-round.close" ? await executeCloseMissionRound(...args)
      : await (scope.actionType === "mission-round.open" ? executeOpenMissionRound : executeReopenMissionRound)(...args);
    if (req.body.viewCardId && !("error" in outcome)) {
      const card = await getPersonalMissionCard(ctx.q, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, req.body.viewCardId, ctx.now());
      if (!card) return ctx.fail(reply, 404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
      return ctx.respond(reply, outcome.conflict ? { conflict: true, latestCard: card } : { ...outcome, card });
    }
    return ctx.respond(reply, outcome);
  });
}
