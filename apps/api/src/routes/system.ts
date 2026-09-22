import type { FastifyReply } from "fastify";
import type { Static } from "@sinclair/typebox";
import { HealthResponse } from "@warmap/contracts";
import { createCompanyMemoryMcpSession } from "../mcpCompanyMemory.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerSystemRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, runtime, companyMemory, radar, requireServiceToken } = ctx;

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
}
