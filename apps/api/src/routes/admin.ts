import type { FastifyReply, FastifyRequest } from "fastify";
import { AdminActionRequest, AdminOverviewResponse } from "@warmap/contracts";
import { executeAdminAction, readAdminOverview } from "../admin.js";
import { personDisplayNames } from "../people.js";
import { isAllowedOrigin, type AppInstance, type RouteContext } from "./shared.js";

/** 管理员：TIANSHU_ADMIN_PERSON_IDS 里的人。 */
export const isAdmin = (ctx: Pick<RouteContext, "env">, personId: string) => ctx.env.adminPersonIds?.includes(personId) ?? false;

/**
 * 管理员视图的接口。守卫 requireAdmin：没登录、不是管理员一律 404（不暴露这页存在）；写请求照常校验 Origin。
 */
export function registerAdminRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, fail, companyMemory } = ctx;
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const person = await ctx.readSession(req);
    if (!person || !isAdmin(ctx, person.personId)) return fail(reply, 404, "NOT_FOUND", "路径不存在");
    if (req.method !== "GET" && !isAllowedOrigin(ctx.env, req.headers.origin)) return fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
    req.person = person;
  };
  const overview = (req: FastifyRequest) => readAdminOverview(q, companyMemory, personDisplayNames(companyMemory), req.person!.personId, ctx.now());

  app.get("/api/admin/overview", { preHandler: requireAdmin, schema: { response: { 200: AdminOverviewResponse } } }, async (req) => overview(req));

  // 守卫先于请求体校验：非管理员拿到的是 404，不是 400。
  app.post("/api/admin/actions", { preValidation: requireAdmin, schema: { body: AdminActionRequest, response: { 200: AdminOverviewResponse } } }, async (req, reply) => {
    const error = await executeAdminAction(pool, companyMemory, req.person!.personId, req.body);
    if (error) return fail(reply, error.status, error.code, error.message);
    return overview(req);
  });
}
