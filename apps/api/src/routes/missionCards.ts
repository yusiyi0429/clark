import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ExecuteMissionRoundActionRequest } from "@warmap/contracts";
import { actionFingerprint, verifyActionId } from "../actionToken.js";
import { executeDraftMissionRound, executeOpenMissionRound, executeReopenMissionRound, getMissionRoundCard } from "../missionRounds.js";
import type { AppInstance, RouteContext } from "./shared.js";

const NoInput = Type.Object({}, { additionalProperties: false });

/** 个人卡拍板动作使用登录人边界；具体对象权限由锁内的仓储再次判断。 */
export function registerMissionCardRoutes(app: AppInstance, ctx: RouteContext): void {
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
    // 整页的个人卡投影归 04b；此时拒绝，而不是执行后返回错误或伪造另一种 Card。
    if (req.body.viewCardId !== undefined) return ctx.fail(reply, 400, "VIEW_CARD_NOT_AVAILABLE", "个人卡页即将上线，请刷新本轮摘要后操作");
    ctx.requestContext.set(req, { actionType: scope.actionType, objectRef: `${scope.objectType}:${scope.objectId}` });
    const fingerprint = actionFingerprint(ctx.env.sessionSecret, req.body.actionId, input);
    if (draft) return ctx.respond(reply, await executeDraftMissionRound(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, scope, fingerprint, ctx.now, ctx.env.missionCardDraftsDir));
    const execute = scope.actionType === "mission-round.open" ? executeOpenMissionRound : executeReopenMissionRound;
    return ctx.respond(reply, await execute(ctx.pool, ctx.companyMemory.searchPeople(undefined), ctx.env.sessionSecret, req.person!, scope, fingerprint, ctx.now));
  });
}
