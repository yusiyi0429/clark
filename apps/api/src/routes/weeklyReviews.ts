import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ExecuteWeeklyReviewActionRequest, ExecuteWeeklyReviewActionResponse, WeeklyReviewBoardResponse, WeeklyReviewResponse, WeeklyReviewUpdateInput } from "@warmap/contracts";
import { actionFingerprint, verifyActionId } from "../actionToken.js";
import { personDisplayNames } from "../people.js";
import { executeWeeklyReviewAction, getWeeklyReviewRow, isWeekStart, projectWeeklyReview, readWeeklyReviewBoard, readWeeklyReviewForViewer } from "../weeklyReviews.js";
import type { AppInstance, RouteContext } from "./shared.js";

const NoInput = Type.Object({}, { additionalProperties: false });
const ACTIONS = ["weekly-review.update", "weekly-review.submit", "weekly-review.generate"];

/** 周复盘：名单、单份、本人的修改 / 提交 / 重新生成。可见范围在仓储层（weeklyReviews.ts）判。 */
export function registerWeeklyReviewRoutes(app: AppInstance, ctx: RouteContext): void {
  const secret = ctx.env.sessionSecret;
  const names = () => personDisplayNames(ctx.companyMemory);

  app.get("/api/weekly-reviews/board", {
    preHandler: ctx.requirePerson,
    schema: { querystring: Type.Object({ week: Type.Optional(Type.String()) }), response: { 200: WeeklyReviewBoardResponse } },
  }, async (req, reply) => {
    const week = req.query.week;
    if (week !== undefined && !isWeekStart(week)) return ctx.fail(reply, 400, "INVALID_INPUT", "week 要写这一周的周一（YYYY-MM-DD）");
    return { board: await readWeeklyReviewBoard(ctx.q, req.person!, names(), ctx.now(), week) };
  });

  app.get("/api/weekly-reviews/:weeklyReviewId", {
    preHandler: ctx.requirePerson,
    schema: { params: Type.Object({ weeklyReviewId: Type.String() }), response: { 200: WeeklyReviewResponse } },
  }, async (req, reply) => {
    const row = await readWeeklyReviewForViewer(ctx.q, req.person!, req.params.weeklyReviewId);
    if (!row) return ctx.fail(reply, 404, "WEEKLY_REVIEW_NOT_FOUND", "周复盘不存在或不可见");
    return { review: projectWeeklyReview(row, req.person!, names(), secret) };
  });

  app.post("/api/weekly-reviews/actions/execute", {
    preHandler: ctx.requirePerson,
    schema: { body: ExecuteWeeklyReviewActionRequest, response: { 200: ExecuteWeeklyReviewActionResponse } },
  }, async (req, reply) => {
    const scope = verifyActionId(secret, req.body.actionId);
    if (!scope || scope.objectType !== "weekly-review" || !ACTIONS.includes(scope.actionType)) return ctx.fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
    const input = req.body.input ?? {};
    const schema = scope.actionType === "weekly-review.update" ? WeeklyReviewUpdateInput : NoInput;
    if (!Value.Check(schema, input)) return ctx.invalidInput(reply, schema, input);
    if (scope.actionType === "weekly-review.generate" && !ctx.weeklyReviewService) return ctx.fail(reply, 503, "WEEKLY_REVIEW_UNAVAILABLE", "周复盘生成服务未配置");
    ctx.requestContext.set(req, { actionType: scope.actionType, objectRef: `weekly-review:${scope.objectId}` });
    const outcome = await executeWeeklyReviewAction(ctx.pool, req.person!, scope, input, actionFingerprint(secret, req.body.actionId, input), ctx.now());
    if ("error" in outcome) return ctx.fail(reply, outcome.error.status, outcome.error.code, outcome.error.message, outcome.error.fieldErrors ? { fieldErrors: outcome.error.fieldErrors } : undefined);
    if ("conflict" in outcome) return ctx.fail(reply, 409, "VERSION_CONFLICT", "周复盘已被修改，请重新读取后再试");
    for (const effect of outcome.effects) {
      if (effect.type === "generate") void ctx.weeklyReviewService?.start(effect.weeklyReviewId, effect.version).catch((error) => console.error("weekly review draft failed", error));
      if (effect.type === "world_sync") ctx.weeklyReviewWorld?.schedule(effect.weeklyReviewId);
    }
    return { review: projectWeeklyReview((await getWeeklyReviewRow(ctx.q, scope.objectId))!, req.person!, names(), secret) };
  });
}
