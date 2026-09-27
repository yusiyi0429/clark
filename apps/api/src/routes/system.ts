import type { FastifyReply, FastifyRequest } from "fastify";
import type { Static } from "@sinclair/typebox";
import { HealthResponse } from "@warmap/contracts";
import { createCompanyMemoryMcpSession } from "../mcpCompanyMemory.js";
import { createMeMcpSession } from "../mcpMe.js";
import { authenticatePersonalToken } from "../personalTokens.js";
import { personDisplayNames } from "../people.js";
import { roleOf } from "../memberAccess.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerSystemRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, runtime, companyMemory, radar, recordings, voiceprints, requireServiceToken } = ctx;

  const healthz = async (): Promise<Static<typeof HealthResponse>> => {
    let database = true;
    try {
      await q("SELECT 1");
    } catch {
      database = false;
    }
    const dependencies = {
      // 启动不变量：任一为 false 时 API 不可能对外服务；字段来自已装配对象而非环境名。
      piRuntime: Boolean(runtime),
      modelSlots: Boolean(env.lightModel && env.heavyModel && env.compactionModel),
      companyMemoryMcp: Boolean(companyMemory),
      // Provider 可选项：安装时就能诚实区分，不发起外部调用。
      search: radar.providerStatus.web,
      wechat: radar.providerStatus.wechat,
      outlets: radar.providerStatus.outlets ?? false,
      // 会议录音识别凭据是否配全（只看变量在不在，不发起外部调用）
      recording: recordings.configured(),
      // 腾讯云声纹凭据是否配全（同上，只看变量）
      voiceprint: voiceprints.configured(),
    };
    const status: Static<typeof HealthResponse>["status"] =
      database && dependencies.piRuntime && dependencies.modelSlots && dependencies.companyMemoryMcp ? "ok" : "degraded";
    return { status, api: true, database, buildSha: env.buildSha, dependencies };
  };
  app.get("/healthz", { schema: { response: { 200: HealthResponse } } }, healthz);
  app.get("/api/healthz", { schema: { response: { 200: HealthResponse } } }, healthz);

  // CompanyMemory MCP：独立服务凭据，只读（ADR-0004/0013）；GET/DELETE 会话协商由无状态 transport 拒绝。
  app.post(
    "/mcp/company-memory",
    { preHandler: requireServiceToken(env.mcpServiceToken) },
    async (req, reply) => {
      reply.hijack();
      const { server, transport } = await createCompanyMemoryMcpSession(companyMemory);
      reply.raw.on("close", () => {
        void server.close();
      });
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  );

  const meMcp = async (req: FastifyRequest, reply: FastifyReply) => {
    const isMember = (personId: string) => companyMemory.searchPeople(undefined).some((person) => person.personId === personId && roleOf(person) === "member");
    const identity = await authenticatePersonalToken(q, req.headers.authorization, env.sessionSecret, ctx.now(), isMember);
    if (!identity) return ctx.fail(reply, 401, "UNAUTHORIZED", "个人令牌无效");
    reply.hijack();
    const { server, transport } = await createMeMcpSession({ pool: ctx.pool, q, pepper: env.sessionSecret, now: ctx.now,
      names: () => personDisplayNames(companyMemory), isMember, authorization: req.headers.authorization });
    reply.raw.on("close", () => { void server.close(); });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post("/mcp/me", meMcp);
  app.get("/mcp/me", meMcp);
  app.delete("/mcp/me", meMcp);
}
