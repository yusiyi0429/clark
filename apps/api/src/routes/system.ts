import type { FastifyReply, FastifyRequest } from "fastify";
import type { Static } from "@sinclair/typebox";
import { HealthResponse } from "@warmap/contracts";
import { createCompanyMemoryMcpSession } from "../mcpCompanyMemory.js";
import { createMeMcpSession } from "../mcpMe.js";
import { authenticateMcpToken, MCP_WRITE_TOOLS, oauthUrls } from "../mcpOAuth.js";
import { personDisplayNames } from "../people.js";
import type { AppInstance, RouteContext } from "./shared.js";
import { worldConfigured } from "../worldClient.js";

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
      world: worldConfigured(env),
    };
    const status: Static<typeof HealthResponse>["status"] =
      database && dependencies.piRuntime && dependencies.modelSlots && dependencies.companyMemoryMcp ? "ok" : "degraded";
    // 本体连通状态（启动时只读探测的结果，不含凭证与地址）；不影响 status。完全没配本体时不带这一项（与原响应一致）。
    return { status, api: true, database, buildSha: env.buildSha, dependencies, ...(ctx.world && (env.worldApiUrl || env.worldAgentToken || env.worldTokenError) ? { world: ctx.world.status() } : {}),
      ...(ctx.worldTk && env.worldTk && (env.worldTk.worldApiUrl || env.worldTk.worldAgentToken || env.worldTk.worldTokenError) ? { worldTk: ctx.worldTk.status() } : {}) };
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
    const findPerson = (personId: string) => companyMemory.searchPeople(undefined).find((person) => person.personId === personId);
    const urls = oauthUrls(env.publicOrigin);
    const identity = await authenticateMcpToken(q, req.headers.authorization, env.sessionSecret, ctx.now(), (personId) => !!findPerson(personId), urls.resource);
    if (!identity) {
      reply.header("WWW-Authenticate", `Bearer resource_metadata="${urls.metadata}", scope="tianshu:read tianshu:write"`);
      return ctx.fail(reply, 401, "UNAUTHORIZED", "连接授权无效，请重新登录或检查个人令牌");
    }
    const rpc = req.body as { method?: string; params?: { name?: string } } | undefined;
    if (identity.scopes && (!identity.scopes.includes("tianshu:read") || rpc?.method === "tools/call" && MCP_WRITE_TOOLS.has(rpc.params?.name ?? "") && !identity.scopes.includes("tianshu:write"))) {
      reply.header("WWW-Authenticate", `Bearer error="insufficient_scope", resource_metadata="${urls.metadata}", scope="tianshu:read tianshu:write"`);
      return ctx.fail(reply, 403, "FORBIDDEN", "这次连接没有写入权限，请重新授权");
    }
    reply.hijack();
    const { server, transport } = await createMeMcpSession({ pool: ctx.pool, q, pepper: env.sessionSecret, now: ctx.now,
      names: () => personDisplayNames(companyMemory), findPerson, initialPerson: findPerson(identity.personId)!, authorization: req.headers.authorization,
      people: () => companyMemory.searchPeople(undefined), publicOrigin: env.publicOrigin });
    reply.raw.on("close", () => { void server.close(); });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post("/mcp/me", meMcp);
  app.get("/mcp/me", meMcp);
  app.delete("/mcp/me", meMcp);
}
