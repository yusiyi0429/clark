import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { CreateRoleRequest, PatchRoleRequest, RoleListResponse, RoleProposalList, RoleProposalView, RoleRevisionList, RoleView, SetRoleSharingRequest } from "@warmap/contracts";
import { personDisplayNames } from "../people.js";
import { acceptProposal, archiveRole, createRole, dismissProposal, listProposals, listRevisions, listRoles, patchRole, readPresets, RoleError, RoleSecrets,
  setRoleSharing, syncRolePresets } from "../roles.js";
import type { AppInstance, RouteContext } from "./shared.js";

const idParams = Type.Object({ id: Type.String({ minLength: 1 }) });

/**
 * 岗位与团队（契约 roles.ts）：本人的岗位、从预设加、改（留记录）、归档；伙伴提的岗位修改的采纳和不要。
 * 启动时把仓库里的预设岗位同步进库（坏文件不拦启动，记一条日志）。
 */
export function registerRoleRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, fail, requirePerson } = ctx;
  const names = () => personDisplayNames(ctx.peopleDirectory);
  app.addHook("onReady", async () => {
    const { presets, errors } = await readPresets();
    for (const error of errors) app.log.error({ error }, "role preset skipped");
    await syncRolePresets(pool, presets, ctx.now()).catch(() => app.log.error("role preset sync failed"));
  });
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof RoleError) return fail(reply, cause.status, cause.code, cause.message);
      if (cause instanceof RoleSecrets) return reply.status(422).send({ code: "SECRET_IN_MATERIAL", message: cause.message, findings: cause.findings });
      throw cause;
    }
  };

  app.get("/api/me/roles", { preHandler: requirePerson, schema: { response: { 200: RoleListResponse } } }, async (req) => listRoles(q, req.person!.personId, names()));

  app.post("/api/me/roles", { preHandler: requirePerson, schema: { body: CreateRoleRequest, response: { 201: RoleView } } }, async (req, reply) =>
    handle(reply, async () => reply.status(201).send(await createRole(pool, req.person!.personId, req.body, names(), ctx.now()))));

  app.patch("/api/me/roles/:id", { preHandler: requirePerson, schema: { params: idParams, body: PatchRoleRequest, response: { 200: RoleView } } }, async (req, reply) =>
    handle(reply, () => patchRole(pool, req.person!.personId, req.params.id, req.body, names(), ctx.now())));

  app.put("/api/me/roles/:id/sharing", { preHandler: requirePerson, schema: { params: idParams, body: SetRoleSharingRequest, response: { 200: RoleView } } },
    async (req, reply) => handle(reply, () => setRoleSharing(q, req.person!.personId, req.params.id, req.body.shared, names(), ctx.now())));

  app.delete("/api/me/roles/:id", { preHandler: requirePerson, schema: { params: idParams } }, async (req, reply) => handle(reply, async () => {
    await archiveRole(q, req.person!.personId, req.params.id, ctx.now());
    return reply.status(204).send();
  }));

  app.get("/api/me/roles/:id/revisions", { preHandler: requirePerson, schema: { params: idParams, response: { 200: RoleRevisionList } } }, async (req, reply) =>
    handle(reply, async () => ({ revisions: await listRevisions(q, req.person!.personId, req.params.id, names()) })));

  app.get("/api/me/role-proposals", { preHandler: requirePerson, schema: {
    querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("all")])) }), response: { 200: RoleProposalList } } }, async (req) =>
    ({ proposals: await listProposals(q, req.person!.personId, req.query.status ?? "open") }));

  app.post("/api/me/role-proposals/:id/accept", { preHandler: requirePerson, schema: { params: idParams, response: { 200: RoleView } } }, async (req, reply) =>
    handle(reply, () => acceptProposal(pool, req.person!.personId, req.params.id, names(), ctx.now())));

  app.post("/api/me/role-proposals/:id/dismiss", { preHandler: requirePerson, schema: { params: idParams, response: { 200: RoleProposalView } } }, async (req, reply) =>
    handle(reply, () => dismissProposal(pool, req.person!.personId, req.params.id, ctx.now())));
}
