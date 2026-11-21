import type { FastifyReply, FastifyRequest } from "fastify";
import { AdminActionRequest, AdminOverviewResponse, UsageQuery, UsageResponse, WorkCountsResponse } from "@warmap/contracts";
import { executeAdminAction, readAdminOverview } from "../admin.js";
import { personDisplayNames } from "../people.js";
import { isWeekStart, readUsage, usageMarkdown } from "../usage.js";
import { readWorkCounts } from "../workCounts.js";
import { isAllowedOrigin, type AppInstance, type RouteContext } from "./shared.js";

/** 管理员：TIANSHU_ADMIN_PERSON_IDS 里的人。 */
export const isAdmin = (ctx: Pick<RouteContext, "env">, personId: string) => ctx.env.adminPersonIds?.includes(personId) ?? false;

/**
 * 管理员视图的接口。守卫 requireAdmin：没登录、不是管理员一律 404（不暴露这页存在）；写请求照常校验 Origin。
 */
export function registerAdminRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, fail, peopleDirectory } = ctx;
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const person = await ctx.readSession(req);
    if (!person || !isAdmin(ctx, person.personId)) return fail(reply, 404, "NOT_FOUND", "路径不存在");
    if (req.method !== "GET" && !isAllowedOrigin(ctx.env, req.headers.origin)) return fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
    req.person = person;
  };
  const overview = (req: FastifyRequest) => readAdminOverview(q, peopleDirectory, personDisplayNames(peopleDirectory), req.person!.personId, ctx.now());

  app.get("/api/admin/overview", { preHandler: requireAdmin, schema: { response: { 200: AdminOverviewResponse } } }, async (req) => overview(req));

  // 守卫先于请求体校验：非管理员拿到的是 404，不是 400。
  app.post("/api/admin/actions", { preValidation: requireAdmin, schema: { body: AdminActionRequest, response: { 200: AdminOverviewResponse } } }, async (req, reply) => {
    const error = await executeAdminAction(pool, peopleDirectory, req.person!.personId, req.body);
    if (error) return fail(reply, error.status, error.code, error.message);
    return overview(req);
  });

  // 使用周报：week 是周一（北京时间），不传为本周（现算）；没有生成过的那一周 404。
  type UsageRequest = FastifyRequest<{ Querystring: { week?: string } }>;
  const usage = async (req: UsageRequest, reply: FastifyReply) => {
    if (req.query.week && !isWeekStart(req.query.week)) return void fail(reply, 400, "INVALID_WEEK", "week 要是某一周的周一");
    const found = await readUsage(q, peopleDirectory, req.query.week, ctx.now());
    if (!found) fail(reply, 404, "USAGE_REPORT_NOT_FOUND", "这一周没有周报");
    return found ?? undefined;
  };
  app.get("/api/admin/usage", { preValidation: requireAdmin, schema: { querystring: UsageQuery, response: { 200: UsageResponse } } },
    async (req: UsageRequest, reply) => (await usage(req, reply)) ?? reply);
  app.get("/api/admin/usage/markdown", { preValidation: requireAdmin, schema: { querystring: UsageQuery } }, async (req: UsageRequest, reply) => {
    const found = await usage(req, reply);
    return found ? reply.type("text/markdown; charset=utf-8").send(usageMarkdown(found.report)) : reply;
  });
  // 使用计数（第 70 条）：week 是周一（北京时间），不传为本周（到现在为止），都现算。
  app.get("/api/admin/work-counts", { preValidation: requireAdmin, schema: { querystring: UsageQuery, response: { 200: WorkCountsResponse } } },
    async (req: UsageRequest, reply) => {
      if (req.query.week && !isWeekStart(req.query.week)) return fail(reply, 400, "INVALID_WEEK", "week 要是某一周的周一");
      return readWorkCounts(q, peopleDirectory, req.query.week, ctx.now());
    });
}
