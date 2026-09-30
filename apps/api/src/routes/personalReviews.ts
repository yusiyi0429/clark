import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ExecutePersonalReviewActionRequest, ExecutePersonalReviewActionResponse, PersonalReviewBoardResponse,
  PersonalReviewResponse, PersonalReviewUpdateInput, MonthlyCycleResponse } from "@warmap/contracts";
import { actionFingerprint, verifyActionId } from "../actionToken.js";
import { createPersonalReviewDraftAgent } from "../personalReviewAgent.js";
import { executePersonalReviewAction, getPersonalReview, projectPersonalReview, readPersonalReviewBoard } from "../personalReviews.js";
import { readMonthlyCycle } from "../monthlyCycle.js";
import { personDisplayNames } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";

const NoInput = Type.Object({}, { additionalProperties: false });
export function registerPersonalReviewRoutes(app: AppInstance, ctx: RouteContext): void {
  const secret = ctx.env.sessionSecret;
  const agent = createPersonalReviewDraftAgent({ query: ctx.q, baseUrl: ctx.env.piBaseUrl, apiKey: ctx.env.piApiKey, modelId: ctx.env.heavyModel });
  app.get("/api/monthly-cycle", { preHandler: ctx.requirePerson, schema: { response: { 200: MonthlyCycleResponse } } },
    async () => ({ cycle: await readMonthlyCycle(ctx.q, ctx.now()) }));
  app.get("/api/personal-reviews/board", { preHandler: ctx.requirePerson, schema: { response: { 200: PersonalReviewBoardResponse } } },
    async (req) => ({ board: await readPersonalReviewBoard(ctx.q, req.person!, personDisplayNames(ctx.companyMemory), secret) }));
  app.get("/api/personal-reviews/:personalReviewId", {
    preHandler: ctx.requirePerson, schema: { params: Type.Object({ personalReviewId: Type.String() }), response: { 200: PersonalReviewResponse } },
  }, async (req, reply) => {
    const row = await getPersonalReview(ctx.q, req.params.personalReviewId);
    if (!row || row.person_id !== req.person!.personId && req.person!.role !== "ceo") return ctx.fail(reply, 404, "PERSONAL_REVIEW_NOT_FOUND", "个人复盘不存在或不可见");
    return { review: await projectPersonalReview(ctx.q, row, req.person!, personDisplayNames(ctx.companyMemory), secret, ctx.conversationAttachmentStorageDir, ctx.now()) };
  });
  app.post("/api/personal-reviews/actions/execute", { preHandler: ctx.requirePerson,
    schema: { body: ExecutePersonalReviewActionRequest, response: { 200: ExecutePersonalReviewActionResponse } },
  }, async (req, reply) => {
    const scope = verifyActionId(secret, req.body.actionId);
    if (!scope || scope.objectType !== "personal-review" || !["personal-review.update", "personal-review.submit", "personal-review.skip", "personal-review.draft_with_co_agent"].includes(scope.actionType)) {
      return ctx.fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
    }
    const input = req.body.input ?? {};
    const schema = scope.actionType === "personal-review.update" ? PersonalReviewUpdateInput : NoInput;
    if (!Value.Check(schema, input)) return ctx.invalidInput(reply, schema, input);
    if (scope.actionType === "personal-review.draft_with_co_agent" && !ctx.monthlyReviewService) return ctx.fail(reply, 503, "MONTHLY_REVIEW_UNAVAILABLE", "复盘服务未配置");
    ctx.requestContext.set(req, { actionType: scope.actionType, objectRef: `personal-review:${scope.objectId}` });
    const outcome = await executePersonalReviewAction(ctx.pool, req.person!, scope, input,
      actionFingerprint(secret, req.body.actionId, input), ctx.now(), ctx.conversationAttachmentStorageDir);
    if ("error" in outcome) return ctx.fail(reply, outcome.error.status, outcome.error.code, outcome.error.message);
    if ("conflict" in outcome) return ctx.fail(reply, 409, "VERSION_CONFLICT", "个人复盘已被修改，请重新读取后再试");
    for (const effect of outcome.effects) {
      const failed = (error: unknown) => console.error("personal review run failed", error);
      if (effect.type === "personal_draft") void ctx.monthlyReviewService?.startPersonalDraft(effect.personalReviewId, effect.version, ctx.conversationAttachmentStorageDir, agent).catch(failed);
      if (effect.type === "draft") void ctx.monthlyReviewService?.startDraft(effect.itemId, effect.runId).catch(failed);
      if (effect.type === "summary") void ctx.monthlyReviewService?.startSummary(effect.reviewId, effect.runId).catch(failed);
    }
    const row = (await getPersonalReview(ctx.q, scope.objectId))!;
    const names = personDisplayNames(ctx.companyMemory);
    return { review: await projectPersonalReview(ctx.q, row, req.person!, names, secret, ctx.conversationAttachmentStorageDir, ctx.now()),
      board: (await readPersonalReviewBoard(ctx.q, req.person!, names, secret, row.monthly_review_id))! };
  });
}
