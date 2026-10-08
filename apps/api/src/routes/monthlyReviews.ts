import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ExecuteMonthlyReviewActionRequest,
  ExecuteMonthlyReviewActionResponse,
  CreateMonthlyReviewCommentRequest,
  CreateMonthlyReviewCommentResponse,
  MonthlyPlanPeriod,
  MonthlyReviewDecideLtcoInput,
  MonthlyReviewItemResponse,
  MonthlyReviewItemUpdateInput,
  MonthlyReviewResolveSuggestionInput,
  MonthlyReviewResponse,
  MonthlyReviewReturnInput,
  MonthlyReviewUpdateSummaryInput,
  MyMonthlyReviewNoticesResponse,
  type TMonthlyReviewPayload,
} from "@warmap/contracts";
import { actionFingerprint, verifyActionId } from "../actionToken.js";
import { companyPeriod } from "../monthlyPlans.js";
import {
  canReadMonthlyReviewItem,
  createMonthlyReviewComment,
  executeMonthlyReviewAction,
  executeMonthlyReviewItemAction,
  getMonthlyReviewByPeriod,
  getMonthlyReviewItem,
  getMonthlyReviewRow,
  listMonthlyReviewItems,
  listMonthlyReviewComments,
  listMonthlyReviewNotices,
  listMonthlyReviewUnits,
  monthlyReviewParticipantIds,
  monthlyReviewOpenAction,
  projectMonthlyReview,
  projectMonthlyReviewItem,
  readLtco,
  type MonthlyReviewEffect,
  type MonthlyReviewRow,
  type ReviewViewer,
} from "../monthlyReviews.js";
import { personDisplayNames } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";
import { registerPersonalReviewRoutes } from "./personalReviews.js";

const NoInput = Type.Object({}, { additionalProperties: false });

/** actionType → [objectType, input schema]；不在表里或 objectType 不匹配的 actionId 一律 404。 */
const ACTIONS: Record<string, [string, TSchema]> = {
  "monthly-review.open": ["monthly-review-slot", NoInput],
  "monthly-review-item.update": ["monthly-review-item", MonthlyReviewItemUpdateInput],
  "monthly-review-item.resolve_suggestion": ["monthly-review-item", MonthlyReviewResolveSuggestionInput],
  "monthly-review-item.submit": ["monthly-review-item", NoInput],
  "monthly-review-item.return": ["monthly-review-item", MonthlyReviewReturnInput],
  "monthly-review-item.confirm": ["monthly-review-item", NoInput],
  "monthly-review-item.retry_draft": ["monthly-review-item", NoInput],
  "monthly-review-item.retry_assessment": ["monthly-review-item", NoInput],
  "monthly-review.update_summary": ["monthly-review", MonthlyReviewUpdateSummaryInput],
  "monthly-review.retry_summary": ["monthly-review", NoInput],
  "monthly-review.confirm_summary": ["monthly-review", NoInput],
  "monthly-review.decide_ltco": ["monthly-review", MonthlyReviewDecideLtcoInput],
};

/** 月末复盘：CEO 总览、负责人 / CEO 的复盘项、现算通知，以及独立的 Action 执行接口。 */
export function registerMonthlyReviewRoutes(app: AppInstance, ctx: RouteContext): void {
  registerPersonalReviewRoutes(app, ctx);
  const secret = ctx.env.sessionSecret;
  const reviewView = async (row: MonthlyReviewRow): Promise<TMonthlyReviewPayload> =>
    projectMonthlyReview(row, await listMonthlyReviewItems(ctx.q, row.id), personDisplayNames(ctx.companyMemory), await readLtco(ctx.q), secret,
      await listMonthlyReviewUnits(ctx.q));
  const itemView = async (row: NonNullable<Awaited<ReturnType<typeof getMonthlyReviewItem>>>, person: ReviewViewer) => {
    const people = personDisplayNames(ctx.companyMemory);
    return projectMonthlyReviewItem(row, person, people, secret, await monthlyReviewParticipantIds(ctx.q, row),
      await listMonthlyReviewComments(ctx.q, row.id, people));
  };

  app.get("/api/monthly-reviews/:period", {
    preHandler: ctx.requireCEO,
    schema: { params: Type.Object({ period: MonthlyPlanPeriod }, { additionalProperties: false }), response: { 200: MonthlyReviewResponse } },
  }, async (req) => {
    const { period } = req.params;
    const row = await getMonthlyReviewByPeriod(ctx.q, period);
    if (row) return { period, review: await reviewView(row), actions: [] };
    return { period, review: null, actions: period === companyPeriod(ctx.now()) ? [monthlyReviewOpenAction(secret, period)] : [] };
  });

  app.get("/api/monthly-review-items/:itemId", {
    preHandler: ctx.requirePerson,
    schema: { params: Type.Object({ itemId: Type.String() }, { additionalProperties: false }), response: { 200: MonthlyReviewItemResponse } },
  }, async (req, reply) => {
    const row = await getMonthlyReviewItem(ctx.q, req.params.itemId);
    if (!row || !await canReadMonthlyReviewItem(ctx.q, req.person!, row)) return ctx.fail(reply, 404, "MONTHLY_REVIEW_ITEM_NOT_FOUND", "复盘项不存在或不可见");
    return { item: await itemView(row, req.person!) };
  });

  app.post("/api/monthly-review-items/:itemId/comments", {
    preHandler: ctx.requirePerson,
    schema: { params: Type.Object({ itemId: Type.String() }, { additionalProperties: false }), body: CreateMonthlyReviewCommentRequest,
      response: { 200: CreateMonthlyReviewCommentResponse } },
  }, async (req, reply) => {
    const result = await createMonthlyReviewComment(ctx.pool, req.params.itemId, req.person!, req.body.clientId,
      req.body.body.trim(), ctx.now(), personDisplayNames(ctx.companyMemory));
    if ("status" in result) return ctx.fail(reply, result.status, result.code, result.message);
    return result;
  });

  app.get("/api/me/monthly-reviews", {
    preHandler: ctx.requirePerson, schema: { response: { 200: MyMonthlyReviewNoticesResponse } },
  }, async (req) => ({ notices: await listMonthlyReviewNotices(ctx.q, req.person!) }));

  const runEffects = async (effects: MonthlyReviewEffect[]) => {
    const service = ctx.monthlyReviewService;
    const logFailure = (err: unknown) => console.error("monthly review run failed", err);
    for (const effect of effects) {
      if (effect.type === "draft") service?.startDraft(effect.itemId, effect.runId).catch(logFailure);
      if (effect.type === "assess") service?.startAssessment(effect.itemId, effect.runId).catch(logFailure);
      if (effect.type === "summary") service?.startSummary(effect.reviewId, effect.runId).catch(logFailure);
      // 下月计划沿用现有创建与生成流程；已存在时 createForPeriod 不重复创建
      if (effect.type === "next_plan") await ctx.monthlyPlanService?.createForPeriod(effect.period).catch((err) => console.error("next monthly plan failed", err));
      // 已有计划按复盘重新生成：与「重新生成草案」同一个执行入口
      if (effect.type === "plan_draft") ctx.monthlyPlanService?.executeRun(effect.planId, effect.runId).catch((err) => console.error("monthly draft run failed", err));
    }
  };

  app.post("/api/monthly-reviews/actions/execute", {
    preHandler: ctx.requirePerson,
    schema: { body: ExecuteMonthlyReviewActionRequest, response: { 200: ExecuteMonthlyReviewActionResponse } },
  }, async (req, reply) => {
    const scope = verifyActionId(secret, req.body.actionId);
    const spec = scope ? ACTIONS[scope.actionType] : undefined;
    if (!scope || !spec || spec[0] !== scope.objectType || (scope.objectType === "monthly-review-slot" && scope.objectVersion !== 1)) {
      return ctx.fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
    }
    const input = req.body.input ?? {};
    if (!Value.Check(spec[1], input)) return ctx.invalidInput(reply, spec[1], input);
    ctx.requestContext.set(req, { actionType: scope.actionType, objectRef: `${scope.objectType}:${scope.objectId}` });
    const person = req.person!;

    if (scope.objectType === "monthly-review-slot") {
      if (person.role !== "ceo") return ctx.fail(reply, 403, "FORBIDDEN", "只有 CEO 可以开启复盘");
      if (scope.objectId !== companyPeriod(ctx.now())) return ctx.fail(reply, 400, "INVALID_PERIOD", "只能开启当月复盘");
      if (!ctx.monthlyReviewService) return ctx.fail(reply, 503, "MONTHLY_REVIEW_UNAVAILABLE", "复盘服务未配置");
      const opened = await ctx.monthlyReviewService.open(scope.objectId);
      return { review: await reviewView((await getMonthlyReviewRow(ctx.q, opened.reviewId))!) };
    }

    const fingerprint = actionFingerprint(secret, req.body.actionId, input);
    const execute = scope.objectType === "monthly-review-item" ? executeMonthlyReviewItemAction : executeMonthlyReviewAction;
    const outcome = await execute(ctx.pool, person, scope, input, fingerprint, ctx.now());
    if ("error" in outcome) {
      return ctx.fail(reply, outcome.error.status, outcome.error.code, outcome.error.message, outcome.error.fieldErrors ? { fieldErrors: outcome.error.fieldErrors } : undefined);
    }
    if ("conflict" in outcome) return ctx.fail(reply, 409, "VERSION_CONFLICT", "复盘已被修改，请重新读取后再试");
    await runEffects(outcome.effects);
    if (scope.objectType === "monthly-review-item") {
      const item = (await getMonthlyReviewItem(ctx.q, scope.objectId))!;
      return { item: await itemView(item, person) };
    }
    return { review: await reviewView((await getMonthlyReviewRow(ctx.q, scope.objectId))!) };
  });
}
